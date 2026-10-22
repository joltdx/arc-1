/**
 * Browser stand-in for `node:url`, scoped to src/aff/validator.ts (see scripts/browser/node-shims.mjs).
 * The validator derives its schema directory from `import.meta.url` at module load. In a browser that is
 * an http(s) URL, or undefined in a non-ESM (classic worker) bundle; Node would throw on both. This returns
 * the URL path, or '' when there is none: the directory is only used for file reads, which the browser
 * replaces with embedded assets (see sea.ts).
 */
export function fileURLToPath(url: string | URL | undefined): string {
  if (!URL.canParse(String(url))) return '';
  return decodeURIComponent(new URL(String(url)).pathname);
}
