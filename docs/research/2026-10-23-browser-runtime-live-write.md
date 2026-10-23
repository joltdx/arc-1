# Browser runtime: live write test (Phase 5)

**Plan:** [browser-embedded runtime](../plans/2026-10-20-browser-embedded-runtime.md), Phase 5
**Earlier evidence:** [browser ADT session spike](2026-10-21-browser-adt-session-spike.md) (tests 6b and 8b),
[live read test](2026-10-22-browser-runtime-live-read.md) (Phase 4)
**Tooling:** `npm run test:browser-live`, block "writes on $TMP through the host helper"
(`tests/browser-live/browser-runtime.live.test.ts`)
**Status:** write path verified on system B (7.57) and system A (7.31, with `abapfs_extensions`). The 7.31 run found that ending the context there needs a stateless request to an existing resource; the `pagehide` close now sends one.

## Setup

Same as the [Phase 4 setup](2026-10-22-browser-runtime-live-read.md#setup), with these differences:

| Item | Value |
| --- | --- |
| Build | `feat/browser-runtime` at `7da712b6` plus the uncommitted Phase 5 changes; minified bundle, 4,231,482 bytes |
| Runtime start | Host helper (`host.js`) on the dev server origin, standard `worker.js` |
| Config | `{ client: <TEST_SAP_CLIENT>, allowWrites: true }`; package allowlist stays `$TMP`; lint before write on (default) |
| Approval | The harness page's `approveWrite` records each call and answers `arc1Harness.approve` (default `true`) |
| Web Locks | Available: `http://127.0.0.1` is a secure context |
| Objects | `ZARC1B_<random>` (PROG) and `ZCL_ARC1B_<random>` (CLAS) in `$TMP`; deleted at the end |

## Results: system B (7.57)

| Check | Result |
| --- | --- |
| PROG create, update, activate, read back | OK; 1.3 s / 0.2 s / 0.24 s. The page approved `SAPWrite.create`, `SAPWrite.update`, `SAPActivate` with the normalized arguments |
| Page refuses a write | Tool error "the user did not approve it"; no SAP request at all |
| CLAS create, `edit_method`, activate, read back | OK; 1.8 s / 0.34 s / 0.45 s |
| Lint latency in the worker | `SAPLint lint` on the class source: 22, 11, 9 ms (first call warms abaplint). Lint before write adds about that to each write |
| Lock held by another session (Node ARC-1 holds the program lock) | The browser update fails with SAP's lock error in 313 ms; no waiting. Node unlocks, and the lock is free again |
| Two tabs update the same program at the same time | Both succeed. The request log shows lock, close, lock, close: the Web Lock kept the two stateful sessions apart, so neither tab's close ended the other's lock (spike 6b) |
| Tab closed in the middle of a write (PUT held at the proxy, SAP holds the lock) | `pagehide` sends one keepalive stateless close-session; another session can lock the program at once (spike 8b: otherwise ~30 min). The held change never reached SAP |
| Stateless requests | Only the close-session requests |
| PROG and CLAS delete | OK; reading the program afterwards fails |

## Results: system A (7.31)

`.env` switched to system A; same suite, same setup.

| Check | Result |
| --- | --- |
| Reads (13) | All pass, parity with Node as in Phase 4 |
| PROG create, update, activate | OK; 1.7 s / 0.55 s / 0.35 s |
| CLAS create, `edit_method`, activate | OK; 1.9 s / 0.65 s / 1.4 s |
| Lint latency in the worker | 35, 15, 13 ms |
| Lock held by another session | Refused in 0.8 s |
| Two tabs | Both succeed, lock/close/lock/close |
| Tab closed mid-write, first run | **Failed**: the keepalive `GET /core/http/sessions` reached SAP (404), and Node still could not lock the program 20 s later |
| Tab closed mid-write, after the fix | Passes: `pagehide` also sends `HEAD /sap/bc/adt/discovery`; another session locks the program at once |

### Which stateless request ends the context on 7.31

A throwaway experiment (one program each, PUT held at the proxy, lock held by the browser's context; another tab
of the same browser sends one stateless request, then Node ARC-1 tries to lock):

| Stateless request | SAP answer | Lock released? | Held PUT afterwards |
| --- | --- | --- | --- |
| `GET /sap/bc/adt/core/http/sessions` (keepalive on `pagehide`, or from another tab) | 404 | No, still locked after 20 s | 200: the context and handle are still valid |
| `HEAD /sap/bc/adt/core/discovery` | 404 | No | 200 |
| `HEAD /sap/bc/adt/discovery` | 400 | Yes, within 0.6 s | 423: the context ended |
| `GET /sap/bc/adt/discovery` | 200 | Yes, within 0.6 s | 423 |
| Normal completion (UNLOCK) | — | Yes | — |

So a 404 is answered before the stateless switch takes effect; a request to an existing resource ends the context.
This corrects the Phase 1 spike, which sent all three close requests in a row and credited the first. ARC-1's own
close (`/core/http/sessions`, then `/core/discovery`) therefore never ends the context on 7.31 +
`abapfs_extensions`, in Node or in the browser; UNLOCK still releases the lock in every normal write. Open
decision in the plan (Phase 5, §6 risk 13).

## Findings

- **Playwright cannot intercept a dedicated worker's requests** (`context.route` misses them; they still appear in
  `context.on('request')`). To hold the PUT, the dev server got a test-only `holdRequest` option.
- **A closed page's keepalive request** does not appear in the context's request events; the test counts it at the
  proxy instead.
- **Approval outside the queue:** the approval hook may call `SAPRead` through the same runtime (for a diff) without
  waiting for the write it is deciding on. Unit-tested; the harness does not show a diff.

## Gaps

- None per system: after the `pagehide` change both systems were rerun, 21/21 each (7.57: lint 21, 9, 9 ms; lock
  refusal 0.66 s).
- Not covered live: transport writes, RAP and DDIC writes, a host's real
  audit store behind `auditReady` (unit-tested only).
