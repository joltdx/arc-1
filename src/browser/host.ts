/**
 * Page side of the ARC-1 browser runtime (`dist/browser/host.js`, @experimental): starts the runtime worker
 * and calls its tools, so a host page needs neither an MCP SDK nor the worker protocol (worker-runtime.ts).
 *
 * A single small ES module with no dependencies; classic scripts load it with `import()`:
 *
 *   const { startBrowserRuntime } = await import('https://host.example/arc1/host.js');
 *   const arc1 = await startBrowserRuntime({ workerUrl: 'https://host.example/arc1/worker.js',
 *     options: { config: { allowWrites: false }, user: 'DEVELOPER' }, onAudit: (event) => … });
 *   const tools = await arc1.listTools();
 *   const result = await arc1.callTool('SAPRead', { type: 'PROG', name: 'ZHELLO' }, { maxResultChars: 60_000 });
 *
 * Only type imports here: anything else would pull the runtime's dependencies into this file.
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BrowserServerConfig } from './config.js';
import type { WriteCall } from './write-gate.js';

export type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
export type { WriteCall } from './write-gate.js';

/** MCP protocol version the helper asks for; the runtime's SDK supports it (checked by a unit test). */
export const HOST_PROTOCOL_VERSION = '2025-11-25';

/** The structured-cloneable part of `BrowserServerOptions`, sent to the worker. */
export interface BrowserRuntimeOptions {
  config?: Partial<BrowserServerConfig>;
  user?: string;
  baseUrl?: string;
  /** Refuse mutating calls unless `auditReady` (in `ConnectOptions`) answers `true`. */
  auditRequiredForWrites?: boolean;
}

export interface ConnectOptions {
  options?: BrowserRuntimeOptions;
  /** Every audit event the runtime records, e.g. to forward to the host's audit store. */
  onAudit?: (event: Record<string, unknown>) => void;
  /** The current tool list after the runtime narrowed it (feature probe), e.g. to register it again. */
  onToolsChanged?: (tools: Tool[]) => void;
  /** Called once when the runtime stops unexpectedly (worker error); calls in flight are rejected. */
  onError?: (error: Error) => void;
  /**
   * Approve each mutating call (write, transport or git scope); required with `config.allowWrites`. Anything
   * but `true` refuses it before any SAP request. `signal` aborts when the call is cancelled meanwhile. Show
   * the object, package and change, not only the tool name: the model may have been steered by code it read.
   */
  approveWrite?: (call: WriteCall, context: { signal: AbortSignal }) => boolean | Promise<boolean>;
  /** Whether the host's audit store can record now; required with `options.auditRequiredForWrites`. */
  auditReady?: () => boolean | Promise<boolean>;
  clientInfo?: { name: string; version: string };
  /** Time for the worker to load and start, in ms (default 30 000). */
  startTimeoutMs?: number;
}

export interface StartOptions extends ConnectOptions {
  /** URL of `worker.js`. On another origin than the page, the worker starts from a `blob:` bootstrap. */
  workerUrl: string | URL;
}

export interface CallToolOptions {
  /** Aborting cancels the call in the runtime and rejects with an `AbortError`. */
  signal?: AbortSignal;
  /** Cut the result's text to this many characters and say so in the result (default: no cut). */
  maxResultChars?: number;
}

export interface BrowserRuntime {
  readonly apiVersion: number;
  /** The resolved runtime configuration. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly serverInfo: { name: string; version: string };
  /** Server instructions for the model (from `initialize`), if any. */
  readonly instructions?: string;
  listTools(): Promise<Tool[]>;
  /** Tool errors come back as a result with `isError: true`; protocol errors reject. */
  callTool(name: string, args?: Record<string, unknown>, options?: CallToolOptions): Promise<CallToolResult>;
  /** Stop the worker; calls in flight are rejected. */
  close(): void;
}

/** The part of Worker the helper uses. */
export interface WorkerLike {
  postMessage(message: unknown, transfer: unknown[]): void;
  addEventListener(type: 'message' | 'error', listener: (event: Event) => void): void;
  removeEventListener(type: 'message' | 'error', listener: (event: Event) => void): void;
  terminate(): void;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** A JSON-RPC error answer from the runtime. */
export class BrowserRuntimeError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'BrowserRuntimeError';
  }
}

const JSONRPC_METHOD_NOT_FOUND = -32601;

type WorkerConstructor = new (url: string | URL, options: { type: 'module'; name: string }) => WorkerLike;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The call was aborted.', 'AbortError');
}

