# Browser-embedded ARC-1 runtime

**Status:** Draft plan (fork: `joltdx/arc-1`, intended for upstream `arc-mcp/arc-1`)
**Related upstream roadmap item:** FEAT-59 — Embeddable multi-tenant server API (P3/L, "Revisit on trigger")
**Proposed ADR:** `docs/adr/0010-browser-embedded-runtime.md` (next free number; verify before creating)

---

## 1. Background

### 1.1 Context

A host platform (a web app with an "ai client" addon in the browser and a vendor-run
"ai backend" that talks to an external LLM) needs to read and write ABAP code. Today the ai
backend acts as an MCP client to a hosted ARC-1. This works of course, but with pain points
regarding the hosted ARC-1

- read/write access to their ABAP system from outside their network
- hosting their own ARC-1 instance.
- authentication
- single-target

### 1.2 Decision

Run ARC-1 **in the user's browser** (Web Worker inside the ai client). The web app is served
from the **same origin** as the ABAP system, so ADT calls are same-origin `fetch` requests using
the user's existing SAP session. The ai backend stays an MCP client; its transport tunnels
JSON-RPC messages through an "ai client tool" call to the browser.

```text
External LLM ⇄ ai backend (vendor, MCP client w/ relay transport)
                  │  each JSON-RPC message = one "ai client tool" call
                  ▼
ai client (browser, same origin as ABAP)
  └─ Web Worker: ARC-1 browser runtime  (this plan)
       ├─ MCP Server: initialize / tools/list / tools/call
       ├─ config        ← supplied by host (platform loads it from SAP side)
       ├─ audit sinks   → supplied by host (platform writes to SAP side)
       ├─ approveWrite  → supplied by host (UI dialog)
       └─ fetch('/sap/bc/adt/…', { credentials: 'include' }) → ABAP
```

### 1.3 Trust model (what this does and doesn't change)

| Concern | Result |
| --- | --- |
| Inbound network path to SAP from outside | None. All ADT traffic starts in the browser |
| SAP credentials outside customer network | None. Browser session only |
| Shared technical user | None. User's own SAP identity and authorizations (design principle 2, natively) |
| Access without a user present | Only while a logged-in user has the app open |
| External LLM deciding what to read/write | **Still true.** Mitigated by host-supplied settings, write approval, audit |
| Source code reaching the LLM | Unchanged (inherent to the use case) |

### 1.4 Split of responsibilities

- **ARC-1 (this repo, upstreamable):** generic browser runtime with injection points. No SAP-side
  endpoints required. Safe defaults: read-only, console audit sink, no approval hook.
- **Host platform (separate repo, NOT here):** SAP-side settings storage and loader, SAP-side
  audit endpoint + `LogSink` implementation, approval UI, backend relay transport, deployment of
  the bundle into the ABAP system (UI5 repository / BSP) as customer-controlled code.

---

## 2. Goals / non-goals

**Goals**:

- `arc-1/browser` export: `createBrowserServer(options)` returning an MCP server usable in a Web Worker.
- Same tool definitions, handlers, safety ceiling, release handling and feature probes as Node ARC-1.
- **Zero behavior change for the Node build**: tool-definition snapshots byte-identical, all existing tests green.
- Every Node-only dependency behind a small seam; each seam is an independently upstreamable, behavior-preserving PR.
- CI guard: the browser bundle contains no `node:*`, `undici`, `express`, `better-sqlite3` imports.

**Non-goals (v1)**:

- BTP destinations, principal propagation, XSUAA/OIDC, OAuth, multi-target, plugins, abapGit (`node:net`), SQLite cache, HTTP/stdio transports in the browser.
- Cross-origin ADT access (CORS, SameSite cookies).
- Concurrent tool calls inside one runtime (serialize; see §4.3).
- Any SAP-side ABAP artifacts in this repo.

---

## 3. Fit with upstream invariants (read AGENTS.md first)

