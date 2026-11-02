import type { JsonRpcTransport } from "@pwrdrvr/agent-transport";

type FixtureTurn = { id: string; status: string; items: unknown[]; error: { message: string } | null };
type FixtureThread = {
  id: string;
  cwd: string;
  preview: string;
  name: string | null;
  createdAt: number;
  updatedAt: number;
  turns: FixtureTurn[];
};

/**
 * The desktop owner's Codex for the owner conformance suite. It behaves like
 * the Outpost's protocol fixture (packages/pwragent/test/fixtures/codex.js), so
 * a difference between the two owners comes from the owners, not from Codex:
 * the first prompt becomes the thread's preview, and a turn completes shortly
 * after it starts with one "Fixture result" agent message. It runs in process
 * because desktop's client sends requests the Outpost fixture rejects.
 */
export class OwnerConformanceCodexTransport implements JsonRpcTransport {
  static threads = new Map<string, FixtureThread>();
  static requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  private static sequence = 0;
  private handler: (message: string) => void = () => {};

  static reset(): void {
    OwnerConformanceCodexTransport.threads = new Map();
    OwnerConformanceCodexTransport.requests = [];
    OwnerConformanceCodexTransport.sequence = 0;
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  setCloseHandler(_handler: (error?: Error) => void): void {}
  setMessageHandler(handler: (message: string) => void): void { this.handler = handler; }

  private notify(method: string, params: unknown): void {
    this.handler(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  send(message: string): void {
    const request = JSON.parse(message) as { id?: number; method: string; params?: Record<string, unknown> };
    if (request.id === undefined) return;
    const params = request.params ?? {};
    OwnerConformanceCodexTransport.requests.push({ method: request.method, params });
    const threads = OwnerConformanceCodexTransport.threads;
    const wire = (thread: FixtureThread) => ({
      ...thread, sessionId: thread.id, status: { type: "idle" }, source: "cli", modelProvider: "openai",
      ephemeral: false, path: null, cliVersion: "0.159.2", gitInfo: null,
    });
    let result: unknown = {};
    if (request.method === "initialize") {
      result = { userAgent: "fixture-codex/0.159.2", codexHome: "/fixture-codex-home", platformFamily: "unix", platformOs: "linux" };
    } else if (request.method === "model/list") {
      result = { data: [{ id: "fixture-model", model: "fixture-model", displayName: "Fixture model", isDefault: true,
        supportedReasoningEfforts: [] }], nextCursor: null };
    } else if (request.method === "thread/start") {
      const now = Math.floor(Date.now() / 1000);
      const thread: FixtureThread = { id: `thread-${++OwnerConformanceCodexTransport.sequence}`, cwd: String(params.cwd),
        preview: "", name: null, createdAt: now, updatedAt: now, turns: [] };
      threads.set(thread.id, thread);
      result = { thread: wire(thread), model: "fixture-model", modelProvider: "openai", cwd: thread.cwd,
        approvalPolicy: "never", sandbox: { type: "workspaceWrite" }, reasoningEffort: null };
    } else if (request.method === "thread/resume" || request.method === "thread/read") {
      const thread = threads.get(String(params.threadId));
      if (!thread) {
        this.handler(JSON.stringify({ jsonrpc: "2.0", id: request.id,
          error: { code: -32600, message: `no rollout found for thread id ${String(params.threadId)}` } }));
        return;
      }
      result = { thread: wire(thread) };
    } else if (request.method === "thread/turns/list") {
      const thread = threads.get(String(params.threadId));
      const turns = [...(thread?.turns ?? [])];
      result = { data: params.sortDirection === "desc" ? turns.reverse() : turns, nextCursor: null };
    } else if (request.method === "thread/list") {
      result = { data: [...threads.values()].map(wire), nextCursor: null, backwardsCursor: null };
    } else if (request.method === "thread/name/set") {
      // Stored and returned by reads and listings. No notification echoes it,
      // so every name event the suite sees comes from the owner itself.
      const thread = threads.get(String(params.threadId));
      if (thread) thread.name = String(params.name);
    } else if (request.method === "turn/start") {
      const thread = threads.get(String(params.threadId));
      const input = params.input as Array<{ type: string; text?: string }> | undefined;
      const prompt = input?.find((item) => item.type === "text")?.text ?? "";
      if (thread && !thread.preview) thread.preview = prompt;
      const turnId = `turn-${++OwnerConformanceCodexTransport.sequence}`;
      result = { turn: { id: turnId, status: "inProgress", items: [], error: null } };
      if (thread) {
        setTimeout(() => {
          // The same turn the Outpost fixture records: one agent message.
          const turn = { id: turnId, status: "completed", items: [{ type: "agentMessage", text: "Fixture result" }], error: null };
          thread.turns.push(turn);
          thread.updatedAt = Math.floor(Date.now() / 1000);
          this.notify("turn/completed", { threadId: thread.id, turn });
        }, 100);
      }
    }
    this.handler(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  }
}
