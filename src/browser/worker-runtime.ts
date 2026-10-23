/**
 * The worker side of the host protocol (`dist/browser/worker.js`), shared by every host:
 *
 * - The page posts one `{ arc1: 'start', options }` message on the worker channel, with a MessagePort.
 *   `options` are the structured-cloneable `BrowserServerOptions` (config, user, baseUrl).
 * - MCP JSON-RPC then flows over that port.
 * - On the worker channel the worker answers `{ arc1: 'ready', apiVersion, config }` or
 *   `{ arc1: 'error', message }`, and reports each audit event as `{ arc1: 'audit', event }`.
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

/** Options the page cannot send (not structured-cloneable), for hosts that write their own worker. */
export type WorkerLocalOptions = Pick<BrowserServerOptions, 'fetch' | 'sinks'>;

/** Serve the runtime once the page sends `start`. Only the first `start` message is taken. */
export function serveBrowserRuntime(scope: WorkerScopeLike, local: WorkerLocalOptions = {}): void {
  const auditSink: LogSink = {
    write(event) {
      scope.postMessage({ arc1: 'audit', event });
    },
  };

  const start = async (event: MessageEvent): Promise<void> => {
    if (event.data?.arc1 !== 'start') return;
    scope.removeEventListener('message', start);
    try {
      const port = event.ports?.[0] as unknown as MessagePortLike | undefined;
      if (!port) throw new Error('The start message carries no MessagePort.');
      const options = (event.data.options ?? {}) as BrowserServerOptions;
      const server = createBrowserServer({
        ...options,
        ...(local.fetch ? { fetch: local.fetch } : {}),
        sinks: [auditSink, ...(local.sinks ?? [])],
      });
      await server.connect(new MessagePortTransport(port));
      scope.postMessage({ arc1: 'ready', apiVersion: BROWSER_API_VERSION, config: { ...server.config } });
    } catch (err) {
      scope.postMessage({ arc1: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };
  scope.addEventListener('message', start);
}
