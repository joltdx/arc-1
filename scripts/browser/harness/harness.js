// Harness page for the ARC-1 browser runtime: starts the worker and relays MCP JSON-RPC to it.
//
// - Automated (tests/browser-live/): the test drives `window.arc1Harness` and receives every message the
//   worker sends through `window.arc1OnMessage`, like a backend MCP client behind a relay transport.
// - Manual: the form below starts the runtime and sends tools/list and tools/call, showing the replies.

const harness = {
  worker: undefined,
  port: undefined,
  audit: [],
  /** Start the runtime with BrowserServerOptions (without fetch or sinks); resolves with its resolved config. */
  start(options = {}) {
    if (harness.worker) throw new Error('Runtime already started; reload the page to start again.');
    const channel = new MessageChannel();
    harness.worker = new Worker('/harness/worker.js', { type: 'module' });
    harness.port = channel.port1;
    harness.port.onmessage = (event) => deliver(event.data);
    const ready = new Promise((resolve, reject) => {
      harness.worker.onmessage = (event) => {
        const data = event.data;
        if (data?.arc1 === 'audit') harness.audit.push(data.event);
        else if (data?.arc1 === 'ready') resolve({ apiVersion: data.apiVersion, config: data.config });
        else if (data?.arc1 === 'error') reject(new Error(data.message));
      };
      harness.worker.onerror = (event) => reject(new Error(event.message || 'worker failed to load'));
    });
    harness.worker.postMessage({ arc1: 'start', options }, [channel.port2]);
    return ready;
  },
  /** Relay one JSON-RPC message to the runtime. */
  send(message) {
    if (!harness.port) throw new Error('Runtime not started.');
    harness.port.postMessage(message);
  },
};
window.arc1Harness = harness;

const pending = new Map();
let nextId = 1;

function deliver(message) {
  window.arc1OnMessage?.(message);
  const waiter = pending.get(message.id);
  if (waiter && ('result' in message || 'error' in message)) {
    pending.delete(message.id);
    waiter(message);
  }
  if (!('id' in message)) show(`← ${message.method}`);
}

function call(method, params) {
  const id = `ui-${nextId++}`;
  const reply = new Promise((resolve) => pending.set(id, resolve));
  harness.send({ jsonrpc: '2.0', id, method, params });
  return reply;
}

const $ = (id) => document.getElementById(id);
const show = (text) => {
  $('output').textContent = `${text}\n\n${$('output').textContent}`.slice(0, 200_000);
};
const showJson = (label, value) => show(`${label}\n${JSON.stringify(value, null, 2)}`);

$('start').addEventListener('click', async () => {
  try {
    const config = JSON.parse($('config').value || '{}');
    const user = $('user').value.trim() || undefined;
    const { apiVersion, config: resolved } = await harness.start({ config, user });
    showJson(`started (API v${apiVersion}); resolved config:`, resolved);
    const init = await call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'arc-1-harness', version: '1' },
    });
    harness.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    showJson('initialize', init.result ?? init.error);
    for (const id of ['list', 'call']) $(id).disabled = false;
    $('start').disabled = true;
  } catch (err) {
    show(`start failed: ${err.message}`);
  }
});

$('list').addEventListener('click', async () => {
  const reply = await call('tools/list', {});
  show(`tools/list: ${(reply.result?.tools ?? []).map((tool) => tool.name).join(', ') || JSON.stringify(reply.error)}`);
});

$('call').addEventListener('click', async () => {
  try {
    const args = JSON.parse($('args').value || '{}');
    const started = performance.now();
    const reply = await call('tools/call', { name: $('tool').value.trim(), arguments: args });
    const ms = Math.round(performance.now() - started);
    const content = reply.result?.content?.map((part) => part.text ?? JSON.stringify(part)).join('\n');
    show(`${$('tool').value} (${ms} ms${reply.result?.isError ? ', isError' : ''})\n${content ?? JSON.stringify(reply.error)}`);
  } catch (err) {
    show(`call failed: ${err.message}`);
  }
});

$('audit').addEventListener('click', () => showJson(`audit events (${harness.audit.length})`, harness.audit.slice(-20)));
