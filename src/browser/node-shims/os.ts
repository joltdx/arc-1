/**
 * Browser-bundle stand-in for `node:os`, scoped to src/server/deny-actions.ts (see
 * scripts/browser/node-shims.mjs): `~` expansion for deny-action files, which the browser never reads.
 */
export function homedir(): never {
  throw new Error('node:os browser shim: homedir() is not supported (deny-action files are Node-only)');
}