| Upstream rule | How this plan respects it |
| --- | --- |
| ADR-0005 single system per instance | One browser runtime = one origin = one system |
| Principle 1 centralized admin control | The embedding host is the admin; ARC-1 enforces the ceiling it's given. Must be argued in ADR-0010 |
| Principle 2 per-user SAP identity | Native: browser session = user identity; no shared creds exist |
| Principle 6 safe defaults | Browser defaults = read-only, `$TMP`-only packages, free SQL/data off |
| ADR-0009 no ABAP execution/RFC in core | Unchanged; no new execution paths |
| "All ADT endpoints have safety guards" | Unchanged; seams sit below `checkOperation()` |
| "Locks never cross an MCP round-trip" | `approveWrite` runs **before** dispatch, outside any lock; never inside `withStatefulSession` |
| Playbook §1 freeze observable surface | `tests/fixtures/tool-definitions/*.json` must stay byte-identical |
| Playbook §2 move-only refactors | Seams first (`refactor:` commits, no release), features later |
| Roadmap discipline | Update FEAT-59 (narrow to this consumer, or split a new item) in the same PR |

---

## 4. Design

### 4.1 Public contract (sketch, `@experimental`, like `arc-1/public`)

```ts
// src/browser/index.ts → package.json exports "./browser"
export interface BrowserServerOptions {
  /** ADT origin-relative fetch; default: globalThis.fetch with credentials:'include'. */
  fetch?: typeof fetch;
  /** Fully resolved settings; host decides where they come from. Defaults = safe read-only. */
  config?: Partial<BrowserServerConfig>;
  /** Audit/log sinks (existing LogSink interface, src/server/sinks/types.ts). */
  sinks?: LogSink[];
  /** If true and no sink can record, mutations are refused (reads continue). */
  auditRequiredForWrites?: boolean;
  /** Called before a mutating tools/call is dispatched (outside any lock). */
  approveWrite?: (call: { tool: string; args: unknown; scope: Scope }) => Promise<boolean>;
  /** Optional SAP client override (sap-client query param). */
  sapClient?: string;
}
export function createBrowserServer(options?: BrowserServerOptions): {
  server: Server;                 // @modelcontextprotocol/sdk Server
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
};
export { MessagePortTransport } from './message-port-transport.js'; // worker ⇄ main thread
```

Open: whether `LogSink` gets a `ready()/healthy` signal for `auditRequiredForWrites`, or a separate `AuditGate` option.

### 4.2 Seam technique

**Decided 2026-10-22 (Phase 2.1): bundle-time stand-ins for drop-in Node built-ins, real seams only where
behavior differs.**

- Shared code keeps its `node:` imports. The browser build redirects drop-in built-ins (`node:crypto`,
  `node:timers/promises`, `node:async_hooks`) to stand-ins under `src/browser/node-shims/`. The redirect map
  and both plugins (esbuild for the bundle, vite for tests) live in one place: `scripts/browser/node-shims.mjs`.
- A stand-in implements exactly the call shapes shared code uses and **throws on anything else**, so a gap
  fails loudly instead of returning a different result.
- Drift guard: `npm run test:browser-shims` (`vitest.browser-shims.config.ts`) re-runs the **whole unit suite**
  with the stand-ins swapped in (~2 min locally, about the same as `npm test`). Exclusions are by scope only and
  listed with reasons: Node-only files (OAuth, multi-target, Node HTTP server, signals, CLI subprocess) and three
  tests that run tool calls concurrently on purpose. A guard test (`tests/unit/browser/node-shims-redirect.shimtest.ts`)
  fails if any redirect silently stops applying. Parity with real Node and an esbuild bundle proof run in the
  normal suite (`tests/unit/browser/node-shims-{crypto,runtime}.test.ts`).
