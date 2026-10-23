// Harness page for the ARC-1 browser runtime. Both paths start the bundle's standard worker (`/bundle/worker.js`).
//
// - Raw relay (tests/browser-live/, SDK client): the test drives `window.arc1Harness.start/send` and receives every
//   message the worker sends through `window.arc1OnMessage`, like a backend MCP client behind a relay transport.
// - Host helper (`/bundle/host.js`, as an embedding page uses it): `arc1Harness.startHost/hostCall`, and the form
//   below. `workerUrl` on another origin exercises the blob bootstrap.

const harness = {
  worker: undefined,
  port: undefined,
  runtime: undefined,
  audit: [],
  toolsChanged: 0,
  /** Raw relay: start the worker with BrowserServerOptions (without fetch or sinks); resolves with its config. */
  start(options = {}) {
    if (harness.worker || harness.runtime) throw new Error('Runtime already started; reload the page to start again.');
    const channel = new MessageChannel();
    harness.worker = new Worker('/bundle/worker.js', { type: 'module' });
    harness.port = channel.port1;
    harness.port.onmessage = (event) => window.arc1OnMessage?.(event.data);
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
  /** Raw relay: send one JSON-RPC message to the runtime. */
  send(message) {
    if (!harness.port) throw new Error('Runtime not started.');
    harness.port.postMessage(message);
  },
  /** Host helper: start through host.js from the worker's directory; resolves with a summary. */
  async startHost({ workerUrl = '/bundle/worker.js', options = {} } = {}) {
    if (harness.worker || harness.runtime) throw new Error('Runtime already started; reload the page to start again.');
    const { startBrowserRuntime } = await import(new URL('host.js', new URL(workerUrl, location.href)).href);
    harness.runtime = await startBrowserRuntime({
      workerUrl,
      options,
      clientInfo: { name: 'arc-1-harness', version: '1' },
      onAudit: (event) => harness.audit.push(event),
      onToolsChanged: () => harness.toolsChanged++,
    });
    const { apiVersion, config, serverInfo } = harness.runtime;
    return { apiVersion, config, serverInfo };
  },
  /** Host helper: one tool call, with CallToolOptions minus the signal. */
  hostCall(name, args, options) {
    if (!harness.runtime) throw new Error('Runtime not started through the host helper.');
    return harness.runtime.callTool(name, args, options);
  },
};
window.arc1Harness = harness;

const $ = (id) => document.getElementById(id);
const show = (text) => {
  $('output').textContent = `${text}\n\n${$('output').textContent}`.slice(0, 200_000);
};
const showJson = (label, value) => show(`${label}\n${JSON.stringify(value, null, 2)}`);

$('start').addEventListener('click', async () => {
  try {
    const config = JSON.parse($('config').value || '{}');
    const user = $('user').value.trim() || undefined;
    const started = await harness.startHost({ options: { config, user } });
    showJson(`started (API v${started.apiVersion}, ${started.serverInfo.name} ${started.serverInfo.version}):`, started.config);
    for (const id of ['list', 'call']) $(id).disabled = false;
    $('start').disabled = true;
  } catch (err) {
    show(`start failed: ${err.message}`);
  }
});

$('list').addEventListener('click', async () => {
  const tools = await harness.runtime.listTools();
  show(`tools/list (${harness.toolsChanged} list change(s) so far): ${tools.map((tool) => tool.name).join(', ')}`);
});

$('call').addEventListener('click', async () => {
  try {
    const args = JSON.parse($('args').value || '{}');
    const max = Number($('max').value) || undefined;
    const started = performance.now();
    const result = await harness.hostCall($('tool').value.trim(), args, max ? { maxResultChars: max } : {});
    const ms = Math.round(performance.now() - started);
    const content = result.content.map((part) => part.text ?? JSON.stringify(part)).join('\n');
    show(`${$('tool').value} (${ms} ms${result.isError ? ', isError' : ''})\n${content}`);
  } catch (err) {
    show(`call failed: ${err.message}`);
  }
});

$('audit').addEventListener('click', () => showJson(`audit events (${harness.audit.length})`, harness.audit.slice(-20)));
