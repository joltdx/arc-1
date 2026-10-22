import { MessageChannel } from 'node:worker_threads';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MessagePortLike, MessagePortTransport } from '../../../src/browser/message-port-transport.js';

const ping: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'ping' };

describe('MessagePortTransport', () => {
  const channels: MessageChannel[] = [];
  const open = () => {
    const channel = new MessageChannel();
    channels.push(channel);
    return { a: channel.port1 as unknown as MessagePortLike, b: channel.port2 as unknown as MessagePortLike };
  };

  afterEach(() => {
    for (const channel of channels.splice(0)) {
      channel.port1.close();
      channel.port2.close();
    }
  });

  it('delivers JSON-RPC messages in both directions', async () => {
    const { a, b } = open();
    const left = new MessagePortTransport(a);
    const right = new MessagePortTransport(b);
    const received = new Promise<JSONRPCMessage>((resolve) => {
      right.onmessage = resolve;
    });
    await left.start();
    await right.start();

    await left.send(ping);

    expect(await received).toEqual(ping);
  });

  it('reports a message that is not JSON-RPC instead of passing it on', async () => {
    const { a, b } = open();
    const transport = new MessagePortTransport(b);
    const onmessage = vi.fn();
    const error = new Promise<Error>((resolve) => {
      transport.onerror = resolve;
    });
    transport.onmessage = onmessage;
    await transport.start();

    a.postMessage({ hello: 'world' });

    expect((await error).message).toMatch(/Invalid JSON-RPC message/);
    expect(onmessage).not.toHaveBeenCalled();
  });

  it('starts once, and stops listening and refuses to send after close', async () => {
    const port = { postMessage: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), close: vi.fn() };
    const transport = new MessagePortTransport(port);
    const onclose = vi.fn();
    transport.onclose = onclose;
    await transport.start();
    await expect(transport.start()).rejects.toThrow(/already started/);

    await transport.close();
    await transport.close();

    expect(port.removeEventListener).toHaveBeenCalledWith('message', port.addEventListener.mock.calls[0]![1]);
    expect(port.close).toHaveBeenCalledOnce();
    expect(onclose).toHaveBeenCalledOnce();
    await expect(transport.send(ping)).rejects.toThrow(/closed/);
  });

  it('works on a Worker-like target without start or close', async () => {
    const port = { postMessage: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const transport = new MessagePortTransport(port);
    await transport.start();
    await transport.send(ping);
    await transport.close();
    expect(port.postMessage).toHaveBeenCalledWith(ping);
  });
});
