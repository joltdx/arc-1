/**
 * MCP transport over a MessagePort-like channel (a Worker, a MessagePort, or the worker's own global scope),
 * so the browser runtime can run in a Web Worker and the host page relays JSON-RPC messages to it.
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type JSONRPCMessage, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

/** The part of MessagePort / Worker / DedicatedWorkerGlobalScope this transport uses. */
export interface MessagePortLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: Event) => void): void;
  removeEventListener(type: 'message', listener: (event: Event) => void): void;
  /** MessagePort only: starts delivery when listening through addEventListener. */
  start?(): void;
  /** MessagePort only; a Worker or worker scope stays open. */
  close?(): void;
}

export class MessagePortTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private started = false;
  private closed = false;
  private readonly listener = (event: Event): void => {
    const parsed = JSONRPCMessageSchema.safeParse((event as MessageEvent).data);
    if (parsed.success) {
      this.onmessage?.(parsed.data);
    } else {
      this.onerror?.(new Error(`Invalid JSON-RPC message: ${parsed.error.message}`));
    }
  };

  constructor(private readonly port: MessagePortLike) {}

  async start(): Promise<void> {
    if (this.started) throw new Error('MessagePortTransport already started.');
    if (this.closed) throw new Error('MessagePortTransport is closed.');
    this.started = true;
    this.port.addEventListener('message', this.listener);
    this.port.start?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('MessagePortTransport is closed.');
    this.port.postMessage(message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.port.removeEventListener('message', this.listener);
    this.port.close?.();
    this.onclose?.();
  }
}
