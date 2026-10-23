/**
 * Live browser test for the ARC-1 browser runtime (Phase 4 of docs/plans/2026-10-20-browser-embedded-runtime.md).
 *
 * Builds the shipped bundle, serves it with the harness page from scripts/browser/dev-server.mjs (which proxies
 * `/sap/*` to the SAP test system, so page, worker and ADT share one origin), and runs it in a module Web Worker
 * in headless Chromium. The test is the backend MCP client: an unmodified SDK `Client` whose transport relays each
 * JSON-RPC message through the page, as the host's relay transport does.
 *
 * The browser context logs on once before the runtime starts, as the host app's own logon would have done (one
 * Basic-authenticated request; an SSO system redirects ADT to its IdP and never sends a Basic challenge). The
 * session cookies then belong to the local origin, and the browser also answers later Basic challenges
 * (Playwright `httpCredentials`). The runtime itself never sees the credentials.
 *
 * Each read also runs through Node ARC-1 (`handleToolCall` with the same resolved config, Basic auth) and must
 * give the same result, so a system's own gaps (e.g. no `/core/discovery` below 7.40) count as parity, not as a
 * browser failure.
 *
 *   npx playwright-core install chromium-headless-shell   # once
 *   npm run test:browser-live                              # TEST_SAP_* or SAP_* from .env
 *
 * A second block starts the runtime as an embedding page does, through the host helper (`host.js`), with the
 * bundle served from another origin (a second dev server), so the helper's blob bootstrap runs for real.
 *
 * Read-only: no object is created or changed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type JSONRPCMessage, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { build } from 'esbuild';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserBundleOptions, browserHostOptions } from '../../scripts/browser/build.mjs';
import { startDevServer } from '../../scripts/browser/dev-server.mjs';
import { defaultFeatureConfig } from '../../src/adt/config.js';
import { probeFeatures } from '../../src/adt/features.js';
import { resolveBrowserConfig } from '../../src/browser/config.js';
import { handleToolCall } from '../../src/handlers/dispatch.js';
import { cacheProbedFeatures } from '../../src/handlers/feature-cache.js';
import { getTestClient, requireSapCredentials } from '../integration/helpers.js';

requireSapCredentials();
const SAP_URL = process.env.TEST_SAP_URL || process.env.SAP_URL || '';
const SAP_USER = process.env.TEST_SAP_USER || process.env.SAP_USER || '';
const SAP_PASSWORD = process.env.TEST_SAP_PASSWORD || process.env.SAP_PASSWORD || '';
const SAP_CLIENT = process.env.TEST_SAP_CLIENT || process.env.SAP_CLIENT || '100';
const INSECURE = (process.env.TEST_SAP_INSECURE || process.env.SAP_INSECURE) === 'true';

interface AuditRecord {
  event: string;
  tool?: string;
  user?: string;
  clientId?: string;
}

/** What scripts/browser/harness/harness.js puts on the page's global scope. */
interface HarnessPage {
  arc1Harness: {
    start(options: unknown): Promise<unknown>;
    send(message: unknown): void;
    startHost(options: unknown): Promise<{ apiVersion: number; serverInfo: { name: string } }>;
    hostCall(name: string, args: unknown, options?: unknown): Promise<{ content: unknown; isError?: boolean }>;
    audit: AuditRecord[];
    toolsChanged: number;
  };
}

interface SeenRequest {
  url: string;
  sessionType?: string;
}

