import { defineConfig } from 'vitest/config';
import { viteNodeShims } from './scripts/browser/node-shims.mjs';

// Re-runs the unit tests of shared modules that import a shimmed Node built-in, with the browser
// stand-ins from scripts/browser/node-shims.mjs swapped in. Upstream drift (a new call shape the
// stand-in lacks) fails here instead of in a user's browser. Extend `include` with each new shim.
export default defineConfig({
  plugins: [viteNodeShims()],
  test: {
    include: [
      // Guard: proves the redirect is active for src/ in this run.
      'tests/unit/browser/node-shims-redirect.shimtest.ts',
      // node:crypto
      'tests/unit/adt/data-source-name.test.ts',
      'tests/unit/adt/data-source-policy*.test.ts',
      'tests/unit/adt/diagnostics.test.ts',
      'tests/unit/adt/dump-filters.test.ts',
      'tests/unit/adt/internal-data-operations.test.ts',
      'tests/unit/cache/memory.test.ts',
      'tests/unit/handlers/context-cache-freshness.test.ts',
      'tests/unit/spikes/stxl*.test.ts',
    ],
    testTimeout: 10000,
    isolate: true,
  },
});
