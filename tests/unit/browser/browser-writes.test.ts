import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BrowserServer, createBrowserServer } from '../../../src/browser/index.js';
import {
  ADT_SESSION_LOCK,
  createStatefulWindow,
  type LockManagerLike,
  mutatingCall,
  type WriteCall,
} from '../../../src/browser/write-gate.js';
import { resetCachedFeatures } from '../../../src/handlers/feature-cache.js';
import type { AuditEvent } from '../../../src/server/audit.js';
import { mockResponse } from '../../helpers/mock-fetch.js';

const BASE_URL = 'https://sap.example.com';
const PROGRAM_URL = '/sap/bc/adt/programs/programs/ZHELLO';
const SOURCE = "REPORT zhello.\nWRITE 'hi'.";
const LOCK_BODY =
  '<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><LOCK_HANDLE>H1</LOCK_HANDLE>' +
  '<CORRNR></CORRNR><IS_LOCAL>X</IS_LOCAL></DATA></asx:values></asx:abap>';

function programXml(pkg: string): string {
  return (
    '<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs" ' +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZHELLO"><adtcore:packageRef adtcore:name="${pkg}"/>` +
    '</program:abapProgram>'
  );
}

interface SentRequest {
  method: string;
  path: string;
  action: string | null;
  headers: Record<string, string>;
}

/** A fake ADT system for one program: metadata, source, CSRF, lock, PUT, unlock and close-session. */
function fakeSap(pkg = '$TMP') {
  const sent: SentRequest[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = { ...(init.headers as Record<string, string>) };
    sent.push({ method, path: url.pathname, action: url.searchParams.get('_action'), headers });
    if (headers['X-CSRF-Token'] === 'fetch') return mockResponse(200, '', { 'x-csrf-token': 'TOKEN' });
    if (url.pathname === PROGRAM_URL && method === 'GET') {
      return mockResponse(200, programXml(pkg), { 'content-type': 'application/vnd.sap.adt.programs.programs.v2+xml' });
    }
    if (url.pathname === `${PROGRAM_URL}/source/main` && method === 'GET') {
      return mockResponse(200, SOURCE, { 'content-type': 'text/plain' });
    }
    if (url.pathname === PROGRAM_URL && url.searchParams.get('_action') === 'LOCK') {
      return mockResponse(200, LOCK_BODY, { 'content-type': 'application/vnd.sap.as+xml' });
    }
    if (url.pathname === PROGRAM_URL && url.searchParams.get('_action') === 'UNLOCK') return mockResponse(200, '');
    if (url.pathname === `${PROGRAM_URL}/source/main` && method === 'PUT') return mockResponse(200, '');
    if (url.pathname === '/sap/bc/adt/core/http/sessions') return mockResponse(200, '');
    return mockResponse(404, 'not found', { 'content-type': 'text/plain' });
  });
  const mutating = () => sent.filter((request) => !['GET', 'HEAD'].includes(request.method));
  return { fetchImpl, sent, mutating };
}

