import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BrowserRuntime,
  BrowserRuntimeError,
  type CallToolResult,
  capResultText,
  connectBrowserRuntime,
  HOST_PROTOCOL_VERSION,
  startBrowserRuntime,
  type WorkerLike,
} from '../../../src/browser/host.js';
import {
  serveBrowserRuntime,
  type WorkerLocalOptions,
  type WorkerScopeLike,
} from '../../../src/browser/worker-runtime.js';
import { resetCachedFeatures } from '../../../src/handlers/feature-cache.js';
import { mockResponse } from '../../helpers/mock-fetch.js';

const BASE_URL = 'https://sap.example.com';
const PROGRAM_PATH = '/sap/bc/adt/programs/programs/ZHELLO/source/main';

type Route = (url: URL, init: RequestInit) => Response | Promise<Response | undefined> | undefined;

function routedFetch(...routes: Route[]) {
  return vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(String(input));
    for (const route of routes) {
      const response = await route(url, init);
      if (response) return response;
    }
    return mockResponse(404, 'not found', { 'content-type': 'text/plain' });
  });
}

const programRoute: Route = (url) =>
  url.pathname === PROGRAM_PATH
    ? mockResponse(200, "REPORT zhello.\nWRITE 'hi'.", { 'content-type': 'text/plain' })
    : undefined;

/** A worker whose scope runs in this process: the page and worker sides talk over a real MessageChannel. */
class InProcessWorker implements WorkerLike {
  readonly control = new MessageChannel();
  private readonly errors = new EventTarget();
  terminated = false;

  /** The worker side; `serveBrowserRuntime` by default, or a raw protocol fake. */
  get scope(): WorkerScopeLike {
    return this.control.port2 as unknown as WorkerScopeLike;
  }

  postMessage(message: unknown, transfer: unknown[]): void {
    this.control.port1.postMessage(message, transfer as never);
  }

  addEventListener(type: 'message' | 'error', listener: (event: Event) => void): void {
    if (type === 'error') this.errors.addEventListener('error', listener);
    else this.control.port1.addEventListener('message', listener);
  }

  removeEventListener(type: 'message' | 'error', listener: (event: Event) => void): void {
    if (type === 'error') this.errors.removeEventListener('error', listener);
    else this.control.port1.removeEventListener('message', listener);
  }

  terminate(): void {
    this.terminated = true;
    this.control.port1.close();
  }

  crash(message: string): void {
    this.errors.dispatchEvent(Object.assign(new Event('error'), { message }));
  }
}

function runtimeWorker(local: WorkerLocalOptions): InProcessWorker {
  const worker = new InProcessWorker();
  serveBrowserRuntime(worker.scope, local);
  return worker;
}

interface RawRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** A worker that speaks the start protocol and hands every JSON-RPC message to `answer`. */
function rawWorker(answer: (message: RawRequest, reply: (message: unknown) => void) => void): InProcessWorker {
  const worker = new InProcessWorker();
  worker.scope.addEventListener('message', (event) => {
    if (event.data?.arc1 !== 'start') return;
    const port = event.ports[0] as unknown as InstanceType<typeof MessageChannel>['port1'];
    port.addEventListener('message', (message) =>
      answer((message as MessageEvent).data as RawRequest, (m) => port.postMessage(m)),
    );
    port.start();
    worker.scope.postMessage({ arc1: 'ready', apiVersion: 1, config: { allowWrites: false } });
  });
  return worker;
}

function initializeAnswer(message: RawRequest, reply: (message: unknown) => void): boolean {
  if (message.method !== 'initialize') return false;
  reply({
    jsonrpc: '2.0',
    id: message.id,
    result: { protocolVersion: HOST_PROTOCOL_VERSION, serverInfo: { name: 'fake', version: '0' }, capabilities: {} },
  });
  return true;
}