- The `node:async_hooks` stand-in keeps one active store per `AsyncLocalStorage` and restores the previous one
  when a run settles. That equals Node only for strictly nested runs, which holds because the browser runtime
  serializes tool calls. Overlapping runs throw (both calls fail) instead of sharing a request id, cancellation
  signal or data budget. Known difference: work a run starts without awaiting reads whatever store is active
  later, not the one that started it.
- Real seams (config injection, as in Node) stay for HTTP/cookies (2.5), AFF schema loading (2.6) and
  lint/deny-action config (2.7).
- `src/browser/` is excluded from the Node `tsc` emit (bundled by esbuild only; typechecked through
  `tsconfig.tests.json`), so the npm package never ships a file importing the `@noble/hashes` devDependency.

Why not the alternatives: package `imports` with conditions (`#platform/*`) and runtime injection of a
`platform` object both touch every importing module upstream (more PRs and review load), and `imports` had
unproven `tsc`/vitest/dist resolution. Upstream precedent (1.7.0, #1027) points the same way: the
single-executable build bundles with esbuild (`scripts/build-sea.mjs`) and switches platform behavior inside
the module (`isSea()` in `aff/validator.ts`, lazy `createRequire` in `cache/sqlite-driver.ts`).

Gotcha (vite 8 / vitest 5): vite externalizes `node:` built-ins before any plugin's `resolveId` runs, so the
test plugin rewrites the import specifiers in shared source during `transform` instead. esbuild's
`onResolve` works directly.

### 4.3 Node-only inventory (verified 2026-10-20 against upstream main `1ff575d9`; re-checked 2026-10-22 at `7b210cbf`, v1.7.0)

| Area | Files | Browser replacement |
| --- | --- | --- |
| Outgoing HTTP | `src/adt/http.ts` (undici `Agent`/`Client`), `bounded-response.ts` (`node:stream`, undici), `request-attempt-budget.ts` (undici) | **Done (2.5):** `AdtHttpConfig.browserFetch` branch in `sendRequest()` (body in `http-browser.ts`); undici replaced by a throwing bundle-only stand-in. Byte-bounding (`capResponseBody`) was already WHATWG streams; the `node:stream`/undici imports in `bounded-response.ts` are type-only, and the Node-stream code there is the out-of-scope Connectivity proxy |
| Cookie jar | `http.ts` `cookieJar`, `cookies.ts` (`node:fs`) | **Done (2.5), no separate option needed:** browsers hide `Set-Cookie` from scripts and drop a script-set `Cookie`, so the jar stays empty by itself; `browserFetch` refuses cookie options and strips `Cookie`. `cookies.ts` gets a bundle-only `node:fs` stand-in scoped to that file |
| Stateful sessions | `http.ts` `withStatefulSession` (clones jar), close via `sap-contextid` | **Transport done (2.5):** close is sent without `sap-contextid` whenever the clone sent a stateful request (the jar cannot see the HttpOnly cookie). Write queue (`navigator.locks`) and `pagehide` close remain Phase 5 |
| Request context | `src/server/context.ts` (`AsyncLocalStorage`); `.run()` in `dispatch.ts`, `http.ts` (server), `stored-text/source.ts`; 18 modules import it | `node:async_hooks` stand-in: single-slot `AsyncLocalStorage`, valid because tool calls are serialized |
| Hashing / random | sync `createHash('sha256')` in `cache/cache.ts`, `source-precondition.ts`, `data-source-name.ts`, `feed-schema.ts`, `diagnostics.ts`, `stored-text/{reader,source}.ts`; `randomBytes` in `data-source-policy.ts` | **Done (2.2):** `node:crypto` stand-in, sync pure-JS sha256 (`@noble/hashes`, avoids async ripple) + `crypto.getRandomValues` |
| Compression | `http-wire-body.ts` (`gzipSync`, opt-in WAF), `stored-text/decoder.ts` (`node:zlib`, `node:util`) | WAF gzip: unsupported in browser (config refuses); stored text: `DecompressionStream` or exclude in v1 |
| Timers | `http-deadline.ts`, `ci-quality.ts` (`node:timers/promises`) | `node:timers/promises` stand-in (`setTimeout` promise) |
| Files | `aff/validator.ts` (schema files; since 1.7.0 also `node:sea` assets via `readSchemaText`), `lint/config-builder.ts`, `server/deny-actions.ts` | AFF schemas bundled/lazy-imported (`readSchemaText` is the natural seam point); lint config + deny actions passed as objects |
| Cache | `cache/sqlite.ts`, `cache/sqlite-driver.ts` (`better-sqlite3` or `node:sqlite` via `node:module`, since 1.7.0) | Memory cache only |
| Server setup | `server/server.ts` `createServer` (express, XSUAA, multi-target, plugins, stdio, `node:http`) | **Do not reuse.** New small `src/browser/` entry composing `AdtClient` + `getToolDefinitions` + `handleToolCall` |
| Logging | `server/logger.ts` (`StderrSink`), `sinks/file.ts`, `runtime-memory.ts` (`node:v8`) | `ConsoleSink` + host sinks via `addSink`; memory envelope = fixed config value |
| Node globals (no import, so no redirect or esbuild error catches them) | `Buffer` (~20 shared uses: `byteLength`, base64/hex, `concat`, stored-text chunks), `process.env` (`http.ts` `ARC1_LOG_HTTP_DEBUG`, server helpers), `process.stderr` (logger, stderr sink) | 2.9. `process.env`: esbuild `define` to `{}` (env config is unset in the browser). `Buffer`: decide between injecting the `buffer` package (faithful port) or a stand-in for the used surface; either way the shimmed test run must use it too. `process.stderr`: 2.8. Tracked per file by the ratchet in `tests/unit/browser/http-bundle.test.ts` |
| Out of scope | `oauth.ts`, `abapgit.ts` (`node:net`), destinations, multi-target, plugin loader | Not reachable from browser entry; enforced by bundle guard |

### 4.4 Browser-specific HTTP behavior to handle

- `credentials: 'include'`; never set `Cookie` or `User-Agent` (forbidden or ignored).
- `redirect: 'manual'` yields an opaque response (status 0) in browsers; the attempt-budget path treats `opaqueredirect`
  like a 3xx (done in 2.5).
- Session expiry: observed on 7.57 as **400 `text/html`** ("Session timed out"), no redirect. Other setups may
  follow a SAML/login redirect and get 200 + HTML. Detect by HTML content type on `/sap/bc/adt` (or
  `response.redirected`); retry once, refresh CSRF, then raise a typed "re-authentication required" error.
  Since 1.7.0 (#1046), a stateful CSRF fetch that gets 400 on both HEAD and GET retries the GET once **without**
  the session header. An expired session (also 400) takes that path first, so the expiry handling must not stack
  a second retry on it or report the HTML page as a CSRF failure.
- `sap-contextid` has path `/sap/bc/adt` (HttpOnly on 7.57, not on 7.31): a host page outside that path cannot
  read it either way, so the close request goes without the `sap-contextid` header (verified to work on both; on
  pre-7.50 + `abapfs_extensions` a stateless request to a 404 close path still ends the context). All tabs share it, and any explicit `stateless` ADT request ends
  the context and its locks, so reads must send no session header.
- `X-sap-adt-sessiontype`, `X-CSRF-Token`, `Accept`/`Content-Type` custom headers are fine same-origin.

---

## 5. Work plan

### Phase 0: Fork hygiene

- [x] `git remote add upstream https://github.com/arc-mcp/arc-1.git`
- [x] Branches: `main` = fast-forward mirror of `upstream/main` (tracks `upstream/main`); `feat/browser-runtime` for integration; one short branch per seam PR
- [x] Sync cadence: weekly `git fetch upstream && git rebase upstream/main` on seam branches; review drift with `git range-diff`
- [x] Keep platform-specific code **out** of this fork
- [x] Conventional commits: seams = `refactor:`, browser entry = `feat:`, plan/ADR = `docs:`
- [x] Full gate passes on a clean fork before any change: `npm ci && npm run typecheck && npm run lint && npm test && npm run validate:policy && npm run build && npm run check:sizes`
  - Baseline 2026-10-20 at `1ff575d9` (WSL2): all green. Under full parallel load, `tests/unit/cli/runtime.test.ts` and
    `tests/unit/server/shutdown.test.ts` (subprocess spawns) can time out locally; they pass when run alone. Treat them as
    environment flakes, not seam regressions.

### Phase 1: Spike (no ARC-1 code; manual, ~1 day)

In a page served from the ABAP origin (or a dev proxy, see §7), with hand-written fetch:

- [x] GET discovery (`/sap/bc/adt/discovery`) and a program source with the browser session (7.31, 7.57)
- [x] CSRF fetch, then stateful lock, PUT source (`$TMP` object), unlock, activate (7.57; 7.31 with `abapfs_extensions`)
- [x] Record the `sap-contextid` cookie **path** and whether closing the ADT stateful session affects the web app's own session/context (`/sap/bc/adt`, HttpOnly; host app unaffected)
- [x] Two tabs: concurrent lock attempts; tab closed while holding a lock (time until release) — conflict; ~30 min orphan; one tab's close releases another tab's lock; `pagehide` keepalive close releases immediately
- [x] Session timeout: confirm what fetch returns (redirect, 200 HTML, 401) — 400 `text/html` on 7.57
- [x] Repeat on oldest and newest target releases (e.g. 7.50 and 8.16) and note differences — 7.31 (+ `abapfs_extensions`) and 7.57; 8.16 optional
- [x] Record results in `docs/research/<date>-browser-adt-session-spike.md` (release, auth route, observations, gaps) — `2026-10-21-browser-adt-session-spike.md`
- **Go/no-go:** if the ADT stateful session cannot be isolated from the host app's session, stop and redesign before Phase 2. **Result: GO (7.57).**

### Phase 2: Node-neutral seams (behavior-preserving, each its own upstream PR)

For every seam: no tool-definition fixture diff, existing tests green, new unit tests for both implementations.

- [x] 2.1 Decide seam technique (§4.2) with a minimal proof on one module (hash): bundle-time stand-ins
- [x] 2.2 `node:crypto` stand-in (`createHash('sha256')` via `@noble/hashes`, `randomBytes` via
  `crypto.getRandomValues`); covers every in-scope user (`oauth.ts` is out of scope and uses `base64url`, which
  the stand-in refuses)
  - [ ] Wire `npm run test:browser-shims` into CI (`.github/workflows/test.yml`) in the upstream PR, or the drift guard never runs
- [x] 2.3 Timers: `node:timers/promises` stand-in (`setTimeout(delay, value, { signal })`, Node-shaped `AbortError`)
- [x] 2.4 Request context: `node:async_hooks` stand-in (single-slot `AsyncLocalStorage`, overlap detection; see
  §4.2). Checked at `7b210cbf`: in browser scope only `dispatch.ts` and `stored-text/source.ts` call `run()`, and
  the stored-text run is nested and awaited; only three unit tests depend on concurrent tool calls.
  - [ ] Phase 3: `createBrowserServer` must serialize `tools/call` (queue), or the overlap detection fails both calls
- [x] 2.5 HTTP: one option, `AdtHttpConfig.browserFetch` (not `fetchImpl` + `cookieMode`: in a browser they always go
  together). Refuses proxy/TLS/credential/WAF-gzip options; `credentials: 'include'`; no `Cookie`/`User-Agent`;
  one attempt-budget charge per fetch; opaque manual redirects treated like 3xx (`bounded-response.ts`). Tests:
  `tests/unit/adt/http-browser.test.ts`; browser bundle of `http.ts` + Node-globals ratchet:
  `tests/unit/browser/http-bundle.test.ts`. `http.ts` budget +4 (body lives in `http-browser.ts`)
  - [x] Security-session gate (1.7.0, #1043): with no jar the first cold request goes alone, then the client fans
    out; a 401 reset re-arms it. Covered in `http-browser.test.ts`.
  - [x] Headerless CSRF retry (1.7.0, #1046): expired-session baseline (400 `text/html`) locked in: stateless CSRF =
    HEAD + GET, stateful adds the headerless GET, then a typed 400. Phase 4 turns this into a re-auth error.
  - Phase 4: repeat spike test 9 (log off, then write) through the real ARC-1 code path on 7.57.
- [ ] 2.6 AFF schema loader seam (fs vs bundled)
- [ ] 2.7 Lint config / deny-actions accept in-memory config without fs
- [ ] 2.8 Logger: `ConsoleSink`; no hard dependency on `StderrSink` from shared code
- [ ] 2.9 Node globals: `process.env` via esbuild `define`; `Buffer` decision (inject `buffer` package vs stand-in), applied
  to the shimmed test run too; shrink the ratchet in `http-bundle.test.ts` as each lands
- [ ] Each PR: roadmap check, size-budget check, PR template filled (live SAP testing N/A for pure refactors; state it)

### Phase 3: Browser entry + bundle

- [ ] `src/browser/index.ts` (`createBrowserServer`), `config.ts` (browser defaults and validation; reuse `DEFAULT_CONFIG` / `validateConfig` where possible), `message-port-transport.ts`
- [ ] `package.json` `exports["./browser"]`; mark `@experimental` like `arc-1/public`
- [ ] Bundle script `build:browser` (esbuild, ESM, worker-targeted); lazy-load abaplint and AFF schemas
- [ ] CI guard `scripts/ci/check-browser-bundle.mjs`: fail on forbidden imports; enforce a size budget (fails on its own staleness, Playbook §5)
- [ ] Unit tests: `createBrowserServer` + `InMemoryTransport` → `initialize`, `tools/list`, `tools/call` against `mock-fetch`
- [ ] Snapshot test: browser `tools/list` for read-only and full configs (new fixtures under `tests/fixtures/tool-definitions/browser-*.json`)

### Phase 4: Read-only end-to-end

- [ ] Browser test harness (Playwright or vitest browser mode) loading the bundle in a real Worker
- [ ] Dev proxy setup (§7) against a real SAP test system: SAPRead, SAPSearch, SAPNavigate, feature probe, release detection
- [ ] Re-auth error surfaces as a clear tool error
- [ ] Platform team wires the relay transport (outside this repo) and confirms backend MCP client works unchanged

### Phase 5: Writes

- [ ] `approveWrite` hook in the browser dispatch wrapper, using `ACTION_POLICY` scope to decide what counts as mutating; deny → tool error, nothing sent to SAP
- [ ] Write queue across tabs (`navigator.locks`, one lock name per origin + SAP client), covering lock → modify → unlock → close-session (spike 6b: one tab's close releases another tab's locks)
- [ ] Browser transport never sends `X-sap-adt-sessiontype: stateless` outside the close request, and drops the `sap-contextid` header (HttpOnly; close works without it)
- [ ] While a stateful window is open, register a `pagehide` handler that sends a `keepalive` stateless close-session (spike 8b: releases an orphaned lock immediately instead of after ~30 min)
- [ ] `auditRequiredForWrites`: refuse mutations when no sink can record; reads unaffected
- [ ] Package allowlist, deny actions and transport gates via config, same enforcement as Node
- [ ] Live CRUD on `$TMP` in the browser harness: create, update, `edit_method`, activate, delete; plus lock conflict and tab-close cases
- [ ] Lint-before-write on (abaplint lazy-loaded): verify bundle size and latency

### Phase 6: Upstream proposal

- [ ] Open upstream issue referencing FEAT-59 with the concrete embedding requirements (lifecycle, isolation, write safety, upgrades)
- [ ] ADR-0010 draft: trust model (§1.3), host-as-admin argument, safe defaults, out-of-scope list
- [ ] Docs page `docs_page/browser-runtime.md` (embedding guide; host responsibilities)
- [ ] Roadmap: narrow or replace FEAT-59 in overview and details
- [ ] Seam PRs first (small, `refactor:`), then the `feat:` browser entry PR
- [ ] If upstream declines: keep `feat/browser-runtime` as a thin fork (seams + entry only) and publish internally

---

## 6. Risks and open questions

1. **Stateful session isolation** (Phase 1 go/no-go): ADT session vs host app session on one origin.
2. **Authorizations / prerequisites:** users need `S_ADT_RES`, `S_DEVELOP`, a developer key (on-prem), `/sap/bc/adt`
   active in SICF. Writes need SAP_BASIS ≥ 7.51 or the `abapfs_extensions` back-port (same as Node ARC-1, #293);
   confirmed on 7.31 in `docs/research/2026-10-21-browser-adt-session-spike.md`.
3. **Lock left behind** when a tab closes mid-write: held until the SAP session times out (~30 min observed on
   7.57; blocks the user's own Eclipse too). Mitigation verified on 7.57: a `pagehide` handler sending a `keepalive`
   stateless close-session releases it immediately. Register it while a stateful window is open; a browser crash
   still leaves the lock until timeout.
4. **Background-tab throttling** during ATC polling / long activation.
5. **Bundle size** (abaplint is several MB): lazy-load; lint-before-write could default off in browser.
6. **Prompt injection:** code read from SAP can steer the LLM toward writes. Approval UI should show object, package and a diff, not just the tool name.
7. **Upstream acceptance:** an embeddable API is a public compatibility surface (FEAT-59's concern). Mitigate with `@experimental` + `apiVersion` fuse like `arc-1/public`.
8. **Open:** audit gate shape (sink health vs separate gate); whether stored-text (SAPscript) is in v1; BTP ABAP / S/4 Cloud same-origin feasibility (not covered by v1).
9. **Shared ADT context across tabs:** one `sap-contextid` per browser profile; an explicit `stateless` ADT request
   from any tab ends every lock held in it. Serialize all stateful windows (including the close) under one Web Lock,
   and never send `stateless` on reads.

---

## 7. Local development setup

- Dev server (e.g. Vite) serving the test page **and** proxying `/sap/*` to the SAP test system, so the browser sees a single origin. Log in once through the proxy.
- Never commit SAP URLs, users or cookies; use `.env` (gitignored) for the proxy target.
- Use `$TMP` and `generateUniqueName()`-style names for write tests; clean up best-effort.

---

## 8. Definition of done (v1)

- [ ] Node build: zero behavior change; all upstream gates green; tool-definition fixtures byte-identical
- [ ] Browser bundle: no forbidden imports; within size budget; read and write tools pass live in a real browser on ≥2 SAP releases
- [ ] Safe defaults verified: no config → read-only; writes require config + approval (+ audit if required)
- [ ] ADR-0010, docs page, roadmap update and PR descriptions with live-test evidence ready for upstream

---

## 9. Start-of-session checklist (for the coding agent)

1. Read `AGENTS.md`, this plan, `docs/security-model.md`, `docs_page/roadmap.md` (FEAT-59).
2. `git fetch upstream` and check how far `main` is behind; re-verify the §4.3 inventory (`grep -rn "from 'node:\|from 'undici'" src`), since upstream moves fast.
3. Pick the next unchecked item; one seam per branch/PR; run the full gate before each commit.
4. Update the checkboxes in this file as part of each PR.
