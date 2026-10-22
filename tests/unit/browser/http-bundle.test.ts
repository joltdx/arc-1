import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { esbuildNodeShims } from '../../../scripts/browser/node-shims.mjs';

/**
 * Node globals still referenced in the browser bundle of the HTTP layer, per source file. Nothing imports
 * them, so neither the redirect map nor esbuild can catch them. Ratchet: a new reference fails, and so
 * does an entry that is gone (shrink this list in the same change). Plan §4.3, "Node globals".
 */
const KNOWN_NODE_GLOBALS: Record<string, string[]> = {
  'src/adt/http.ts': ['Buffer', 'process'], // Basic auth (refused with browserFetch); ARC1_LOG_HTTP_DEBUG
  'src/server/logger.ts': ['process'], // stderr (Phase 2.8)
  'src/server/sinks/stderr.ts': ['process'], // stderr (Phase 2.8)
};

const NODE_GLOBAL = /\b(Buffer|process|__dirname|__filename|require)\b(?=\s*[.(])/g;

async function bundle(entry: string) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    plugins: [esbuildNodeShims()],
  });
  return result.outputFiles[0].text;
}

/** esbuild marks each inlined module with a `// path` comment in unminified output. */
function nodeGlobalsBySource(code: string): Record<string, string[]> {
  const found: Record<string, Set<string>> = {};
  let source = '';
  for (const line of code.split('\n')) {
    const marker = line.match(/^\/\/ ((?:src|node_modules)\/\S+)$/);
    if (marker) {
      source = marker[1];
      continue;
    }
    if (!source.startsWith('src/') || /^\s*(\/\/|\*)/.test(line)) continue;
    for (const [, name] of line.matchAll(NODE_GLOBAL)) (found[source] ??= new Set()).add(name);
  }
  return Object.fromEntries(Object.entries(found).map(([file, names]) => [file, [...names].sort()]));
}

describe('browser bundle of the ADT HTTP layer', () => {
  it('resolves without Node built-ins or undici and only references known Node globals', async () => {
    const code = await bundle('src/adt/http.ts');
    expect(code).not.toMatch(/from\s*["'](node:|undici)/);
    expect(nodeGlobalsBySource(code)).toEqual(KNOWN_NODE_GLOBALS);
  });
});
