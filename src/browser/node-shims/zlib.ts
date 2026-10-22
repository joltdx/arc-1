/**
 * Browser-bundle stand-in for `node:zlib`, scoped (see scripts/browser/node-shims.mjs) to:
 * - src/adt/http-wire-body.ts: WAF gzip (`gzipDataPreviewBody`) is refused with `browserFetch`.
 * - src/adt/stored-text/decoder.ts: stored text is not in browser v1. It needs the number of compressed
 *   bytes inflate consumed, which the browser's DecompressionStream does not report.
 */
export function gzipSync(): never {
  throw new Error('node:zlib browser shim: gzipSync() is not supported (gzipDataPreviewBody is Node-only)');
}

export function inflateRaw(): never {
  throw new Error('node:zlib browser shim: inflateRaw() is not supported (stored text is not in browser v1)');
}
