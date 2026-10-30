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
  'tests/unit/handlers/pinned-write-isolation.test.ts', // multi-target, overlapping tool calls on purpose
  'tests/unit/server/http-request-body.test.ts', // Node HTTP server
  'tests/unit/server/http-default-transport.test.ts', // Node HTTP server
  'tests/unit/server/shutdown.test.ts', // process signals
  'tests/unit/cli/runtime.test.ts', // CLI subprocess
  // Cloud Connector PP transport pool (decodes the bearer JWT expiry with 'base64url')
  'tests/unit/server/per-user-transport.test.ts',
  'tests/unit/server/http-pp-transport.test.ts',
  // Node single-executable asset path, tested by mocking node:sea; the browser replaces that module
  // (its own tests: tests/unit/browser/node-shims-*.test.ts, http-bundle.test.ts).
  'tests/unit/aff/validator-sea.test.ts',
  // Stored text is not in browser v1 (needs zlib's consumed-byte count); these also compare Node Buffers.
  'tests/unit/spikes/stxl*.test.ts',
];

/** Individual tests on paths the browser runtime does not have; each fails loudly there by design. */
const OUT_OF_SCOPE_TESTS = [
  // Concurrent tool calls: the browser runtime serializes them, and the async_hooks stand-in throws on overlap.
  'shares a FIFO process-wide lease, leaves source reads independent, and holds it through terminal audit',
  'classifies an expired admission wait and releases the two active slots',
  'admits at most two full analyses across independent clients',
  // Bearer JWT decoding ('base64url', unknown to the buffer package): browserFetch refuses bearer auth.
  'getEffectiveUser derives the user from the bearer JWT user_name when no SAP_USER',
  'getEffectiveUser retries after a transient token-provider failure',
];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default defineConfig({
  plugins: [viteNodeShims()],
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/unit/browser/*.shimtest.ts'],
    exclude: OUT_OF_SCOPE_FILES,
    testNamePattern: new RegExp(`^(?!.*(?:${OUT_OF_SCOPE_TESTS.map(escapeRegExp).join('|')})).*$`, 's'),
    testTimeout: 10000,
    isolate: true,
    setupFiles: ['tests/helpers/supertest-loopback.ts'],
  },
});
