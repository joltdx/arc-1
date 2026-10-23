import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MessageChannel, Worker } from 'node:worker_threads';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserBundleOptions } from '../../../scripts/browser/build.mjs';
import { checkBundle, checkHost, FORBIDDEN_PACKAGES } from '../../../scripts/ci/check-browser-bundle.mjs';
import { MessagePortTransport } from '../../../src/browser/message-port-transport.js';

/**
 * Builds the shipped browser bundle (minified ESM with chunks, as `build:browser` does) and runs it in a
 * worker thread connected over a MessageChannel, the way a host page talks to its Web Worker.
 *
 * Node's own fetch classes read Node globals (`new Response(string)` reads `Buffer`), so the globals cannot
 * simply be deleted. Instead each one is a getter that answers `undefined`, as a browser would, when the
 * reading frame is in the bundle, and records that access; Node internals still get the real value.
 */
const TRAPPED_GLOBALS = ['process', 'Buffer', 'global', 'setImmediate', 'clearImmediate'];
const DELETED_GLOBALS = ['require', '__dirname', '__filename'];

const WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const report = (message) => parentPort.postMessage(message);
for (const name of ${JSON.stringify(TRAPPED_GLOBALS)}) {
  const real = globalThis[name];
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      const caller = new Error().stack.split('\\n')[2] ?? '';
      if (!caller.includes(workerData.dir)) return real;
      report({ access: name + ' at ' + caller.trim() });
      return undefined;
    },
  });
}
for (const name of ${JSON.stringify(DELETED_GLOBALS)}) delete globalThis[name];
(async () => {
  const runtime = await import(workerData.url);
  const fakeSap = async (input) => {
    const url = new URL(String(input));
    report({ request: url.pathname });
    return url.pathname === '/sap/bc/adt/programs/programs/ZHELLO/source/main'
      ? new Response('REPORT zhello.', { status: 200, headers: { 'content-type': 'text/plain' } })
      : new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  };
  console.error = () => undefined;
  const server = runtime.createBrowserServer({ baseUrl: 'https://sap.example.com', fetch: fakeSap, user: 'developer' });
  await server.connect(new runtime.MessagePortTransport(workerData.port));
  report({ ready: true, apiVersion: runtime.BROWSER_API_VERSION });
})().catch((err) => report({ error: String(err && err.stack || err) }));
`;

let outdir: string;
let worker: Worker;
let client: Client;
const requests: string[] = [];
const nodeGlobalAccesses: string[] = [];
let ready: { apiVersion: number };

beforeAll(async () => {
  outdir = mkdtempSync(join(tmpdir(), 'arc1-browser-bundle-test-'));
  await build({ ...browserBundleOptions({ outdir }), legalComments: 'none', logLevel: 'silent' });
  const channel = new MessageChannel();
  worker = new Worker(WORKER, {
    eval: true,
    workerData: {
      url: pathToFileURL(join(outdir, 'index.js')).href,
      dir: pathToFileURL(outdir).href,
      port: channel.port1,
    },
    transferList: [channel.port1],
  });
  ready = await new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      if (message.request) requests.push(message.request);
      if (message.access) nodeGlobalAccesses.push(message.access);
      if (message.error) reject(new Error(message.error));
      if (message.ready) resolve(message);
    });
    worker.on('error', reject);
  });
  client = new Client({ name: 'host', version: '1.0.0' });
  await client.connect(new MessagePortTransport(channel.port2));
}, 120_000);

afterAll(async () => {
  await client?.close();
  await worker?.terminate();
  if (outdir) rmSync(outdir, { recursive: true, force: true });
});

describe('browser runtime bundle without Node globals', () => {
  it('loads and exports the contract version', () => {
    expect(ready.apiVersion).toBe(1);
  });

  it('answers initialize and tools/list over a MessageChannel', async () => {
    expect(client.getServerVersion()?.name).toBe('arc-1');
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('SAPRead');
    expect(names).not.toContain('SAPWrite');
  });

  it('dispatches a read to SAP through the injected fetch', async () => {
    const result = await client.callTool({ name: 'SAPRead', arguments: { type: 'PROG', name: 'ZHELLO' } });
    expect(JSON.stringify(result.content)).toContain('REPORT zhello.');
    expect(result.isError).toBeFalsy();
    expect(requests).toContain('/sap/bc/adt/programs/programs/ZHELLO/source/main');
  });

  it('runs abaplint-backed tools in the minified bundle', async () => {
    const result = await client.callTool({
      name: 'SAPLint',
      arguments: { action: 'lint', source: "REPORT zhello.\nWRITE 'hi'.", name: 'ZHELLO' },
    });
    expect(result.isError).toBeFalsy();
  });

  it('never reads a Node global', () => {
    expect(nodeGlobalAccesses).toEqual([]);
  });
});

describe('check-browser-bundle', () => {
  const metafile = (inputs: string[], imports: Array<{ path: string; external?: boolean }> = []) => ({
    inputs: Object.fromEntries(inputs.map((input) => [input, { bytes: 1 }])),
    outputs: { 'out/index.js': { bytes: 1, imports } },
  });

  it('accepts a clean bundle within budget', () => {
    expect(checkBundle(metafile(['src/browser/index.ts', 'node_modules/zod/index.js']), 95, 100)).toEqual([]);
  });

  it('flags forbidden packages, leftover imports, an exceeded budget and a stale budget', () => {
    expect(FORBIDDEN_PACKAGES).toContain('undici');
    expect(
      checkBundle(
        metafile(
          ['node_modules/undici/index.js', 'node_modules/@arc-mcp/xsuaa-auth/dist/index.js'],
          [{ path: 'node:fs', external: true }],
        ),
        101,
        100,
      ),
    ).toEqual([
      'forbidden package bundled: undici',
      'forbidden package bundled: @arc-mcp/xsuaa-auth',
      "out/index.js keeps an import of 'node:fs'",
      'bundle is 101 bytes, over the 100-byte budget',
    ]);
    expect(checkBundle(metafile([]), 50, 100)).toEqual([
      'bundle is 50 bytes, under 90% of the 100-byte budget: lower BUDGET_BYTES',
    ]);
  });

  it('allows only project source in host.js, within its budget', () => {
    expect(checkHost(metafile(['src/browser/host.ts']), 95, 100)).toEqual([]);
    expect(
      checkHost(metafile(['src/browser/host.ts', 'node_modules/zod/index.js'], [{ path: './chunks/a.js' }]), 101, 100),
    ).toEqual([
      'host.js bundles package code: zod',
      "out/index.js keeps an import of './chunks/a.js'",
      'host.js is 101 bytes, over the 100-byte budget',
    ]);
    expect(checkHost(metafile([]), 50, 100)).toEqual([
      'host.js is 50 bytes, under 90% of the 100-byte budget: lower HOST_BUDGET_BYTES',
    ]);
  });
});
