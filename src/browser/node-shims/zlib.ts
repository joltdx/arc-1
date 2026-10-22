/**
 * Browser-bundle stand-in for `node:zlib`, scoped to src/adt/http-wire-body.ts (see
 * scripts/browser/node-shims.mjs). WAF gzip (`gzipDataPreviewBody`) is refused with `browserFetch`.
 */
export function gzipSync(): never {
  throw new Error('node:zlib browser shim: gzipSync() is not supported (gzipDataPreviewBody is Node-only)');
}
