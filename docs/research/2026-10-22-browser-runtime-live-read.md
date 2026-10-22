# Browser runtime: live read-only test (Phase 4)

**Plan:** [browser-embedded runtime](../plans/2026-10-20-browser-embedded-runtime.md), Phase 4
**Earlier evidence:** [browser ADT session spike](2026-10-21-browser-adt-session-spike.md) (Phase 1)
**Tooling:** `npm run test:browser-live` (`tests/browser-live/browser-runtime.live.test.ts`), `npm run dev:browser`
(`scripts/browser/dev-server.mjs` + `scripts/browser/harness/`)
**Status:** read path verified on system A (7.31) and system B (7.57), including spike test 9 on system B.

## Setup

| Item | Value |
| --- | --- |
| Build | `feat/browser-runtime` at `249f2d00` plus the uncommitted Phase 4 changes; minified bundle, 4,209,036 bytes |
| Browser | Playwright `chromium-headless-shell` 156.0.8078.4 (`playwright-core` 1.64.0), headless, WSL2 |
| Runtime | Module Web Worker loading the bundle; MCP JSON-RPC over a `MessagePort` |
| Backend side | Unmodified MCP SDK `Client` (Node) whose transport relays each message through the page, the shape of the host's relay transport |
| SAP systems | System A of the spike: SAP_BASIS 7.31 behind an Apache reverse proxy, HTTPS. System B: SAP_BASIS 7.57, HTTPS; logon order Entra ID (OIDC) redirect first, then Basic |
| Route | Local dev server: page, worker and bundle on `http://127.0.0.1:<port>`, `/sap/*` proxied to the system. Same origin as seen by the browser |
| Logon | The browser context logs on once before the runtime starts (one Basic-authenticated request, as the host app's logon would have done) and answers later Basic challenges (Playwright `httpCredentials`). SAP sets session cookies on the local origin. The runtime never sees credentials |
| Config | `{ client: <TEST_SAP_CLIENT> }`, user from `SAP_USER`; otherwise browser defaults (read-only) |

## Method

Each read runs twice: through the browser runtime, and through Node ARC-1 (`handleToolCall` with the same resolved
config, Basic auth, features probed the same way). The test requires the same `isError` and the same text. A
system gap therefore shows up as parity, not as a browser failure.

## Results: system A (7.31)

| Check | Result |
| --- | --- |
| `initialize` + `tools/list` over the relay | `arc-1`, read-only tool list (no `SAPWrite`) |
| Feature probe | Completes, then `tools/list_changed`. About 1.5 s after `initialize` |
| `SAPRead PROG RSHOWTIM`, `CLAS CL_ABAP_CHAR_UTILITIES` | OK, identical to Node |
| `SAPSearch CL_ABAP_CHAR*` | OK, identical to Node |
| `SAPNavigate references PROG RSHOWTIM` | OK, identical to Node |
| `SAPRead SYSTEM` | **Error in both**: 404 on `/sap/bc/adt/core/discovery`, which 7.31 does not have (spike: same) |
| `SAPNavigate references TABL BAPIRET2` | **Error in both**: 404 "No suitable resource found" on `/ddic/structures/BAPIRET2` |
| Audit events | `tool_call_start` carries the host user and `clientId: arc-1-browser` |
| Requests | All same-origin; none sent `X-sap-adt-sessiontype: stateless` |
| Session cookies cleared mid-session | Next call succeeds: the browser answered SAP's 401 with its cached credentials before the runtime saw it |
| No logon at all | Tool error "SAP session ended: the user is no longer logged on to SAP in this browser (SAP answered HTTP 401 with an HTML page)" plus a hint to log on again in the browser. No `SAP_USER`/`SAP_PASSWORD` advice, no SAP HTML in the message |

Timings on this setup (localhost bundle, so download time is not representative): worker ready (bundle loaded,
server created) 280–360 ms, `initialize` 30–46 ms. Whole suite about 9 s.

## Results: system B (7.57)

The first run failed 5 of 9; both causes are fixed, and the suite now passes 9/9.

| Check | Result |
| --- | --- |
| `initialize` + `tools/list`, feature probe | OK; probe about 1.2 s after `initialize` |
| `SAPRead SYSTEM` | OK, identical to Node (7.57 has `/core/discovery`) |
| `SAPRead PROG RSHOWTIM`, `CLAS CL_ABAP_CHAR_UTILITIES`, `SAPSearch`, `SAPNavigate references PROG RSHOWTIM` | OK, identical to Node |
| Audit events, same-origin, no `stateless` header | As on system A |
| Session cookies cleared mid-session | Next call succeeds: see "Logon order on system B" |
| No logon at all | Session-ended error with the logon hint |

Timings: worker ready 260–410 ms, `initialize` 20–38 ms, suite about 9 s. References for `TABL BAPIRET2` were
dropped from the suite: the where-used search on this system takes longer than 60 s.

### Failures of the first run

1. **Every ADT request was "ADT network error: Failed to fetch".** Without a session, system B answers ADT with
   a 302 to `login.microsoftonline.com`. `fetch` followed it, and the cross-origin IdP response failed CORS: an
   opaque network error, which ARC-1 does not retry and cannot tell from a dead network. Node passed because it
   sends Basic credentials with every request. Fix: the browser transport always uses `redirect: 'manual'`, and
   `browserSessionEnded()` treats the resulting status 0 as SAP's logon layer (retry once, then
   `BrowserSessionEndedError`).
