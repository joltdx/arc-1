/**
 * Browser runtime transport for AdtHttpClient (`AdtHttpConfig.browserFetch`): same-origin fetch on the
 * user's own SAP session. See docs/plans/2026-10-20-browser-embedded-runtime.md.
 */

import { getCurrentContext } from '../server/context.js';
import { traceHeaders } from '../server/trace-context.js';
import type { AdtHttpConfig } from './http.js';
import { type AdtRequestOptions, requestSignal } from './http-deadline.js';

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
    // Automatic redirects would create uncounted sends outside the caller's allowance.
    ...(options?.attemptBudget ? { redirect: 'manual' as const } : {}),
  });
}
