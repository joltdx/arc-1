/**
 * Browser-bundle stand-in for `undici`. The browser runtime sends through `AdtHttpConfig.browserFetch`
 * and refuses the options (proxy, custom TLS) that build undici dispatchers, so nothing here should be
 * reached. Each export throws instead of pulling the Node HTTP stack into the bundle.
 *
 * Bundle-only (see scripts/browser/node-shims.mjs): the shimmed unit-test run keeps the real undici
 * because the Node HTTP tests mock it.
 */

class UnsupportedShimError extends Error {
  constructor(what: string) {
    super(`undici browser shim: ${what} is not supported (use AdtHttpConfig.browserFetch)`);
    this.name = 'UnsupportedShimError';
  }
}

export class Agent {
  constructor() {
    throw new UnsupportedShimError('Agent');
  }
}

export class Client {
  constructor() {
    throw new UnsupportedShimError('Client');
  }
}

export function fetch(): never {
  throw new UnsupportedShimError('fetch()');
}

export function getGlobalDispatcher(): never {
  throw new UnsupportedShimError('getGlobalDispatcher()');
}
