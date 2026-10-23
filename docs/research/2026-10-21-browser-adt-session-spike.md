# Browser ADT session spike (Phase 1)

**Plan:** [browser-embedded runtime](../plans/2026-10-20-browser-embedded-runtime.md), Phase 1
**Tooling:** [browser-adt-session-spike/](browser-adt-session-spike/) (`spike.js`, console-pasteable)
**Status:** Phase 1 complete (8.16 optional). **Go/no-go: GO** on 7.57 (system B) and 7.31 + `abapfs_extensions` (system A). The ADT stateful context is isolated from the host
app by cookie path, and browser writes work, under the constraints listed in "Implications" for system B.

## Systems

| System | SAP_BASIS | Route | Browser | Auth |
| --- | --- | --- | --- | --- |
| A | 7.31 (stated by the user; not detectable via ADT, see below) | HTTPS through an Apache reverse proxy (`server: Apache`) to ICM; host app (an ICF-based web platform) on the same origin | Edge 155 (Chromium), Windows | Browser SSO cookies (`MYSAPSSO2`, `SAP_SESSIONID_<SID>_<CLIENT>`); Node ARC-1 comparison with Basic auth |
| B | 757 (from `/system/components`) | HTTPS, same-origin; host app ICF service under `/sap/bc/http/…` | Edge 155 (Chromium), Windows | Browser session (SAP session cookies HttpOnly, not visible to JS); default client |

## System A (7.31)

### Works in the browser

- Same-origin `fetch` with `credentials: 'include'` reaches `/sap/bc/adt/*` using the SSO session. No extra setup.
- Legacy discovery `GET /sap/bc/adt/discovery` → 200 `application/atomsvc+xml`.
- CSRF: `/sap/bc/adt/core/discovery` is 404. The token comes from `GET /sap/bc/adt/discovery` with
  `X-CSRF-Token: fetch`, which is the same fallback as ARC-1 `fetchCsrfToken()`.
- Source read (`/programs/programs/<name>/source/main`) → 200 `text/plain`.
- Object create (`POST /programs/programs?_package=$TMP`) → 200.
- LOCK → 200 with a `LOCK_HANDLE`.
- Activation → 200.
- The host app's own page kept returning 200 before, during and after the ADT calls.

### Fails: the lock does not outlive the LOCK request

- The LOCK response has no `Set-Cookie`. No `sap-contextid` cookie exists afterwards (checked with DevTools and
  `cookieStore`).
