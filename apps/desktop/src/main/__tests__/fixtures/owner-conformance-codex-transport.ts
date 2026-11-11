import type { JsonRpcTransport } from "@pwrdrvr/agent-transport";
import { readFileSync, writeFileSync, watch } from "node:fs";
import path from "node:path";

type FixtureTurn = { id: string; status: string; items: unknown[]; error: { message: string } | null };
type FixtureThread = {
  id: string;
  cwd: string;
  preview: string;
  name: string | null;
  createdAt: number;
  updatedAt: number;
  turns: FixtureTurn[];
  archived?: boolean;
};

/**
 * The desktop owner's Codex for the owner conformance suite. It behaves like
 * the Outpost's protocol fixture (packages/pwragent/test/fixtures/codex.js), so
 * a difference between the two owners comes from the owners, not from Codex:
 * the first prompt becomes the thread's preview, and a turn completes shortly
 * after it starts with one "Fixture result" agent message. It runs in process
 * because desktop's client sends requests the Outpost fixture rejects.
 *
 * It also sends two notifications that Codex 0.159.2 sends, recorded in a
 * protocol capture of thread/start then thread/name/set: `thread/started`
 * after a thread starts, and a `thread/name/updated` echo, with no
 * `titleSource`, after each name is set. Each one follows its response.
 * Desktop announces new Codex threads through the first, and must not pass
 * the second to viewers.
 */
export class OwnerConformanceCodexTransport implements JsonRpcTransport {
  static threads = new Map<string, FixtureThread>();
  static requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  static refusedStarts = 0;
  static refusedSteers = 0;
  static recordsFile: string | undefined;
  static helperTitle: string | undefined;
  private static heldCompletions = new Map<string, () => void>();

  /** A protocol-fixture barrier: completion follows the oracle's overlap check. */
  static completeHeldTurn(threadId: string): void {
    const complete = this.heldCompletions.get(threadId);
    if (!complete) throw new Error(`No held fixture turn for ${threadId}`);
    complete();
  }
  private static sequence = 0;
  private static activeTurns = new Map<string, FixtureTurn>();
  private handler: (message: string) => void = () => {};
  private readonly ownedActiveTurns = new Set<string>();
  private get activeTurns() { return OwnerConformanceCodexTransport.activeTurns; }
  private readonly helpers = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private schedule(action: () => void, delay: number): void {
    const timer = setTimeout(() => { this.timers.delete(timer); action(); }, delay);
    this.timers.add(timer);
  }

