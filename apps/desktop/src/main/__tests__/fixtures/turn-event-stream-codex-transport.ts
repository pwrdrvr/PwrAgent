import type { JsonRpcTransport } from "@pwrdrvr/agent-transport";
import { OwnerConformanceCodexTransport } from "./owner-conformance-codex-transport";

/**
 * The owner conformance suite's Codex, with turns under the test's control.
 * Threads, resumes, lists and helpers go to that fixture unchanged. A turn
 * or review starts and then stays in progress until the scenario sends its
 * notifications, so every event arrives in the order the scenario writes.
 */
export class ScriptedCodexTransport implements JsonRpcTransport {
  private static sequence = 0;
  private static serverRequestSequence = 0;
  private static readonly owners = new Map<string, ScriptedCodexTransport>();
  private static readonly pendingServerRequests = new Map<string, { resolve(result: unknown): void; reject(error: Error): void }>();

  static reset(): void {
    OwnerConformanceCodexTransport.reset();
    this.sequence = 0;
    this.serverRequestSequence = 0;
    this.owners.clear();
    this.pendingServerRequests.clear();
  }

  /** Sends a notification on the connection that last addressed the thread. */
  static notify(threadId: string, method: string, params: unknown): void {
    const connection = this.owners.get(threadId);
    if (!connection) throw new Error(`No Codex connection has addressed ${threadId}`);
    connection.handler(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** Sends a server request, as Codex does for a dynamic tool call. */
  static request(threadId: string, method: string, params: unknown): Promise<unknown> {
    const connection = this.owners.get(threadId);
    if (!connection) throw new Error(`No Codex connection has addressed ${threadId}`);
    const id = `server-${++this.serverRequestSequence}`;
    const answered = new Promise<unknown>((resolve, reject) => this.pendingServerRequests.set(id, { resolve, reject }));
    connection.handler(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return answered;
  }

  private readonly inner = new OwnerConformanceCodexTransport();
  private handler: (message: string) => void = () => {};

  async connect(): Promise<void> { await this.inner.connect(); }
  async close(): Promise<void> { await this.inner.close(); }
  setCloseHandler(handler: (error?: Error) => void): void { this.inner.setCloseHandler(handler); }
  setMessageHandler(handler: (message: string) => void): void {
    this.handler = handler;
    this.inner.setMessageHandler(handler);
  }

  send(message: string): void {
    const request = JSON.parse(message) as {
      id?: number | string;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message?: string };
    };
    if (request.method === undefined && request.id !== undefined) {
      const answer = ScriptedCodexTransport.pendingServerRequests.get(String(request.id));
      ScriptedCodexTransport.pendingServerRequests.delete(String(request.id));
      if (request.error) answer?.reject(new Error(`Server request ${String(request.id)} failed: ${request.error.message ?? "unknown error"}`));
      else answer?.resolve(request.result);
      return;
    }
    const params = request.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (threadId) ScriptedCodexTransport.owners.set(threadId, this);
    // A task monitor runs on an ephemeral helper thread; its turns are scripted too.
    const known = threadId !== undefined && (OwnerConformanceCodexTransport.threads.has(threadId) || threadId.startsWith("helper-"));
    const scriptedTurn = request.id !== undefined && known
      && (request.method === "turn/start" || request.method === "review/start" || request.method === "turn/interrupt")
      // The conformance fixture answers a refused submission itself.
      && !(request.method === "turn/start" && OwnerConformanceCodexTransport.refusedStarts > 0);
    const scripted = request.method === "model/list" || request.method === "config/read" || scriptedTurn;
    if (!scripted) {
      this.inner.send(message);
      const started = /"method":"thread\/start"/.test(message);
      if (started) {
        // The fixture answers thread/start synchronously; adopt the new thread.
        for (const id of OwnerConformanceCodexTransport.threads.keys()) {
          if (!ScriptedCodexTransport.owners.has(id)) ScriptedCodexTransport.owners.set(id, this);
        }
      }
      return;
    }
    OwnerConformanceCodexTransport.requests.push({ method: request.method!, params });
    let result: unknown = {};
    if (request.method === "model/list") {
      // Every field the client consumes, so a task monitor can pick a model.
      result = { data: [{ id: "fixture-mini", model: "fixture-mini", displayName: "Fixture mini", hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }], defaultReasoningEffort: "low",
        inputModalities: ["text"], additionalSpeedTiers: [], serviceTiers: [], isDefault: true }], nextCursor: null };
    } else if (request.method === "config/read") {
      // A configured MCP inventory, so a monitor's PwrAgent-only access holds.
      result = { config: { mcp_servers: {} } };
    }
    if (request.method === "turn/start" || request.method === "review/start") {
      const turnId = `turn-${++ScriptedCodexTransport.sequence}`;
      const turn = { id: turnId, status: "inProgress", items: [], error: null };
      result = request.method === "turn/start" ? { turn } : { turn, reviewThreadId: threadId };
    }
    this.handler(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  }
}
