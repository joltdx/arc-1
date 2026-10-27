#!/usr/bin/env node
/**
 * CI guard for the browser runtime bundle (docs/plans/2026-10-20-browser-embedded-runtime.md).
 *
 * - The bundle builds: a Node built-in without a stand-in fails esbuild's browser resolution.
 * - No Node-only package is bundled (undici, express, SQLite, BTP auth), and the output has no imports left.
 * - host.js (the page-side helper) bundles project source only, no package code, within HOST_BUDGET_BYTES.
 * - The minified JavaScript (entry and chunks) stays within BUDGET_BYTES. The check also fails when it drops below
 *   STALE_RATIO of the budget, so a shrink lowers the budget in the same change (Playbook §5).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { browserBundleOptions, browserHostOptions, bundleBytes } from '../browser/build.mjs';

export const BUDGET_BYTES = 4_500_000;
export const HOST_BUDGET_BYTES = 5_200;
const STALE_RATIO = 0.9;

/** Packages that must never reach the browser bundle. */
export const FORBIDDEN_PACKAGES = [
  'undici',
  'express',
  'better-sqlite3',
  '@arc-mcp/xsuaa-auth',
  'jose',
  'dotenv',
  'commander',
];

/** Package name of a node_modules path, or undefined for project source. */
function packageOf(input) {
  const parts = input.split('node_modules/');
  if (parts.length < 2) return undefined;
  const segments = parts.at(-1).split('/');
  return segments[0].startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
}

/** Violations for the host helper: no package code at all (the page loads it next to the host's own scripts). */
export function checkHost(metafile, bytes, budget = HOST_BUDGET_BYTES) {
  const violations = [...new Set(Object.keys(metafile.inputs).map(packageOf).filter(Boolean))].map(
    (pkg) => `host.js bundles package code: ${pkg}`,
  );
  for (const [file, output] of Object.entries(metafile.outputs)) {
    for (const entry of output.imports ?? []) violations.push(`${file} keeps an import of '${entry.path}'`);
  }
  if (bytes > budget) violations.push(`host.js is ${bytes} bytes, over the ${budget}-byte budget`);
  else if (bytes < budget * STALE_RATIO) {
    violations.push(`host.js is ${bytes} bytes, under ${STALE_RATIO * 100}% of the ${budget}-byte budget: lower HOST_BUDGET_BYTES`);
  }
  return violations;
}

/** Returns the list of violations for an esbuild metafile and the bundle's byte size. */
export function checkBundle(metafile, bytes, budget = BUDGET_BYTES) {
  const violations = [];
  const bundled = new Set(Object.keys(metafile.inputs).map(packageOf).filter(Boolean));
  for (const pkg of FORBIDDEN_PACKAGES) {
    if (bundled.has(pkg)) violations.push(`forbidden package bundled: ${pkg}`);
  }
  for (const [file, output] of Object.entries(metafile.outputs)) {
    for (const entry of output.imports ?? []) {
      if (entry.external) violations.push(`${file} keeps an import of '${entry.path}'`);
    }
  }
  if (bytes > budget) {
    violations.push(`bundle is ${bytes} bytes, over the ${budget}-byte budget`);
  } else if (bytes < budget * STALE_RATIO) {
    violations.push(
      `bundle is ${bytes} bytes, under ${STALE_RATIO * 100}% of the ${budget}-byte budget: lower BUDGET_BYTES`,
    );
  }
  return violations;
}

async function main() {
  const outdir = mkdtempSync(join(tmpdir(), 'arc1-browser-bundle-'));
  try {
    const result = await build(browserBundleOptions({ outdir }));
    const bytes = bundleBytes(result.metafile);
    const host = await build(browserHostOptions({ outdir }));
    const hostBytes = bundleBytes(host.metafile);
    const violations = [...checkBundle(result.metafile, bytes), ...checkHost(host.metafile, hostBytes)];
    if (violations.length > 0) {
      for (const violation of violations) console.error(`✗ browser bundle: ${violation}`);
      process.exit(1);
    }
    console.log(`✓ browser bundle: ${bytes} bytes (budget ${BUDGET_BYTES}), no Node-only packages.`);
    console.log(`✓ host.js: ${hostBytes} bytes (budget ${HOST_BUDGET_BYTES}), no package code.`);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  await main();
}
