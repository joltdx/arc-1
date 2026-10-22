/**
 * Node built-ins that the browser build replaces with stand-ins under src/browser/node-shims/.
 *
 * Single source for every consumer: the browser bundle (esbuild) and the shimmed unit-test run
 * (vitest.browser-shims.config.ts), so the tests exercise exactly what the bundle ships.
 * Only shared code is redirected; the stand-ins themselves and test files keep the real module.
 */
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcDir = join(root, 'src') + sep;
const shimDir = join(root, 'src', 'browser', 'node-shims') + sep;

/** Built-in specifier → stand-in source file. */
export const NODE_SHIMS = {
  'node:async_hooks': join(shimDir, 'async-hooks.ts'),
  'node:crypto': join(shimDir, 'crypto.ts'),
  'node:timers/promises': join(shimDir, 'timers-promises.ts'),
};

/** True when `importer` is shared source whose Node built-ins the browser build replaces. */
export function shouldRedirect(importer) {
  if (!importer) return false;
  const file = resolve(importer.split('?')[0]);
  return file.startsWith(srcDir) && !file.startsWith(shimDir);
}

/** esbuild plugin for the browser bundle. */
export function esbuildNodeShims() {
  const filter = new RegExp(`^(${Object.keys(NODE_SHIMS).join('|')})$`);
  return {
    name: 'arc1-node-shims',
    setup(build) {
      build.onResolve({ filter }, (args) =>
        shouldRedirect(args.importer) ? { path: NODE_SHIMS[args.path] } : undefined,
      );
    },
  };
}

/**
 * Vite/vitest plugin for the shimmed unit-test run. Vite externalizes `node:` built-ins before any
 * plugin's resolveId runs, so this rewrites the specifier of import/export statements (static and
 * dynamic) in shared source instead. Other string literals are left alone.
 */
export function viteNodeShims() {
  const specifiers = Object.keys(NODE_SHIMS).join('|');
  const pattern = new RegExp(`(\\bfrom\\s*|\\bimport\\s*\\(?\\s*)(['"])(${specifiers})\\2`, 'g');
  return {
    name: 'arc1-node-shims',
    enforce: 'pre',
    transform(code, id) {
      if (!shouldRedirect(id)) return null;
      let changed = false;
      const out = code.replace(pattern, (_match, lead, quote, spec) => {
        changed = true;
        return `${lead}${quote}${NODE_SHIMS[spec]}${quote}`;
      });
      return changed ? { code: out, map: null } : null;
    },
  };
}
