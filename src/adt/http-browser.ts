/**
 * Browser runtime transport for AdtHttpClient (`AdtHttpConfig.browserFetch`): same-origin fetch on the
 * user's own SAP session. See docs/plans/2026-10-20-browser-embedded-runtime.md.
 */

import { getCurrentContext } from '../server/context.js';
import { traceHeaders } from '../server/trace-context.js';
import { AdtApiError } from './errors.js';
import type { AdtHttpConfig } from './http.js';
import { type AdtRequestOptions, requestSignal } from './http-deadline.js';

/**
 * The user's SAP logon in this browser has ended (or never existed). Only a new logon in the browser helps,
 * which the runtime cannot do itself: it holds no credentials. A 401 for every existing auth-error path.
 */
export class BrowserSessionEndedError extends AdtApiError {
  constructor(path: string, observed: string) {
    const message = `SAP session ended: the user is no longer logged on to SAP in this browser (SAP answered ${observed}).`;
    super(message, 401, path, undefined, { plainText: true });
    this.name = 'BrowserSessionEndedError';
  }
}

/**
 * Browser transport only: the session-ended error when SAP answered from its logon layer instead of ADT, else
 * undefined. That is a 401, a redirect (status 0, see sendBrowserRequest; an SSO system redirects to its IdP),
 * a logon page, or the HTML "session timed out" page that 7.57 answers with 400 after a logoff; ADT reports its
 * own errors as XML. `request()` retries once first: the retry
 * logs on again silently while the browser still holds the user's credentials (spike test 9).
 */
export function browserSessionEnded(
  config: Pick<AdtHttpConfig, 'browserFetch'>,
  path: string,
  response: { status: number; headers: Headers },
  loginPage = false,
): BrowserSessionEndedError | undefined {
  if (!config.browserFetch) return undefined;
  if (loginPage) return new BrowserSessionEndedError(path, `HTTP ${response.status} with a logon page`);
  if (response.status === 0) return new BrowserSessionEndedError(path, 'with a redirect to a logon page');
  const contentType = response.headers.get('content-type')?.toLowerCase();
  const isHtml = !!contentType?.startsWith('text/html');
  if (response.status !== 401 && !(response.status === 400 && isHtml)) return undefined;
  return new BrowserSessionEndedError(path, `HTTP ${response.status}${isHtml ? ' with an HTML page' : ''}`);
}

/** Options that need Node transport or explicit credentials, which the browser session replaces. */
const BROWSER_INCOMPATIBLE_OPTIONS = [
  'btpProxy',
  'insecure',
  'gzipDataPreviewBody',
  'cookies',
  'cookieFile',
  'cookieString',
  'username',
  'password',
  'bearerTokenProvider',
  'samlAuthorization',
  'sapConnectivityAuth',
  'ppProxyAuth',
] as const satisfies readonly (keyof AdtHttpConfig)[];

export function assertBrowserCompatible(config: AdtHttpConfig): void {
  const conflicting = BROWSER_INCOMPATIBLE_OPTIONS.filter((key) => {
    const value = config[key];
    if (value === undefined || value === false || value === '') return false;
    return !(typeof value === 'object' && Object.keys(value).length === 0);
  });
  if (conflicting.length > 0) {
    throw new Error(`browserFetch cannot be combined with: ${conflicting.join(', ')}.`);
  }
}

/** One attempt-budget charge per fetch; the browser attaches its own cookies and User-Agent. */
export async function sendBrowserRequest(
  browserFetch: typeof fetch,
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string | Buffer,
  options?: AdtRequestOptions,
): Promise<Response> {
  const outbound: Record<string, string> = { ...headers, ...traceHeaders(getCurrentContext()) };
  // A script-set Cookie header is forbidden in browsers and silently dropped; never send one.
  delete outbound.Cookie;
  options?.attemptBudget?.consume();
  return browserFetch(url, {
    method,
    headers: outbound,
    body,
    signal: requestSignal(options),
    credentials: 'include',
    // ADT redirects only to a logon page. Followed, a redirect to an IdP on another origin fails as an opaque
    // network error (CORS) and every redirect is an uncounted send; manual reports it as status 0 instead.
    redirect: 'manual',
  });
}
