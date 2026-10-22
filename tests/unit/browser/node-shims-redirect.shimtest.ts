/**
 * Runs only under vitest.browser-shims.config.ts. If a redirect silently stopped working, every
 * other test in that run would pass against the real Node module and prove nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const readFileSync = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  readFileSync.mockImplementation(actual.readFileSync);
  return { ...actual, readFileSync };
});

import { sleepWithinRequestBudget } from '../../../src/adt/http-deadline.js';
import { sourceHash } from '../../../src/adt/source-precondition.js';
import { assembleChunks } from '../../../src/adt/stored-text/chunks.js';
import { resetValidatorCache, validateAffHeader } from '../../../src/aff/validator.js';
import { requestContext } from '../../../src/server/context.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('browser node-shims redirect', () => {
  it('routes node:crypto in src/ to the browser stand-in', () => {
    // Node throws ERR_INVALID_ARG_TYPE here; only the stand-in names itself.
    expect(() => sourceHash(42 as unknown as string)).toThrow(/node:crypto browser shim/);
    expect(sourceHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('routes node:async_hooks in src/ to the browser stand-in', () => {
    // Node supports enterWith; only the stand-in refuses it.
    expect(() => requestContext.enterWith({ requestId: 'REQ-guard' })).toThrow(/node:async_hooks browser shim/);
    expect(requestContext.run({ requestId: 'REQ-guard' }, () => requestContext.getStore()?.requestId)).toBe(
      'REQ-guard',
    );
  });

  it('routes node:timers/promises in src/ to the browser stand-in', async () => {
    // Node's timers/promises uses internal timers; only the stand-in goes through globalThis.setTimeout.
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await sleepWithinRequestBudget(1);
    expect(spy).toHaveBeenCalled();
  });

  it('routes node:sea/url/path in the AFF validator to the embedded schemas', () => {
    resetValidatorCache();
    expect(validateAffHeader('INTF', { description: 42 }).valid).toBe(false);
    // Without the redirect, the validator reads src/aff/schemas/intf-v1.json from disk.
    expect(readFileSync.mock.calls.some(([path]) => String(path).includes('aff'))).toBe(false);
  });

  it('gives shared source the buffer package as Buffer', () => {
    const key = { TDOBJECT: 'TEXT', TDNAME: 'Z_GUARD', TDID: 'ST', TDSPRAS: 'E' };
    const row = { ...key, MANDT: '001', RELID: 'TX', SRTF2: '0 ', CLUSTR: '2 ', CLUSTD: '0aff'.padEnd(15804, '0') };
    const bytes = assembleChunks([row], key, '001');
    // Node's own Buffer would pass this check; the injected package's Buffer is a different class.
    expect(Buffer.isBuffer(bytes)).toBe(false);
    expect([...bytes]).toEqual([0x0a, 0xff]);
  });
});
