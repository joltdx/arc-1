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

Run ARC-1 **in the user's browser** (Web Worker inside the ai client). The web app runs on the
**same origin** as the ABAP system, so ADT calls are same-origin `fetch` requests using the user's
existing SAP session. The ai backend does not speak MCP to the browser: it already relays "client
tools" (decided 2026-10-23 after reading the first host's code). The ai client registers ARC-1's
tool list with the backend, the backend offers those tools to the LLM, and each tool call travels
to the browser and its result back over the host's own channel. MCP runs only between the page and
the worker, behind a small page-side helper (Phase 4b).

```text
External LLM ⇄ ai backend (vendor; offers the registered client tools to the LLM)
                  │  host channel: register tool list; each tool call → browser → result
                  ▼
ai client (browser page on the ABAP origin)
  └─ host helper (arc-1 host.js): listTools / callTool / onToolsChanged / onAudit
       │  MCP JSON-RPC over a MessagePort
       ▼
     Web Worker: ARC-1 browser runtime  (this plan)
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
  audit endpoint + `LogSink` implementation, approval UI, backend tool relay, and serving the bundle:
  either from the ABAP system (UI5 repository / BSP, e.g. a small transport next to the platform) or
  from the host's own web server, which needs CORS for the bundle files and a host CSP that allows the
  worker (see §6). Hosts that relay results must not silently cut tool output (see Phase 4b).

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

### 4.1 Public contract (`@experimental`, like `arc-1/public`)

As built in Phase 3 (`src/browser/index.ts`, `config.ts`, `message-port-transport.ts`) and Phase 5 (`write-gate.ts`).

```ts
export const BROWSER_API_VERSION = 1;
export interface BrowserServerOptions {
  fetch?: typeof fetch;          // same-origin fetch on the user's session; default globalThis.fetch
  baseUrl?: string;              // default globalThis.location.origin (the worker's origin)
  config?: Partial<BrowserServerConfig>; // host settings; unknown or unsupported keys throw
  user?: string;                 // host-supplied SAP user (decided 2026-10-22), see below
  sinks?: LogSink[];             // audit sinks in addition to the console
  approveWrite?(call: WriteCall, { signal }): boolean | Promise<boolean>; // required with allowWrites
  auditRequiredForWrites?: boolean; auditReady?(): boolean | Promise<boolean>; // the second requires the first
  onStatefulSessionChange?(open: boolean): void; // the page closes an open session on pagehide
  locks?: LockManagerLike | null;                // cross-tab queue; default navigator.locks
}
interface WriteCall { tool; action?; scope: 'write' | 'transports' | 'git'; args } // hyperfocused: the mapped tool
export function createBrowserServer(options?: BrowserServerOptions): {
  server: Server; config: Readonly<ServerConfig>;
  connect(transport: Transport): Promise<void>; // then probes features, then tools/list_changed
  close(): Promise<void>;
};
export { MessagePortTransport, type MessagePortLike }; // Worker, MessagePort or the worker's own scope

// dist/browser/worker.js: serveBrowserRuntime(self); hosts that need fetch, in-worker sinks or hooks call it themselves.
export function serveBrowserRuntime(scope: WorkerScopeLike, local?: { fetch?; sinks?; approveWrite?; auditReady? }): void;

