import type { JsonRpcTransport } from "@pwrdrvr/agent-transport";
import type { AppServerNotification } from "@pwragent/shared";

export type ArchiveWorktreeThread = {
  id: string;
  cwd: string;
  source: string;
  originator?: string;
  name?: string;
  archived?: boolean;
};

/** Provider-owned fixture state survives closing and recreating the client.
 * Source filters and pagination are enforced instead of returning every row
 * regardless of the production request. No real agent or Codex storage is used. */
export class ArchiveWorktreeTransport implements JsonRpcTransport {
  static threads: ArchiveWorktreeThread[] = [];
  static requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  static onList?: (params: Record<string, unknown>, transport: ArchiveWorktreeTransport) => void;
  static rejectSafetySources = false;
  private handler: (message: string) => void = () => {};

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  setCloseHandler(_handler: (error?: Error) => void): void {}
  setMessageHandler(handler: (message: string) => void): void { this.handler = handler; }
  emitNotification(notification: AppServerNotification): void {
    this.handler(JSON.stringify({ jsonrpc: "2.0", ...notification }));
  }

  send(message: string): void {
    const request = JSON.parse(message) as { id?: number; method: string; params?: Record<string, unknown> };
    if (request.id === undefined) return;
    const params = request.params ?? {};
    ArchiveWorktreeTransport.requests.push({ method: request.method, params });
    let result: unknown = {};
    const wireThread = (thread: ArchiveWorktreeThread) => ({
      ...thread, name: thread.name ?? thread.id, createdAt: 1, updatedAt: 2, modelProvider: "openai",
      threadSource: thread.source.startsWith("subAgent") ? "subagent" : "user", turns: [],
    });
    if (request.method === "initialize") {
      result = { userAgent: "archive-fixture/1.0", codexHome: "/fixture", platformFamily: "unix", platformOs: "linux" };
    } else if (request.method === "thread/start") {
      const thread = { id: "old-target", cwd: String(params.cwd), source: "cli", originator: "pwragent-desktop" };
      ArchiveWorktreeTransport.threads.push(thread);
      result = { thread: wireThread(thread) };
    } else if (request.method === "thread/archive") {
      const thread = ArchiveWorktreeTransport.threads.find((row) => row.id === params.threadId);
      if (thread) thread.archived = true;
    } else if (request.method === "thread/read") {
      const thread = ArchiveWorktreeTransport.threads.find((row) => row.id === params.threadId);
      result = { thread: thread ? wireThread(thread) : undefined };
    } else if (request.method === "thread/unarchive") {
      const thread = ArchiveWorktreeTransport.threads.find((row) => row.id === params.threadId);
      if (thread) thread.archived = false;
      result = { thread: thread ? wireThread(thread) : undefined };
    } else if (request.method === "thread/list") {
      ArchiveWorktreeTransport.onList?.(params, this);
      const sources = params.sourceKinds as string[] | undefined;
      if (ArchiveWorktreeTransport.rejectSafetySources && sources?.includes("appServer")) {
        this.handler(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Unsupported safety source filter." } }));
        return;
      }
      const rows = ArchiveWorktreeTransport.threads.filter((row) => Boolean(row.archived) === (params.archived === true)
        && (sources?.length ? sources.includes(row.source) : ["cli", "vscode"].includes(row.source)));
      const offset = Number(params.cursor ?? 0);
      const limit = Number(params.limit ?? 50);
      result = { data: rows.slice(offset, offset + limit).map(wireThread), nextCursor: offset + limit < rows.length ? String(offset + limit) : null };
    } else if (request.method === "model/list") {
      result = { data: [], nextCursor: null };
    }
    this.handler(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  }
}
