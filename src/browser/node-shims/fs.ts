/**
 * Browser-bundle stand-in for `node:fs`, scoped to src/adt/cookies.ts (see scripts/browser/node-shims.mjs).
 * Cookie files are a Node-only auth mode that `browserFetch` refuses, so reading one is never reached.
 */
export function readFileSync(): never {
  throw new Error('node:fs browser shim: readFileSync() is not supported (cookie files are Node-only)');
}