/** Start the runtime worker from `workerUrl` and connect to it. */
export async function startBrowserRuntime(options: StartOptions): Promise<BrowserRuntime> {
  const page = (globalThis as { location?: { href: string; origin: string } }).location;
  const url = new URL(options.workerUrl, page?.href);
  let bootstrap: string | undefined;
  const Worker = (globalThis as unknown as { Worker: WorkerConstructor }).Worker;
  let worker: WorkerLike;
  if (page && url.origin !== page.origin) {
    // A module worker must be same-origin. Started from a blob, it runs on the page's origin (so ADT fetches
    // stay same-origin) and imports the runtime cross-origin, which needs CORS on every bundle file.
    const source = `import ${JSON.stringify(url.href)};`;
    bootstrap = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    worker = new Worker(bootstrap, { type: 'module', name: 'arc-1' });
  } else {
    worker = new Worker(url, { type: 'module', name: 'arc-1' });
  }
  try {
    return await connectBrowserRuntime(worker, options);
  } finally {
    if (bootstrap) URL.revokeObjectURL(bootstrap);
  }
}

/** Connect to a runtime worker the host created itself (it must run `worker.js` or `serveBrowserRuntime`). */
export async function connectBrowserRuntime(worker: WorkerLike, options: ConnectOptions = {}): Promise<BrowserRuntime> {
  const channel = new MessageChannel();
  const port = channel.port1;
  const pending = new Map<string | number, { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let stopped: Error | undefined;

  // While the runtime holds a stateful ADT session (SAP locks), leaving the page must close it, or SAP keeps
  // the locks until the session times out. A keepalive request outlives the page; stopping the worker does too.
  const page = globalThis as {
    addEventListener?(type: 'pagehide', listener: () => void): void;
    removeEventListener?(type: 'pagehide', listener: () => void): void;
  };
  let closeSessionUrls: Array<[method: string, url: string]> = [];
  let sessionOpen = false;
  const closeSession = (): void => {
    if (!sessionOpen) return;
    sessionOpen = false;
    page.removeEventListener?.('pagehide', closeSession);
    for (const [method, url] of closeSessionUrls) {
      fetch(url, {
        method,
        credentials: 'include',
        keepalive: true,
        headers: { Accept: '*/*', 'sap-adt-purpose': 'close-session', 'X-sap-adt-sessiontype': 'stateless' },
      }).catch(() => undefined);
    }
  };
  const asked = new Map<number, AbortController>();

  const stop = (error: Error): void => {
    if (stopped) return;
    stopped = error;
    closeSession();
    for (const controller of asked.values()) controller.abort();
    asked.clear();
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    worker.removeEventListener('message', onWorkerMessage);
    worker.removeEventListener('error', onWorkerError);
    port.close();
    worker.terminate();
  };

  const post = (message: JsonRpcMessage): void => {
    if (stopped) throw stopped;
    port.postMessage(message);
  };

  const request = (method: string, params: Record<string, unknown>, signal?: AbortSignal) => {
    if (stopped) return Promise.reject(stopped);
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const id = nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const onAbort = (): void => {
        if (!pending.delete(id)) return;
        // The runtime aborts the tool call; a late answer to this id is dropped.
        post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'aborted' } });
        reject(abortError(signal as AbortSignal));
      };
      pending.set(id, {
        resolve: (message) => {
          signal?.removeEventListener('abort', onAbort);
          if (message.error) reject(new BrowserRuntimeError(message.error.message, message.error.code));
          else resolve(message.result ?? {});
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      post({ jsonrpc: '2.0', id, method, params });
    });
  };

  const listTools = async (): Promise<Tool[]> => {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await request('tools/list', cursor ? { cursor } : {});
      tools.push(...((page.tools as Tool[] | undefined) ?? []));
      cursor = page.nextCursor as string | undefined;
    } while (cursor);
    return tools;
  };

  port.addEventListener('message', (event) => {
    const message = (event as MessageEvent).data as JsonRpcMessage;
    if (message?.jsonrpc !== '2.0') return;
    if (message.method === undefined && message.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      waiter?.resolve(message);
    } else if (message.method !== undefined && message.id !== undefined) {
      // Server requests: answer ping; v1 has no sampling, roots or elicitation.
      if (message.method === 'ping') post({ jsonrpc: '2.0', id: message.id, result: {} });
      else
        post({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: JSONRPC_METHOD_NOT_FOUND, message: `Not supported by the host: ${message.method}` },
        });
    } else if (message.method === 'notifications/tools/list_changed' && options.onToolsChanged) {
      const notify = options.onToolsChanged;
      listTools().then(notify, () => undefined);
    }
  });
  port.start();

  let started: { resolve: (data: { apiVersion: number; config: Record<string, unknown> }) => void } | undefined;
  const answer = async (id: number, hook: unknown, call: WriteCall): Promise<void> => {
    const controller = new AbortController();
    asked.set(id, controller);
    let value = false;
    try {
      if (hook === 'approveWrite') value = (await options.approveWrite?.(call, { signal: controller.signal })) === true;
      else if (hook === 'auditReady') value = (await options.auditReady?.()) === true;
    } catch {
      value = false;
    }
    if (asked.delete(id) && !stopped) worker.postMessage({ arc1: 'answer', id, value }, []);
  };
  const onWorkerMessage = (event: Event): void => {
    const data = (event as MessageEvent).data;
    if (data?.arc1 === 'audit') options.onAudit?.(data.event);
    else if (data?.arc1 === 'ask') void answer(data.id, data.hook, data.call);
    else if (data?.arc1 === 'cancel') asked.get(data.id)?.abort();
    else if (data?.arc1 === 'session' && !data.open) {
      sessionOpen = false;
      page.removeEventListener?.('pagehide', closeSession);
    } else if (data?.arc1 === 'session') {
      sessionOpen = true;
      page.addEventListener?.('pagehide', closeSession);
    } else if (data?.arc1 === 'ready') started?.resolve(data);
    else if (data?.arc1 === 'error') stop(new BrowserRuntimeError(`ARC-1 runtime failed to start: ${data.message}`));
  };
  const onWorkerError = (event: Event): void => {
    const message = (event as { message?: string }).message || 'the worker failed to load or crashed';
    const error = new BrowserRuntimeError(`ARC-1 runtime stopped: ${message}`);
    const running = started === undefined;
    stop(error);
    if (running) options.onError?.(error);
  };
  worker.addEventListener('message', onWorkerMessage);
  worker.addEventListener('error', onWorkerError);

  const timeoutMs = options.startTimeoutMs ?? 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await new Promise<{ apiVersion: number; config: Record<string, unknown> }>((resolve, reject) => {
      started = { resolve };
      // stop() rejects every pending waiter: park one under a key no JSON-RPC answer uses.
      pending.set('arc1:start', { resolve: () => undefined, reject });
      timer = setTimeout(
        () => stop(new BrowserRuntimeError(`ARC-1 runtime did not start within ${timeoutMs} ms.`)),
        timeoutMs,
      );
      const pageHooks = { approveWrite: !!options.approveWrite, auditReady: !!options.auditReady };
      worker.postMessage({ arc1: 'start', options: { ...options.options, pageHooks } }, [channel.port2]);
    });
    pending.delete('arc1:start');
    clearTimeout(timer);
    started = undefined;
    const base = options.options?.baseUrl ?? (globalThis as { location?: { origin: string } }).location?.origin;
    if (base) {
      // Any stateless request to an existing ADT resource ends the context and its locks. Below 7.50 the close
      // resource is missing, and a 404 leaves the context open (7.31 + abapfs_extensions), so discovery follows.
      const adtUrl = (path: string): string => {
        const url = new URL(path, base);
        if (ready.config.client) url.searchParams.set('sap-client', String(ready.config.client));
        return url.href;
      };
      closeSessionUrls = [
        ['GET', adtUrl('/sap/bc/adt/core/http/sessions')],
        ['HEAD', adtUrl('/sap/bc/adt/discovery')],
      ];
    }

    const init = await request('initialize', {
      protocolVersion: HOST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: options.clientInfo ?? { name: 'arc-1-host', version: String(ready.apiVersion) },
    });
    post({ jsonrpc: '2.0', method: 'notifications/initialized' });

    return {
      apiVersion: ready.apiVersion,
      config: Object.freeze({ ...ready.config }),
      serverInfo: init.serverInfo as { name: string; version: string },
      instructions: init.instructions as string | undefined,
      listTools,
      async callTool(name, args = {}, callOptions = {}) {
        const result = (await request(
          'tools/call',
          { name, arguments: args },
          callOptions.signal,
        )) as unknown as CallToolResult;
        return callOptions.maxResultChars === undefined ? result : capResultText(result, callOptions.maxResultChars);
      },
      close: () => stop(new BrowserRuntimeError('ARC-1 runtime closed.')),
    };
  } catch (err) {
    clearTimeout(timer);
    stop(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

/** Cut a result's text parts to `max` characters in total and append a notice the model can act on. */
export function capResultText(result: CallToolResult, max: number): CallToolResult {
  const parts = result.content ?? [];
  const total = parts.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 0), 0);
  if (total <= max) return result;
  let left = Math.max(0, max);
  const content: CallToolResult['content'] = [];
  for (const part of parts) {
    if (part.type !== 'text') {
      content.push(part);
      continue;
    }
    if (left === 0) continue;
    const keep = Math.min(part.text.length, left);
    left -= keep;
    content.push(keep < part.text.length ? { ...part, text: part.text.slice(0, keep) } : part);
  }
  content.push({
    type: 'text',
    text:
      `[Result cut to ${max} of ${total} characters by the host. Narrow the request, for example SAPRead ` +
      'with method, grep or lineStart/lineEnd.]',
  });
  return { ...result, content };
}
