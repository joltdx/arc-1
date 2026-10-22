import * as nodeTimers from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from '../../../src/browser/node-shims/async-hooks.js';
import { setTimeout as sleep } from '../../../src/browser/node-shims/timers-promises.js';

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

describe('node:timers/promises browser stand-in', () => {
  it('resolves with the value after the delay', async () => {
    await expect(sleep(1, 'done')).resolves.toBe('done');
    await expect(sleep(0)).resolves.toBeUndefined();
  });

  it('rejects like Node when the signal is already aborted', async () => {
    const reason = new Error('stop');
    const signal = AbortSignal.abort(reason);
    const ours = await rejection(sleep(10, undefined, { signal }));
    const node = await rejection(nodeTimers.setTimeout(10, undefined, { signal }));
    expect(ours.name).toBe(node.name);
    expect((ours as Error & { code?: string }).code).toBe((node as Error & { code?: string }).code);
    expect(ours.cause).toBe(reason);
    expect(node.cause).toBe(reason);
  });

  it('rejects when the signal aborts during the wait', async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, undefined, { signal: controller.signal });
    controller.abort(new Error('later'));
    const error = await rejection(pending);
    expect(error.name).toBe('AbortError');
    expect((error.cause as Error).message).toBe('later');
  });

  it('refuses options it does not implement', () => {
    expect(() => sleep(1, undefined, { ref: false } as { signal?: AbortSignal })).toThrow(/option 'ref'/);
  });
});

describe('node:async_hooks browser stand-in', () => {
  it('scopes the store to sync and async runs and restores the outer store', async () => {
    const als = new AsyncLocalStorage<string>();
    expect(als.getStore()).toBeUndefined();
    expect(als.run('sync', () => als.getStore())).toBe('sync');
    expect(als.getStore()).toBeUndefined();

    const seen: Array<string | undefined> = [];
    await als.run('outer', async () => {
      seen.push(als.getStore());
      await sleep(1);
      seen.push(
        await als.run('inner', async () => {
          await sleep(1);
          return als.getStore();
        }),
      );
      seen.push(als.getStore());
    });
    expect(seen).toEqual(['outer', 'inner', 'outer']);
    expect(als.getStore()).toBeUndefined();
  });

  it('restores the store when the callback throws or rejects', async () => {
    const als = new AsyncLocalStorage<string>();
    expect(() =>
      als.run('x', () => {
        throw new Error('sync boom');
      }),
    ).toThrow('sync boom');
    await expect(
      als.run('y', async () => {
        throw new Error('async boom');
      }),
    ).rejects.toThrow('async boom');
    expect(als.getStore()).toBeUndefined();
  });

  it('fails both calls loudly when runs overlap instead of sharing a store', async () => {
    const als = new AsyncLocalStorage<string>();
    const first = als.run('first', () => sleep(5));
    const second = als.run('second', () => sleep(20));
    await expect(first).rejects.toThrow(/overlapping AsyncLocalStorage.run\(\) calls/);
    await expect(second).rejects.toThrow(/overlapping AsyncLocalStorage.run\(\) calls/);
    expect(als.getStore()).toBeUndefined();
  });

  it('refuses the APIs it does not implement', () => {
    const als = new AsyncLocalStorage<string>();
    expect(() => als.enterWith('x')).toThrow(/enterWith/);
    expect(() => als.exit(() => 1)).toThrow(/exit/);
    expect(() => als.disable()).toThrow(/disable/);
  });
});
