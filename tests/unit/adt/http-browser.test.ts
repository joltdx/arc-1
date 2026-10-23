import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestAttemptBudget } from '../../../src/adt/request-attempt-budget.js';
import { requestContext } from '../../../src/server/context.js';
import { mockResponse } from '../../helpers/mock-fetch.js';

const undiciFetch = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: undiciFetch,
}));
const { AdtHttpClient } = await import('../../../src/adt/http.js');
const { AdtApiError } = await import('../../../src/adt/errors.js');
const { BrowserSessionEndedError } = await import('../../../src/adt/http-browser.js');

const browserFetch = vi.fn<typeof fetch>();
const config = { baseUrl: 'https://sap.example.com', client: '001', browserFetch };
const closePath = '/sap/bc/adt/core/http/sessions';

function call(index: number) {
  const [url, init] = browserFetch.mock.calls[index]!;
  const parsed = new URL(String(url));
  return { path: parsed.pathname, url: parsed, init: init!, headers: init!.headers as Record<string, string> };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('AdtHttpClient browserFetch transport', () => {
  beforeEach(() => {
    browserFetch.mockReset();
    undiciFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses options that need Node transport or explicit credentials', () => {
    for (const option of [
      { btpProxy: { host: 'proxy', port: 20003, protocol: 'http' } },
      { insecure: true },
      { gzipDataPreviewBody: true },
      { cookies: { MYSAPSSO2: 'x' } },
      { cookieFile: '/tmp/cookies.txt' },
      { cookieString: 'a=b' },
      { username: 'u', password: 'p' },
      { bearerTokenProvider: async () => 't' },
      { samlAuthorization: 'SAML2.0 x' },
      { sapConnectivityAuth: 'x' },
      { ppProxyAuth: 'x' },
    ]) {
      expect(() => new AdtHttpClient({ ...config, ...option } as never)).toThrow(/browserFetch cannot be combined/);
    }
    // Empty values are what config plumbing passes when the option is unset.
    expect(() => new AdtHttpClient({ ...config, cookies: {}, username: '', insecure: false })).not.toThrow();
  });

  it('sends same-origin requests on the browser session without Cookie, User-Agent or session header', async () => {
    browserFetch.mockResolvedValueOnce(mockResponse(200, 'REPORT z.', { 'content-type': 'text/plain' }));
    const client = new AdtHttpClient(config);

    const response = await client.get('/sap/bc/adt/programs/programs/Z/source/main', { Accept: 'text/plain' });

    expect(response.body).toBe('REPORT z.');
    expect(undiciFetch).not.toHaveBeenCalled();
    const { url, init, headers } = call(0);
    expect(url.searchParams.get('sap-client')).toBe('001');
    expect(init.credentials).toBe('include');
    expect(init.redirect).toBe('manual');
    expect(headers.Accept).toBe('text/plain');
    expect(headers).not.toHaveProperty('Cookie');
    expect(headers).not.toHaveProperty('User-Agent');
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers).not.toHaveProperty('X-sap-adt-sessiontype');
  });

  it('forwards the caller trace context', async () => {
    browserFetch.mockResolvedValueOnce(mockResponse(200, ''));
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    await requestContext.run({ requestId: 'REQ-1', traceparent }, () =>
      new AdtHttpClient(config).get('/sap/bc/adt/core/discovery'),
    );
    expect(call(0).headers.traceparent).toBe(traceparent);
  });

  it('fetches a CSRF token and sends it on writes', async () => {
    browserFetch
      .mockResolvedValueOnce(mockResponse(200, '', { 'x-csrf-token': 'TOKEN' }))
      .mockResolvedValueOnce(mockResponse(200, 'ok'));
    const client = new AdtHttpClient(config);

    await client.post('/sap/bc/adt/programs/programs', '<xml/>', 'application/xml');

    expect(call(0).headers['X-CSRF-Token']).toBe('fetch');
    expect(call(1).init.method).toBe('POST');
    expect(call(1).headers['X-CSRF-Token']).toBe('TOKEN');
    expect(call(1).headers).not.toHaveProperty('Cookie');
  });

  describe('security-session gate (#1043) without a cookie jar', () => {
    it('sends the first cold request alone, then lets a warm client fan out', async () => {
      const first = deferred<Response>();
      browserFetch.mockReturnValueOnce(first.promise).mockResolvedValue(mockResponse(200, ''));
      const client = new AdtHttpClient(config);

      const cold = [client.get('/sap/bc/adt/a'), client.get('/sap/bc/adt/b')];
      await flush();
      expect(browserFetch).toHaveBeenCalledTimes(1);
      first.resolve(mockResponse(200, ''));
      await Promise.all(cold);
      expect(browserFetch).toHaveBeenCalledTimes(2);

      const slow = deferred<Response>();
      browserFetch.mockReturnValueOnce(slow.promise);
      const warm = [client.get('/sap/bc/adt/c'), client.get('/sap/bc/adt/d')];
      await flush();
      expect(browserFetch).toHaveBeenCalledTimes(4);
      slow.resolve(mockResponse(200, ''));
      await Promise.all(warm);
    });

    it('re-arms after a 401 resets the session', async () => {
      browserFetch
        .mockResolvedValueOnce(mockResponse(200, ''))
        .mockResolvedValueOnce(mockResponse(401, ''))
        .mockResolvedValueOnce(mockResponse(200, ''));
      const client = new AdtHttpClient(config);
      await client.get('/sap/bc/adt/warm');
      await client.get('/sap/bc/adt/unauthorized-then-retried');
      expect(browserFetch).toHaveBeenCalledTimes(3);

      // The retry succeeded, so the gate is open again; a fresh 401 reset closes it until one succeeds.
      browserFetch.mockResolvedValueOnce(mockResponse(401, '')).mockResolvedValueOnce(mockResponse(401, ''));
      await expect(client.get('/sap/bc/adt/expired')).rejects.toBeInstanceOf(AdtApiError);
      const first = deferred<Response>();
      browserFetch.mockReturnValueOnce(first.promise).mockResolvedValue(mockResponse(200, ''));
      const burst = [client.get('/sap/bc/adt/e'), client.get('/sap/bc/adt/f')];
      await flush();
      expect(browserFetch).toHaveBeenCalledTimes(6);
      first.resolve(mockResponse(200, ''));
      await Promise.all(burst);
      expect(browserFetch).toHaveBeenCalledTimes(7);
    });
  });

  describe('stateful sessions', () => {
    it('closes the context without the HttpOnly sap-contextid header', async () => {
      browserFetch.mockResolvedValue(mockResponse(200, '', { 'x-csrf-token': 'T' }));
      const client = new AdtHttpClient(config);

      await client.withStatefulSession(async (session) => {
        await session.post('/sap/bc/adt/programs/programs/Z', undefined, undefined, undefined);
      });

      const requests = browserFetch.mock.calls.map((_c, i) => call(i));
      const writes = requests.filter((r) => r.path !== closePath);
      expect(writes.every((r) => r.headers['X-sap-adt-sessiontype'] === 'stateful')).toBe(true);
      const close = requests.at(-1)!;
      expect(close.path).toBe(closePath);
      expect(close.headers['X-sap-adt-sessiontype']).toBe('stateless');
      expect(close.headers['sap-adt-purpose']).toBe('close-session');
      expect(close.headers).not.toHaveProperty('sap-contextid');
      expect(close.init.credentials).toBe('include');
    });

    it('sends no close when the session never went stateful', async () => {
      const client = new AdtHttpClient(config);
      await expect(
        client.withStatefulSession(async () => {
          throw new Error('validation failed before any request');
        }),
      ).rejects.toThrow('validation failed');
      expect(browserFetch).not.toHaveBeenCalled();
    });

    it('runs the whole session, close included, inside statefulWindow', async () => {
      const log: string[] = [];
      browserFetch.mockImplementation(async (url) => {
        log.push(new URL(String(url)).pathname);
        return mockResponse(200, '', { 'x-csrf-token': 'T' });
      });
      const statefulWindow = async <T>(run: () => Promise<T>): Promise<T> => {
        log.push('enter');
        try {
          return await run();
        } finally {
          log.push('leave');
        }
      };
      const client = new AdtHttpClient({ ...config, statefulWindow });

      const result = await client.withStatefulSession(async (session) => {
        await session.post('/sap/bc/adt/programs/programs/Z', undefined, undefined, undefined);
        return 'done';
      });

      expect(result).toBe('done');
      expect(log[0]).toBe('enter');
      expect(log.slice(-2)).toEqual([closePath, 'leave']);
      // Reads outside a session do not enter the window.
      await client.get('/sap/bc/adt/programs/programs/Z');
      expect(log.at(-1)).toBe('/sap/bc/adt/programs/programs/Z');
    });
  });

  describe('session end (spike test 9: 400 text/html after logoff)', () => {
    const expired = () => mockResponse(400, '<html>Session timed out</html>', { 'content-type': 'text/html' });
    const html401 = () => mockResponse(401, '<html>Logon Error Message</html>', { 'content-type': 'text/html' });
    const source = '/sap/bc/adt/programs/programs/Z/source/main';

    it('retries once and recovers when the browser logs on again silently', async () => {
      browserFetch
        .mockResolvedValueOnce(expired())
        .mockResolvedValueOnce(mockResponse(200, 'REPORT z.', { 'content-type': 'text/plain' }));
      const response = await new AdtHttpClient(config).get(source);
      expect(response.body).toBe('REPORT z.');
      expect(browserFetch).toHaveBeenCalledTimes(2);
    });

    it('raises BrowserSessionEndedError (401) when the session stays gone', async () => {
      for (const ended of [expired, html401]) {
        browserFetch.mockReset();
        browserFetch.mockImplementation(async () => ended());
        const error = await new AdtHttpClient(config).get(source).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(BrowserSessionEndedError);
        expect(error).toMatchObject({ statusCode: 401, path: source });
        expect((error as Error).message).toMatch(
          /no longer logged on to SAP in this browser \(SAP answered HTTP 40[01] with an HTML page\)/,
        );
        expect(browserFetch).toHaveBeenCalledTimes(2);
      }
    });

    it('treats a redirect (an SSO IdP on another origin) as a session end after one retry', async () => {
      const opaque = () =>
        ({ ...mockResponse(200, ''), status: 0, ok: false, type: 'opaqueredirect', body: null }) as unknown as Response;
      browserFetch.mockImplementation(async () => opaque());
      const error = await new AdtHttpClient(config).get(source).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(BrowserSessionEndedError);
      expect((error as Error).message).toContain('SAP answered with a redirect to a logon page');
      expect(browserFetch).toHaveBeenCalledTimes(2);
      expect(call(1).init.redirect).toBe('manual');
    });

    it('stateless CSRF fetch: a redirect is a session end, not a missing token', async () => {
      browserFetch.mockImplementation(
        async () =>
          ({
            ...mockResponse(200, ''),
            status: 0,
            ok: false,
            type: 'opaqueredirect',
            body: null,
          }) as unknown as Response,
      );
      await expect(new AdtHttpClient(config).fetchCsrfToken()).rejects.toBeInstanceOf(BrowserSessionEndedError);
    });

    it('treats a logon page as a session end', async () => {
      browserFetch.mockImplementation(async () =>
        mockResponse(200, '<html><form action="/sap/bc/ui2/login">sap-user</form></html>', {
          'content-type': 'text/html',
        }),
      );
      await expect(new AdtHttpClient(config).get(source)).rejects.toBeInstanceOf(BrowserSessionEndedError);
    });

    it('refetches the CSRF token on the write retry', async () => {
      browserFetch
        .mockResolvedValueOnce(mockResponse(200, '', { 'x-csrf-token': 'OLD' }))
        .mockResolvedValueOnce(expired())
        .mockResolvedValueOnce(mockResponse(200, '', { 'x-csrf-token': 'NEW' }))
        .mockResolvedValueOnce(mockResponse(200, 'ok'));
      await new AdtHttpClient(config).post('/sap/bc/adt/programs/programs', '<xml/>', 'application/xml');
      expect(call(3).init.method).toBe('POST');
      expect(call(3).headers['X-CSRF-Token']).toBe('NEW');
    });

    it('stateless CSRF fetch: HEAD and GET, then the session error instead of a CSRF failure', async () => {
      browserFetch.mockImplementation(async () => expired());
      const client = new AdtHttpClient(config);
      await expect(client.fetchCsrfToken()).rejects.toBeInstanceOf(BrowserSessionEndedError);
      expect(browserFetch.mock.calls.map((_c, i) => call(i).init.method)).toEqual(['HEAD', 'GET']);
    });

    it('stateful CSRF fetch keeps the #1046 headerless GET and adds no retry of its own', async () => {
      browserFetch.mockImplementation(async () => expired());
      const client = new AdtHttpClient({ ...config, sessionType: 'stateful' });
      await expect(client.fetchCsrfToken()).rejects.toBeInstanceOf(BrowserSessionEndedError);
      const sessionHeaders = browserFetch.mock.calls.map((_c, i) => call(i).headers['X-sap-adt-sessiontype']);
      expect(sessionHeaders).toEqual(['stateful', 'stateful', undefined]);
    });

    it('leaves ADT errors alone: a 400 with an XML body is not retried', async () => {
      browserFetch.mockResolvedValue(
        mockResponse(400, '<exc:exception><message>bad</message></exc:exception>', {
          'content-type': 'application/xml',
        }),
      );
      const error = await new AdtHttpClient(config).get(source).catch((err: unknown) => err);
      expect(error).not.toBeInstanceOf(BrowserSessionEndedError);
      expect(error).toMatchObject({ statusCode: 400 });
      expect(browserFetch).toHaveBeenCalledTimes(1);
    });

    it('does not change the Node transport: a 400 HTML page stays a single 400', async () => {
      undiciFetch.mockResolvedValue(expired());
      const client = new AdtHttpClient({ baseUrl: 'https://sap.example.com', username: 'u', password: 'p' });
      const error = await client.get(source).catch((err: unknown) => err);
      expect(error).not.toBeInstanceOf(BrowserSessionEndedError);
      expect(error).toMatchObject({ statusCode: 400 });
      expect(undiciFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('attempt budget', () => {
    it('charges one attempt per fetch and refuses redirects', async () => {
      browserFetch.mockResolvedValue(mockResponse(200, ''));
      const client = new AdtHttpClient(config);
      const attemptBudget = new RequestAttemptBudget(1);

      await client.get('/sap/bc/adt/a', undefined, { attemptBudget });
      expect(call(0).init.redirect).toBe('manual');
      await expect(client.get('/sap/bc/adt/b', undefined, { attemptBudget })).rejects.toThrow(/attempt limit \(1\)/);
      expect(browserFetch).toHaveBeenCalledTimes(1);
    });

    it('treats an opaque manual redirect like a 3xx', async () => {
      const opaque = { ...mockResponse(200, ''), status: 0, ok: false, type: 'opaqueredirect', body: null };
      browserFetch.mockResolvedValueOnce(opaque as unknown as Response);
      const client = new AdtHttpClient(config);
      await expect(
        client.get('/sap/bc/adt/a', undefined, { attemptBudget: new RequestAttemptBudget(3) }),
      ).rejects.toThrow('Redirects are not allowed during bounded SAP analysis.');
    });
  });
});
