import type { AcpJsonRpcTransport } from "../acp-client.js";

export class FakeAcpAgentTransport implements AcpJsonRpcTransport {
  readonly requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
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
    return {};
  }

  onNotification(
    listener: (method: string, params: Record<string, unknown>) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitSessionUpdate(sessionId: string, update: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener("session/update", { sessionId, update });
    }
  }
}
