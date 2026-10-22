/**
 * Browser-bundle stand-in for `node:util`, scoped to src/adt/stored-text/decoder.ts (see
 * scripts/browser/node-shims.mjs). The decoder promisifies zlib at module load, so this must not throw
 * there; the returned function throws when called (stored text is not in browser v1).
 */
export function promisify(original: (...args: never[]) => unknown): (...args: unknown[]) => Promise<never> {
  const name = original.name || 'function';
  return () => Promise.reject(new Error(`node:util browser shim: promisified ${name}() is not supported`));
}
