/**
 * Browser stand-in for the `node:timers/promises` subset that shared ARC-1 code uses.
 *
 * Supported: `setTimeout(delay, value?, { signal? })`. Like Node, an aborted signal rejects with an
 * `AbortError` whose `cause` is the signal's reason (callers check `signal.aborted` themselves).
 */

class UnsupportedShimError extends Error {
  constructor(what: string) {
    super(`node:timers/promises browser shim: ${what} is not supported`);
    this.name = 'UnsupportedShimError';
  }
}

function abortError(signal: AbortSignal): Error {
  return Object.assign(new Error('The operation was aborted', { cause: signal.reason }), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
}

export function setTimeout<T = void>(delay?: number, value?: T, options?: { signal?: AbortSignal }): Promise<T> {
  const unsupported = Object.keys(options ?? {}).filter((key) => key !== 'signal');
  if (unsupported.length > 0) throw new UnsupportedShimError(`setTimeout() option '${unsupported[0]}'`);
  const signal = options?.signal;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(abortError(signal as AbortSignal));
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(value as T);
    }, delay);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
