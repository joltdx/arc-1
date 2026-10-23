import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rewriteLocation, rewriteSetCookie, startDevServer } from '../../../scripts/browser/dev-server.mjs';

describe('dev-server rewrites', () => {
  it('drops Domain, and Secure and SameSite=None only on a plain-HTTP local origin', () => {
    const cookie = 'sap-contextid=abc; path=/sap/bc/adt; domain=sap.example.com; secure; HttpOnly; SameSite=None';
    expect(rewriteSetCookie(cookie, { secure: false })).toBe('sap-contextid=abc; path=/sap/bc/adt; HttpOnly');
    expect(rewriteSetCookie('a=b; path=/; SameSite=Strict', { secure: false })).toBe('a=b; path=/; SameSite=Strict');
    expect(rewriteSetCookie(cookie, { secure: true })).toBe(
      'sap-contextid=abc; path=/sap/bc/adt; secure; HttpOnly; SameSite=None',
    );
  });

  it('maps only redirects to the SAP origin back onto the local origin', () => {
    expect(
      rewriteLocation('https://sap.example.com/sap/bc/ui2/login', 'https://sap.example.com', 'http://127.0.0.1:1'),
    ).toBe('http://127.0.0.1:1/sap/bc/ui2/login');
    expect(rewriteLocation('https://idp.example.com/saml', 'https://sap.example.com', 'http://127.0.0.1:1')).toBe(
      'https://idp.example.com/saml',
    );
  });
});

describe('startDevServer', () => {
  let upstream: Server;
  let upstreamUrl: string;
  let seen: { url?: string; headers?: IncomingHttpHeaders; body?: string } = {};
  let bundleDir: string;
  let dev: { url: string; close(): Promise<void> };

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        seen = { url: req.url, headers: req.headers, body };
        res.writeHead(302, {
          'set-cookie': [`SAP_SESSIONID_X_100=s; path=/; domain=127.0.0.1; secure; HttpOnly`],
          location: `${upstreamUrl}/sap/bc/adt/discovery`,
          'x-csrf-token': 'TOKEN',
        });
        res.end('moved');
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    bundleDir = mkdtempSync(join(tmpdir(), 'arc1-dev-server-test-'));
    writeFileSync(join(bundleDir, 'index.js'), 'export const ok = true;');
    dev = await startDevServer({ target: upstreamUrl, bundleDir });
  });

  afterAll(async () => {
    await dev?.close();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
  });

  it('proxies /sap/* with method, body and query, presenting the request as same-origin to SAP', async () => {
    const response = await fetch(`${dev.url}/sap/bc/adt/programs/programs?sap-client=100`, {
      method: 'POST',
      body: '<xml/>',
      headers: { origin: dev.url, 'x-csrf-token': 'fetch' },
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
    expect(seen.url).toBe('/sap/bc/adt/programs/programs?sap-client=100');
    expect(seen.body).toBe('<xml/>');
    expect(seen.headers?.origin).toBe(upstreamUrl);
    expect(seen.headers?.['x-csrf-token']).toBe('fetch');
    expect(response.headers.get('x-csrf-token')).toBe('TOKEN');
    expect(response.headers.get('location')).toBe(`${dev.url}/sap/bc/adt/discovery`);
    expect(response.headers.getSetCookie()).toEqual(['SAP_SESSIONID_X_100=s; path=/; HttpOnly']);
  });

  it('serves the harness and the bundle', async () => {
    expect(await (await fetch(`${dev.url}/`)).text()).toContain('ARC-1 browser harness');
    const page = await fetch(`${dev.url}/harness/harness.js`);
    expect(page.headers.get('content-type')).toMatch(/text\/javascript/);
    expect(page.headers.get('access-control-allow-origin')).toBeNull();
    const bundle = await fetch(`${dev.url}/bundle/index.js`);
    expect(await bundle.text()).toBe('export const ok = true;');
    expect(bundle.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('serves nothing outside the harness and bundle directories', async () => {
    const status = (path: string) =>
      new Promise<number>((resolve, reject) => {
        request(`${dev.url}${path}`, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
          .on('error', reject)
          .end();
      });
    expect(await status('/bundle/../package.json')).toBe(404);
    expect(await status('/bundle/%2e%2e/%2e%2e/package.json')).toBe(404);
    expect(await status('/harness/..%2f..%2f..%2fpackage.json')).toBe(404);
    expect(await status('/package.json')).toBe(404);
  });

  it('holds a proxied request until the test releases it, and drops it on rejection', async () => {
    let release!: () => void;
    let drop!: () => void;
    const held = await startDevServer({
      target: upstreamUrl,
      bundleDir,
      holdRequest: (req) =>
        req.method !== 'PUT'
          ? undefined
          : new Promise<void>((resolve, reject) => {
              if (req.url?.includes('keep')) release = resolve;
              else drop = () => reject(new Error('dropped'));
            }),
    });
    try {
      seen = {};
      const kept = fetch(`${held.url}/sap/keep`, { method: 'PUT', body: 'x', redirect: 'manual' });
      await vi.waitFor(() => expect(release).toBeDefined());
      expect(seen.url).toBeUndefined();
      release();
      expect((await kept).status).toBe(302);
      expect(seen).toMatchObject({ url: '/sap/keep', body: 'x' });

      const dropped = fetch(`${held.url}/sap/drop`, { method: 'PUT', body: 'y', redirect: 'manual' });
      await vi.waitFor(() => expect(drop).toBeDefined());
      drop();
      await expect(dropped).rejects.toThrow();
      expect(seen.url).toBe('/sap/keep');
    } finally {
      await held.close();
    }
  });
});