function text(result: CallToolResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

describe('browser runtime host helper', () => {
  let runtime: BrowserRuntime | undefined;

  beforeEach(() => {
    resetCachedFeatures();
  });

  afterEach(() => {
    runtime?.close();
    runtime = undefined;
    vi.unstubAllGlobals();
  });

  it('asks for a protocol version the runtime supports', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(HOST_PROTOCOL_VERSION);
  });

  it('starts the runtime, initializes and lists its tools', async () => {
    const worker = runtimeWorker({ fetch: routedFetch() });
    runtime = await connectBrowserRuntime(worker, { options: { baseUrl: BASE_URL, user: 'developer' } });

    expect(runtime.apiVersion).toBe(1);
    expect(runtime.config).toMatchObject({ allowWrites: false, username: 'DEVELOPER' });
    expect(runtime.serverInfo.name).toBe('arc-1');
    const names = (await runtime.listTools()).map((tool) => tool.name);
    expect(names).toContain('SAPRead');
    expect(names).not.toContain('SAPWrite');
  });

  it('calls tools and forwards the audit events with the host user', async () => {
    const audit: Record<string, unknown>[] = [];
    const worker = runtimeWorker({ fetch: routedFetch(programRoute) });
    runtime = await connectBrowserRuntime(worker, {
      options: { baseUrl: BASE_URL, user: 'developer' },
      onAudit: (event) => audit.push(event),
    });

    const result = await runtime.callTool('SAPRead', { type: 'PROG', name: 'ZHELLO' });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('REPORT zhello.');
    await vi.waitFor(() =>
      expect(audit).toContainEqual(
        expect.objectContaining({ event: 'tool_call_end', tool: 'SAPRead', user: 'DEVELOPER' }),
      ),
    );
  });

  it('returns tool errors as results', async () => {
    const worker = runtimeWorker({ fetch: routedFetch() });
    runtime = await connectBrowserRuntime(worker, { options: { baseUrl: BASE_URL } });

    const result = await runtime.callTool('SAPWrite', { action: 'delete', type: 'PROG', name: 'ZHELLO' });

    expect(result.isError).toBe(true);
  });

  it('reports the narrowed tool list after the feature probe', async () => {
    const changed = vi.fn();
    const worker = runtimeWorker({ fetch: routedFetch() });
    runtime = await connectBrowserRuntime(worker, { options: { baseUrl: BASE_URL }, onToolsChanged: changed });

    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(changed.mock.calls[0]![0].map((tool: { name: string }) => tool.name)).toContain('SAPRead');
  });

  it('rejects an aborted call at once; the runtime finishes it and keeps serving', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    const slow: Route = async (url, init) => {
      if (url.pathname !== PROGRAM_PATH) return undefined;
      reached = true;
      await gate;
      return programRoute(url, init);
    };
    const worker = runtimeWorker({ fetch: routedFetch(slow) });
    runtime = await connectBrowserRuntime(worker, { options: { baseUrl: BASE_URL } });
    const controller = new AbortController();

    const call = runtime.callTool('SAPRead', { type: 'PROG', name: 'ZHELLO' }, { signal: controller.signal });
    await vi.waitFor(() => expect(reached).toBe(true));
    controller.abort();
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });

    release();
    const next = await runtime.callTool('SAPRead', { type: 'PROG', name: 'ZHELLO' });
    expect(text(next)).toContain('REPORT zhello.');
  });

  it('sends notifications/cancelled on abort and drops the late answer', async () => {
    const seen: RawRequest[] = [];
    let lateAnswer: (() => void) | undefined;
    const worker = rawWorker((message, reply) => {
      seen.push(message);
      if (initializeAnswer(message, reply)) return;
      if (message.method === 'tools/call' && message.params?.name === 'SLOW') {
        lateAnswer = () => reply({ jsonrpc: '2.0', id: message.id, result: { content: [] } });
      } else if (message.method === 'tools/call') {
        reply({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } });
      }
    });
    runtime = await connectBrowserRuntime(worker);
    const controller = new AbortController();

    const call = runtime.callTool('SLOW', {}, { signal: controller.signal });
    await vi.waitFor(() => expect(lateAnswer).toBeDefined());
    controller.abort();
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() =>
      expect(seen).toContainEqual({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: expect.any(Number), reason: 'aborted' },
      }),
    );
    lateAnswer?.();

    expect(text(await runtime.callTool('FAST'))).toBe('ok');
  });

  it('rejects at once for an already aborted signal', async () => {
    const worker = runtimeWorker({ fetch: routedFetch() });
    runtime = await connectBrowserRuntime(worker, { options: { baseUrl: BASE_URL } });
    await expect(runtime.callTool('SAPRead', {}, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('cuts the result text on request', async () => {
    const worker = runtimeWorker({ fetch: routedFetch(programRoute) });
    runtime = await connectBrowserRuntime(worker, { options: { baseUrl: BASE_URL } });

    const result = await runtime.callTool('SAPRead', { type: 'PROG', name: 'ZHELLO' }, { maxResultChars: 6 });

    expect(result.content[0]).toEqual({ type: 'text', text: 'REPORT' });
    expect(text(result)).toMatch(/Result cut to 6 of \d+ characters by the host/);
  });

  it('fails the start with the runtime error and stops the worker', async () => {
    const worker = runtimeWorker({ fetch: routedFetch() });
    const start = connectBrowserRuntime(worker, {
      options: { baseUrl: BASE_URL, config: { url: 'https://other' } as never },
    });

    await expect(start).rejects.toThrow(/ARC-1 runtime failed to start: .*url/);
    expect(worker.terminated).toBe(true);
  });

  it('fails the start when the worker does not answer in time', async () => {
    const worker = new InProcessWorker();
    await expect(connectBrowserRuntime(worker, { startTimeoutMs: 20 })).rejects.toThrow(/did not start within 20 ms/);
    expect(worker.terminated).toBe(true);
  });

  it('fails the start when the worker cannot load', async () => {
    const worker = new InProcessWorker();
    const start = connectBrowserRuntime(worker);
    worker.crash('404 worker.js');
    await expect(start).rejects.toThrow(/ARC-1 runtime stopped: 404 worker.js/);
  });

  it('rejects calls in flight and reports a crash after the start', async () => {
    const onError = vi.fn();
    const worker = rawWorker((message, reply) => {
      initializeAnswer(message, reply);
    });
    runtime = await connectBrowserRuntime(worker, { onError });

    const call = runtime.callTool('SAPRead', {});
    worker.crash('out of memory');

    await expect(call).rejects.toThrow(/ARC-1 runtime stopped: out of memory/);
    expect(onError).toHaveBeenCalledOnce();
    expect(worker.terminated).toBe(true);
    await expect(runtime.listTools()).rejects.toBeInstanceOf(BrowserRuntimeError);
  });

  it('rejects calls after close', async () => {
    const worker = rawWorker((message, reply) => {
      initializeAnswer(message, reply);
    });
    runtime = await connectBrowserRuntime(worker);
    const call = runtime.callTool('SAPRead', {});
    runtime.close();
    await expect(call).rejects.toThrow('ARC-1 runtime closed.');
    expect(worker.terminated).toBe(true);
  });

  it('pages through tools/list and raises JSON-RPC errors', async () => {
    const worker = rawWorker((message, reply) => {
      if (initializeAnswer(message, reply)) return;
      if (message.method === 'tools/list') {
        const second = message.params?.cursor === 'page2';
        reply({
          jsonrpc: '2.0',
          id: message.id,
          result: second ? { tools: [{ name: 'B' }] } : { tools: [{ name: 'A' }], nextCursor: 'page2' },
        });
      } else if (message.method === 'tools/call') {
        reply({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool: X' } });
      }
    });
    runtime = await connectBrowserRuntime(worker);

    expect((await runtime.listTools()).map((tool) => tool.name)).toEqual(['A', 'B']);
    await expect(runtime.callTool('X')).rejects.toMatchObject({ name: 'BrowserRuntimeError', code: -32602 });
  });

  it('answers ping and refuses other server requests', async () => {
    const replies: RawRequest[] = [];
    let send: ((message: unknown) => void) | undefined;
    const worker = rawWorker((message, reply) => {
      send = reply;
      if (initializeAnswer(message, reply)) return;
      if (message.method === undefined) replies.push(message);
    });
    runtime = await connectBrowserRuntime(worker);

    send?.({ jsonrpc: '2.0', id: 's1', method: 'ping' });
    send?.({ jsonrpc: '2.0', id: 's2', method: 'sampling/createMessage', params: {} });

    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[0]).toEqual({ jsonrpc: '2.0', id: 's1', result: {} });
    expect(replies[1]).toMatchObject({ id: 's2', error: { code: -32601 } });
  });

  describe('startBrowserRuntime', () => {
    function stubBrowser(origin: string) {
      const created: Array<{ url: string; options: unknown }> = [];
      const blobs: string[] = [];
      const revoked: string[] = [];
      vi.stubGlobal('location', { href: `${origin}/app/index.html`, origin });
      vi.stubGlobal(
        'Worker',
        class extends InProcessWorker {
          constructor(url: string | URL, options: unknown) {
            super();
            created.push({ url: String(url), options });
            serveBrowserRuntime(this.scope, { fetch: routedFetch() });
          }
        },
      );
      vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
        blobs.push(blob as unknown as string);
        return 'blob:https://sap.example.com/1';
      });
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
        revoked.push(url);
      });
      return { created, blobs, revoked };
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('loads a same-origin worker directly', async () => {
      const { created, blobs } = stubBrowser(BASE_URL);
      runtime = await startBrowserRuntime({ workerUrl: '/arc1/worker.js', options: { baseUrl: BASE_URL } });

      expect(created).toEqual([{ url: `${BASE_URL}/arc1/worker.js`, options: { type: 'module', name: 'arc-1' } }]);
      expect(blobs).toEqual([]);
    });

    it('starts a worker from another origin through a blob bootstrap on the page origin', async () => {
      const { created, blobs, revoked } = stubBrowser(BASE_URL);
      runtime = await startBrowserRuntime({
        workerUrl: 'https://portal.example.com/arc1/worker.js',
        options: { baseUrl: BASE_URL },
      });

      expect(created).toEqual([{ url: 'blob:https://sap.example.com/1', options: { type: 'module', name: 'arc-1' } }]);
      expect(await (blobs[0] as unknown as Blob).text()).toBe('import "https://portal.example.com/arc1/worker.js";');
      expect(revoked).toEqual(['blob:https://sap.example.com/1']);
    });
  });
});

describe('capResultText', () => {
  const result = (...parts: CallToolResult['content']): CallToolResult => ({ content: parts });

  it('keeps a result within the limit unchanged', () => {
    const input = result({ type: 'text', text: 'abc' });
    expect(capResultText(input, 3)).toBe(input);
  });

  it('cuts across text parts, keeps other parts and keeps isError', () => {
    const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' };
    const capped = capResultText(
      {
        ...result({ type: 'text', text: 'abcd' }, image, { type: 'text', text: 'efgh' }, { type: 'text', text: 'ij' }),
        isError: true,
      },
      6,
    );

    expect(capped.isError).toBe(true);
    expect(capped.content.slice(0, 3)).toEqual([{ type: 'text', text: 'abcd' }, image, { type: 'text', text: 'ef' }]);
    expect(capped.content).toHaveLength(4);
    expect(capped.content[3]).toMatchObject({ type: 'text', text: expect.stringMatching(/cut to 6 of 10 characters/) });
  });
});
