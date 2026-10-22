/**
 * Browser-bundle stand-in for `node:fs`, scoped to files whose reads are Node-only config paths (cookie
 * files, deny-action files, abaplint config files, AFF schema files; see scripts/browser/node-shims.mjs).
 * The browser runtime never configures a file, so reading one is never reached.
 */
export function readFileSync(): never {
  throw new Error('node:fs browser shim: readFileSync() is not supported (file-based config is Node-only)');
}
