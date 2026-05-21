import type { AcpJsonRpcTransport } from "../acp-client.js";

export class FakeAcpAgentTransport implements AcpJsonRpcTransport {
  readonly requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closeCount = 0;
  private listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  private nextSessionId = "session-1";

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params });
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

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  emitSessionUpdate(sessionId: string, update: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener("session/update", { sessionId, update });
    }
  }
}