/** MCP transport that relays every JSON-RPC message through the harness page to the worker and back. */
class PageRelayTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly page: Page) {}

  async start(): Promise<void> {
    await this.page.exposeFunction('arc1OnMessage', (message: JSONRPCMessage) => this.onmessage?.(message));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await this.page.evaluate((m) => (globalThis as unknown as HarnessPage).arc1Harness.send(m), message);
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

interface Session {
  context: BrowserContext;
  page: Page;
  client: Client;
  requests: SeenRequest[];
  listChanged: Promise<void>;
  timings: { workerReadyMs: number; initializeMs: number };
}

let outdir: string;
let devServer: { url: string; close(): Promise<void> };
/** Serves the same bundle on another origin, as the host's own web server would. */
let bundleServer: { url: string; close(): Promise<void> };
let browser: Browser;

async function openSession(withLogon: boolean): Promise<Session> {
  const { context, page, requests } = await openPage(withLogon);
  const transport = new PageRelayTransport(page);
  const client = new Client({ name: 'browser-live-test', version: '1.0.0' });
  let resolveListChanged!: () => void;
  const listChanged = new Promise<void>((resolve) => {
    resolveListChanged = resolve;
  });
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => resolveListChanged());

  const started = Date.now();
  await page.evaluate((options) => (globalThis as unknown as HarnessPage).arc1Harness.start(options), {
    config: { client: SAP_CLIENT },
    user: SAP_USER,
  });
  const workerReadyMs = Date.now() - started;
  await client.connect(transport);
  const initializeMs = Date.now() - started - workerReadyMs;
  return { context, page, client, requests, listChanged, timings: { workerReadyMs, initializeMs } };
}

/** A harness page on the dev server, logged on to SAP or not; records every `/sap/*` request. */
async function openPage(withLogon: boolean) {
  const context = await browser.newContext(
    withLogon ? { httpCredentials: { username: SAP_USER, password: SAP_PASSWORD, origin: devServer.url } } : {},
  );
  const requests: SeenRequest[] = [];
  context.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/sap/')) {
      requests.push({ url: request.url(), sessionType: request.headers()['x-sap-adt-sessiontype'] });
    }
  });
  if (withLogon) {
    const authorization = `Basic ${Buffer.from(`${SAP_USER}:${SAP_PASSWORD}`).toString('base64')}`;
    const logon = await context.request.get(
      `${devServer.url}/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=RSHOWTIM&maxResults=1&sap-client=${SAP_CLIENT}`,
      { headers: { authorization }, maxRedirects: 0 },
    );
    expect(logon.status(), 'logon through the dev server').toBe(200);
  }
  const page = await context.newPage();
  await page.goto(devServer.url);
  return { context, page, requests };
}

function text(result: unknown): string {
  return ((result as { content: unknown }).content as Array<{ type: string; text: string }>)
    .map((part) => part.text)
    .join('\n');
}

const nodeConfig = resolveBrowserConfig({ client: SAP_CLIENT }, SAP_USER);
const nodeClient = getTestClient();

/** Run a call in the browser and in Node ARC-1; both must give the same result. Returns the browser's. */
async function expectParity(session: Session, name: string, args: Record<string, unknown>) {
  const browserResult = await session.client.callTool({ name, arguments: args });
  const nodeResult = await handleToolCall(nodeClient, nodeConfig, name, { ...args });
  const label = `${name} ${JSON.stringify(args)}`;
  expect(text(browserResult), `${label}: browser and Node differ`).toBe(text(nodeResult));
  expect(Boolean(browserResult.isError), `${label}: browser and Node differ in isError`).toBe(
    Boolean(nodeResult.isError),
  );
  console.log(`    ${label}: ${browserResult.isError ? 'error' : 'ok'} in the browser and in Node`);
  return { isError: Boolean(browserResult.isError), body: text(browserResult) };
}

async function expectSuccess(session: Session, name: string, args: Record<string, unknown>): Promise<string> {
  const { isError, body } = await expectParity(session, name, args);
  expect(isError, `${name} ${JSON.stringify(args)} failed:\n${body}`).toBe(false);
  return body;
}

beforeAll(async () => {
  outdir = mkdtempSync(join(tmpdir(), 'arc1-browser-live-'));
  await build({ ...browserBundleOptions({ outdir }), legalComments: 'none', logLevel: 'silent' });
  await build({ ...browserHostOptions({ outdir }), logLevel: 'silent' });
  devServer = await startDevServer({ target: SAP_URL, bundleDir: outdir, insecure: INSECURE });
  bundleServer = await startDevServer({ target: SAP_URL, bundleDir: outdir, insecure: INSECURE });
  // Node probes too, so both sides answer from the same feature set.
  cacheProbedFeatures(await probeFeatures(nodeClient.http, defaultFeatureConfig(), nodeConfig.systemType), false);
  try {
    browser = await chromium.launch({ executablePath: process.env.ARC1_BROWSER_EXECUTABLE || undefined });
  } catch (err) {
    throw new Error(
      `Could not start Chromium (${err instanceof Error ? err.message.split('\n')[0] : err}). ` +
        'Run `npx playwright-core install chromium-headless-shell`, or set ARC1_BROWSER_EXECUTABLE.',
    );
  }
});

