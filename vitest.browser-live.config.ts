import { defineConfig } from 'vitest/config';

// Live browser runtime suite: headless Chromium + a real SAP system (docs/plans/2026-10-20-browser-embedded-runtime.md).
export default defineConfig({
  test: {
    include: ['tests/browser-live/**/*.test.ts'],
    // Bundle build and browser start happen once in beforeAll.
    hookTimeout: 180000,
    testTimeout: 60000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