/** A Web Lock stand-in that records each request and runs the callbacks one at a time. */
function fakeLocks() {
  const names: string[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  const locks: LockManagerLike = {
    request(name, _options, callback) {
      names.push(name);
      const run = tail.then(callback);
      tail = run.catch(() => undefined);
      return run;
    },
  };
  return { locks, names };
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join('\n');
}

const UPDATE = { action: 'update', type: 'PROG', name: 'ZHELLO', source: "REPORT zhello.\nWRITE 'bye'." };

describe('mutatingCall', () => {
  it('classifies by ACTION_POLICY scope with the normalization dispatch applies', () => {
    expect(mutatingCall('SAPRead', { type: 'PROG', name: 'ZHELLO' })).toBeUndefined();
    expect(mutatingCall('SAPSearch', { query: 'Z*' })).toBeUndefined();
    expect(mutatingCall('SAPQuery', { action: 'sql', sql: 'SELECT 1' })).toBeUndefined();
    expect(mutatingCall('SAPDiagnose', { action: 'atc', type: 'PROG', name: 'ZHELLO' })).toBeUndefined();
    expect(mutatingCall('SAPTransport', { action: 'list' })).toBeUndefined();

    expect(mutatingCall('SAPWrite', { ...UPDATE, transport: '' })).toEqual({
      tool: 'SAPWrite',
      action: 'update',
      scope: 'write',
      args: { action: 'update', type: 'PROG', name: 'ZHELLO', source: UPDATE.source },
    });
    expect(mutatingCall('SAPActivate', { type: 'PROG', name: 'ZHELLO' })).toMatchObject({ scope: 'write' });
    expect(mutatingCall('SAPTransport', { action: 'create', description: 'x' })).toMatchObject({
      action: 'create',
      scope: 'transports',
    });
  });

  it('classifies the hyperfocused tool by the tool its action maps to', () => {
    expect(mutatingCall('SAP', { action: 'read', type: 'PROG', name: 'ZHELLO' })).toBeUndefined();
    expect(
      mutatingCall('SAP', { action: 'write', type: 'PROG', name: 'ZHELLO', params: { action: 'delete' } }),
    ).toMatchObject({ tool: 'SAPWrite', action: 'delete', scope: 'write' });
    expect(mutatingCall('SAP', { action: 'nonsense' })).toBeUndefined();
  });
});

describe('createStatefulWindow', () => {
  it('holds the cross-tab lock and reports the session for each outermost window only', async () => {
    const { locks, names } = fakeLocks();
    const changes: boolean[] = [];
    const window = createStatefulWindow(locks, (open) => changes.push(open));

    const result = await window(async () => {
      expect(changes).toEqual([true]);
      return window(async () => 'nested');
    });

    expect(result).toBe('nested');
    expect(names).toEqual([ADT_SESSION_LOCK]);
    expect(changes).toEqual([true, false]);
  });

  it('reports the session closed when the window fails, and works without Web Locks', async () => {
    const changes: boolean[] = [];
    const window = createStatefulWindow(undefined, (open) => changes.push(open));
    await expect(window(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(changes).toEqual([true, false]);
  });
});

describe('browser runtime writes', () => {
  let runtime: BrowserServer | undefined;
  let client: Client | undefined;

  beforeEach(() => {
    resetCachedFeatures();
  });

  afterEach(async () => {
    await client?.close();
    await runtime?.close();
    client = undefined;
    runtime = undefined;
  });

  async function connect(options: Parameters<typeof createBrowserServer>[0]) {
    runtime = createBrowserServer({ baseUrl: BASE_URL, locks: null, ...options });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-host', version: '1.0.0' });
    await runtime.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  it('needs an approval hook for writes and an audit hook when audit is required', () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() => createBrowserServer({ baseUrl: BASE_URL, fetch: fetchImpl, config: { allowWrites: true } })).toThrow(
      /approveWrite/,
    );
    expect(() =>
      createBrowserServer({ baseUrl: BASE_URL, fetch: fetchImpl, auditRequiredForWrites: true, locks: null }),
    ).toThrow(/auditReady/);
  });

  it('asks for approval with the normalized call and sends nothing to SAP when refused', async () => {
    const sap = fakeSap();
    const events: AuditEvent[] = [];
    const approveWrite = vi.fn(() => false);
    const client = await connect({
      fetch: sap.fetchImpl,
      user: 'developer',
      config: { allowWrites: true },
      approveWrite,
      sinks: [{ write: (event) => events.push(event) }],
    });
    await client.callTool({ name: 'SAPRead', arguments: { type: 'PROG', name: 'ZHELLO' } });
    expect(approveWrite).not.toHaveBeenCalled();
    const before = sap.sent.length;

    const result = await client.callTool({ name: 'SAPWrite', arguments: { ...UPDATE, transport: '' } });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe('SAPWrite.update was not run: the user did not approve it. Nothing was sent to SAP.');
    expect(approveWrite).toHaveBeenCalledWith(
      { tool: 'SAPWrite', action: 'update', scope: 'write', args: UPDATE } satisfies WriteCall,
      { signal: expect.any(AbortSignal) },
    );
    expect(sap.sent.length).toBe(before);
    expect(events.find((event) => event.event === 'safety_blocked')).toMatchObject({
      operation: 'SAPWrite.update',
      reason: 'Browser host: the user did not approve it',
      user: 'DEVELOPER',
      clientId: 'arc-1-browser',
    });
  });

  it('refuses when the approval hook throws or answers anything but true', async () => {
    const sap = fakeSap();
    const answers = [() => Promise.reject(new Error('dialog failed')), () => 'yes' as unknown as boolean];
    const client = await connect({
      fetch: sap.fetchImpl,
      config: { allowWrites: true },
      approveWrite: () => (answers.shift() as () => boolean)(),
    });
    for (let i = 0; i < 2; i++) {
      const result = await client.callTool({ name: 'SAPWrite', arguments: UPDATE });
      expect(text(result)).toMatch(/did not approve/);
    }
    expect(sap.mutating()).toEqual([]);
  });

  it('runs an approved update in one queued stateful session and closes it statelessly', async () => {
    const sap = fakeSap();
    const { locks, names } = fakeLocks();
    const sessions: boolean[] = [];
    const client = await connect({
      fetch: sap.fetchImpl,
      config: { allowWrites: true },
      approveWrite: () => true,
      locks,
      onStatefulSessionChange: (open) => sessions.push(open),
    });

    const result = await client.callTool({ name: 'SAPWrite', arguments: UPDATE });

    expect(result.isError, text(result)).toBeFalsy();
    expect(names).toEqual([ADT_SESSION_LOCK]);
    expect(sessions).toEqual([true, false]);
    expect(sap.mutating().map((request) => `${request.method} ${request.path} ${request.action ?? ''}`.trim())).toEqual(
      [`POST ${PROGRAM_URL} LOCK`, `PUT ${PROGRAM_URL}/source/main`, `POST ${PROGRAM_URL} UNLOCK`],
    );
    const close = sap.sent.find((request) => request.path === '/sap/bc/adt/core/http/sessions');
    expect(close?.headers['X-sap-adt-sessiontype']).toBe('stateless');
    expect(close?.headers).not.toHaveProperty('sap-contextid');
    // Only the close is stateless: any other stateless ADT request would end the shared context.
    const stateless = sap.sent.filter((request) => request.headers['X-sap-adt-sessiontype'] === 'stateless');
    expect(stateless).toEqual([close]);
    for (const request of sap.mutating()) expect(request.headers['X-sap-adt-sessiontype']).toBe('stateful');
  });

  it('lets the approval hook read through the runtime (it runs outside the call queue)', async () => {
    const sap = fakeSap();
    let current = '';
    const client = await connect({
      fetch: sap.fetchImpl,
      config: { allowWrites: true },
      approveWrite: async () => {
        const read = await client.callTool({ name: 'SAPRead', arguments: { type: 'PROG', name: 'ZHELLO' } });
        current = text(read);
        return true;
      },
    });

    const result = await client.callTool({ name: 'SAPWrite', arguments: UPDATE });

    expect(result.isError, text(result)).toBeFalsy();
    expect(current).toContain("WRITE 'hi'.");
  });

  it('refuses a call cancelled while waiting for approval and tells the hook', async () => {
    const sap = fakeSap();
    let hookSignal: AbortSignal | undefined;
    const client = await connect({
      fetch: sap.fetchImpl,
      config: { allowWrites: true },
      approveWrite: (_call, { signal }) => {
        hookSignal = signal;
        return new Promise<boolean>((resolve) => signal.addEventListener('abort', () => resolve(true)));
      },
    });
    const controller = new AbortController();
    const call = client.callTool({ name: 'SAPWrite', arguments: UPDATE }, undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(hookSignal).toBeDefined());

    controller.abort();

    await expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(hookSignal?.aborted).toBe(true));
    expect(sap.mutating()).toEqual([]);
  });

  it('refuses writes, not reads, while the audit store cannot record', async () => {
    const sap = fakeSap();
    let ready = false;
    const approveWrite = vi.fn(() => true);
    const client = await connect({
      fetch: sap.fetchImpl,
      config: { allowWrites: true },
      approveWrite,
      auditRequiredForWrites: true,
      auditReady: () => ready,
    });

    const read = await client.callTool({ name: 'SAPRead', arguments: { type: 'PROG', name: 'ZHELLO' } });
    const refused = await client.callTool({ name: 'SAPWrite', arguments: UPDATE });

    expect(read.isError).toBeFalsy();
    expect(text(refused)).toMatch(/audit store cannot record/);
    expect(approveWrite).not.toHaveBeenCalled();
    expect(sap.mutating()).toEqual([]);

    ready = true;
    expect((await client.callTool({ name: 'SAPWrite', arguments: UPDATE })).isError).toBeFalsy();
  });

  it('refuses a write when the audit hook throws', async () => {
    const sap = fakeSap();
    const client = await connect({
      fetch: sap.fetchImpl,
      config: { allowWrites: true },
      approveWrite: () => true,
      auditRequiredForWrites: true,
      auditReady: () => {
        throw new Error('store down');
      },
    });

    const result = await client.callTool({ name: 'SAPWrite', arguments: UPDATE });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/audit store cannot record/);
    expect(sap.mutating()).toEqual([]);
  });

  it('leaves the ceiling to dispatch: denied actions and other packages never reach the host', async () => {
    const sap = fakeSap('ZOTHER');
    const approveWrite = vi.fn(() => true);
    const client = await connect({
      fetch: sap.fetchImpl,
      config: { allowWrites: true, denyActions: ['SAPWrite.delete'] },
      approveWrite,
    });

    const denied = await client.callTool({ name: 'SAPWrite', arguments: { ...UPDATE, action: 'delete' } });
    expect(text(denied)).toMatch(/denied by server policy/);
    expect(approveWrite).not.toHaveBeenCalled();

    // Approved, then refused by the package allowlist ($TMP) against the object's real package.
    const otherPackage = await client.callTool({ name: 'SAPWrite', arguments: UPDATE });
    expect(otherPackage.isError).toBe(true);
    expect(text(otherPackage)).toMatch(/ZOTHER/);
    expect(sap.mutating()).toEqual([]);
  });

  it('keeps transport writes behind their own flag', async () => {
    const sap = fakeSap();
    const client = await connect({ fetch: sap.fetchImpl, config: { allowWrites: true }, approveWrite: () => true });

    const result = await client.callTool({
      name: 'SAPTransport',
      arguments: { action: 'create', description: 'test', package: 'ZPKG' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/transport/i);
    expect(sap.mutating()).toEqual([]);
  });
});
