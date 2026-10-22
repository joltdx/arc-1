import { defineConfig } from 'vitest/config';
import { viteNodeShims } from './scripts/browser/node-shims.mjs';

// Re-runs the unit suite with the browser stand-ins from scripts/browser/node-shims.mjs swapped in
// for shared src/ code. Upstream drift (a new call shape a stand-in lacks) fails here instead of in
// a user's browser. Exclusions are by scope, never to hide a stand-in gap.

/** Node-only code the browser runtime never loads (plan §2 non-goals). */
const OUT_OF_SCOPE_FILES = [
  'tests/unit/adt/oauth.test.ts', // browser OAuth/PKCE (base64url, not in the crypto stand-in)
  'tests/unit/server/multi-target-basic-auth.test.ts', // multi-target
  'tests/unit/server/multi-target-shared-auth-state.test.ts', // multi-target
  'tests/unit/server/http-request-body.test.ts', // Node HTTP server
  'tests/unit/server/http-default-transport.test.ts', // Node HTTP server
  'tests/unit/server/shutdown.test.ts', // process signals
  'tests/unit/cli/runtime.test.ts', // CLI subprocess
];

/**
 * Tests that run tool calls concurrently on purpose. The browser runtime serializes tool calls, and
 * the async_hooks stand-in throws on overlapping runs, so these fail by design.
 */
const CONCURRENT_TOOL_CALL_TESTS = [
  'shares a FIFO process-wide lease, leaves source reads independent, and holds it through terminal audit',
  'classifies an expired admission wait and releases the two active slots',
  'admits at most two full analyses across independent clients',
];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default defineConfig({
  plugins: [viteNodeShims()],
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/unit/browser/*.shimtest.ts'],
    exclude: OUT_OF_SCOPE_FILES,
    testNamePattern: new RegExp(`^(?!.*(?:${CONCURRENT_TOOL_CALL_TESTS.map(escapeRegExp).join('|')})).*$`, 's'),
    testTimeout: 10000,
    isolate: true,
    setupFiles: ['tests/helpers/supertest-loopback.ts'],
  },
});
