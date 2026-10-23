/**
 * The worker side of the host protocol (`dist/browser/worker.js`), shared by every host:
 *
 * - The page posts one `{ arc1: 'start', options }` message on the worker channel, with a MessagePort.
 *   `options` are the structured-cloneable `WorkerStartOptions`, including which hooks the page answers.
 * - MCP JSON-RPC then flows over that port.
 * - On the worker channel the worker answers `{ arc1: 'ready', apiVersion, config }` or
 *   `{ arc1: 'error', message }`, and reports each audit event as `{ arc1: 'audit', event }` and each
 *   stateful ADT session opening and closing as `{ arc1: 'session', open }`.
 * - For a page hook the worker asks `{ arc1: 'ask', id, hook, call? }` (`approveWrite` or `auditReady`); the page
 *   answers `{ arc1: 'answer', id, value }`. A call cancelled meanwhile is sent `{ arc1: 'cancel', id }`.
 *
 * The page side is `host.ts`.
 */

import type { LogSink } from '../server/sinks/types.js';
import { BROWSER_API_VERSION, type BrowserServerOptions, createBrowserServer } from './index.js';
import { type MessagePortLike, MessagePortTransport } from './message-port-transport.js';

/** The part of DedicatedWorkerGlobalScope the worker side uses. */
export interface WorkerScopeLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** The structured-cloneable start options the page sends. */
export interface WorkerStartOptions
  extends Pick<BrowserServerOptions, 'config' | 'user' | 'baseUrl' | 'auditRequiredForWrites'> {
  /** The hooks the page answers over the worker channel. */
  pageHooks?: { approveWrite?: boolean; auditReady?: boolean };
}

/** Options the page cannot send (not structured-cloneable), for hosts that write their own worker. */
export type WorkerLocalOptions = Pick<BrowserServerOptions, 'fetch' | 'sinks' | 'approveWrite' | 'auditReady'>;

/** Serve the runtime once the page sends `start`. Only the first `start` message is taken. */
export function serveBrowserRuntime(scope: WorkerScopeLike, local: WorkerLocalOptions = {}): void {
  const auditSink: LogSink = {
    write(event) {
      scope.postMessage({ arc1: 'audit', event });
    },
  };

  // Questions to the page, by id; answered on the worker channel.
  const asked = new Map<number, (value: unknown) => void>();
  let nextAsk = 1;
  const ask = (hook: 'approveWrite' | 'auditReady', call?: unknown, signal?: AbortSignal): Promise<unknown> => {
    const id = nextAsk++;
    return new Promise((resolve) => {
      const onAbort = (): void => {
        asked.delete(id);
        scope.postMessage({ arc1: 'cancel', id });
        resolve(false);
      };
      asked.set(id, (value) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      scope.postMessage({ arc1: 'ask', id, hook, ...(call === undefined ? {} : { call }) });
    });
  };
  const onAnswer = (event: MessageEvent): void => {
    if (event.data?.arc1 !== 'answer') return;
    const answer = asked.get(event.data.id);
    asked.delete(event.data.id);
    answer?.(event.data.value);
  };

  const start = async (event: MessageEvent): Promise<void> => {
    if (event.data?.arc1 !== 'start') return;
    scope.removeEventListener('message', start);
    try {
      const port = event.ports?.[0] as unknown as MessagePortLike | undefined;
      if (!port) throw new Error('The start message carries no MessagePort.');
      const { pageHooks, ...options } = (event.data.options ?? {}) as WorkerStartOptions;
      if (pageHooks?.approveWrite || pageHooks?.auditReady) scope.addEventListener('message', onAnswer);
      const server = createBrowserServer({
        ...options,
        ...(local.fetch ? { fetch: local.fetch } : {}),
        sinks: [auditSink, ...(local.sinks ?? [])],
        approveWrite:
          local.approveWrite ??
          (pageHooks?.approveWrite
            ? async (call, { signal }) => (await ask('approveWrite', call, signal)) === true
            : undefined),
        auditReady:
          local.auditReady ?? (pageHooks?.auditReady ? async () => (await ask('auditReady')) === true : undefined),
        onStatefulSessionChange: (open) => scope.postMessage({ arc1: 'session', open }),
      });
      await server.connect(new MessagePortTransport(port));
      scope.postMessage({ arc1: 'ready', apiVersion: BROWSER_API_VERSION, config: { ...server.config } });
    } catch (err) {
      scope.postMessage({ arc1: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };
  scope.addEventListener('message', start);
}
