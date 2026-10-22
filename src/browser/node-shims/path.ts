/**
 * Browser stand-in for `node:path` (POSIX `dirname`/`join` only), scoped to src/aff/validator.ts (see
 * scripts/browser/node-shims.mjs), where it only builds the unused schema file path. Bundle-only for
 * deny-actions.ts, whose path branch is unreachable: everything else throws.
 */
export function dirname(path: string): string {
  const index = path.replace(/\/+$/, '').lastIndexOf('/');
  return index <= 0 ? (path.startsWith('/') ? '/' : '.') : path.slice(0, index);
}

export function join(...segments: string[]): string {
  return segments
    .filter(Boolean)
    .join('/')
    .replace(/\/{2,}/g, '/');
}

export function resolve(): never {
  throw new Error('node:path browser shim: resolve() is not supported (file paths are Node-only)');
}
