import type { JsonRpcTransport } from "@pwrdrvr/agent-transport";

/**
 * A scripted Codex App Server that records every request the client sends.
 * Tests read `requests` to see what the provider was given. No real agent
 * process and no Codex storage is involved.
 */
export class AgentInstructionCodexTransport implements JsonRpcTransport {
  static requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  static instances: AgentInstructionCodexTransport[] = [];
  /** Result for `server/capabilities/read`. Undefined answers as stock Codex does. */
  static capabilities: Record<string, unknown> | undefined;
  /** The next request with this method is answered with an error, once. */
  static failNext: string | undefined;
  private static nextThread = 0;
  private static nextTurn = 0;
  private handler: (message: string) => void = () => {};

  constructor() {
    AgentInstructionCodexTransport.instances.push(this);
  }

  static reset(): void {
    AgentInstructionCodexTransport.requests = [];
    AgentInstructionCodexTransport.instances = [];
    AgentInstructionCodexTransport.capabilities = undefined;
    AgentInstructionCodexTransport.failNext = undefined;
    AgentInstructionCodexTransport.nextThread = 0;
    AgentInstructionCodexTransport.nextTurn = 0;
  }

  static sent(method: string): Array<Record<string, unknown>> {
    return AgentInstructionCodexTransport.requests
      .filter((request) => request.method === method)
      .map((request) => request.params);
  }

  /** Deliver a server notification on every live connection. */
  static notify(method: string, params: Record<string, unknown>): void {
    for (const instance of AgentInstructionCodexTransport.instances) {
      instance.handler(JSON.stringify({ jsonrpc: "2.0", method, params }));
    }
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  setCloseHandler(_handler: (error?: Error) => void): void {}
  setMessageHandler(handler: (message: string) => void): void { this.handler = handler; }

  send(message: string): void {
    const request = JSON.parse(message) as { id?: number; method: string; params?: Record<string, unknown> };
    if (request.id === undefined) return;
    const params = request.params ?? {};
    AgentInstructionCodexTransport.requests.push({ method: request.method, params });
    const thread = (id: string) => ({
      id, cwd: String(params.cwd ?? "/fixture"), source: "cli", name: id, createdAt: 1, updatedAt: 2,
      modelProvider: "openai", threadSource: "user", turns: [],
    });
    if (AgentInstructionCodexTransport.failNext === request.method) {
      AgentInstructionCodexTransport.failNext = undefined;
      this.handler(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "fixture failure" } }));
      return;
    }
    let result: unknown = {};
    if (request.method === "initialize") {
      result = { userAgent: "agent-instruction-fixture/1.0", codexHome: "/fixture", platformFamily: "unix", platformOs: "linux" };
    } else if (request.method === "thread/start") {
      result = { thread: thread(`codex-thread-${++AgentInstructionCodexTransport.nextThread}`), model: "fixture-model" };
    } else if (request.method === "thread/resume" || request.method === "thread/read") {
      result = { thread: thread(String(params.threadId)), model: "fixture-model" };
    } else if (request.method === "turn/start") {
      result = { turn: { id: `codex-turn-${++AgentInstructionCodexTransport.nextTurn}`, status: "inProgress", items: [] } };
    } else if (request.method === "thread/list" || request.method === "model/list") {
      result = { data: [], nextCursor: null };
    } else if (request.method === "server/capabilities/read") {
      if (!AgentInstructionCodexTransport.capabilities) {
        this.handler(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }));
        return;
      }
      result = AgentInstructionCodexTransport.capabilities;
    }
    this.handler(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  }
}
