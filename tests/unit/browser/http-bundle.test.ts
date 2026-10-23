import vm from 'node:vm';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { browserBuildOptions } from '../../../scripts/browser/node-shims.mjs';

/**
 * Builds shared modules the way the browser bundle does and runs them in a vm context that has only web
 * APIs: no `process`, `Buffer`, `require` or other Node globals. Anything that slips past the redirect
 * rules and the injected globals fails here with a ReferenceError instead of in a user's browser.
 */
const ENTRY = `
  export { AdtHttpClient } from './src/adt/http.ts';
  export { parseUiadSource } from './src/adt/uiad.ts';
  export { validateAffHeader } from './src/aff/validator.ts';
  export { logger } from './src/server/logger.ts';
  export const InjectedBuffer = Buffer;
`;

const WEB_GLOBALS = [
  'fetch',
  'Headers',
  'Request',
  'Response',
  'URL',
  'URLSearchParams',
  'TextEncoder',
  'TextDecoder',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'AbortController',
  'AbortSignal',
  'DOMException',
  'Event',
  'EventTarget',
  'crypto',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
  'structuredClone',
  'atob',
  'btoa',
] as const;

type Bundle = {
  AdtHttpClient: new (
    config: Record<string, unknown>,
  ) => {
    get(path: string): Promise<{ statusCode: number; body: string }>;
    post(path: string, body: string, contentType: string): Promise<{ statusCode: number; body: string }>;
  };
  parseUiadSource(source: string): unknown;
  validateAffHeader(type: string, header: Record<string, unknown>): { valid: boolean; errors?: string[] };
  InjectedBuffer: typeof Buffer;
};

let bundle: Bundle;
let context: vm.Context;
const consoleWarnings: string[] = [];

beforeAll(async () => {
  const result = await build({
    ...browserBuildOptions(),
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    format: 'iife',
    globalName: 'arc1',
    write: false,
    logLevel: 'silent',
  });
  const sandbox: Record<string, unknown> = {
    console: { ...console, warn: (...args: unknown[]) => consoleWarnings.push(args.join(' ')) },
  };
  for (const name of WEB_GLOBALS) sandbox[name] = globalThis[name];
  context = vm.createContext(sandbox);
  vm.runInContext(result.outputFiles[0].text, context);
  bundle = context.arc1 as Bundle;
}, 60_000);

describe('browser bundle in a context without Node globals', () => {
  it('has no Node globals to fall back on', () => {
    for (const name of ['process', 'Buffer', 'require', 'global', '__dirname', 'setImmediate']) {
      expect(vm.runInContext(`typeof ${name}`, context)).toBe('undefined');
    }
  });

  it('sends ADT requests through browserFetch and logs to the console', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const responses = [
      new Response('REPORT z.', { status: 200, headers: { 'content-type': 'text/plain' } }),
      new Response(null, { status: 200, headers: { 'x-csrf-token': 'TOKEN' } }),
      new Response('dump', { status: 500 }),
    ];
    const browserFetch = async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return responses.shift()!;
    };
    const client = new bundle.AdtHttpClient({ baseUrl: 'https://sap.example.com', client: '001', browserFetch });

    await expect(client.get('/sap/bc/adt/programs/programs/Z/source/main')).resolves.toMatchObject({
      body: 'REPORT z.',
    });
    await expect(client.post('/sap/bc/adt/programs/programs', '<x/>', 'application/xml')).rejects.toMatchObject({
      statusCode: 500,
    });

    expect(requests.map((r) => r.init.method)).toEqual(['GET', 'HEAD', 'POST']);
    expect(requests.every((r) => r.init.credentials === 'include')).toBe(true);
    expect((requests[2].init.headers as Record<string, string>)['X-CSRF-Token']).toBe('TOKEN');
    // The failed POST is logged at warn level through the injected process.stderr → console.warn.
    expect(
      consoleWarnings.some((line) => line.includes('WARN') && line.includes('/sap/bc/adt/programs/programs')),
    ).toBe(true);
  });

  it('runs shared Buffer code on the injected buffer package', () => {
    expect(() => bundle.parseUiadSource('{"a":1}')).not.toThrow();
  });

  it('matches Node Buffer for the call shapes shared code uses', () => {
    const B = bundle.InjectedBuffer;
    for (const text of ['', 'ascii', 'Grüße – 日本語 𝄞', 'x'.repeat(1000)]) {
      expect(B.byteLength(text)).toBe(Buffer.byteLength(text));
      expect(B.byteLength(text, 'utf8')).toBe(Buffer.byteLength(text, 'utf8'));
      for (const encoding of ['base64', 'hex', 'utf8', 'utf-8'] as const) {
        const encoded = Buffer.from(text, 'utf-8').toString(encoding);
        expect(B.from(text, 'utf-8').toString(encoding)).toBe(encoded);
        expect(B.from(encoded, encoding).toString('utf-8')).toBe(text);
      }
      expect(B.from(text).subarray(0, 7).toString('utf8')).toBe(Buffer.from(text).subarray(0, 7).toString('utf8'));
    }
    expect(B.concat([B.from('ab'), B.from('cd')]).toString()).toBe('abcd');
    expect(B.from('0aff', 'hex')).toHaveLength(2);
  });

  it('validates AFF metadata against the schemas embedded in the bundle', () => {
    expect(bundle.validateAffHeader('CLAS', { description: 'Test', originalLanguage: 'en' })).toEqual({ valid: true });
    const invalid = bundle.validateAffHeader('CLAS', { description: 42 });
    expect(invalid.valid).toBe(false);
  });
});
