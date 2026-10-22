#!/usr/bin/env node
/**
 * Local single-origin setup for the browser runtime (plan §7): serves the harness page and the browser bundle,
 * and proxies `/sap/*` to an SAP system, so the page, its worker and ADT share one origin as they do when the
 * host app is served from the ABAP system. Log on once through the proxy (the browser's own logon prompt);
 * the SAP session cookies then belong to the local origin. Credentials never pass through this script.
 *
 *   npm run build:browser && node scripts/browser/dev-server.mjs   # SAP_URL / SAP_INSECURE from .env
 *   node scripts/browser/dev-server.mjs --target https://sap.example.com --port 5173 [--bundle dir] [--insecure]
 *
 * Used by the live browser suite (tests/browser-live/), which starts it on a free port.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '..', '..');
const HARNESS_DIR = join(import.meta.dirname, 'harness');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** Request headers that describe the local hop, not the SAP one. */
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade']);

/**
 * Rewrite a `Set-Cookie` for the local origin: no `Domain` (the cookie belongs to the local host), and on a
 * plain-HTTP local origin no `Secure` and no `SameSite=None` (browsers reject `SameSite=None` without `Secure`;
 * the default, Lax, covers same-origin requests). Path and HttpOnly stay as SAP sent them.
 */
export function rewriteSetCookie(cookie, { secure }) {
  return cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => !/^domain=/i.test(part) && (secure || !/^(secure|samesite=none)$/i.test(part)))
    .join('; ');
}

/** Map an absolute redirect to the SAP origin back onto the local origin; anything else is unchanged. */
export function rewriteLocation(location, targetOrigin, localOrigin) {
  return location.startsWith(targetOrigin) ? localOrigin + location.slice(targetOrigin.length) : location;
}

function serveFile(res, dir, relativePath) {
  const file = normalize(join(dir, relativePath));
  if (!(file === dir || file.startsWith(dir + sep)) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

function proxy(req, res, target, localOrigin, insecure) {
  const upstream = new URL(req.url, target);
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_HEADERS.has(name)) headers[name] = value;
  }
  // SAP compares Origin with its own host for some services; present the request as same-origin there too.
  if (headers.origin) headers.origin = target.origin;
  if (typeof headers.referer === 'string') headers.referer = rewriteLocation(headers.referer, localOrigin, target.origin);
  const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
  const outbound = send(
    upstream,
    { method: req.method, headers, ...(insecure ? { rejectUnauthorized: false } : {}) },
    (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers };
      const setCookie = upstreamRes.headers['set-cookie'];
      if (setCookie) {
        responseHeaders['set-cookie'] = setCookie.map((c) => rewriteSetCookie(c, { secure: localOrigin.startsWith('https:') }));
      }
      if (upstreamRes.headers.location) {
        responseHeaders.location = rewriteLocation(upstreamRes.headers.location, target.origin, localOrigin);
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
    },
  );
  outbound.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`dev-server proxy error: ${err.message}`);
  });
  req.pipe(outbound);
}

/**
 * Start the dev server. `/` and `/harness/*` serve the harness, `/bundle/*` the browser bundle and `/sap/*` is
 * proxied to `target`.
 * @param {{ target: string, port?: number, host?: string, bundleDir?: string, insecure?: boolean }} options
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function startDevServer({ target, port = 0, host = '127.0.0.1', bundleDir, insecure = false }) {
  const targetUrl = new URL(target);
  const bundle = resolve(bundleDir ?? join(root, 'dist', 'browser'));
  let localOrigin = '';
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    if (path === '/sap' || path.startsWith('/sap/')) return proxy(req, res, targetUrl, localOrigin, insecure);
    if (path === '/') return serveFile(res, HARNESS_DIR, 'index.html');
    if (path.startsWith('/harness/')) return serveFile(res, HARNESS_DIR, decodeURIComponent(path.slice(9)));
    if (path.startsWith('/bundle/')) return serveFile(res, bundle, decodeURIComponent(path.slice(8)));
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  localOrigin = `http://${host}:${address.port}`;
  return {
    url: localOrigin,
    close: () =>
      new Promise((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}

async function main() {
  const { config } = await import('dotenv');
  config({ quiet: true });
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      port: { type: 'string', default: '5173' },
      bundle: { type: 'string' },
      insecure: { type: 'boolean', default: false },
    },
  });
  const target = values.target ?? process.env.TEST_SAP_URL ?? process.env.SAP_URL;
  if (!target) throw new Error('Set --target, TEST_SAP_URL or SAP_URL.');
  const insecure = values.insecure || (process.env.TEST_SAP_INSECURE ?? process.env.SAP_INSECURE) === 'true';
  const bundleDir = values.bundle ? resolve(values.bundle) : undefined;
  if (!existsSync(join(bundleDir ?? join(root, 'dist', 'browser'), 'index.js'))) {
    throw new Error('No browser bundle found: run `npm run build:browser` first.');
  }
  const { url } = await startDevServer({ target, port: Number(values.port), bundleDir, insecure });
  console.log(`ARC-1 browser harness: ${url}  (proxying /sap/* to ${new URL(target).origin})`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main();
}
