/**
 * Runs only under vitest.browser-shims.config.ts. If the redirect silently stopped working, every
 * other test in that run would pass against real node:crypto and prove nothing.
 */
import { describe, expect, it } from 'vitest';
import { sourceHash } from '../../../src/adt/source-precondition.js';

describe('browser node-shims redirect', () => {
  it('routes node:crypto in src/ to the browser stand-in', () => {
    // Node throws ERR_INVALID_ARG_TYPE here; only the stand-in names itself.
    expect(() => sourceHash(42 as unknown as string)).toThrow(/node:crypto browser shim/);
  });

  it('still hashes like Node', () => {
    expect(sourceHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
