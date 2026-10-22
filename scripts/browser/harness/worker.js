// Module Web Worker running the ARC-1 browser runtime, as an embedding host would. The page sends one
// `{ arc1: 'start', options }` message with a MessagePort; MCP JSON-RPC then flows over that port, and the
// worker reports audit events and its own state back on the worker channel.
import { BROWSER_API_VERSION, createBrowserServer, MessagePortTransport } from '/bundle/index.js';

const auditSink = {
  write(event) {
    self.postMessage({ arc1: 'audit', event });
  },
};

self.addEventListener('message', async function start(event) {
  if (event.data?.arc1 !== 'start') return;
  self.removeEventListener('message', start);
  try {
    const server = createBrowserServer({ ...event.data.options, sinks: [auditSink] });
    await server.connect(new MessagePortTransport(event.ports[0]));
    self.postMessage({ arc1: 'ready', apiVersion: BROWSER_API_VERSION, config: { ...server.config } });
  } catch (err) {
    self.postMessage({ arc1: 'error', message: err instanceof Error ? err.message : String(err) });
  }
});
