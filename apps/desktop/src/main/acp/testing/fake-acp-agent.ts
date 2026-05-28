import type { AcpJsonRpcTransport } from "../acp-client.js";

export class FakeAcpAgentTransport implements AcpJsonRpcTransport {
  readonly requests: Array<{
    method: string;
    params?: Record<string, unknown>;
    timeoutMs?: number;
  }> = [];
  readonly notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closeCount = 0;
  private listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  private requestHandler:
    | ((
        method: string,
        params: Record<string, unknown>,
        id?: string | number,
      ) => Promise<unknown> | unknown)
    | undefined;
  private nextSessionId = "session-1";

  constructor(
    private readonly responses: Partial<Record<string, unknown>> = {},
  ) {}

  async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    this.requests.push({
      method,
      params,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    if (method in this.responses) {
      return this.responses[method];
    }
    if (method === "initialize") {
      return { protocolVersion: 1 };
    }
    if (method === "session/new") {
      return { sessionId: this.nextSessionId };
    }
    if (method === "session/prompt") {
      return { turnId: "turn-1" };
    }
    if (method === "session/load") {
      return { updates: [] };
    }
    return {};
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    this.notifications.push({ method, params });
  }

  onNotification(
    listener: (method: string, params: Record<string, unknown>) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onRequest(
    listener: (
      method: string,
      params: Record<string, unknown>,
      id?: string | number,
    ) => Promise<unknown> | unknown,
  ): () => void {
    this.requestHandler = listener;
    return () => {
      if (this.requestHandler === listener) {
        this.requestHandler = undefined;
      }
    };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  emitSessionUpdate(sessionId: string, update: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener("session/update", { sessionId, update });
    }
  }

  /**
   * Emit a vendor-prefixed notification (e.g. Grok's
   * `_x.ai/session_notification`). Same envelope shape as session/update —
   * `{ sessionId, update }` — but routed under a custom method name. Lets
   * tests cover the vendor-extension dispatch in acp-client without a real
   * stdio transport.
   */
  emitVendorNotification(params: {
    method: string;
    sessionId: string;
    update: Record<string, unknown>;
  }): void {
    for (const listener of this.listeners) {
      listener(params.method, { sessionId: params.sessionId, update: params.update });
    }
  }

  async emitRequest(
    method: string,
    params: Record<string, unknown>,
    id?: string | number,
  ): Promise<unknown> {
    if (!this.requestHandler) {
      throw new Error("No ACP request handler registered");
    }
    return await this.requestHandler(method, params, id);
  }
}
