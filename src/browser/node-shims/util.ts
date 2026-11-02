/**
 * Browser-bundle stand-in for `node:util` (see scripts/browser/node-shims.mjs).
 * - `TextDecoder` is the browser's own, for src/adt/source-plugin-parser.ts.
 * - `promisify` is for src/adt/stored-text/decoder.ts, which promisifies zlib at module load, so this must not
 *   throw there; the returned function throws when called (stored text is not in browser v1).
 */
export const TextDecoder = globalThis.TextDecoder;

export function promisify(original: (...args: never[]) => unknown): (...args: unknown[]) => Promise<never> {
  const name = original.name || 'function';
  return () => Promise.reject(new Error(`node:util browser shim: promisified ${name}() is not supported`));
}
