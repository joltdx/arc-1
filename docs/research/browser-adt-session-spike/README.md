# Browser ADT session spike (Phase 1)

Tooling for Phase 1 of [the browser-embedded runtime plan](../../plans/2026-10-20-browser-embedded-runtime.md).
Results go to `docs/research/<date>-browser-adt-session-spike.md`.

## Load it

- **Console:** open any page served from the ABAP origin (ideally the host web app itself), paste `spike.js` into
  DevTools → Console.
- **Page:** upload `index.html` + `spike.js` to the ABAP origin (BSP / UI5 repository) and open it.

Running inside the real host app is the stronger test, because the isolation question is about *that* app's session.
Set **host probe URL** to a request the host app really makes (an OData/REST call, or its own page URL).

The panel keeps every request in `window.arcSpike.log`, logs to the console, and **Report (copy)** copies a Markdown
summary. Cookie values, CSRF tokens and lock handles are never recorded. Check error-body snippets for user names before
committing a report.

## Protocol (per release, e.g. 7.50 and 8.16)

| # | Do | Answers |
|---|----|---------|
| 1 | **1 Env** | Origin, browser APIs, cookies present *before* ADT (does the host app already have a `sap-contextid`?) |
| 2 | **2 Discovery** | Discovery + SAP_BASIS release with the browser session |
| 3 | **3 Read source** | Plain source GET |
| 4 | **4 Write flow** | CSRF → create `$TMP` program → stateful LOCK → host probe + stateless read *inside* the stateful window → PUT → UNLOCK → close-session → host probe → activate → read back. Notes show cookie diffs (`sap-contextid` path/expiry where `cookieStore` exists — Chrome/Edge) |
| 4b | **5 Shared-jar read** (only if step 4's PUT succeeded) | Browser-only risk: reads share the `sap-contextid` cookie with the held lock. Does a header-less read keep the context? Does an explicit `stateless` read end it (PUT → 423)? |
| 5 | DevTools → Application → Cookies | Record `sap-contextid` **Path**, HttpOnly, SameSite after step 4's LOCK (rerun **Hold lock** if needed). If path is `/sap/bc/adt`, the host app never sees it |
| 6 | Tab A **Hold lock**, tab B (same browser) **Try lock** | Do tabs share one SAP stateful context? (Expect yes: shared cookie jar.) Then **Release lock** |
| 6b | Tab A **Hold lock** → tab A **Put held** (expect 200) → tab B (same browser) **Close session** → tab A **Put held** | Can one tab's close-session end another tab's lock? 423 on the second PUT = yes (shared `sap-contextid`) |
| 7 | Tab A **Hold lock**, **incognito window** (log in again) **Try lock** | Separate session, same user: real lock conflict? Message text? |
| 8 | Tab A **Hold lock**, close tab A; in another window (incognito, or after clearing cookies) **Poll lock** | Time until SAP releases an orphaned lock. Also try polling from a tab in the *same* browser and note whether it gets the lock immediately (context still alive via shared cookie) |
| 8b | Tab A **Hold lock (auto-release)**, close tab A; incognito **Poll lock** (every 10 s) | Does a keepalive close-session on `pagehide` release an orphaned lock at once, instead of after the ~30 min session timeout? |
| 9 | **Probe once** after logging off in another tab (`/sap/public/bc/icf/logoff`), and/or **Session watch** left running past the idle timeout | What fetch returns on expiry: 401, 200 + HTML login page, redirect (`redirected`, `opaqueredirect` for `redirect: 'manual'`), CSRF behavior on POST |
| 10 | **Delete test prog**, then **Report (copy)** (+ **JSON**) | Cleanup + raw evidence |

Go/no-go (plan §5 Phase 1): if steps 4–5 show the ADT stateful context or close-session breaking the host app's own
session (host probe fails, login page, or host app state lost), stop and redesign before Phase 2.
