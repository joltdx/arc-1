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

Prefer **package `imports` with conditions** so Node code paths stay as they are and bundlers
pick the browser variant:

```json
"imports": {
  "#platform/*": { "browser": "./dist/platform/*.browser.js", "default": "./dist/platform/*.node.js" }
}
```

Fallback if this complicates `tsc`/vitest: runtime injection via a `platform` object set once at startup.
Decide in Phase 2.1 and use one technique consistently.

### 4.3 Node-only inventory (verified 2026-10-20 against upstream main `1ff575d9`)

| Area | Files | Browser replacement |
| --- | --- | --- |
| Outgoing HTTP | `src/adt/http.ts` (undici `Agent`/`Client`), `bounded-response.ts` (`node:stream`, undici), `request-attempt-budget.ts` (undici) | `fetchImpl` seam at `doFetch` (`http.ts` ~L1335, the single outbound choke point); no dispatcher/proxy; byte-bounding via WHATWG `ReadableStream` reader |
| Cookie jar | `http.ts` `cookieJar`, `cookies.ts` (`node:fs`) | `cookieMode: 'browser'`: no jar, no `Cookie` header, no file reload; CSRF logic unchanged |
| Stateful sessions | `http.ts` `withStatefulSession` (clones jar), close via `sap-contextid` | Browser: no jar clone possible; serialize via write queue (`navigator.locks`); close-session behavior must be re-verified (§6 risk 1) |
| Request context | `src/server/context.ts` (`AsyncLocalStorage`); `.run()` in `dispatch.ts`, `http.ts` (server), `stored-text/source.ts`; 18 modules import it | Context-provider seam; browser impl = single slot, valid because tool calls are serialized |
| Hashing / random | sync `createHash('sha256')` in `cache/cache.ts`, `source-precondition.ts`, `data-source-name.ts`, `feed-schema.ts`, `diagnostics.ts`, `stored-text/{reader,source}.ts`; `randomBytes` in `data-source-policy.ts` | `#platform/hash` (sync, pure-JS sha256, e.g. `@noble/hashes`, avoids async ripple) + `crypto.getRandomValues` |
| Compression | `http-wire-body.ts` (`gzipSync`, opt-in WAF), `stored-text/decoder.ts` (`node:zlib`, `node:util`) | WAF gzip: unsupported in browser (config refuses); stored text: `DecompressionStream` or exclude in v1 |
| Timers | `http-deadline.ts`, `ci-quality.ts` (`node:timers/promises`) | `setTimeout` promise |
| Files | `aff/validator.ts` (schema files), `lint/config-builder.ts`, `server/deny-actions.ts` | AFF schemas bundled/lazy-imported; lint config + deny actions passed as objects |
| Cache | `cache/sqlite.ts` (`better-sqlite3`) | Memory cache only |
| Server setup | `server/server.ts` `createServer` (express, XSUAA, multi-target, plugins, stdio, `node:http`) | **Do not reuse.** New small `src/browser/` entry composing `AdtClient` + `getToolDefinitions` + `handleToolCall` |
| Logging | `server/logger.ts` (`StderrSink`), `sinks/file.ts`, `runtime-memory.ts` (`node:v8`) | `ConsoleSink` + host sinks via `addSink`; memory envelope = fixed config value |
| Out of scope | `oauth.ts`, `abapgit.ts` (`node:net`), destinations, multi-target, plugin loader | Not reachable from browser entry; enforced by bundle guard |

### 4.4 Browser-specific HTTP behavior to handle

- `credentials: 'include'`; never set `Cookie` or `User-Agent` (forbidden or ignored).
- `redirect: 'manual'` yields an opaque response (status 0) in browsers; adapt the attempt-budget path.
- Session expiry: fetch follows the SAML/login redirect and gets **200 + HTML**. Detect by
  content type or `response.redirected` and raise a typed "re-authentication required" error.
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

- [ ] GET discovery (`/sap/bc/adt/discovery`) and a program source with the browser session
- [ ] CSRF fetch, then stateful lock, PUT source (`$TMP` object), unlock, activate
- [ ] Record the `sap-contextid` cookie **path** and whether closing the ADT stateful session affects the web app's own session/context
- [ ] Two tabs: concurrent lock attempts; tab closed while holding a lock (time until release)
- [ ] Session timeout: confirm what fetch returns (redirect, 200 HTML, 401)
- [ ] Repeat on oldest and newest target releases (e.g. 7.50 and 8.16) and note differences
- [ ] Record results in `docs/research/<date>-browser-adt-session-spike.md` (release, auth route, observations, gaps)
- **Go/no-go:** if the ADT stateful session cannot be isolated from the host app's session, stop and redesign before Phase 2.

### Phase 2: Node-neutral seams (behavior-preserving, each its own upstream PR)

For every seam: no tool-definition fixture diff, existing tests green, new unit tests for both implementations.

- [ ] 2.1 Decide seam technique (§4.2) with a minimal proof on one module (hash)
- [ ] 2.2 `#platform/hash` + random; replace all `node:crypto` uses in the inventory
- [ ] 2.3 Timers
- [ ] 2.4 Request-context provider (`context.ts`); keep `AsyncLocalStorage` as Node default
- [ ] 2.5 HTTP: `fetchImpl` + `cookieMode` in `AdtHttpClient` config; bounded response on web streams; manual-redirect handling
- [ ] 2.6 AFF schema loader seam (fs vs bundled)
- [ ] 2.7 Lint config / deny-actions accept in-memory config without fs
- [ ] 2.8 Logger: `ConsoleSink`; no hard dependency on `StderrSink` from shared code
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
- [ ] Write queue across tabs (`navigator.locks`, one lock name per origin + SAP client)
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
2. **Authorizations:** users need `S_ADT_RES`, `S_DEVELOP`, a developer key (on-prem), `/sap/bc/adt` active in SICF.
3. **Lock left behind** when a tab closes mid-write: held until the SAP session times out. Document it; keep lock windows short.
4. **Background-tab throttling** during ATC polling / long activation.
5. **Bundle size** (abaplint is several MB): lazy-load; lint-before-write could default off in browser.
6. **Prompt injection:** code read from SAP can steer the LLM toward writes. Approval UI should show object, package and a diff, not just the tool name.
7. **Upstream acceptance:** an embeddable API is a public compatibility surface (FEAT-59's concern). Mitigate with `@experimental` + `apiVersion` fuse like `arc-1/public`.
8. **Open:** audit gate shape (sink health vs separate gate); whether stored-text (SAPscript) is in v1; BTP ABAP / S/4 Cloud same-origin feasibility (not covered by v1).

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
