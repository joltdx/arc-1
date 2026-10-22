#!/usr/bin/env node
/**
 * Build the browser runtime bundle (`arc-1/browser`): src/browser/index.ts → dist/browser/index.js plus
 * chunks/, ESM for a module Web Worker. See docs/plans/2026-10-20-browser-embedded-runtime.md.
 *
 * - `splitting`: without it, esbuild evaluates the targets of dynamic `import()` lazily, and the zod
 *   modules they reach are then never initialized for the MCP SDK, which imports zod through `export *`
 *   re-exports ("Class2 is not a constructor" at load).
 * - `keepNames`: abaplint registers its syntax handlers by class name; minified names collide.
 *
 *   node scripts/browser/build.mjs [--outdir dist/browser] [--no-minify] [--sourcemap]
 */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { browserBuildOptions } from './node-shims.mjs';

const root = resolve(import.meta.dirname, '..', '..');

/**
 * esbuild options for the browser bundle; shared with the bundle check and tests.
 * @returns {import('esbuild').BuildOptions & { outdir: string }}
 */
export function browserBundleOptions({ outdir = join(root, 'dist', 'browser'), minify = true, sourcemap = false } = {}) {
  return {
    ...browserBuildOptions(),
    absWorkingDir: root,
    entryPoints: { index: 'src/browser/index.ts' },
    outdir,
    bundle: true,
    format: 'esm',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    target: 'es2022',
    minify,
    keepNames: true,
    sourcemap,
    metafile: true,
    legalComments: 'linked',
    logLevel: 'warning',
  };
}

/** Total JavaScript bytes of a build (entry and chunks): what a worker downloads. */
export function bundleBytes(metafile) {
  return Object.entries(metafile.outputs)
    .filter(([file]) => file.endsWith('.js'))
    .reduce((sum, [, output]) => sum + output.bytes, 0);
}

async function main() {
  const { values } = parseArgs({
    options: {
      outdir: { type: 'string' },
      'no-minify': { type: 'boolean', default: false },
      sourcemap: { type: 'boolean', default: false },
    },
  });
  const options = browserBundleOptions({
    outdir: values.outdir ? resolve(values.outdir) : undefined,
    minify: !values['no-minify'],
    sourcemap: values.sourcemap,
  });
  const result = await build(options);
  console.log(`${options.outdir}: ${(bundleBytes(result.metafile) / 1024).toFixed(0)} KiB of JavaScript`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main();
}