  static reset(): void {
    OwnerConformanceCodexTransport.threads = new Map();
    OwnerConformanceCodexTransport.requests = [];
    OwnerConformanceCodexTransport.sequence = 0;
    OwnerConformanceCodexTransport.refusedStarts = 0;
    OwnerConformanceCodexTransport.refusedSteers = 0;
    OwnerConformanceCodexTransport.recordsFile = undefined;
    OwnerConformanceCodexTransport.helperTitle = undefined;
    OwnerConformanceCodexTransport.heldCompletions.clear();
    OwnerConformanceCodexTransport.activeTurns.clear();
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const threadId of this.ownedActiveTurns) {
      OwnerConformanceCodexTransport.heldCompletions.delete(threadId);
      this.activeTurns.delete(threadId);
    }
    this.ownedActiveTurns.clear();
  }
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
    const recordsFile = OwnerConformanceCodexTransport.recordsFile;
    if (recordsFile) {
      let records: Record<string, FixtureThread> = {};
      try { records = JSON.parse(readFileSync(recordsFile, "utf8")); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      OwnerConformanceCodexTransport.threads = new Map(Object.entries(records));
      for (const thread of Object.values(records)) {
        for (const id of [thread.id, ...thread.turns.map(turn => turn.id)]) {
          const sequence = /^(?:thread|turn)-(\d+)$/.exec(id)?.[1];
          if (sequence) OwnerConformanceCodexTransport.sequence = Math.max(OwnerConformanceCodexTransport.sequence, Number(sequence));
        }
      }
    }
    const threads = OwnerConformanceCodexTransport.threads;
    const wire = (thread: FixtureThread) => ({
      ...thread, sessionId: thread.id, status: this.activeTurns.has(thread.id)
        ? { type: "active", activeFlags: [] } : { type: "idle" }, source: "cli", modelProvider: "openai",
      ephemeral: false, path: null, cliVersion: "0.159.2", gitInfo: null,
    });
    let result: unknown = {};
    let followUp: { method: string; params: unknown } | undefined;
    if (request.method === "initialize") {
      result = { userAgent: "fixture-codex/0.159.2", codexHome: "/fixture-codex-home", platformFamily: "unix", platformOs: "linux" };
    } else if (request.method === "config/read" && OwnerConformanceCodexTransport.helperTitle) {
      result = { config: { mcp_servers: {} } };
    } else if (request.method === "account/read") {
      result = { account: null, requiresOpenaiAuth: false };
    } else if (request.method === "mcpServerStatus/list" && this.helpers.has(String(params.threadId))) {
      result = { data: [], nextCursor: null };
    } else if (request.method === "thread/unsubscribe" && this.helpers.has(String(params.threadId))) {
      this.helpers.delete(String(params.threadId));
    } else if (request.method === "thread/start" && params.ephemeral === true) {
      const id = `helper-${++OwnerConformanceCodexTransport.sequence}`;
      this.helpers.add(id);
      result = { thread: { id, cwd: params.cwd, ephemeral: true, turns: [] }, instructionSources: [] };
    } else if (request.method === "turn/start" && this.helpers.has(String(params.threadId))) {
      result = { turn: { id: `helper-turn-${++OwnerConformanceCodexTransport.sequence}`, status: "completed", items: [
        { type: "agentMessage", text: JSON.stringify({ title: OwnerConformanceCodexTransport.helperTitle }) },
      ] } };
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
      followUp = { method: "thread/started", params: { thread: wire(thread) } };
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
      result = { data: [...threads.values()].filter(thread => Boolean(thread.archived) === (params.archived === true)).map(wire), nextCursor: null, backwardsCursor: null };
    } else if (request.method === "thread/archive" || request.method === "thread/unarchive") {
      const thread = threads.get(String(params.threadId));
      if (thread) thread.archived = request.method === "thread/archive";
    } else if (request.method === "thread/name/set") {
      const thread = threads.get(String(params.threadId));
      if (thread) {
        thread.name = String(params.name);
        followUp = { method: "thread/name/updated", params: { threadId: thread.id, threadName: thread.name } };
      }
    } else if (request.method === "turn/start") {
      if (OwnerConformanceCodexTransport.refusedStarts > 0) {
        OwnerConformanceCodexTransport.refusedStarts -= 1;
        this.handler(JSON.stringify({ jsonrpc: "2.0", id: request.id,
          error: { code: -32600, message: "Fixture provider refused submission" } }));
        return;
      }
      const thread = threads.get(String(params.threadId));
      const input = params.input as Array<{ type: string; text?: string }> | undefined;
      const prompt = input?.find((item) => item.type === "text")?.text ?? "";
      if (thread && !thread.preview) thread.preview = prompt;
      const turnId = `turn-${++OwnerConformanceCodexTransport.sequence}`;
      result = { turn: { id: turnId, status: "inProgress", items: [], error: null } };
      if (thread && prompt === "slow") {
        // Match the Outpost fixture's held turn, released by turn/interrupt.
        const turn: FixtureTurn = { id: turnId, status: "inProgress", items: [], error: null };
        this.activeTurns.set(thread.id, turn);
        this.ownedActiveTurns.add(thread.id);
        OwnerConformanceCodexTransport.heldCompletions.set(thread.id, () => {
          this.activeTurns.delete(thread.id);
          OwnerConformanceCodexTransport.heldCompletions.delete(thread.id);
          turn.status = "completed";
          turn.items = [{ type: "agentMessage", text: "Fixture result" }];
          const current = OwnerConformanceCodexTransport.threads.get(thread.id)!;
          current.turns = current.turns.map(value => value.id === turn.id ? turn : value);
          if (recordsFile) writeFileSync(recordsFile, JSON.stringify(Object.fromEntries(OwnerConformanceCodexTransport.threads)));
          this.notify("turn/completed", { threadId: thread.id, turn });
        });
        thread.turns.push(turn);
        followUp = { method: "turn/started", params: { threadId: thread.id, turn } };
      } else if (thread) {
        this.schedule(() => {
          // The same turn the Outpost fixture records: one agent message.
          const turn = { id: turnId, status: prompt === "fail" ? "failed" : "completed", items: [{ type: "agentMessage", text: "Fixture result" }], error: prompt === "fail" ? { message: "Fixture failure" } : null };
          const current = OwnerConformanceCodexTransport.threads.get(thread.id)!;
          current.turns.push(turn);
          // Codex reports seconds. A real turn outlasts one, so its end always
          // moves the thread's activity forward; this one takes 100 ms.
          current.updatedAt = Math.max(Math.floor(Date.now() / 1000), current.updatedAt + 1);
          if (recordsFile) writeFileSync(recordsFile, JSON.stringify(Object.fromEntries(OwnerConformanceCodexTransport.threads)));
          this.notify("turn/completed", { threadId: thread.id, turn });
        }, 100);
      }
    } else if (request.method === "turn/steer" || request.method === "turn/interrupt") {
      if (request.method === "turn/steer" && OwnerConformanceCodexTransport.refusedSteers > 0) {
        OwnerConformanceCodexTransport.refusedSteers--;
        this.handler(JSON.stringify({ jsonrpc: "2.0", id: request.id,
          error: { code: -32600, message: "Fixture provider refused guidance" } }));
        return;
      }
      const turn = this.activeTurns.get(String(params.threadId));
      const expected = request.method === "turn/steer" ? params.expectedTurnId : params.turnId;
      if (!turn || turn.id !== expected) {
        this.handler(JSON.stringify({ jsonrpc: "2.0", id: request.id,
          error: { code: -32600, message: "Active turn changed" } }));
        return;
      }
      if (request.method === "turn/steer") {
        result = { turnId: turn.id };
        const prompt = (params.input as Array<{ text?: string }> | undefined)?.[0]?.text;
        if (prompt === "hold-steer-ack" && recordsFile) {
          const directory = path.dirname(recordsFile);
          const watcher = watch(directory, (_event, file) => {
            if (String(file) !== "steer.release") return;
            watcher.close();
            this.handler(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
          });
          writeFileSync(path.join(directory, "steer.ready"), turn.id);
          return;
        }
      }
      else {
        turn.status = "interrupted";
        const current = threads.get(String(params.threadId))!;
        current.turns = current.turns.map(value => value.id === turn.id ? turn : value);
        this.activeTurns.delete(String(params.threadId));
        OwnerConformanceCodexTransport.heldCompletions.delete(String(params.threadId));
        followUp = { method: "turn/completed", params: { threadId: params.threadId, turn } };
      }
    }
    if (recordsFile) writeFileSync(recordsFile, JSON.stringify(Object.fromEntries(threads)));
    this.handler(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    const next = followUp;
    if (next) this.schedule(() => this.notify(next.method, next.params), 0);
  }
}
