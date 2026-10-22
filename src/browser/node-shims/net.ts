/**
 * Browser-bundle stand-in for `node:net`, scoped to src/adt/abapgit.ts (see scripts/browser/node-shims.mjs).
 * abapGit is out of scope for the browser runtime; its host check is not re-implemented here.
 */
export function isIP(): never {
  throw new Error('node:net browser shim: isIP() is not supported (abapGit is not in the browser runtime)');
}