- The next PUT (or DELETE) with the handle → **423 `ExceptionResourceInvalidLockHandle`** ("Resource INCLUDE … is
  not locked"). UNLOCK → 200, a no-op.
- **Node ARC-1 behaves identically** against the same host. Its `SAPWrite update` returns the same 423, after the
  same request sequence: legacy CSRF, LOCK 200 without `Set-Cookie`, PUT 423, UNLOCK 200.
- Cause: this is the known pre-7.51 limitation (`src/adt/release.ts`, issue #293). The ADT HTTP handler does not
  honor `X-sap-adt-sessiontype: stateful` below SAP_BASIS 7.51. The workaround is the community
  [`abapfs_extensions`](https://github.com/marcellourbani/abapfs_extensions) back-port.
- Eclipse ADT works on this system because SAP GUI-based projects use RFC, which keeps its own session. Its
  communication log shows no `X-sap-adt-sessiontype` and no `Set-Cookie`. It is **not** a valid comparison for
  HTTP behavior.

### Other observations

- Release detection fails: `/sap/bc/adt/system/components` and `/sap/bc/adt/abapsource/syntax/configurations` are
  both 404. ARC-1's pre-7.51 startup warning (`shouldWarnPreStatefulRelease`) therefore stays silent, and users
  only see the 423 hint at write time. This is a possible small upstream improvement.
- Close-session: `/sap/bc/adt/core/http/sessions` → 404, `HEAD /core/discovery` → 404, and
  `HEAD /sap/bc/adt/discovery` (extra, not in ARC-1) → 400. There is no close path, but with no stateful context
  there is nothing to close.
- `sap-contextid` is not visible to JS in any state tested. If it is HttpOnly on newer releases too, a browser
  runtime cannot send the `sap-contextid` header ARC-1 sets on its close request.
- Leftover object: `Z_ARC1_SPK_EMYFRD` ($TMP, empty, active). It cannot be deleted over HTTP on this system;
  delete it in SE38/SE80 or Eclipse.

### Re-run with `abapfs_extensions` installed (2026-10-22)

- Steps 1–4 again, same browser and route. **LOCK → PUT 200 → UNLOCK → activate → read back: the source
  matches.** Writes work in the browser on 7.31 once the 7.51 stateful handling is back-ported.
- The host app page returned 200 before, during and after the stateful window.
- Still no close endpoint: `/core/http/sessions` 404, `HEAD /core/discovery` 404, `HEAD /sap/bc/adt/discovery`
  400. Both 404s are ADT exception XML, so the ADT framework processed the requests, including their `stateless`
  header.
- **The close works anyway:** Hold lock → Put held (200) → Close session → Put held → **423**. The stateless
  request ends the context even when the resource is 404. The spike sends three close requests in a row (two as in
  ARC-1, plus the extra legacy HEAD), so this run does not isolate which one ended the context. 7.57's test 4b
  shows any stateless ADT request suffices, so the first (ARC-1's) most likely did.
  - **Corrected 2026-10-23** ([live write test](2026-10-23-browser-runtime-live-write.md#results-system-a-731)): it was the
    third one. On 7.31 a stateless request to a 404 path (`/core/http/sessions`, `/core/discovery`) leaves the
    context and its locks in place; a stateless request to an existing resource (`HEAD` or `GET
    /sap/bc/adt/discovery`) ends it and releases the locks at once. So ARC-1's own close does not end the context
    on these systems (Node and browser alike); its UNLOCK still releases the lock.
- `sap-contextid`: path `/sap/bc/adt`, **not HttpOnly** (7.57: HttpOnly). It is still invisible to a host page
  outside `/sap/bc/adt` (`document.cookie` only lists cookies whose path covers the page), so the runtime must
  not depend on reading it either way.
- Cleanup: `Z_ARC1_SPK_EMYFRD` deleted with **Delete test prog** (verified).

### Implications for the plan

- **This is not a browser limitation.** HTTP ADT writes need SAP_BASIS ≥ 7.51 or `abapfs_extensions`, for Node
  ARC-1 and the browser alike. Add it to §6 risk 2 (prerequisites). Reads work on 7.31.
- With `abapfs_extensions` installed, system A behaves like system B for writes, host-app isolation and close (see
  the re-run above).

## System B (7.57)

### Write lifecycle works in the browser

- Core discovery, components feed (`SAP_BASIS 757`), source read, CSRF from `/core/discovery` → all 200.
- Create → stateful LOCK → PUT → UNLOCK → close-session → activate → read back: all 200. The active source
  matches what was PUT.
- **Host app isolation:** the host app's ICF endpoint returned 200 before the stateful window, during it, after
  close-session, and at the end.

### `sap-contextid` cookie

- Set by the stateful LOCK. Attributes (DevTools): **Path `/sap/bc/adt`, HttpOnly, SameSite=None**.
- The path means the host app (any path outside `/sap/bc/adt`) never receives it. This is why the host session
  is unaffected, and it answers the Phase 1 go/no-go.
- HttpOnly means JS cannot read it, so the browser cannot send ARC-1's `sap-contextid` request header on the
  close request. The close (`GET /core/http/sessions`, `X-sap-adt-sessiontype: stateless`,
  `sap-adt-purpose: close-session`) still returned 200 `…core.http.session.v3+xml`, because the browser sends the
  cookie itself.

### Shared cookie jar (test 4b)

Lock, then a sequence of PUTs with the same handle, interleaved with reads that also carry the `sap-contextid`
cookie:

| Step | Result |
| --- | --- |
| PUT right after LOCK | 200 |
| Read **without** a session header (like ARC-1's normal reads), then PUT | 200: the context and lock survive |
| Read with **explicit `X-sap-adt-sessiontype: stateless`**, then PUT | **423 invalid lock handle**: the read ended the context |

### Locks across tabs and browsers

- Tab B (same browser, so same cookie jar) and an incognito window (separate session, same user) both got
  "User JOLT is currently editing Z_ARC1_SPK_…" while tab A held the lock. The test cannot tell whether tab B
  shared tab A's context; either way, a second LOCK does not take over an existing lock.
- **Orphaned lock:** tab A held a lock and was closed. An incognito window polling every 30 s acquired the lock
  after **1782 s (~30 min)**. This is consistent with the ADT HTTP session timeout releasing the context; the
  configured timeout was not checked.
- **Cross-tab close (6b), confirmed:** tab A held a lock, and PUT with the held handle → 200. Tab B (same browser)
  sent only the stateless close-session. Tab A's next PUT with the same handle → **423**. One tab's
  close-session releases every lock held by every tab of the same browser profile.
- **`pagehide` keepalive close (8b), confirmed:** tab A held a lock with a `pagehide` handler sending
  `fetch(…/core/http/sessions, { keepalive: true })` with `X-sap-adt-sessiontype: stateless` and
  `sap-adt-purpose: close-session` (no CSRF token, no `sap-contextid` header). After tab A was closed, the
  incognito window's **first** poll acquired the lock, with no ~30 min wait. Untested: a browser crash or killed
  process (no `pagehide`), and mobile/background-tab discard.

### Session expiry (test 9)

After logging off in another tab:

| Request | Result |
| --- | --- |
| `GET /core/discovery` (redirect: follow) | **400 `text/html`** "Session timed out" page (not 401, no redirect) |
| Same request again (redirect: manual) | 200 discovery: the session was re-established **silently**. This system uses Basic authentication, so the browser re-sent its cached credentials; there was no SSO and no manual login. SSO/SAML setups are untested and may need a login round-trip instead |
| POST with the old CSRF token | **403 "CSRF token validation failed"**, which ARC-1's existing refetch-and-retry handles |

### Implications for the plan (system B)

1. **GO:** cookie path `/sap/bc/adt` isolates the ADT context from the host app.
2. **One ADT context per browser profile.** All tabs on the origin share `sap-contextid`. Any explicit `stateless`
   ADT request ends the context, and with it every lock held in it. That includes ARC-1's own close-session and
   another tab's close-session. In the browser runtime:
   - Reads must never send `X-sap-adt-sessiontype: stateless`. A header-less read is safe (4b).
   - The whole lock → modify → unlock → close window must hold a cross-tab Web Lock (`navigator.locks`), and the
     close must be inside that Web Lock. Confirmed by test 6b.
3. **Close-session without the `sap-contextid` header** works (200). The browser transport drops that header.
   ARC-1's "cookie value is `0`" check after a close has no browser equivalent.
4. **Orphaned locks last ~30 min** after a tab closes mid-write, and they block the user's own Eclipse too. A
   `pagehide` keepalive close-session releases them immediately (8b). The runtime should register it while a
   stateful window is open, keep lock windows short, and document the crash case.
5. **Session expiry is `400 text/html`, not `200 + HTML` as plan §4.4 assumed.** Treat HTML from `/sap/bc/adt` as
   "session expired": retry once (the browser may re-send cached Basic credentials, or SSO may re-establish the
   session), refresh CSRF, otherwise raise a typed re-authentication error. Write the retry so it does not assume
   it will succeed: with SSO/SAML the retry may get a login page again.

## Pending

- Optional: 8.16 for release spread.
- Optional: test 9 on an SSO/SAML-authenticated system.
- Session timeout on system A (still valid without a stateful context).
- No leftover test objects (both deleted and verified).