afterAll(async () => {
  await browser?.close();
  await devServer?.close();
  await bundleServer?.close();
  if (outdir) rmSync(outdir, { recursive: true, force: true });
});

describe('browser runtime in Chromium against live SAP (read-only)', () => {
  let session: Session;
  let probeMs: number;

  beforeAll(async () => {
    session = await openSession(true);
    const probeStart = Date.now();
    await session.listChanged;
    probeMs = Date.now() - probeStart;
    console.log(
      `    worker ready ${session.timings.workerReadyMs} ms, initialize ${session.timings.initializeMs} ms, ` +
        `feature probe ${probeMs} ms after initialize`,
    );
  });

  afterAll(async () => {
    await session?.client.close();
    await session?.context.close();
  });

  it('initializes over the page relay and serves the read-only tool list', async () => {
    expect(session.client.getServerVersion()?.name).toBe('arc-1');
    const names = (await session.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['SAPRead', 'SAPSearch', 'SAPNavigate']));
    expect(names).not.toContain('SAPWrite');
  });

  it('reports the system with the host-supplied user, as Node does', async () => {
    // Below 7.40 there is no /core/discovery, and SAPRead SYSTEM fails the same way in Node.
    const { isError, body } = await expectParity(session, 'SAPRead', { type: 'SYSTEM' });
    if (!isError) expect(body).toContain(SAP_USER.toUpperCase());
  });

  it('reads program and class source', async () => {
    expect(await expectSuccess(session, 'SAPRead', { type: 'PROG', name: 'RSHOWTIM' })).toMatch(/REPORT\s+rshowtim/i);
    expect(await expectSuccess(session, 'SAPRead', { type: 'CLAS', name: 'CL_ABAP_CHAR_UTILITIES' })).toMatch(
      /class\s+cl_abap_char_utilities\s+definition/i,
    );
  });

  it('searches the repository', async () => {
    expect(await expectSuccess(session, 'SAPSearch', { query: 'CL_ABAP_CHAR*', maxResults: 5 })).toContain(
      'CL_ABAP_CHAR_UTILITIES',
    );
  });

  it('navigates references as Node does', async () => {
    // A rarely used object keeps the where-used search short (a widely used one, e.g. BAPIRET2, takes minutes).
    await expectParity(session, 'SAPNavigate', { action: 'references', type: 'PROG', name: 'RSHOWTIM', maxResults: 5 });
  });

  it('records audit events with the host user and the browser client id', async () => {
    const audit = await session.page.evaluate(() => (globalThis as unknown as HarnessPage).arc1Harness.audit);
    expect(audit.find((event) => event.event === 'tool_call_start' && event.tool === 'SAPRead')).toMatchObject({
      user: SAP_USER.toUpperCase(),
      clientId: 'arc-1-browser',
    });
  });

  it('sends every SAP request same-origin and none as stateless', () => {
    expect(session.requests.length).toBeGreaterThan(0);
    for (const request of session.requests) {
      expect(new URL(request.url).origin).toBe(devServer.url);
      expect(request.sessionType).not.toBe('stateless');
    }
  });

  it('carries on, or asks for a new logon, after the session cookies are gone', async () => {
    await session.context.clearCookies();
    const result = await session.client.callTool({
      name: 'SAPSearch',
      arguments: { query: 'RSHOWTIM*', maxResults: 5 },
    });
    // A Basic system challenges and the browser answers with its cached credentials; an SSO system redirects to
    // its IdP, which only a new logon in the browser can complete. Never a bare network error.
    if (result.isError) {
      expect(text(result)).toContain('log on to SAP again in this browser');
      console.log('    after the cookies were cleared: session-ended error (no Basic challenge on this system)');
    } else {
      expect(text(result)).toContain('RSHOWTIM');
      console.log('    after the cookies were cleared: the browser logged on again by itself');
    }
  });
});

