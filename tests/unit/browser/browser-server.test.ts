import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_DEFAULT_CONFIG, resolveBrowserConfig } from '../../../src/browser/config.js';
import { type BrowserServer, createBrowserServer } from '../../../src/browser/index.js';
import { resetCachedFeatures } from '../../../src/handlers/feature-cache.js';
import type { AuditEvent } from '../../../src/server/audit.js';
import { buildAdtConfig } from '../../../src/server/server.js';
import { mockResponse } from '../../helpers/mock-fetch.js';

const BASE_URL = 'https://sap.example.com';
const PROGRAM_PATH = '/sap/bc/adt/programs/programs/ZHELLO/source/main';

type Route = (url: URL, init: RequestInit) => Response | Promise<Response | undefined> | undefined;

function routedFetch(...routes: Route[]) {
  return vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(String(input));
    for (const route of routes) {
      const response = await route(url, init);
      if (response) return response;
    }
    return mockResponse(404, 'not found', { 'content-type': 'text/plain' });
  });
}

const programRoute: Route = (url) =>
  url.pathname === PROGRAM_PATH
    ? mockResponse(200, "REPORT zhello.\nWRITE 'hi'.", { 'content-type': 'text/plain' })
    : undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join('\n');
}

describe('resolveBrowserConfig', () => {
  it('defaults to read-only, $TMP only, no sap-client, memory cache, no abapGit and no stored text', () => {
    const config = resolveBrowserConfig();
    expect(config).toMatchObject({
      allowWrites: false,
      allowDataPreview: false,
      allowFreeSQL: false,
      allowTransportWrites: false,
      allowGitWrites: false,
      allowedPackages: ['$TMP'],
      client: '',
      cacheMode: 'memory',
      featureAbapGit: 'off',
      username: '',
      url: '',
      password: '',
      plugins: [],
    });
    expect(config.denyActions).toEqual(['SAPQuery.long_text']);
  });

  it('merges host settings and keeps the stored-text denial', () => {
    const config = resolveBrowserConfig(
      {
        allowWrites: true,
        allowedPackages: [' Z* ', '$TMP'],
        denyActions: ['SAPWrite.delete'],
        blockedDataSources: ['usr02'],
        client: '001',
        systemLabel: 'DEV\n001',
        maxConcurrent: 4,
        toolMode: 'hyperfocused',
      },
      ' developer ',
    );
    expect(config).toMatchObject({
      allowWrites: true,
      allowedPackages: ['Z*', '$TMP'],
      blockedDataSources: ['USR02'],
      client: '001',
      systemLabel: 'DEV 001',
      maxConcurrent: 4,
      toolMode: 'hyperfocused',
      username: 'DEVELOPER',
    });
    expect(config.denyActions).toEqual(['SAPWrite.delete', 'SAPQuery.long_text']);
  });

  it.each([
    ['url', 'https://other.example.com'],
    ['username', 'SHARED'],
    ['password', 'secret'],
    ['cookieFile', '/tmp/cookies'],
    ['plugins', ['/x.js']],
    ['abaplintConfig', '/x.jsonc'],
    ['allowGitWrites', true],
    ['featureAbapGit', 'on'],
    ['insecure', true],
    ['transport', 'http-streamable'],
    ['somethingElse', 1],
  ])('refuses the unsupported setting %s', (key, value) => {
    expect(() => resolveBrowserConfig({ [key]: value } as never)).toThrow(`Browser config '${key}' is not supported`);
  });

  it.each([
    [{ allowWrites: 'true' }, /allowWrites' must be true or false/],
    [{ allowedPackages: 'Z*' }, /allowedPackages' must be an array of non-empty strings/],
    [{ allowedPackages: ['Z*', ' '] }, /allowedPackages' must be an array of non-empty strings/],
    [{ allowedPackages: [] }, /use \['\*'\] to allow every package/],
    [{ maxConcurrent: 0 }, /maxConcurrent' must be a positive integer/],
    [{ cacheMode: 'sqlite' }, /cacheMode' must be one of memory, none/],
    [{ client: '1' }, /3-digit SAP client/],
    [{ denyActions: ['SAPWrite.nope'] }, /matches no actions/],
    [{ blockedDataSources: ['USR 02'] }, /blockedDataSources entry/],
  ])('rejects invalid values: %j', (input, message) => {
    expect(() => resolveBrowserConfig(input as never)).toThrow(message);
  });

  it('rejects a user that is not an SAP user name', () => {
    expect(() => resolveBrowserConfig({}, 'FIRST LAST')).toThrow(/user' must be an SAP user name/);
    expect(() => resolveBrowserConfig({}, 'A'.repeat(13))).toThrow(/at most 12 characters/);
    expect(() => resolveBrowserConfig({}, 42 as never)).toThrow(/user' must be a string/);
  });

  it('builds the same safety ceiling as the Node server for the same settings', async () => {
    const { createBrowserClient } = await import('../../../src/browser/index.js');
    const config = resolveBrowserConfig({
      allowWrites: true,
      allowDataPreview: true,
      allowedPackages: ['Z*'],
      allowedTransports: ['DEVK9*'],
      blockedDataSources: ['USR02'],
    });
    const client = createBrowserClient(config, vi.fn<typeof fetch>(), BASE_URL);
    expect(client.safety).toEqual(buildAdtConfig(config).safety);
    expect(client.username).toBe('');
    expect(client.sapClient).toBe('');
  });

  it('does not change the Node defaults it starts from', () => {
    expect(Object.isFrozen(BROWSER_DEFAULT_CONFIG)).toBe(true);
    resolveBrowserConfig({ allowWrites: true });
    expect(BROWSER_DEFAULT_CONFIG.allowWrites).toBe(false);
  });
});

describe('createBrowserServer', () => {
  let runtime: BrowserServer | undefined;
  let client: Client | undefined;

  beforeEach(() => {
    resetCachedFeatures();
  });

  afterEach(async () => {
    await client?.close();
    await runtime?.close();
    client = undefined;
    runtime = undefined;
  });

  async function connect(options: Parameters<typeof createBrowserServer>[0]) {
    runtime = createBrowserServer({ baseUrl: BASE_URL, ...options });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-host', version: '1.0.0' });
    const listChanged = deferred<void>();
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => listChanged.resolve());
    await runtime.connect(serverTransport);
    await client.connect(clientTransport);
    return { runtime, client, listChanged: listChanged.promise };
  }

  it('needs an origin outside a browser', () => {
    expect(() => createBrowserServer({ fetch: vi.fn<typeof fetch>() })).toThrow(/needs baseUrl/);
  });

  it('serves the read-only tool surface by default and the write tools when allowed', async () => {
    const readOnly = await connect({ fetch: routedFetch() });
    const readNames = (await readOnly.client.listTools()).tools.map((tool) => tool.name);
    expect(readNames).toContain('SAPRead');
    expect(readNames).not.toContain('SAPWrite');
    expect(readNames).not.toContain('SAPQuery');
    await client?.close();
    await runtime?.close();

    const writable = await connect({ fetch: routedFetch(), config: { allowWrites: true } });
    expect((await writable.client.listTools()).tools.map((tool) => tool.name)).toContain('SAPWrite');
  });

  it('never lists stored text, even with data preview allowed', async () => {
    const { client } = await connect({ fetch: routedFetch(), config: { allowDataPreview: true } });
    const query = (await client.listTools()).tools.find((tool) => tool.name === 'SAPQuery');
    const actions = (query?.inputSchema.properties?.action as { enum?: string[] } | undefined)?.enum ?? [];
    expect(actions).not.toContain('long_text');

    const result = await client.callTool({
      name: 'SAPQuery',
      arguments: { action: 'long_text', longText: { object: 'TEXT', name: 'X', id: 'ST', language: 'E' } },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/denied|not allowed|blocked/i);
  });

  it('reads source over the browser session and records the host user in audit events', async () => {
    const events: AuditEvent[] = [];
    const fetchImpl = routedFetch(programRoute);
    const { client } = await connect({
      fetch: fetchImpl,
      user: 'developer',
      sinks: [{ write: (event) => events.push(event) }],
    });

    const result = await client.callTool({ name: 'SAPRead', arguments: { type: 'PROG', name: 'ZHELLO' } });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('REPORT zhello.');
    const [url, init] = fetchImpl.mock.calls.find(([input]) => String(input).includes(PROGRAM_PATH))!;
    expect(new URL(String(url)).searchParams.has('sap-client')).toBe(false);
    expect(init?.credentials).toBe('include');
    expect(init?.headers).not.toHaveProperty('Cookie');
    expect(init?.headers).not.toHaveProperty('Authorization');
    const start = events.find((event) => event.event === 'tool_call_start');
    expect(start).toMatchObject({ tool: 'SAPRead', user: 'DEVELOPER', clientId: 'arc-1-browser' });
  });

  it('refuses writes under the default ceiling before any mutating request', async () => {
    // The package allowlist check reads the object's real package first (as in Node); the write gate follows.
    const metadataRoute: Route = (url) =>
      url.pathname === '/sap/bc/adt/programs/programs/ZHELLO'
        ? mockResponse(
            200,
            '<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZHELLO"><adtcore:packageRef adtcore:name="$TMP"/></program:abapProgram>',
            { 'content-type': 'application/vnd.sap.adt.programs.programs.v2+xml' },
          )
        : undefined;
    const fetchImpl = routedFetch(metadataRoute, programRoute);
    const { client } = await connect({ fetch: fetchImpl });
    await client.callTool({ name: 'SAPRead', arguments: { type: 'PROG', name: 'ZHELLO' } });
    const before = fetchImpl.mock.calls.length;

    const result = await client.callTool({
      name: 'SAPWrite',
      arguments: { action: 'update', type: 'PROG', name: 'ZHELLO', source: 'REPORT zhello.' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/write/i);
    expect(text(result)).not.toMatch(/404|not found/i);
    const methods = fetchImpl.mock.calls.slice(before).map(([, init]) => init?.method ?? 'GET');
    expect(methods.filter((method) => method !== 'GET' && method !== 'HEAD')).toEqual([]);
  });

  it('runs tool calls one at a time, in arrival order', async () => {
    const gate = deferred<void>();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const slowRoute: Route = async (url) => {
      const match = /\/programs\/programs\/(Z[A-Z]+)\/source\/main$/.exec(url.pathname);
      if (!match) return undefined;
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(match[1]!);
      if (match[1] === 'ZFIRST') await gate.promise;
      active--;
      return mockResponse(200, `REPORT ${match[1]!.toLowerCase()}.`, { 'content-type': 'text/plain' });
    };
    const { client } = await connect({ fetch: routedFetch(slowRoute) });

    const first = client.callTool({ name: 'SAPRead', arguments: { type: 'PROG', name: 'ZFIRST' } });
    const second = client.callTool({ name: 'SAPRead', arguments: { type: 'PROG', name: 'ZSECOND' } });
    await vi.waitFor(() => expect(order).toEqual(['ZFIRST']));
    gate.resolve();

    expect(text(await first)).toContain('REPORT zfirst.');
    expect(text(await second)).toContain('REPORT zsecond.');
    expect(order).toEqual(['ZFIRST', 'ZSECOND']);
    expect(maxActive).toBe(1);
  });

  it('probes features before the first tool call and announces the narrowed tool list', async () => {
    const fetchImpl = routedFetch(programRoute);
    const { client, listChanged } = await connect({ fetch: fetchImpl });

    await client.callTool({ name: 'SAPRead', arguments: { type: 'PROG', name: 'ZHELLO' } });

    const paths = fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths.indexOf(PROGRAM_PATH)).toBeGreaterThan(0);
    await listChanged;
  });

  it('shows the host user in SAPRead SYSTEM', async () => {
    const discovery = '<?xml version="1.0"?><app:service xmlns:app="http://www.w3.org/2007/app"/>';
    const { client } = await connect({
      fetch: routedFetch((url) =>
        url.pathname === '/sap/bc/adt/core/discovery'
          ? mockResponse(200, discovery, { 'content-type': 'application/atomsvc+xml' })
          : undefined,
      ),
      user: 'developer',
    });
    const result = await client.callTool({ name: 'SAPRead', arguments: { type: 'SYSTEM' } });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('DEVELOPER');
  });

  it('asks for a new logon in the browser when the SAP session has ended', async () => {
    const loggedOff: Route = (url) =>
      url.pathname === PROGRAM_PATH
        ? mockResponse(401, '<html>Logon Error Message</html>', { 'content-type': 'text/html' })
        : undefined;
    const { client } = await connect({ fetch: routedFetch(loggedOff) });

    const result = await client.callTool({ name: 'SAPRead', arguments: { type: 'PROG', name: 'ZHELLO' } });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no longer logged on to SAP in this browser');
    expect(text(result)).toContain('log on to SAP again in this browser');
    expect(text(result)).not.toMatch(/SAP_USER|SAP_PASSWORD|Logon Error Message/);
  });
});
