/**
 * Browser stand-in for the `node:async_hooks` subset that shared ARC-1 code uses.
 *
 * Supported: `new AsyncLocalStorage()`, `run(store, fn)` and `getStore()`. Browsers have no async
 * context propagation, so this keeps ONE active store per instance: `run()` sets it and restores the
 * previous one when `fn` (or the promise it returns) settles. That equals Node's behavior only while
 * runs are strictly nested, which holds because the browser runtime serializes tool calls. A run
 * that settles while another is still active means calls overlapped; it throws instead of letting
 * one call read another's context (request id, cancellation signal, data budget).
 *
 * Not equal to Node: work a run starts but does not await sees whatever store is active when it
 * eventually reads it, not the store of the run that started it.
 */

class UnsupportedShimError extends Error {
  constructor(what: string) {
    super(`node:async_hooks browser shim: ${what} is not supported`);
    this.name = 'UnsupportedShimError';
  }
}

interface Frame<T> {
  store: T;
}

export class AsyncLocalStorage<T> {
  private readonly stack: Frame<T>[] = [];

  getStore(): T | undefined {
    return this.stack.at(-1)?.store;
  }

  run<R>(store: T, callback: () => R): R {
    const frame: Frame<T> = { store };
    this.stack.push(frame);
    const leave = () => {
      if (this.stack.at(-1) !== frame) {
        this.stack.length = 0;
        throw new UnsupportedShimError(
          'overlapping AsyncLocalStorage.run() calls (browser tool calls must be serialized)',
        );
      }
      this.stack.pop();
    };
    let result: R;
    try {
      result = callback();
    } catch (error) {
      leave();
      throw error;
    }
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          leave();
          return value;
        },
        (error) => {
          leave();
          throw error;
        },
      ) as R;
    }
    leave();
    return result;
  }

  enterWith(_store: T): void {
    throw new UnsupportedShimError('AsyncLocalStorage.enterWith()');
  }

  exit<R>(_callback: () => R): R {
    throw new UnsupportedShimError('AsyncLocalStorage.exit()');
  }

  disable(): void {
    throw new UnsupportedShimError('AsyncLocalStorage.disable()');
  }
}
