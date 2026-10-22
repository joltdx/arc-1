/**
 * Node modules and globals that the browser build replaces with stand-ins under src/browser/.
 *
 * Single source for every consumer: the browser bundle (esbuild) and the shimmed unit-test run
 * (vitest.browser-shims.config.ts), so the tests exercise exactly what the bundle ships.
 * See docs/plans/2026-10-20-browser-embedded-runtime.md §4.2.
 */
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcDir = join(root, 'src') + sep;
const browserDir = join(root, 'src', 'browser') + sep;
const shim = (file) => join(browserDir, 'node-shims', file);

/** Injected into the browser bundle for free `Buffer` / `process` references. */
export const BROWSER_GLOBALS = join(browserDir, 'globals.ts');

const VALIDATOR = 'src/aff/validator.ts';

/**
 * Redirect rules, first match wins. A rule applies to shared source (src/, outside src/browser/) unless
 * `importers` names the files it is limited to (which may be dependencies in node_modules/).
 * `bundleOnly` rules use stand-ins that throw: the code paths are unreachable with the browser config, and
 * their unit tests need the real module, so the shimmed test run keeps it. Scoping a rule to its importers
 * means a new use of the module elsewhere still fails the bundle until it is handled.
 */
export const SHIM_RULES = [
  // Drop-in replacements, active in the bundle and the shimmed test run.
  { specifier: 'node:async_hooks', shim: shim('async-hooks.ts') },
  { specifier: 'node:crypto', shim: shim('crypto.ts') },
  { specifier: 'node:timers/promises', shim: shim('timers-promises.ts') },
  // AFF schemas embedded in the bundle, the way the single-executable build embeds them.
  { specifier: 'node:sea', shim: shim('sea.ts'), importers: [VALIDATOR] },
  { specifier: 'node:url', shim: shim('url.ts'), importers: [VALIDATOR] },
  { specifier: 'node:path', shim: shim('path.ts'), importers: [VALIDATOR] },
  // Unreachable with the browser config.
  { specifier: 'undici', shim: shim('undici.ts'), bundleOnly: true },
  {
    specifier: 'node:fs',
    shim: shim('fs.ts'),
    bundleOnly: true,
    importers: ['src/adt/cookies.ts', 'src/lint/config-builder.ts', 'src/server/deny-actions.ts', VALIDATOR],
  },
  { specifier: 'node:os', shim: shim('os.ts'), bundleOnly: true, importers: ['src/server/deny-actions.ts'] },
  { specifier: 'node:path', shim: shim('path.ts'), bundleOnly: true, importers: ['src/server/deny-actions.ts'] },
  {
    specifier: 'node:zlib',
    shim: shim('zlib.ts'),
    bundleOnly: true,
    importers: ['src/adt/http-wire-body.ts', 'src/adt/stored-text/decoder.ts'],
  },
  { specifier: 'node:util', shim: shim('util.ts'), bundleOnly: true, importers: ['src/adt/stored-text/decoder.ts'] },
  { specifier: 'node:net', shim: shim('net.ts'), bundleOnly: true, importers: ['src/adt/abapgit.ts'] },
  // Dependencies that require bare `crypto`: abaplint's downport rule (sha1), and rate-limiter-flexible's
  // cluster limiter (randomBytes, never used: ARC-1 uses RateLimiterMemory).
  {
    specifier: 'crypto',
    shim: shim('crypto.ts'),
    bundleOnly: true,
    importers: [
      'node_modules/@abaplint/core/build/src/rules/downport.js',
      'node_modules/rate-limiter-flexible/lib/RateLimiterCluster.js',
    ],
  },
];

const toRelative = (file) => relative(root, resolve(file.split('?')[0])).split(sep).join('/');

/** True for shared source whose Node imports the browser build replaces by default. */
export function isSharedSource(file) {
  if (!file) return false;
  const path = resolve(file.split('?')[0]);
  return path.startsWith(srcDir) && !path.startsWith(browserDir);
}

function findRule(rules, specifier, importer) {
  if (!importer) return undefined;
  return rules.find(
    (rule) =>
      rule.specifier === specifier &&
      (rule.importers ? rule.importers.includes(toRelative(importer)) : isSharedSource(importer)),
  );
}

/** esbuild plugin for the browser bundle (use with `browserBuildOptions()` for the globals). */
export function esbuildNodeShims() {
  const specifiers = [...new Set(SHIM_RULES.map((rule) => rule.specifier))];
  const filter = new RegExp(`^(${specifiers.map((s) => s.replace(/[/]/g, '\\/')).join('|')})$`);
  return {
    name: 'arc1-node-shims',
    setup(build) {
      build.onResolve({ filter }, (args) => {
        const rule = findRule(SHIM_RULES, args.path, args.importer);
        return rule ? { path: rule.shim } : undefined;
      });
    },
  };
}

/**
 * esbuild options shared by every browser build: target, redirects and injected globals.
 * @returns {{ platform: 'browser', plugins: import('esbuild').Plugin[], inject: string[] }}
 */
export function browserBuildOptions() {
  return { platform: 'browser', plugins: [esbuildNodeShims()], inject: [BROWSER_GLOBALS] };
}

/**
 * Vite/vitest plugin for the shimmed unit-test run.
 * - Vite externalizes `node:` built-ins before any plugin's resolveId runs, so this rewrites the
 *   specifiers of import/export statements (static and dynamic) in shared source instead.
 * - It imports the `buffer` package as `Buffer` into shared source that uses it, like the bundle's
 *   injection. `process` stays Node's: tests set environment variables that shared code reads.
 */
export function viteNodeShims() {
  const rules = SHIM_RULES.filter((rule) => !rule.bundleOnly);
  const specifiers = [...new Set(rules.map((rule) => rule.specifier))].join('|');
  const pattern = new RegExp(`(\\bfrom\\s*|\\bimport\\s*\\(?\\s*)(['"])(${specifiers})\\2`, 'g');
  const bufferPackage = createRequire(import.meta.url).resolve('buffer/');
  return {
    name: 'arc1-node-shims',
    enforce: 'pre',
    transform(code, id) {
      if (!isSharedSource(id)) return null;
      let changed = false;
      let out = code.replace(pattern, (match, lead, quote, specifier) => {
        const rule = findRule(rules, specifier, id);
        if (!rule) return match;
        changed = true;
        return `${lead}${quote}${rule.shim}${quote}`;
      });
      if (/\bBuffer\b/.test(out) && !/\bimport\b[^;]*\bBuffer\b[^;]*\bfrom\b/.test(out)) {
        out = `import { Buffer } from ${JSON.stringify(bufferPackage)};\n${out}`;
        changed = true;
      }
      return changed ? { code: out, map: null } : null;
    },
  };
}
