/**
 * Browser runtime write safety: which tool calls mutate SAP (they need the host's approval and, when
 * required, a ready audit store), and the cross-tab queue for stateful ADT sessions.
 * See docs/plans/2026-10-20-browser-embedded-runtime.md (Phase 5).
 */

import { getActionPolicy, invocationPolicyKey, type Scope } from '../authz/policy.js';
import { expandHyperfocusedArgs } from '../handlers/hyperfocused.js';
import { normalizeTypeArgsForValidation } from '../handlers/object-types.js';
import { logger } from '../server/logger.js';

/** A mutating tool call, as the host's approval hook sees it. */
export interface WriteCall {
  /** The tool that runs: for the hyperfocused `SAP` tool, the tool its action maps to. */
  tool: string;
  /** The policy key: SAPRead's type or the tool's action, when the call names one. */
  action?: string;
  /** The ARC-1 scope the call needs (`write`, `transports` or `git`). */
  scope: Scope;
  /** The arguments as dispatch validates them (empty values stripped, types normalized). */
  args: Record<string, unknown>;
}

/** Approve one mutating call; anything but `true` (a throw too) refuses it before any SAP request. */
export type ApproveWrite = (call: WriteCall, context: { signal: AbortSignal }) => boolean | Promise<boolean>;

/** Whether the host's audit store can record now; checked before each mutating call when audit is required. */
export type AuditReady = () => boolean | Promise<boolean>;

const MUTATING_SCOPES: readonly Scope[] = ['write', 'transports', 'git', 'admin'];

/**
 * The mutating call behind a tool call, or undefined for reads (and for calls dispatch rejects as unknown).
 * Derived from ACTION_POLICY with the same argument normalization dispatch applies, so the approval
 * gate and the scope gate cannot classify one call differently.
 */
export function mutatingCall(tool: string, rawArgs: Record<string, unknown>): WriteCall | undefined {
  let name = tool;
  let args = rawArgs;
  if (tool === 'SAP') {
    const expanded = expandHyperfocusedArgs(rawArgs);
    if ('error' in expanded) return undefined;
    name = expanded.toolName;
    args = expanded.expandedArgs;
  }
  const normalized = normalizeTypeArgsForValidation(name, args);
  const action = invocationPolicyKey(name, normalized);
  const policy = getActionPolicy(name, action);
  if (!policy || !MUTATING_SCOPES.includes(policy.scope)) return undefined;
  return { tool: name, ...(action ? { action } : {}), scope: policy.scope, args: normalized };
}

/** The part of the Web Locks API (`navigator.locks`) the write queue uses. */
export interface LockManagerLike {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>;
}

/**
 * Web Lock that serializes stateful ADT sessions across tabs. All tabs of a browser profile share one
 * `sap-contextid` cookie (path `/sap/bc/adt`, whatever the SAP client), and closing that context in one
 * tab releases the locks another tab holds in it. Web Locks are scoped to the origin already.
 */
export const ADT_SESSION_LOCK = 'arc-1:adt-stateful-session';

/**
 * The `statefulWindow` hook for AdtHttpClient: each stateful session (lock → modify → unlock → close) holds
 * the cross-tab lock, and `onChange` reports when this runtime opens and closes one (the page's `pagehide`
 * close needs it). A session opened inside another one in this runtime (calls are serialized, so it belongs
 * to the same tool call) runs at once: Web Locks are not reentrant.
 */
export function createStatefulWindow(
  locks: LockManagerLike | undefined,
  onChange?: (open: boolean) => void,
): <T>(run: () => Promise<T>) => Promise<T> {
  let depth = 0;
  const enter = async <T>(run: () => Promise<T>): Promise<T> => {
    if (depth++ === 0) onChange?.(true);
    try {
      return await run();
    } finally {
      if (--depth === 0) onChange?.(false);
    }
  };
  return (run) => {
    if (depth > 0 || !locks) return enter(run);
    return locks.request(ADT_SESSION_LOCK, { mode: 'exclusive' }, () => enter(run));
  };
}

/** `navigator.locks`, if this context has it (secure contexts only: HTTPS or localhost). */
export function defaultLockManager(): LockManagerLike | undefined {
  return (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
}

/** Warn once when writes are on but the browser offers no Web Locks (plain HTTP): no cross-tab queue. */
export function warnWithoutLocks(allowWrites: boolean, locks: LockManagerLike | undefined): void {
  if (!allowWrites || locks) return;
  logger.warn(
    'Web Locks are unavailable (not a secure context): writes from two tabs of this browser can end each ' +
      "other's SAP locks. Serve the page over HTTPS to queue them.",
  );
}