2. **Session cookies were dropped, then "CSRF token validation failed" (403).** System B sets its cookies with
   `SameSite=None`; the dev proxy removed `Secure` for the plain-HTTP local origin, and Chromium rejects
   `SameSite=None` without `Secure`. Fix in `scripts/browser/dev-server.mjs`: drop `SameSite=None` too on plain
   HTTP (the default, Lax, covers same-origin requests). Not a runtime issue: an HTTPS host origin keeps both.

Also: the logon by the browser's own Basic challenge only worked by chance (an OData probe was the first path to
challenge), so the suite now logs the browser context on explicitly before the runtime starts.

### Logon order on system B

Traced request by request (no credentials in the browser's requests after the logon):

1. No session: `302` to the Entra ID authorize endpoint, setting `OIDCTokenRequested`.
2. The runtime's one retry carries `OIDCTokenRequested`; SAP then falls back to Basic: `401` with
   `WWW-Authenticate: Basic`.
3. A browser that holds the user's Basic credentials answers that challenge without a prompt, and SAP sets a new
   session (`systeminformation` reports the same user). A browser without them gets the session-ended error.

So on this system the retry is what makes a silent re-logon possible, and it needs the manual redirect: with a
followed redirect, step 1 already ends the call as a network error.

### Spike test 9 (manual, Edge)

Through `npm run dev:browser` against system B: logged on with the Basic challenge, called a tool, logged off in
another tab, called the tool again. Result: **silent success**, no credentials dialog. The response sequence of
that call was not recorded.

## Session-end handling (added in this phase)

- `browserSessionEnded()` (`src/adt/http-browser.ts`), browser transport only: a 401, a redirect (status 0 with
  `redirect: 'manual'`), a logon page, or a 400 with an HTML body is SAP's logon layer, not ADT (ADT answers
  errors as XML).
- `request()` retries such a response once through the existing 401 path (CSRF refetch for writes). On 7.57 this
  retry is what silently logs on again (spike test 9). If it persists, `BrowserSessionEndedError` (a 401
  `AdtApiError`) is raised, also from the CSRF fetch, after the #1046 headerless GET, which gets no extra retry.
- `dispatch.ts` turns it into the hint "Ask the user to log on to SAP again in this browser (for example by
  reloading the app), then retry."
- The Node transport is unchanged (unit test: a 400 HTML page stays a single 400).

## Gaps

- Spike test 9 covers a read on system B only; the write variant (stale CSRF token after a re-logon) comes with
  Phase 5's live CRUD. Which logon-layer response the manual run hit (400 HTML, redirect or 401) was not recorded.
- A completed IdP (OIDC/SAML) logon through the dev proxy is not possible: the IdP calls back to the real SAP
  host, not the proxy origin. Only the redirect itself is covered (now a session-ended error, not a network error).
- A redirect during bounded analysis (attempt budget) still reports "Redirects are not allowed during bounded SAP
  analysis", not the session-ended error.
- 8.16 not covered.
- The relay transport of the host platform is outside this repo; the test's relay only shows the shape works with
  an unmodified SDK client.