// dist/browser/host.js (page side, Phase 4b): no dependencies, loadable with import() from classic scripts.
export function startBrowserRuntime(options: {
  workerUrl: string | URL;       // another origin → blob bootstrap (CORS on the bundle, CSP allows blob: workers)
  options?: { config?; user?; baseUrl?; auditRequiredForWrites? };
  onAudit?(event): void; onToolsChanged?(tools: Tool[]): void; onError?(error: Error): void;
  approveWrite?(call: WriteCall, { signal }): boolean | Promise<boolean>; auditReady?(): boolean | Promise<boolean>;
  clientInfo?; startTimeoutMs?: number;
}): Promise<BrowserRuntime>;     // also connectBrowserRuntime(worker, options) for a host-made worker
interface BrowserRuntime {
  apiVersion; config; serverInfo; instructions?;
  listTools(): Promise<Tool[]>;
  callTool(name, args?, { signal?, maxResultChars? }?): Promise<CallToolResult>; // tool errors: isError
  close(): void;
}
```

Worker protocol (between the two): one `{ arc1: 'start', options }` message with a MessagePort (`options.pageHooks`
names the hooks the page answers), answered by `{ arc1: 'ready', apiVersion, config }` or `{ arc1: 'error', message }`;
audit events as `{ arc1: 'audit', event }`; stateful sessions as `{ arc1: 'session', open }`; hook questions as
`{ arc1: 'ask', id, hook, call? }` → `{ arc1: 'answer', id, value }`, withdrawn by `{ arc1: 'cancel', id }`; MCP
JSON-RPC on the port.

- **Config** (`resolveBrowserConfig`): an allowlist of `ServerConfig` keys (safety flags and lists, feature
  toggles, tool mode, limits, `client`, `language`, labels). Anything else throws, so a URL, credentials,
  plugins, a lint config file, SQLite cache, abapGit or git writes are never silently ignored. `allowedPackages: []`
  is refused (it means "all packages" to the safety check; `['*']` says so explicitly). Defaults are Node's plus
  `client: ''` (no `sap-client` parameter: the browser session is already bound to one client, and a different
  value would mean another logon), `cacheMode: 'memory'` and `featureAbapGit: 'off'`. `SAPQuery.long_text` is always
  added to the deny actions, so stored text is hidden from `tools/list` and refused at dispatch.
- **User**: the browser cannot read the logged-on user from its session (no SAP user configured, no bearer token),
  so the host passes it. It becomes `AdtClient.username` / `ServerConfig.username` (used for `adtcore:responsible` on
  create, `SAPRead SYSTEM`, transport and trace defaults) and the audit `user`. It is never sent as a credential: the
  browser `AdtHttpClient` is built separately, so the `browserFetch` credential guard is unaffected.
- **Scopes**: calls carry a fixed `authInfo` with `scopes: ['admin']`, so as on stdio the safety ceiling is the only
  ARC-1 gate; `clientId: 'arc-1-browser'` and the user land in every audit event.
- **Serialization**: tool calls and the feature probe share one queue (the request-context stand-in requires it).
  The probe runs first after `connect`; `tools/list` never waits for it. `tools/list_changed` is sent only after the
  client's `initialized` notification (otherwise a fast probe notifies before `initialize` is answered).

- **Writes** (Phase 5): `allowWrites` without `approveWrite` fails at start, so writes always need settings and
  approval. A call is mutating when its `ACTION_POLICY` scope is `write`, `transports` or `git`, derived with the
  normalization dispatch applies (`mutatingCall`). The gate asks only when the ceiling would run the call
  (`allowWrites` on, action not denied); dispatch refuses the rest with its own message. Anything but `true` from the
  hook (a throw, a cancelled call) refuses before any SAP request, as a tool error plus a `safety_blocked` audit event.
  The hook runs outside the call queue and outside any lock (it may read through the runtime for a diff).
  Package allowlist, deny actions and transport flags are the Node ceiling, unchanged.
- **Audit gate** (decided 2026-10-23): a separate `auditReady` hook, not a `LogSink` health signal. `LogSink.write`
  is fire-and-forget, and in the standard worker the host's store is behind `onAudit` on the page, so only the host
  can say whether it can record. Checked before and after approval.
- **Write queue**: AdtHttpClient's `statefulWindow` hook (one optional config field, 2.5's seam) wraps each stateful
  session from its first request through the close. The browser holds the Web Lock `arc-1:adt-stateful-session` for
  it, one per origin, not per SAP client: `sap-contextid` has path `/sap/bc/adt` whatever the client. A session opened
  inside another one in the same runtime runs without a second request (Web Locks are not reentrant). Without Web
  Locks (plain HTTP) writes still run, with a startup warning.

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
  normal suite (`tests/unit/browser/node-shims-{crypto,runtime,modules}.test.ts`, `http-bundle.test.ts`).
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
| Stateful sessions | `http.ts` `withStatefulSession` (clones jar), close via `sap-contextid` | **Transport done (2.5):** close is sent without `sap-contextid` whenever the clone sent a stateful request (the jar cannot see the HttpOnly cookie). **Done (Phase 5):** `statefulWindow` hook → Web Lock write queue; the page closes an open session on `pagehide` |
| Request context | `src/server/context.ts` (`AsyncLocalStorage`); `.run()` in `dispatch.ts`, `http.ts` (server), `stored-text/source.ts`; 18 modules import it | **Done (2.4):** `node:async_hooks` stand-in: single-slot `AsyncLocalStorage`, valid because tool calls are serialized |
| Hashing / random | sync `createHash('sha256')` in `cache/cache.ts`, `source-precondition.ts`, `data-source-name.ts`, `feed-schema.ts`, `diagnostics.ts`, `stored-text/{reader,source}.ts`; `randomBytes` in `data-source-policy.ts` | **Done (2.2):** `node:crypto` stand-in, sync pure-JS sha256 (`@noble/hashes`, avoids async ripple) + `crypto.getRandomValues` |
| Compression | `http-wire-body.ts` (`gzipSync`, opt-in WAF), `stored-text/decoder.ts` (`node:zlib`, `node:util`) | **Done (2.7):** throwing bundle-only stand-ins scoped to both files. WAF gzip is refused with `browserFetch`. **Stored text is not in v1:** the decoder needs inflate's consumed-byte count (`engine.bytesWritten`), which `DecompressionStream` does not report |
| Timers | `http-deadline.ts`, `ci-quality.ts` (`node:timers/promises`) | **Done (2.3):** `node:timers/promises` stand-in (`setTimeout` promise) |
| Files | `aff/validator.ts` (schema files; since 1.7.0 also `node:sea` assets via `readSchemaText`), `lint/config-builder.ts`, `server/deny-actions.ts` | **Done (2.6/2.7), no upstream change:** the validator's existing single-executable switch serves the schemas: a `node:sea` stand-in (`isSea()` true, `getAsset` from the 7 bundled schemas, 56 KB) plus `node:url`/`node:path` stand-ins for its module-load path. Lint config files and deny-action files are Node-only config: `node:fs`/`node:os`/`node:path` stand-ins that throw, scoped to those files. A custom abaplint config as an object is a possible later addition |
| Cache | `cache/sqlite.ts`, `cache/sqlite-driver.ts` (`better-sqlite3` or `node:sqlite` via `node:module`, since 1.7.0) | Memory cache only |
| Server setup | `server/server.ts` `createServer` (express, XSUAA, multi-target, plugins, stdio, `node:http`) | **Do not reuse.** New small `src/browser/` entry composing `AdtClient` + `getToolDefinitions` + `handleToolCall` |
| Logging | `server/logger.ts` (`StderrSink`), `sinks/file.ts`, `runtime-memory.ts` (`node:v8`) | **Done (2.8), no upstream change:** the injected `process.stderr.write` forwards to the console method of the line's level (`console.debug`/`info`/`warn`/`error`; unreadable lines stay on `console.error`), so the default `StderrSink` acts as a console sink; host sinks via `logger.addSink`. `runtime-memory.ts`: not in the handler graph |
| Node globals (no import, so no redirect or esbuild error catches them) | `Buffer` (~20 shared uses: `byteLength`, base64/hex, `concat`, stored-text chunks), `process.env` (`http.ts` `ARC1_LOG_HTTP_DEBUG`, server helpers), `process.stderr` (logger, stderr sink) | **Done (2.9):** esbuild injects `src/browser/globals.ts`: `Buffer` from the `buffer` package, and a minimal `process` (empty `env`, `stderr.write` → console). The shimmed test run imports the same `Buffer` into shared source (`process` stays Node's there, since tests set env vars). `buffer` refuses `'base64url'` loudly; its only user is bearer JWT decoding, which `browserFetch` refuses |
| Out of scope | `oauth.ts`, `abapgit.ts` (`node:net`), destinations, multi-target, plugin loader | `abapgit.ts` `isIP`: throwing bundle-only stand-in (no re-implemented SSRF check). Dependencies requiring bare `crypto` (abaplint downport rule: sha1; rate-limiter-flexible cluster limiter) get the `node:crypto` stand-in, scoped to those files |

### 4.4 Browser-specific HTTP behavior to handle

- `credentials: 'include'`; never set `Cookie` or `User-Agent` (forbidden or ignored).
- `redirect: 'manual'` yields an opaque response (status 0) in browsers; the attempt-budget path treats `opaqueredirect`
  like a 3xx (done in 2.5). Since Phase 4 every browser request uses `redirect: 'manual'`: system B (7.57)
  redirects an unauthenticated ADT request to its Entra ID IdP, and a followed cross-origin redirect fails as an
  opaque CORS network error that nothing retries.
- Session expiry: observed on 7.57 as **400 `text/html`** ("Session timed out"), no redirect; a missing logon on
  7.31 is 401 `text/html`; on system B without a session, a 302 to Entra ID, then (once SAP has set
  `OIDCTokenRequested`) a Basic 401 challenge. **Done (Phase 4):** `browserSessionEnded()` (`http-browser.ts`)
  treats a 401, a redirect (status 0), a logon page or a 400 HTML page as SAP's logon layer;
  `request()` retries it once through the 401 path (CSRF refetch for writes), then raises `BrowserSessionEndedError`
  (401), and `dispatch.ts` hints "log on to SAP again in this browser". The #1046 headerless CSRF GET (1.7.0)
  stays the only extra CSRF retry; its final failure is reported as the session end, not as a CSRF failure.
- `sap-contextid` has path `/sap/bc/adt` (HttpOnly on 7.57, not on 7.31): a host page outside that path cannot
  read it either way, so the close request goes without the `sap-contextid` header (verified to work on both).
  On 7.31 + `abapfs_extensions` a stateless request to a 404 path does **not** end the context (corrected
  2026-10-23); only one to an existing resource does (`/sap/bc/adt/discovery`). ARC-1's close (`/core/http/sessions`,
  then `/core/discovery`, both 404 there) therefore leaves the context open; the page's `pagehide` close adds
  `HEAD /sap/bc/adt/discovery`. All tabs share it, and any explicit `stateless` ADT request ends
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
  - [x] Wire `npm run test:browser-shims` into CI (`.github/workflows/test.yml`, after the unit tests)
- [x] 2.3 Timers: `node:timers/promises` stand-in (`setTimeout(delay, value, { signal })`, Node-shaped `AbortError`)
- [x] 2.4 Request context: `node:async_hooks` stand-in (single-slot `AsyncLocalStorage`, overlap detection; see
  §4.2). Checked at `7b210cbf`: in browser scope only `dispatch.ts` and `stored-text/source.ts` call `run()`, and
  the stored-text run is nested and awaited; only three unit tests depend on concurrent tool calls.
  - [x] Phase 3: `createBrowserServer` serializes `tools/call` and the feature probe (one queue)
- [x] 2.5 HTTP: one option, `AdtHttpConfig.browserFetch` (not `fetchImpl` + `cookieMode`: in a browser they always go
  together). Refuses proxy/TLS/credential/WAF-gzip options; `credentials: 'include'`; no `Cookie`/`User-Agent`;
  one attempt-budget charge per fetch; opaque manual redirects treated like 3xx (`bounded-response.ts`). Tests:
  `tests/unit/adt/http-browser.test.ts`; browser bundle of `http.ts` + Node-globals ratchet:
  `tests/unit/browser/http-bundle.test.ts`. `http.ts` budget +4 (body lives in `http-browser.ts`)
  - [x] Security-session gate (1.7.0, #1043): with no jar the first cold request goes alone, then the client fans
    out; a 401 reset re-arms it. Covered in `http-browser.test.ts`.
  - [x] Headerless CSRF retry (1.7.0, #1046): stateless CSRF = HEAD + GET, stateful adds the headerless GET; since
    Phase 4 the final failure is `BrowserSessionEndedError`.
  - Phase 4: spike test 9 (log off, then call a tool) repeated through the real ARC-1 code path on 7.57: silent
    success. The write variant comes with Phase 5's live CRUD.
- [x] 2.6 AFF schemas: `node:sea` stand-in serves them from the bundle via the validator's existing single-executable
  switch (no upstream change). A unit test fails if `src/aff/schemas/` gains a file the stand-in lacks (the
  validator would otherwise skip validation for that type silently)
- [x] 2.7 Lint config files / deny-action files: Node-only config, throwing stand-ins scoped to those files; the browser
  passes deny actions as an array. Also covered: stored-text decoder, `abapgit.ts` `isIP`, bare `crypto` in dependencies
- [x] 2.8 Logger: no code change; the injected `process.stderr` routes the default sink to the console, by level
  (first host test: every line on `console.error` showed INFO events as red errors)
- [x] 2.9 Node globals: `buffer` package + minimal `process` injected (`src/browser/globals.ts`)
- [x] Redirect table is one rule list in `scripts/browser/node-shims.mjs` (per-rule `importers` scope and
  `bundleOnly`); `browserBuildOptions()` is the shared esbuild setup for Phase 3
- [x] `tests/unit/browser/http-bundle.test.ts` runs the bundled HTTP layer, logger, validator and a `Buffer` user in a
  vm context with only web APIs (no Node globals): requests, CSRF, console logging, embedded schemas, `Buffer` parity
- [x] Whole handler graph (`src/handlers/dispatch.ts`) bundles for the browser: 2,018 modules, ~7.3 MB unminified
  (mostly abaplint, which stays in the startup graph: see the Phase 3 note)
- [ ] Each PR: roadmap check, size-budget check, PR template filled (live SAP testing N/A for pure refactors; state it)

### Phase 3: Browser entry + bundle

- [x] `src/browser/index.ts` (`createBrowserServer`, `createBrowserClient`, `browserToolDefinitions`), `config.ts`
  (`resolveBrowserConfig`: browser defaults on `DEFAULT_CONFIG`, reuses `validateConfig`, `validateDenyActions`,
  `normalizeSystemLabel`, `canonicalDataSourceNames`), `message-port-transport.ts`. See §4.1. No upstream file changed
- Packaging: moved to Phase 6 (decided 2026-10-22: a separate package, see there). Not needed for Phases 4–5, which
  use the local `build:browser` output
- [x] Bundle script `build:browser` (`scripts/browser/build.mjs`, `browserBundleOptions()`): minified ESM with code
  splitting (`index.js` + `chunks/`, for a module Worker), `keepNames`, source map opt-in (`--sourcemap`, 14 MB).
  Two esbuild findings, both caught only by running the minified bundle:
  - Without `splitting`, esbuild evaluates dynamic `import()` targets lazily (`__esm`), the zod modules they reach
    become lazy too, and the MCP SDK (which imports zod through `export *` re-exports) gets no init call:
    "Class2 is not a constructor" at load. Splitting removes the lazy wrappers
  - abaplint registers syntax handlers by class name; minified names collide ("duplicate statement syntax handler")
  - Lazy-loading abaplint: **deferred.** It is half the bundle (2.0 of 4.2 MB minified, ~1 MB gzipped total) but is
    statically imported by 12 modules, including read paths (`features.ts`, method/unit surgery, compressor, deps).
    Lazy-loading means making those async upstream. The bundle loads in a worker, off the main thread; revisit with
    Phase 4 load-time measurements
  - Re-checked 2026-10-23 at upstream 1.8.0: **not lazy-loaded, and not planned for v1.** 10 modules import
    abaplint values statically (`features.ts`, `include-expansion.ts`, `sql-source-analyzer.ts`, `deps.ts`,
    `contract.ts`, `method-surgery.ts`, `unit-surgery.ts`, `lint.ts`, `config-builder.ts`,
    `abaplint-config-cache.ts`; 2 more are type-only). Upstream keeps adding sync users on read paths
    (`include-expansion.ts`, `sql-source-analyzer.ts`), so an async split would be a large upstream change for
    a one-time worker load (280–360 ms on localhost)
- [x] `getEffectiveUser()`: host-supplied `user` option (decided 2026-10-22), see §4.1
- [x] Browser config refuses or hides what v1 does not support: stored text (always-denied action), abapGit
  (`featureAbapGit` fixed off, `allowGitWrites` not configurable), SQLite cache, plugins, lint config files,
  URL/credential/cookie/TLS/WAF-gzip settings (unknown key → error; `browserFetch` refuses them too)
- [x] CI guard `scripts/ci/check-browser-bundle.mjs` (`npm run check:browser-bundle`, wired into `test.yml`):
  forbidden packages, leftover imports, size budget over entry + chunks (4,500,000 bytes since the 2026-10-27 upstream sync (abaplint 2.120.86); fails below 90%, Playbook §5)
- [x] Unit tests: `tests/unit/browser/browser-server.test.ts` (`createBrowserServer` + `InMemoryTransport`:
  config validation, tool surface, read, write refusal, stored-text denial, serialization, probe, audit user,
  `SAPRead SYSTEM`); `message-port-transport.test.ts`; `browser-bundle.test.ts` runs the shipped minified bundle in a
  worker thread over a `MessageChannel` and fails if the bundle reads any Node global (getter traps, because Node's
  own `Response` reads `Buffer`)
- [x] Snapshot test: `tests/unit/browser/browser-tool-definitions.test.ts` →
  `tests/fixtures/tool-definitions/browser-{readonly,full}.json`
- Note: with `allowWrites: false`, `SAPWrite update` still reads the object's metadata (the package allowlist check
  resolves the real package before the write gate). Same as Node; it sends no mutating request

### Phase 4: Read-only end-to-end

Results: `docs/research/2026-10-22-browser-runtime-live-read.md`.

- [x] Browser test harness: `npm run test:browser-live` (`tests/browser-live/`, `vitest.browser-live.config.ts`)
  builds the bundle and runs it in a module Worker in headless Chromium (`playwright-core` devDependency, browser
  via `npx playwright-core install chromium-headless-shell`). The backend side is an unmodified MCP SDK `Client`
  whose transport relays each message through the page. Like `test:integration`, it needs SAP credentials and
  is not in CI
- [x] Dev proxy setup (§7): `scripts/browser/dev-server.mjs` (`npm run dev:browser`) serves the harness page and
  the bundle and proxies `/sap/*`; also used by the live suite. Unit-tested in `tests/unit/browser/dev-server.test.ts`
- [x] Live reads on 7.31 (system A): SAPRead, SAPSearch, SAPNavigate, feature probe, audit user, same-origin and no
  `stateless` header. Each call must match Node ARC-1 (`handleToolCall`, same config) exactly; `SAPRead SYSTEM`
  and structure references fail on 7.31 in both. Release detection: not possible on 7.31 (no components feed),
  same as Node
- [x] Same suite on 7.57 (system B): 9/9, `SAPRead SYSTEM` works there. Found and fixed on the way: the IdP
  redirect (manual redirects, above) and `SameSite=None` cookies dropped by the dev proxy on plain HTTP; the
  suite now logs the browser context on once before the runtime starts
  - [x] Spike test 9 manually through `npm run dev:browser` in Edge on system B (log off, then call a tool):
    silent success, no credentials dialog (2026-10-22)
- [x] Re-auth error surfaces as a clear tool error (§4.4); live on 7.31 and 7.57 without a logon
- [ ] Platform team wires the tool relay (outside this repo): register the tool list from the host helper with the
  backend, relay each call through `callTool`. Decided 2026-10-23: the backend relays client tools over its own
  channel instead of running an MCP client against the browser (Phase 4b)
  - [x] Local prototype in the first host (2026-10-23, uncommitted local branches of the host's client and backend):
    the client starts the runtime from the app designer page with the bundle served cross-origin by the dev server,
    registers the tool list, and relays each call through `callTool` (60,000-character cap). Reads and `$TMP`
    writes worked end to end through the host's model, backend gates and approval card, plus `approveWrite`.
    Host-side finding: Gemini's legacy `parameters` field rejects `uniqueItems` (SAPManage), so a host must pass
    ARC-1's schemas as `parametersJsonSchema`. The console-level fix in 2.8 came from this test

### Phase 4b: Host helper (page side)

The first host has no MCP SDK in the page and loads its own scripts from its web server, not from the ABAP origin.
The helper hides the worker protocol and MCP from the host.

- [x] Standard worker entry `dist/browser/worker.js` (`src/browser/worker.ts`, logic in `worker-runtime.ts`): the
  start/ready/error/audit protocol the harness worker had, for every host. Shares chunks with `index.js`
- [x] `dist/browser/host.js` (`src/browser/host.ts`, 3.9 KB minified): a single small ESM file with no dependencies, importable from
  classic scripts with `import()`. `startBrowserRuntime({ workerUrl, options, onAudit, onToolsChanged })` starts
  the worker, then `initialize`; returns `{ apiVersion, config, instructions, listTools, callTool, close }`.
  `connectBrowserRuntime(worker, …)` for hosts that create the worker themselves
- [x] Cross-origin bundle: when `workerUrl` is on another origin, start the worker from a `blob:` module that
  imports it, so the worker runs on the page's (ABAP) origin and its ADT fetches stay same-origin. The bundle's
  server then needs CORS for the entry and every chunk, and the host CSP must allow `blob:` workers (`worker-src`)
- [x] `callTool(name, args, { signal, maxResultChars })`: abort sends `notifications/cancelled`; the opt-in cap cuts
  text content and says so in the result, with a hint to narrow the read, so a relay never has to cut blindly.
  An abort rejects at once; the runtime then aborts SAP requests only where upstream passes the request signal
  down (feeds, ATC/CI, include expansion, syntax batches). Other calls finish and their answer is dropped, so the
  next call waits for them (calls are serialized)
- [x] Answers `ping` from the server; refuses other server requests (no sampling or elicitation in v1)
- [x] Build, bundle check (host budget, no packages in `host.js`), unit tests with an in-process worker
  (`tests/unit/browser/host.test.ts`), harness page uses the helper (`harness/worker.js` removed), dev server sends
  CORS on `/bundle/*`
- [x] Live (2026-10-23, system A, 7.31): 13/13, including the helper with the bundle served by a second dev server
  on another origin: blob bootstrap, chunks loaded cross-origin, every SAP request on the page origin, parity with
  Node, result cut, audit and tool-list change forwarded. System B (7.57) not rerun

### Phase 5: Writes

Contract in §4.1 (Writes, Audit gate, Write queue). Unit tests: `tests/unit/browser/browser-writes.test.ts`, the
writes block of `host.test.ts`, `http-browser.test.ts` (`statefulWindow`). Live results:
`docs/research/2026-10-23-browser-runtime-live-write.md`.

- [x] `approveWrite` hook in the browser dispatch wrapper, using `ACTION_POLICY` scope to decide what counts as mutating; deny → tool error, nothing sent to SAP
  - Required with `allowWrites` (start fails without it); runs outside the call queue; refusal audited as `safety_blocked`
  - Through the host helper: the worker asks the page (`ask`/`answer`), and a cancelled call aborts the page's dialog
- [x] Write queue across tabs (`navigator.locks`), covering lock → modify → unlock → close-session (spike 6b: one tab's close releases another tab's locks)
  - One lock per origin, not per SAP client: the `sap-contextid` cookie is shared by every client on the origin
  - `http.ts` +6 lines (`statefulWindow`); the lock itself lives in `src/browser/write-gate.ts`
- [x] Browser transport never sends `X-sap-adt-sessiontype: stateless` outside the close request, and drops the `sap-contextid` header (HttpOnly; close works without it). Already true since 2.5; now asserted for a whole write in unit and live tests
- [x] While a stateful window is open, register a `pagehide` handler that sends a `keepalive` stateless close-session (spike 8b: releases an orphaned lock immediately instead of after ~30 min)
  - In the host helper (a worker sees no page lifecycle): the worker reports `{ arc1: 'session', open }`; stopping the runtime with a session open sends the close too
  - Sends `GET /core/http/sessions` and `HEAD /sap/bc/adt/discovery`, both stateless: on 7.31 only the second ends the context (found by the 7.31 live run)
- [x] `auditRequiredForWrites`: refuse mutations unless the host's `auditReady` hook confirms; reads unaffected
- [x] Package allowlist, deny actions and transport gates via config, same enforcement as Node (unit-tested; denied actions never reach the approval hook)
- [x] Live CRUD on `$TMP` in the browser harness: create, update, `edit_method`, activate, delete; plus lock conflict and tab-close cases (7.57 and 7.31, 8/8 each)
  - Tab close: Playwright cannot intercept a dedicated worker's requests, so the dev server got a test-only `holdRequest` option that holds the PUT at the proxy
- [x] Lint-before-write on (abaplint is already in the bundle, not lazy-loaded): verify per-write lint latency in the worker — 9–22 ms per lint of a small class (7.57)
- [x] Live writes on system A (7.31, `abapfs_extensions`): 21/21 after the `pagehide` fix above
- [ ] Decide: ARC-1's own close (`http.ts` `closeStatefulSession`) leaves the context open on 7.31 + `abapfs_extensions`
  (Node and browser). Harmless while UNLOCK succeeds; if UNLOCK fails, the lock stays until the session times out.
  Candidate upstream fix: a final `/sap/bc/adt/discovery` fallback (see §6 risk 13)

### Phase 6: Upstream proposal

- [x] Open upstream issue referencing FEAT-59 with the concrete embedding requirements (lifecycle, isolation, write safety, upgrades):
  [arc-mcp/arc-1#1149](https://github.com/arc-mcp/arc-1/issues/1149) (2026-10-30)
- [ ] ADR-0010 draft: trust model (§1.3), host-as-admin argument, safe defaults, out-of-scope list
- [ ] Docs page `docs_page/browser-runtime.md` (embedding guide; host responsibilities)
- [ ] Roadmap: narrow or replace FEAT-59 in overview and details
- [ ] Packaging (preferred 2026-10-22): a second, `@experimental` package from the same repo and release run
  (e.g. `@arc-mcp/arc-1-browser`), same version as `arc-1`, published by the same release job. It has no
  dependencies (the bundle contains everything), so browser consumers do not install Node ARC-1's ~68 MB of
  dependencies (express, undici, native `better-sqlite3`), and Node users do not carry the bundle. Fallback: ship it
  in `arc-1` as `exports["./browser"]` (+1.0 MB tarball / +4.2 MB unpacked, +68%; ~6% of the full install with
  dependencies). Ruled out: consumers building from source (the npm package ships no `src/` or build setup, and the
  esbuild setup is easy to get subtly wrong). Either way: declarations for the public API only (`tsc` does not emit
  `src/browser/`). Until then the product consumes a fork build (e.g. a GitHub release asset)
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
5. **Bundle size**: 4.38 MB minified after the 2026-10-27 sync (4.2 MB, ~1 MB gzipped on 2026-10-22); abaplint is 2.0 MB, zod 0.45 MB. abaplint is not
   lazy-loaded: 10 upstream modules use it synchronously, including read paths (Phase 3 note). Phase 4 on localhost: worker ready in
   280–360 ms; a real network download from the ABAP server is still to be measured in the host app.
6. **Prompt injection:** code read from SAP can steer the LLM toward writes. Approval UI should show object, package and a diff, not just the tool name.
7. **Upstream acceptance:** an embeddable API is a public compatibility surface (FEAT-59's concern). Mitigate with `@experimental` + `apiVersion` fuse like `arc-1/public`.
8. **Bundle served from another origin than SAP** (the host's own web server, preferred by the first host for
   updates independent of SAP transports): a module Worker must be same-origin, so the helper starts it from a
   `blob:` bootstrap (Phase 4b). Requires CORS on every bundle file and a host CSP allowing `blob:` workers and
   the bundle origin in `script-src`; a customer CSP that forbids either needs the ABAP-served variant instead.
   Loading code from another origin into the ABAP origin is the same trust step the host already takes for its
   own scripts.
9. **Open:** BTP ABAP / S/4 Cloud same-origin feasibility (not covered by v1). Audit gate shape: decided (§4.1, a
   separate `auditReady` hook).
10. **Shared ADT context across tabs:** one `sap-contextid` per browser profile; an explicit `stateless` ADT request
   from any tab ends every lock held in it. Serialize all stateful windows (including the close) under one Web Lock,
   and never send `stateless` on reads.
11. **Plain HTTP SAP origins** have no Web Locks (secure contexts only): writes from two tabs can end each other's
   locks there. The runtime warns at start; an HTTPS origin (or the ABAP-served bundle on HTTPS) avoids it.
12. **Parallel stateful sessions inside one tool call** share the browser's single ADT context (Node gives each its
   own cookie jar), so the first close would end the second's lock. No current write path opens two at once; one
   nested inside another runs without a second Web Lock request.
13. **ARC-1's close does not end the context on 7.31 + `abapfs_extensions`** (both close paths are 404, and a 404
   leaves the context open there). After a normal write only the lock-free context remains until the session
   times out; after a failed UNLOCK the lock remains too. Node is affected the same way (its context is private
   to the clone, so only the lock matters there). The page's `pagehide` close covers a closed tab.

---

## 7. Local development setup

- `npm run build:browser && npm run dev:browser` (`--target <url>`, default `TEST_SAP_URL`/`SAP_URL` from `.env`;
  `--port`, default 5173) serves the harness page **and** proxies `/sap/*` to the SAP test system, so the browser
  sees a single origin. Log in once through the proxy with a Basic challenge: open `/sap/bc/adt/discovery` on a
  Basic system. On an SSO system (system B) that URL first redirects to the IdP, whose callback goes to the real
  SAP host, so the session never reaches the proxy origin; open a path that challenges directly instead (system B:
  `/sap/opu/odata/UI5/ABAP_REPOSITORY_SRV`), or the same ADT URL a second time. Then start the runtime and call
  tools from the page. The proxy drops `Domain` (and `Secure` and `SameSite=None` on plain HTTP) from SAP cookies
  and maps SAP-origin redirects back to the local origin. With `{"allowWrites": true}` in the harness config, each
  write asks for approval in a `confirm()` dialog showing the call's arguments.
- Never commit SAP URLs, users or cookies; use `.env` (gitignored) for the proxy target.
- Use `$TMP` and `generateUniqueName()`-style names for write tests; clean up best-effort.

---

## 8. Definition of done (v1)

- [ ] Node build: zero behavior change; all upstream gates green; tool-definition fixtures byte-identical
- [ ] Browser bundle: no forbidden imports; within size budget; read and write tools pass live in a real browser on ≥2 SAP releases
- [x] Safe defaults verified: no config → read-only; writes require config + approval (+ audit if required)
- [ ] ADR-0010, docs page, roadmap update and PR descriptions with live-test evidence ready for upstream

---

## 9. Start-of-session checklist (for the coding agent)

1. Read `AGENTS.md`, this plan, `docs/security-model.md`, `docs_page/roadmap.md` (FEAT-59).
2. `git fetch upstream` and check how far `main` is behind; re-verify the §4.3 inventory (`grep -rn "from 'node:\|from 'undici'" src`), since upstream moves fast.
3. Pick the next unchecked item; one seam per branch/PR; run the full gate before each commit.
4. Update the checkboxes in this file as part of each PR.