describe('host helper with the bundle on another origin (read-only)', () => {
  let opened: Awaited<ReturnType<typeof openPage>>;
  const bundleRequests: string[] = [];
  let startMs: number;

  const harness = () =>
    opened.page.evaluate.bind(opened.page) as <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) => Promise<R>;

  beforeAll(async () => {
    opened = await openPage(true);
    opened.context.on('request', (request) => {
      if (request.url().startsWith(bundleServer.url)) bundleRequests.push(new URL(request.url()).pathname);
    });
    const started = Date.now();
    const summary = await harness()(
      (options) => (globalThis as unknown as HarnessPage).arc1Harness.startHost(options),
      {
        workerUrl: `${bundleServer.url}/bundle/worker.js`,
        options: { config: { client: SAP_CLIENT }, user: SAP_USER },
      },
    );
    startMs = Date.now() - started;
    expect(summary).toMatchObject({ apiVersion: 1, serverInfo: { name: 'arc-1' } });
    console.log(`    host helper: runtime from ${bundleServer.url} ready and initialized in ${startMs} ms`);
  });

  afterAll(async () => {
    await opened?.context.close();
  });

  it('loads the bundle from the other origin and calls SAP only on the page origin', async () => {
    const result = await harness()(
      ([name, args]) => (globalThis as unknown as HarnessPage).arc1Harness.hostCall(name, args),
      ['SAPRead', { type: 'PROG', name: 'RSHOWTIM' }] as const,
    );
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatch(/REPORT\s+rshowtim/i);
    expect(bundleRequests).toEqual(expect.arrayContaining(['/bundle/host.js', '/bundle/worker.js']));
    expect(bundleRequests.some((path) => path.startsWith('/bundle/chunks/'))).toBe(true);
    expect(opened.requests.length).toBeGreaterThan(0);
    for (const request of opened.requests) expect(new URL(request.url).origin).toBe(devServer.url);
  });

  it('gives the same result as Node ARC-1', async () => {
    const args = { type: 'CLAS', name: 'CL_ABAP_CHAR_UTILITIES' };
    const result = await harness()(
      ([name, a]) => (globalThis as unknown as HarnessPage).arc1Harness.hostCall(name, a),
      ['SAPRead', args] as const,
    );
    expect(text(result)).toBe(text(await handleToolCall(nodeClient, nodeConfig, 'SAPRead', { ...args })));
  });

  it('cuts the result text on request', async () => {
    const result = await harness()(
      ([name, args]) =>
        (globalThis as unknown as HarnessPage).arc1Harness.hostCall(name, args, { maxResultChars: 100 }),
      ['SAPRead', { type: 'CLAS', name: 'CL_ABAP_CHAR_UTILITIES' }] as const,
    );
    const parts = result.content as Array<{ text: string }>;
    expect(parts[0]!.text).toHaveLength(100);
    expect(parts.at(-1)!.text).toMatch(/Result cut to 100 of \d+ characters/);
  });

  it('forwards audit events and reports the narrowed tool list', async () => {
    const state = () =>
      harness()(() => {
        const h = (globalThis as unknown as HarnessPage).arc1Harness;
        return { toolsChanged: h.toolsChanged, audit: h.audit };
      }, undefined);
    await expect.poll(async () => (await state()).toolsChanged).toBeGreaterThan(0);
    expect((await state()).audit.find((event) => event.event === 'tool_call_start')).toMatchObject({
      user: SAP_USER.toUpperCase(),
      clientId: 'arc-1-browser',
    });
  });
});

describe('browser runtime without an SAP logon', () => {
  let session: Session;

  beforeAll(async () => {
    session = await openSession(false);
  });

  afterAll(async () => {
    await session?.client.close();
    await session?.context.close();
  });

  it('answers tool calls with the session-ended error and a logon hint', async () => {
    const result = await session.client.callTool({ name: 'SAPRead', arguments: { type: 'PROG', name: 'RSHOWTIM' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no longer logged on to SAP in this browser');
    expect(text(result)).toContain('log on to SAP again in this browser');
  });
});
