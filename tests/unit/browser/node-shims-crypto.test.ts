import * as nodeCrypto from 'node:crypto';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { esbuildNodeShims } from '../../../scripts/browser/node-shims.mjs';
import { createHash, randomBytes } from '../../../src/browser/node-shims/crypto.js';

const nodeSha256 = (data: string | Uint8Array) => nodeCrypto.createHash('sha256').update(data).digest('hex');

describe('node:crypto browser stand-in', () => {
  it.each([
    ['empty', ''],
    ['ascii', 'REPORT zfoo.\nWRITE / 1.\n'],
    ['non-ascii', 'Grüße – ÄÖÜ ß € 𝄞 日本語'],
    ['lone surrogate', 'a\uD800b'],
    ['long', 'x'.repeat(100_000)],
  ])('matches Node sha256 hex for %s strings', (_name, text) => {
    expect(createHash('sha256').update(text).digest('hex')).toBe(nodeSha256(text));
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(nodeSha256(text));
  });

  it('matches Node for bytes, including a Buffer, and for chained updates', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(nodeSha256(bytes));
    expect(createHash('sha256').update(Buffer.from('abc')).digest('hex')).toBe(nodeSha256('abc'));
    expect(createHash('sha256').update('ab').update('c').digest('hex')).toBe(nodeSha256('abc'));
  });

  it('refuses call shapes it does not implement', () => {
    expect(() => createHash('md5')).toThrow(/createHash\('md5'\) is not supported/);
    expect(() => createHash('sha256').update('a', 'latin1' as 'utf8')).toThrow(/input encoding 'latin1'/);
    expect(() => createHash('sha256').update(42 as unknown as string)).toThrow(/non-string/);
    expect(() => createHash('sha256').digest('base64' as 'hex')).toThrow(/digest\('base64'\)/);
    const used = createHash('sha256');
    used.digest('hex');
    expect(() => used.update('a')).toThrow(/after digest/);
    expect(() => used.digest('hex')).toThrow(/twice/);
  });

  it('returns random bytes that render as hex', () => {
    const bytes = randomBytes(8);
    expect(bytes).toHaveLength(8);
    expect(bytes.toString('hex')).toMatch(/^[0-9a-f]{16}$/);
    expect(randomBytes(8).toString('hex')).not.toBe(bytes.toString('hex'));
    expect(() => bytes.toString('base64' as 'hex')).toThrow(/not supported/);
  });
});

describe('esbuild browser redirect', () => {
  it('bundles a hashing module for the browser without node:crypto and keeps its output', async () => {
    const result = await build({
      entryPoints: ['src/adt/source-precondition.ts'],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
      plugins: [esbuildNodeShims()],
    });
    const code = result.outputFiles[0].text;
    expect(code).not.toMatch(/["']node:/);

    const mod = (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)) as {
      sourceHash(source: string): string;
    };
    expect(mod.sourceHash('Grüße')).toBe(nodeSha256('Grüße'));
  });
});
