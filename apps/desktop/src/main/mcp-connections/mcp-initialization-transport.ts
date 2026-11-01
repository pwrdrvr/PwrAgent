import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { InitializeResultSchema, type InitializeResult, type JSONRPCMessage, type RequestId } from "@modelcontextprotocol/sdk/types.js";

/** The SDK exposes identity/instructions but has no getter for initialize _meta. */
export class McpInitializationTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  initialization?: InitializeResult;
  private initializeId?: RequestId;

  constructor(private readonly inner: Transport, private readonly metadata?: InitializeResult["_meta"]) {}

  get sessionId(): string | undefined { return this.inner.sessionId; }
  setProtocolVersion(version: string): void { this.inner.setProtocolVersion?.(version); }

  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message, extra) => {
      if ("method" in message && message.method === "initialize" && "id" in message) this.initializeId = message.id;
      if ("result" in message && message.id === this.initializeId) {
        const parsed = InitializeResultSchema.safeParse(message.result);
        if (parsed.success) this.initialization = parsed.data;
      }
      this.onmessage?.(message, extra);
    };
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if ("method" in message && message.method === "initialize" && "id" in message) this.initializeId = message.id;
    // Leave negotiation and client capabilities with the SDK. Only restore
    // metadata from the upstream handshake on the bridge's matching answer.
    if (this.metadata && "result" in message && message.id === this.initializeId) {
      message = { ...message, result: { ...message.result, _meta: this.metadata } };
    }
    await this.inner.send(message, options);
  }

  async close(): Promise<void> { await this.inner.close(); }
}
