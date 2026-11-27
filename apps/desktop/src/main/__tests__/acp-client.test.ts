import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPendingRequestActions,
  buildPendingRequestResponse,
} from "@pwragent/shared/pending-request-response";
import { deriveInboxState } from "@pwragent/shared/inbox";
import type { AppServerPendingRequestNotification } from "@pwragent/shared/contracts/normalized-app-server";
import { AcpAgentClient, AcpSessionTransferBusyError, resolveAntigravityMcpToolTarget } from "../acp/acp-client";
import { pwragentToolSkipsAgentApproval } from "../app-server/acp-host-tool-approval";
import { AcpRolloutStore } from "../acp/acp-rollout-store";
import { AcpSessionStore } from "../storage/acp-session-store";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import { StateDb } from "../state/state-db";
import { createAcpPromptSettlement } from "./fixtures/acp-prompt-settlement";
import {
  openInMemoryStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

let tempDir: string;
let stateDb: StateDb;
let store: AcpSessionStore;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-acp-client-"));
  stateDb = openInMemoryStateDb();
  store = new AcpSessionStore(stateDb);
});

afterEach(() => {
  vi.useRealTimers();
  stateDb.close();
  removeTempStateDbDir(tempDir);
});

it("persists ordinary ACP activity but strips review ledger payloads across tool updates", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom(
    { name: "mcp_pwragent_record_review_candidate" },
    { title: "dispose_review_candidate" },
    { rawInput: { variant: "UseTool", tool_name: "list_review_candidates" } },
    { name: "mcp_pwragent_submit_review_output" },
  ), async (identity) => {
    const transport = new FakeAcpAgentTransport();
    const rolloutStore = new AcpRolloutStore(mkdtempSync(path.join(tempDir, "review-rollout-")));
    const backendId = "acp:antigravity";
    const client = new AcpAgentClient({
      backendId, store, transport, rolloutStore,
      mcpServers: () => ({
        servers: [{ type: "http", name: "pwragent", url: "http://127.0.0.1/mcp", headers: [] }],
        managedReviewLedgerAvailable: true,
      }),
    });
    try {
      await client.initialize();
      const { sessionId } = await client.startSession({
        cwd: "/repo", executionMode: "default", managedReview: true,
      });
      transport.emitSessionUpdate(sessionId, {
        sessionUpdate: "tool_call", toolCallId: "ledger", status: "pending",
        ...identity,
        rawInput: { ...("rawInput" in identity ? identity.rawInput : {}), input: "private-candidate-input" },
      });
      transport.emitSessionUpdate(sessionId, {
        sessionUpdate: "tool_call", toolCallId: "ordinary", title: "read_file", status: "pending",
        rawInput: { path: "ordinary-source.ts" },
      });
      transport.emitSessionUpdate(sessionId, {
        sessionUpdate: "tool_call_update", toolCallId: "ledger", status: "completed",
        rawOutput: "private-candidate-result",
        content: [{ type: "content", content: { type: "text", text: "private-candidate-result" } }],
        _meta: { output: "private-candidate-result" },
      });
      const updates = rolloutStore.readUpdates({ backendId, sessionId }).map((record) => record.update);
      expect(JSON.stringify(updates)).not.toContain("private-candidate-");
      expect(updates).toContainEqual(expect.objectContaining({
        toolCallId: "ordinary", rawInput: { path: "ordinary-source.ts" },
      }));
      expect(updates).toContainEqual(expect.objectContaining({
        toolCallId: "ledger", status: "completed",
      }));
    } finally {
      await client.dispose();
    }
  }), { numRuns: 4, examples: [
    [{ name: "mcp_pwragent_record_review_candidate" }],
    [{ title: "dispose_review_candidate" }],
    [{ rawInput: { variant: "UseTool", tool_name: "list_review_candidates" } }],
    [{ name: "mcp_pwragent_submit_review_output" }],
  ] });
});

it("keeps Grok planning provenance when selecting permissions and receiving mode updates", async () => {
  const configOptions = [{
    id: "permission_mode",
    category: "mode",
    currentValue: "auto",
    options: [{ value: "default", name: "Default" }, { value: "auto", name: "Auto" }],
  }];
  const modes = {
    currentModeId: "plan",
    availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }],
  };
  const transport = new FakeAcpAgentTransport({
    "session/new": { sessionId: "grok-session", configOptions, modes },
    "session/set_config_option": {
      configOptions: [{ ...configOptions[0], currentValue: "default" }],
      modes,
    },
  });
  const client = new AcpAgentClient({ backendId: "acp:grok", store, transport });
  await client.initialize();
  await client.startSession({ cwd: "/repo", executionMode: "default" });
  await expect(client.setRuntimeOption({
    sessionId: "grok-session",
    source: "configOption",
    optionId: "permission_mode",
    value: "default",
  })).resolves.toMatchObject({
    currentModeId: "plan",
    configValues: { permission_mode: "default" },
  });
  transport.emitSessionUpdate("grok-session", {
    sessionUpdate: "current_mode_update",
    currentModeId: "default",
  });
  expect(store.getSession("acp:grok", "grok-session")?.acpRuntime).toMatchObject({
    currentModeId: "default",
    configValues: { permission_mode: "default" },
  });
  await client.dispose();
});

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

/**
 * Kimi Code 2.0.0's `session/set_config_option` behavior, as measured against
 * the real CLI:
 * - The model decides which thought levels exist.
 * - A model change keeps the session's current level and lists it in the new
 *   model's menu, whether or not that model offers it.
 * - A level the current model does not offer is refused with -32602.
 * - Every reply carries the full option set.
 */
class KimiConfigOptionTransport extends FakeAcpAgentTransport {
  model = "kimi-code/kimi-for-coding";
  thinking = "on";

  override async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (method === "session/new") {
      this.requests.push({ method, params });
      return { sessionId: "kimi-session", configOptions: this.configOptions() };
    }
    if (method !== "session/set_config_option") {
      return await super.request(method, params, timeoutMs);
    }
    this.requests.push({ method, params });
    const value = String(params?.value);
    if (params?.configId === "model") {
      this.model = value;
    } else if (params?.configId === "thinking") {
      if (!this.levels().includes(value)) {
        throw new Error(`Invalid params: Unknown thinking value: ${value}`);
      }
      this.thinking = value;
    }
    return { configOptions: this.configOptions() };
  }

  private levels(): string[] {
    return this.model === "kimi-code/k3" ? ["low", "high", "max"] : ["on"];
  }

  configOptions(): Array<Record<string, unknown>> {
    const levels = this.levels().includes(this.thinking)
      ? this.levels()
      : [...this.levels(), this.thinking];
    return [
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: this.model,
        options: [
          { value: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
          { value: "kimi-code/k3", name: "K3" },
        ],
      },
      {
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        currentValue: this.thinking,
        options: levels.map((level) => ({ value: level, name: level })),
      },
    ];
  }
}

/**
 * Holds `session/prompt` open the way a busy agent does, and applies the same
 * deadline `JsonRpcConnection` does: every request gets a timer, and an
 * omitted deadline falls back to the ACP stdio transport's 10-minute default.
 */
class DeadlineEnforcingAcpTransport extends FakeAcpAgentTransport {
  private settle: ((value: unknown) => void) | undefined;

  override async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (method !== "session/prompt") {
      return await super.request(method, params, timeoutMs);
    }
    this.requests.push({ method, params, timeoutMs });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`json-rpc timeout: ${method}`));
      }, Math.max(100, timeoutMs ?? 10 * 60_000));
      this.settle = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
    });
  }

  settlePrompt(value: unknown): void {
    this.settle?.(value);
  }
}

function readRawAcpSessionPayload(
  backendId: string,
  sessionId: string,
): Record<string, unknown> | undefined {
  const row = stateDb.raw
    .prepare(
      `SELECT payload FROM acp_sessions WHERE backend_id = ? AND session_id = ?`,
    )
    .get(backendId, sessionId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
}

describe("AcpAgentClient", () => {
  it.each(["acp:qwen", "acp:kimi", "acp:grok"] as const)(
    "denies helper approvals without consulting the operator for %s",
    async (backendId) => {
      const transport = new FakeAcpAgentTransport();
      const onRequest = vi.fn(() => ({ decision: "accept" }));
      const client = new AcpAgentClient({ backendId, store, transport, onRequest });
      await client.initialize();
      const session = await client.startSession({
        sessionId: "helper-app-id",
        cwd: tempDir,
        executionMode: "default",
        approvalPolicy: "deny-all",
        hidden: true,
        mcpServers: "none",
      });
      expect(store.getSession(backendId, session.sessionId)?.approvalPolicy).toBe("deny-all");
      const permission = {
        toolCall: { toolCallId: "tool-1", kind: "execute", title: "Run command" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      };
      await expect(transport.emitRequest("session/request_permission", {
        ...permission,
        sessionId: "session-1",
      })).resolves.toEqual({ outcome: { outcome: "cancelled" } });
      expect(onRequest).not.toHaveBeenCalled();

      // An unrelated session retains the normal approval path.
      await expect(transport.emitRequest("session/request_permission", {
        ...permission,
        sessionId: "parent-session",
      })).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
      expect(onRequest).toHaveBeenCalledOnce();
      await client.dispose();
    },
  );
  it("rejects unsupported Grok steering before sending the extension RPC", async () => {
    const transport = new FakeAcpAgentTransport({
      "_x.ai/session/steer": { result: { delivery: "currentTurn" } },
    });
    const client = new AcpAgentClient({ backendId: "acp:grok", store, transport });
    await client.initialize();
    const session = await client.startSession({ executionMode: "default", mcpServers: "none" });
    try {
      await expect(client.steerSession({
        sessionId: session.sessionId,
        text: "Add berries",
        content: [{ type: "text", text: "Add berries" }],
        interjectionId: "steer-unsupported",
      })).rejects.toThrow("does not support turn steering over ACP");
      expect(transport.requests.map((request) => request.method)).not.toContain("_x.ai/session/steer");
    } finally {
      await client.dispose();
    }
  });

  it("sends Grok steering and workflow-budget extension payloads", async () => {
    const transport = new FakeAcpAgentTransport({
      "session/new": { sessionId: "grok-session" },
      "_x.ai/session/steer": {
        result: { status: "queued", delivery: "currentTurn" },
      },
      "_x.ai/session/workflow_budget": {
        result: { defaultAgentBudget: 64, maxAgentBudget: 256 },
      },
    });
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      supportsTurnSteering: true,
      store,
      transport,
    });
    await client.initialize();
    const session = await client.startSession({
      executionMode: "default",
      mcpServers: "none",
    });

    await expect(client.steerSession({
      sessionId: session.sessionId,
      text: "Add berries",
      content: [{ type: "text", text: "Add berries" }],
      interjectionId: "steer-1",
    })).resolves.toEqual({ delivery: "currentTurn" });
    await expect(client.configureWorkflowBudget({
      sessionId: session.sessionId,
      defaultAgentBudget: 64,
      maxAgentBudget: 256,
    })).resolves.toEqual({ defaultAgentBudget: 64, maxAgentBudget: 256 });

    expect(transport.requests.slice(-2)).toEqual([
      {
        method: "_x.ai/session/steer",
        params: {
          sessionId: "grok-session",
          text: "Add berries",
          interjectionId: "steer-1",
          content: [{ type: "text", text: "Add berries" }],
        },
        timeoutMs: 20_000,
      },
      {
        method: "_x.ai/session/workflow_budget",
        params: {
          sessionId: "grok-session",
          defaultAgentBudget: 64,
          maxAgentBudget: 256,
        },
        timeoutMs: 20_000,
      },
    ]);
  });

  it("separates Antigravity's in-flight generation, compaction request, and continuation context reports", async () => {
    const prompts: Array<ReturnType<typeof Promise.withResolvers<unknown>>> = [];
    const transport = new FakeAcpAgentTransport({
      initialize: { protocolVersion: 1, agentInfo: { name: "Antigravity ACP Server", version: "1.5.18" } },
    });
    const request = transport.request.bind(transport);
    transport.request = async (method, params, timeout) => {
      if (method !== "session/prompt") return await request(method, params, timeout);
      const deferred = Promise.withResolvers<unknown>();
      prompts.push(deferred);
      return deferred.promise;
    };
    const updates: Array<{ used: unknown; source: unknown; turnId: unknown }> = [];
    const finishes: Array<{ compacted: unknown; usage: unknown }> = [];
    const client = new AcpAgentClient({
      backendId: "acp:antigravity", store, transport,
      onSessionUpdate: (event) => {
        if (event.update.sessionUpdate === "usage_update") {
          updates.push({ used: event.update.used, source: event.contextUsageSource, turnId: event.turnId });
        }
        if (event.update.kind === "turn_finished") {
          finishes.push({ compacted: event.completedAcpCompactionRequest, usage: event.update.usage });
        }
      },
    });
    async function start(turnId: string) {
      await client.startPrompt({ sessionId: "session-1", prompt: "Write about gardening.", turnId });
    }
    function report(used: number) {
      transport.emitSessionUpdate("session-1", { sessionUpdate: "usage_update", used, size: 1_048_576 });
    }
    try {
      await client.initialize();
      await client.startSession({ cwd: "/repo", executionMode: "default", mcpServers: "none" });
      report(0);
      await start("turn-1");
      const steer = client.steerSession({ sessionId: "session-1", text: "/compact",
        content: [{ type: "text", text: "/compact" }], interjectionId: "compaction" });
      await vi.waitFor(() => expect(prompts).toHaveLength(2));
      prompts[0]!.resolve({ stopReason: "end_turn" });
      report(37_205);
      report(38_745);
      report(38_745);
      prompts[1]!.resolve({ stopReason: "end_turn", usage: { totalTokens: 75_950 } });
      await expect(steer).resolves.toEqual({ delivery: "currentTurn" });
      await vi.waitFor(() => expect(finishes).toHaveLength(1));
      expect(updates).toEqual([
        { used: 0, source: "session", turnId: undefined },
        { used: 37_205, source: undefined, turnId: "turn-1" },
        { used: 38_745, source: "compaction", turnId: "turn-1" },
      ]);
      expect(finishes[0]).toEqual({ compacted: true, usage: { totalTokens: 75_950 } });
      await start("turn-2");
      transport.emitSessionUpdate("session-1", {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." },
      });
      report(13_383);
      prompts[2]!.resolve({ stopReason: "end_turn" });
      await vi.waitFor(() => expect(finishes).toHaveLength(2));
      expect(updates.at(-1)).toEqual({ used: 13_383, source: undefined, turnId: "turn-2" });
      expect(finishes[1]?.compacted).toBeUndefined();

      // Replacing /compact must flush its summary and start a clean ordinary generation.
      await client.startPrompt({ sessionId: "session-1", prompt: "/compact",
        turnId: "turn-3", isCompactCommand: true });
      const replacement = client.steerSession({ sessionId: "session-1", text: "Keep gardening.",
        content: [{ type: "text", text: "Keep gardening." }], interjectionId: "replace-compact" });
      await vi.waitFor(() => expect(prompts).toHaveLength(5));
      report(39_000);
      prompts[3]!.resolve({ stopReason: "end_turn" });
      // Wait for the detached response's handler to observe the handoff.
      await new Promise<void>((resolve) => setImmediate(resolve));
      transport.emitSessionUpdate("session-1", {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Continuing." },
      });
      await expect(replacement).resolves.toEqual({ delivery: "currentTurn" });
      report(15_000);
      report(16_000);
      prompts[4]!.resolve({ stopReason: "end_turn" });
      await vi.waitFor(() => expect(finishes).toHaveLength(3));
      expect(updates.slice(-3)).toEqual([
        { used: 39_000, source: "compaction", turnId: "turn-3" },
        { used: 15_000, source: undefined, turnId: "turn-3" },
        { used: 16_000, source: undefined, turnId: "turn-3" },
      ]);
      expect(finishes[2]?.compacted).toBeUndefined();
    } finally {
      await client.dispose();
    }
  });

  it("steers an active Antigravity turn via overlapping session/prompt handoff", async () => {
    const prompts: Array<ReturnType<typeof createDeferred<unknown>>> = [];
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" },
      },
      "session/new": { sessionId: "agy-session" },
    });
    const baseRequest = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/prompt") {
        transport.requests.push({ method, params, timeoutMs });
        const deferred = createDeferred<unknown>();
        prompts.push(deferred);
        return await deferred.promise;
      }
      return await baseRequest(method, params, timeoutMs);
    };
    const rolloutStore = new AcpRolloutStore(path.join(tempDir, "rollouts"));
    let clock = 1000;
    const updates: Array<{ turnId?: string; update: Record<string, unknown> }> = [];
    const onPromptError = vi.fn();
    const client = new AcpAgentClient({
      backendId: "acp:antigravity",
      store,
      rolloutStore,
      transport,
      now: () => (clock += 10),
      onSessionUpdate: ({ turnId, update }) => {
        updates.push({ turnId, update });
      },
      onPromptError,
    });

    await client.initialize();
    expect(client.supportsTurnSteering()).toBe(true);
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
      mcpServers: "none",
    });
    const started = await client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Write a 60-line poem about ocean waves.",
      turnId: "turn-1",
    });
    expect(started.turnId).toBe("turn-1");
    expect(prompts).toHaveLength(1);

    // Stream only a thought chunk before steering — no assistant message text yet.
    transport.emitSessionUpdate("agy-session", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Planning the poem..." },
    });

    const steerPromise = client.steerSession({
      sessionId: session.sessionId,
      text: "Stop and reply ONLY with PINEAPPLE.",
      prompt: "Stop and reply ONLY with PINEAPPLE.",
      parts: [{ type: "text", text: "Stop and reply ONLY with PINEAPPLE." }],
      content: [{ type: "text", text: "Stop and reply ONLY with PINEAPPLE." }],
      interjectionId: "steer-1",
    });
    await vi.waitFor(() => expect(prompts).toHaveLength(2));

    // Antigravity immediately detaches the running prompt with end_turn (no usage).
    prompts[0]!.resolve({ stopReason: "end_turn" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    transport.emitSessionUpdate("agy-session", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "PINEAPPLE" },
    });
    await expect(steerPromise).resolves.toEqual({ delivery: "currentTurn" });

    // The turn remains active under the second prompt; no premature turn_finished.
    expect(client.hasActiveTurns()).toBe(true);
    expect(store.getSession("acp:antigravity", session.sessionId)?.status).toBe("active");
    expect(updates.some((entry) => entry.update.kind === "turn_finished")).toBe(false);
    expect(updates.some((entry) => entry.update.kind === "pwragent_steered_user_prompt")).toBe(true);
    expect(onPromptError).not.toHaveBeenCalled();

    prompts[1]!.resolve({ stopReason: "end_turn", usage: { totalTokens: 42 } });

    await vi.waitFor(() => {
      expect(updates.filter((entry) => entry.update.kind === "turn_finished")).toHaveLength(1);
    });
    expect(client.hasActiveTurns()).toBe(false);
    expect(store.getSession("acp:antigravity", session.sessionId)?.status).toBe("idle");
    expect(onPromptError).not.toHaveBeenCalled();

    const replay = client.readReplay(session.sessionId);
    expect(replay.messages.map((message) => ({ role: message.role, text: message.text }))).toEqual([
      { role: "user", text: "Write a 60-line poem about ocean waves." },
      { role: "assistant", text: "Planning the poem..." },
      { role: "user", text: "Stop and reply ONLY with PINEAPPLE." },
      { role: "assistant", text: "PINEAPPLE" },
    ]);

    // Rollout history reproduces the steered user message on a fresh client.
    await client.dispose();
    const restoredClient = new AcpAgentClient({
      backendId: "acp:antigravity",
      store,
      rolloutStore,
      transport: new FakeAcpAgentTransport({ initialize: { protocolVersion: 1, agentCapabilities: { loadSession: false } } }),
    });
    await restoredClient.initialize();
    const restoredReplay = await restoredClient.loadSession(
      store.getSession("acp:antigravity", session.sessionId)!,
    );
    expect(restoredReplay.messages.map((message) => ({ role: message.role, text: message.text }))).toEqual([
      { role: "user", text: "Write a 60-line poem about ocean waves." },
      { role: "assistant", text: "Planning the poem..." },
      { role: "user", text: "Stop and reply ONLY with PINEAPPLE." },
      { role: "assistant", text: "PINEAPPLE" },
    ]);
    await restoredClient.dispose();
  });

  it("keeps the original Antigravity prompt running when a concurrent steer is rejected", async () => {
    const prompts: Array<ReturnType<typeof createDeferred<unknown>>> = [];
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" },
      },
      "session/new": { sessionId: "agy-session" },
    });
    const baseRequest = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/prompt") {
        transport.requests.push({ method, params, timeoutMs });
        const deferred = createDeferred<unknown>();
        prompts.push(deferred);
        return await deferred.promise;
      }
      return await baseRequest(method, params, timeoutMs);
    };
    const updates: Array<Record<string, unknown>> = [];
    const onPromptError = vi.fn();
    const client = new AcpAgentClient({
      backendId: "acp:antigravity",
      store,
      transport,
      onSessionUpdate: ({ update }) => { updates.push(update); },
      onPromptError,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
      mcpServers: "none",
    });
    await client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Run echo hello",
      turnId: "turn-1",
    });

    const steerPromise = client.steerSession({
      sessionId: session.sessionId,
      text: "Never mind",
      content: [{ type: "text", text: "Never mind" }],
      interjectionId: "steer-perm",
    });
    await vi.waitFor(() => expect(prompts).toHaveLength(2));

    prompts[1]!.reject(
      new Error("the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again"),
    );
    await expect(steerPromise).rejects.toThrow("waiting for a permission or question answer");

    // Original prompt is still alive and no steered message was recorded.
    expect(client.hasActiveTurns()).toBe(true);
    expect(onPromptError).not.toHaveBeenCalled();
    expect(updates.some((update) => update.kind === "pwragent_steered_user_prompt")).toBe(false);

    transport.emitSessionUpdate("agy-session", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    });
    prompts[0]!.resolve({ stopReason: "end_turn" });

    await vi.waitFor(() => {
      expect(updates.filter((update) => update.kind === "turn_finished")).toHaveLength(1);
    });
    expect(client.hasActiveTurns()).toBe(false);
    expect(client.readReplay(session.sessionId).messages.map((m) => m.text)).toEqual([
      "Run echo hello",
      "hello",
    ]);
    await client.dispose();
  });

  it("chains multiple Antigravity steers and cancels the latest in-flight prompt", async () => {
    const prompts: Array<ReturnType<typeof createDeferred<unknown>>> = [];
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" },
      },
      "session/new": { sessionId: "agy-session" },
    });
    const baseRequest = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/prompt") {
        transport.requests.push({ method, params, timeoutMs });
        const deferred = createDeferred<unknown>();
        prompts.push(deferred);
        return await deferred.promise;
      }
      return await baseRequest(method, params, timeoutMs);
    };
    const updates: Array<Record<string, unknown>> = [];
    const client = new AcpAgentClient({
      backendId: "acp:antigravity",
      store,
      transport,
      onSessionUpdate: ({ update }) => { updates.push(update); },
    });

    await client.initialize();
    const session = await client.startSession({ cwd: "/repo", executionMode: "default", mcpServers: "none" });
    await client.startPrompt({ sessionId: session.sessionId, prompt: "First", turnId: "turn-1" });

    const steer1 = client.steerSession({
      sessionId: session.sessionId,
      text: "Second",
      content: [{ type: "text", text: "Second" }],
      interjectionId: "s-1",
    });
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    prompts[0]!.resolve({ stopReason: "end_turn" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    transport.emitSessionUpdate("agy-session", {
      sessionUpdate: "tool_call", toolCallId: "after-first-steer", status: "in_progress",
    });
    await expect(steer1).resolves.toEqual({ delivery: "currentTurn" });

    const steer2 = client.steerSession({
      sessionId: session.sessionId,
      text: "Third",
      content: [{ type: "text", text: "Third" }],
      interjectionId: "s-2",
    });
    await vi.waitFor(() => expect(prompts).toHaveLength(3));
    prompts[1]!.resolve({ stopReason: "end_turn" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    transport.emitSessionUpdate("agy-session", {
      sessionUpdate: "tool_call", toolCallId: "after-second-steer", status: "in_progress",
    });
    await expect(steer2).resolves.toEqual({ delivery: "currentTurn" });

    await client.cancelSession(session.sessionId);
    prompts[2]!.resolve({ stopReason: "cancelled" });

    await vi.waitFor(() => {
      expect(updates.filter((update) => update.kind === "turn_finished")).toHaveLength(1);
    });
    expect(updates.find((update) => update.kind === "turn_finished")?.stopReason).toBe("cancelled");
    expect(client.hasActiveTurns()).toBe(false);
    expect(client.readReplay(session.sessionId).messages.map((m) => m.text)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
    await client.dispose();
  });

  it("rejects Antigravity steering and cancels an unsettled follow-up if the active prompt is cancelled mid-handoff", async () => {
    const prompts: Array<ReturnType<typeof createDeferred<unknown>>> = [];
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" },
      },
      "session/new": { sessionId: "agy-session" },
    });
    const baseRequest = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/prompt") {
        transport.requests.push({ method, params, timeoutMs });
        const deferred = createDeferred<unknown>();
        prompts.push(deferred);
        return await deferred.promise;
      }
      return await baseRequest(method, params, timeoutMs);
    };
    const updates: Array<Record<string, unknown>> = [];
    const onPromptError = vi.fn();
    const client = new AcpAgentClient({
      backendId: "acp:antigravity",
      store,
      transport,
      onSessionUpdate: ({ update }) => { updates.push(update); },
      onPromptError,
    });

    await client.initialize();
    const session = await client.startSession({ cwd: "/repo", executionMode: "default", mcpServers: "none" });
    await client.startPrompt({ sessionId: session.sessionId, prompt: "First", turnId: "turn-1" });

    const steer = client.steerSession({
      sessionId: session.sessionId,
      text: "Late steer",
      content: [{ type: "text", text: "Late steer" }],
      interjectionId: "s-cancel",
    });
    await vi.waitFor(() => expect(prompts).toHaveLength(2));

    // Active prompt settles as cancelled instead of detaching with end_turn.
    prompts[0]!.resolve({ stopReason: "cancelled" });
    await expect(steer).rejects.toThrow("cancelled before steering was accepted");

    // Late rejection/settlement of the follow-up prompt must not emit a second terminal event or error.
    prompts[1]!.reject(new Error("the running prompt is being cancelled"));
    await vi.waitFor(() => {
      expect(updates.filter((update) => update.kind === "turn_finished")).toHaveLength(1);
    });
    expect(transport.notifications.some((n) => n.method === "session/cancel")).toBe(true);
    expect(onPromptError).not.toHaveBeenCalled();
    expect(client.hasActiveTurns()).toBe(false);
    await client.dispose();
  });

  it("accepts Antigravity steering when the detached prompt returns usage after tool rounds and sums turn usage", async () => {
    const prompts: Array<ReturnType<typeof createDeferred<unknown>>> = [];
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" },
      },
      "session/new": { sessionId: "agy-session" },
    });
    const baseRequest = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/prompt") {
        transport.requests.push({ method, params, timeoutMs });
        const deferred = createDeferred<unknown>();
        prompts.push(deferred);
        return await deferred.promise;
      }
      return await baseRequest(method, params, timeoutMs);
    };
    const updates: Array<Record<string, unknown>> = [];
    const onPromptError = vi.fn();
    const client = new AcpAgentClient({
      backendId: "acp:antigravity",
      store,
      transport,
      onSessionUpdate: ({ update }) => { updates.push(update); },
      onPromptError,
    });

    await client.initialize();
    const session = await client.startSession({ cwd: "/repo", executionMode: "default", mcpServers: "none" });
    await client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Inspect CPU resource checkouts.",
      turnId: "turn-1",
    });

    // Tool calls and thoughts ran before steering, with no final assistant text yet.
    transport.emitSessionUpdate("agy-session", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Checking resource checkout files..." },
    });
    transport.emitSessionUpdate("agy-session", {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      name: "run_command",
      status: "in_progress",
    });
    transport.emitSessionUpdate("agy-session", {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      name: "run_command",
      status: "completed",
    });
    transport.emitSessionUpdate("agy-session", {
      sessionUpdate: "tool_call",
      toolCallId: "call-2",
      name: "run_command",
      status: "in_progress",
    });

    const steer = client.steerSession({
      sessionId: session.sessionId,
      text: "Check what is asking for 16 CPUs too.",
      prompt: "Check what is asking for 16 CPUs too.",
      parts: [{ type: "text", text: "Check what is asking for 16 CPUs too." }],
      content: [{ type: "text", text: "Check what is asking for 16 CPUs too." }],
      interjectionId: "steer-after-tools",
    });
    await vi.waitFor(() => expect(prompts).toHaveLength(2));

    // Antigravity 1.5.15 detaches the running prompt with end_turn AND accumulated usage.
    prompts[0]!.resolve({
      stopReason: "end_turn",
      usage: {
        inputTokens: 16_937,
        outputTokens: 208,
        cachedReadTokens: 12_614,
        cachedWriteTokens: 0,
        thoughtTokens: 116,
        totalTokens: 29_759,
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    transport.emitSessionUpdate("agy-session", {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-2",
      name: "run_command",
      status: "completed",
    });
    transport.emitSessionUpdate("agy-session", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "MANGO" },
    });
    await expect(steer).resolves.toEqual({ delivery: "currentTurn" });

    expect(client.hasActiveTurns()).toBe(true);
    expect(store.getSession("acp:antigravity", session.sessionId)?.status).toBe("active");
    expect(transport.notifications.some((n) => n.method === "session/cancel")).toBe(false);
    expect(onPromptError).not.toHaveBeenCalled();
    expect(updates.some((u) => u.kind === "turn_finished")).toBe(false);

    prompts[1]!.resolve({
      stopReason: "end_turn",
      usage: {
        inputTokens: 2_443,
        outputTokens: 41,
        cachedReadTokens: 12_831,
        cachedWriteTokens: 0,
        thoughtTokens: 38,
        totalTokens: 15_315,
      },
    });

    await vi.waitFor(() => {
      expect(updates.filter((u) => u.kind === "turn_finished")).toHaveLength(1);
    });
    expect(onPromptError).not.toHaveBeenCalled();
    expect(updates.find((u) => u.kind === "turn_finished")?.usage).toEqual({
      inputTokens: 19_380,
      outputTokens: 249,
      cachedReadTokens: 25_445,
      cachedWriteTokens: 0,
      thoughtTokens: 154,
      totalTokens: 45_074,
    });
    expect(client.readReplay(session.sessionId).messages.map((m) => ({ role: m.role, text: m.text }))).toEqual([
      { role: "user", text: "Inspect CPU resource checkouts." },
      { role: "assistant", text: "Checking resource checkout files..." },
      { role: "user", text: "Check what is asking for 16 CPUs too." },
      { role: "assistant", text: "MANGO" },
    ]);
    await client.dispose();
  });

  it("preserves detached Antigravity prompt usage when the replacement prompt fails", async () => {
    const prompts: Array<ReturnType<typeof createDeferred<unknown>>> = [];
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" },
      },
      "session/new": { sessionId: "agy-session" },
    });
    const baseRequest = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/prompt") {
        transport.requests.push({ method, params, timeoutMs });
        const deferred = createDeferred<unknown>();
        prompts.push(deferred);
        return await deferred.promise;
      }
      return await baseRequest(method, params, timeoutMs);
    };
    const onPromptError = vi.fn();
    const client = new AcpAgentClient({
      backendId: "acp:antigravity",
      store,
      transport,
      onPromptError,
    });

    await client.initialize();
    const session = await client.startSession({ cwd: "/repo", executionMode: "default", mcpServers: "none" });
    await client.startPrompt({ sessionId: session.sessionId, prompt: "First", turnId: "turn-1" });

    const steer = client.steerSession({
      sessionId: session.sessionId,
      text: "Second",
      content: [{ type: "text", text: "Second" }],
      interjectionId: "s-err",
    });
    await vi.waitFor(() => expect(prompts).toHaveLength(2));

    prompts[0]!.resolve({
      stopReason: "end_turn",
      usage: {
        inputTokens: 1_000,
        cachedReadTokens: 500,
        cachedWriteTokens: 0,
        outputTokens: 50,
        thoughtTokens: 20,
        totalTokens: 1_550,
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    transport.emitSessionUpdate("agy-session", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Considering the steer" },
    });
    await expect(steer).resolves.toEqual({ delivery: "currentTurn" });

    prompts[1]!.reject(new Error("upstream disconnect"));
    await vi.waitFor(() => expect(onPromptError).toHaveBeenCalledTimes(1));
    expect(onPromptError).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.sessionId,
      turnId: "turn-1",
      usage: {
        scope: "turn",
        tokenUsage: {
          inputTokens: 1_500,
          cachedInputTokens: 500,
          outputTokens: 50,
          reasoningOutputTokens: 20,
          totalTokens: 1_550,
        },
      },
    }));
    await client.dispose();
  });

  it("refuses Antigravity turn steering on CLI versions below 1.5.0 without sending a concurrent prompt", async () => {
    const prompts: Array<ReturnType<typeof createDeferred<unknown>>> = [];
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.4.9" },
      },
      "session/new": { sessionId: "agy-old-session" },
    });
    const baseRequest = transport.request.bind(transport);
    transport.request = async (method, params, timeoutMs) => {
      if (method === "session/prompt") {
        transport.requests.push({ method, params, timeoutMs });
        const deferred = createDeferred<unknown>();
        prompts.push(deferred);
        return await deferred.promise;
      }
      return await baseRequest(method, params, timeoutMs);
    };
    const client = new AcpAgentClient({
      backendId: "acp:antigravity",
      // Even if a stale cached capability enabled steering, the live 1.4.9 handshake wins.
      supportsTurnSteering: true,
      store,
      transport,
    });

    await client.initialize();
    expect(client.supportsTurnSteering()).toBe(false);
    const session = await client.startSession({ cwd: "/repo", executionMode: "default", mcpServers: "none" });
    await client.startPrompt({ sessionId: session.sessionId, prompt: "First", turnId: "turn-1" });

    await expect(client.steerSession({
      sessionId: session.sessionId,
      text: "Steer",
      content: [{ type: "text", text: "Steer" }],
      interjectionId: "s-old",
    })).rejects.toThrow("Installed Antigravity CLI does not support turn steering over ACP");
    expect(prompts).toHaveLength(1);
    await client.dispose();

    // Conversely, a live 1.5.0+ handshake enables steering even if a stale cached capability was false.
    const upgradedTransport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.0" },
      },
    });
    const upgradedClient = new AcpAgentClient({
      backendId: "acp:antigravity",
      supportsTurnSteering: false,
      store,
      transport: upgradedTransport,
    });
    await upgradedClient.initialize();
    expect(upgradedClient.supportsTurnSteering()).toBe(true);
    await upgradedClient.dispose();
  });

  it("lists and executes Grok conversation-only rewind extensions", async () => {
    const transport = new FakeAcpAgentTransport({
      "session/new": { sessionId: "grok-session" },
      "_x.ai/rewind/points": {
        rewind_points: [
          {
            prompt_index: 0,
            created_at: "2026-08-14T12:00:00Z",
            num_file_snapshots: 2,
            has_file_changes: true,
            prompt_preview: "Write a breakfast poem",
          },
        ],
      },
      "_x.ai/rewind/execute": {
        success: true,
        prompt_text: "Write a breakfast poem",
      },
    });
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      store,
      transport,
      now: () => 2000,
    });
    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
      mcpServers: "none",
    });
    transport.emitSessionUpdate(session.sessionId, {
      kind: "user_message_chunk",
      content: "Write a breakfast poem",
    });
    transport.emitSessionUpdate(session.sessionId, {
      kind: "agent_message_chunk",
      content: "Toast in the morning",
    });

    await expect(client.listRewindPoints(session.sessionId)).resolves.toEqual([
      {
        promptIndex: 0,
        createdAt: Date.parse("2026-08-14T12:00:00Z"),
        fileSnapshotCount: 2,
        hasFileChanges: true,
        promptPreview: "Write a breakfast poem",
      },
    ]);
    await expect(client.rewindSession({
      sessionId: session.sessionId,
      targetPromptIndex: 0,
    })).resolves.toEqual({
      promptText: "Write a breakfast poem",
      updatedAt: 2000,
    });

    expect(transport.requests.slice(-2)).toEqual([
      {
        method: "_x.ai/rewind/points",
        params: { sessionId: "grok-session" },
        timeoutMs: 20_000,
      },
      {
        method: "_x.ai/rewind/execute",
        params: {
          sessionId: "grok-session",
          targetPromptIndex: 0,
          force: true,
          mode: "conversation_only",
        },
        timeoutMs: 20_000,
      },
    ]);
    expect(client.readReplay(session.sessionId).entries).toEqual([]);
  });

  it("keeps provider rewind success authoritative when local history is incomplete", async () => {
    const transport = new FakeAcpAgentTransport({
      "session/new": { sessionId: "grok-session" },
      "_x.ai/rewind/execute": {
        success: true,
        prompt_text: "Provider-only prompt",
      },
    });
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      store,
      transport,
      now: () => 3000,
    });
    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
      mcpServers: "none",
    });

    await expect(client.rewindSession({
      sessionId: session.sessionId,
      targetPromptIndex: 4,
    })).resolves.toEqual({
      promptText: "Provider-only prompt",
      updatedAt: 3000,
    });
    expect(client.readReplay(session.sessionId).entries).toEqual([]);
    expect(store.getSession("acp:grok", session.sessionId)).toMatchObject({
      status: "idle",
      updatedAt: 3000,
    });
  });

  it("tracks non-turn RPCs until their transport requests settle", async () => {
    const sessionResponse = createDeferred<unknown>();
    const runtimeOptionResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/new": sessionResponse.promise,
      "session/set_model": runtimeOptionResponse.promise,
    });
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    expect(client.hasActiveOperations()).toBe(false);
    expect(client.hasRetainableSessions()).toBe(false);
    expect(client.ownsSession("session-1")).toBe(false);

    const session = client.startSession({
      cwd: "/repo",
      executionMode: "default",
      mcpServers: "none",
    });
    expect(client.hasActiveOperations()).toBe(true);
    sessionResponse.resolve({ sessionId: "session-1" });
    await expect(session).resolves.toMatchObject({ sessionId: "session-1" });
    expect(client.hasActiveOperations()).toBe(false);
    expect(client.hasRetainableSessions()).toBe(true);
    expect(client.ownsSession("session-1")).toBe(true);

    const runtimeOption = client.setRuntimeOption({
      sessionId: "session-1",
      source: "model",
      optionId: "model",
      value: "gemini-2.5-pro",
    });
    expect(client.hasActiveOperations()).toBe(true);
    runtimeOptionResponse.resolve({});
    await runtimeOption;
    expect(client.hasActiveOperations()).toBe(false);

    await client.dispose();
    expect(client.hasRetainableSessions()).toBe(false);
    expect(client.ownsSession("session-1")).toBe(false);
  });

  it("does not retain the client solely for hidden helper sessions", async () => {
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport: new FakeAcpAgentTransport({
        "session/new": { sessionId: "hidden-session" },
      }),
      now: () => 1000,
    });

    await client.initialize();
    await client.startSession({
      cwd: "/repo",
      executionMode: "default",
      hidden: true,
      mcpServers: "none",
    });

    expect(client.ownsSession("hidden-session")).toBe(true);
    expect(client.hasRetainableSessions()).toBe(false);
  });

  it("initializes, starts sessions, sends prompts, and normalizes updates", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const sessionUpdates: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:codex-acp",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ sessionId }) => {
        sessionUpdates.push(sessionId);
      },
    });

    await client.initialize();
    expect(client.hasActiveTurns()).toBe(false);
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
      title: "Test ACP",
    });
    const promptPromise = client.prompt({
      sessionId: session.sessionId,
      prompt: "hello",
    });
    expect(client.hasActiveTurns()).toBe(true);
    transport.emitSessionUpdate(session.sessionId, {
      kind: "agent_message_chunk",
      content: "Done",
    });
    promptResponse.resolve({ turnId: "turn-1" });
    const prompt = await promptPromise;
    expect(client.hasActiveTurns()).toBe(false);

    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
    ]);
    expect(transport.requests[0]?.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {
        auth: {
          terminal: false,
        },
        elicitation: {
          form: {},
        },
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
      },
      clientInfo: {
        name: "pwragent",
        title: "PwrAgent",
        version: "0.0.0",
      },
    });
    expect(transport.requests[1]?.params).toEqual({
      cwd: "/repo",
      mcpServers: [],
    });
    expect(transport.requests[2]?.params).toEqual({
      sessionId: "session-1",
      prompt: [{ type: "text", text: "hello" }],
    });
    expect(transport.requests[2]?.timeoutMs).toBe(2_147_483_647);
    expect(prompt).toEqual({ sessionId: "session-1", turnId: "turn-1" });
    expect(store.getSession("acp:codex-acp", "session-1")).toMatchObject({
      title: "Test ACP",
      cwd: "/repo",
      executionMode: "default",
      hasConversationHistory: true,
    });
    expect(client.readReplay("session-1").lastAssistantMessage).toBe("Done");
    expect(
      readRawAcpSessionPayload("acp:codex-acp", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
    expect(sessionUpdates).toEqual(["session-1"]);
  });

  it("uses a provider update timestamp for persisted ACP activity", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      store,
      transport,
      now: () => 1_800_000_000_000,
    });
    store.upsertSession({
      backendId: "acp:grok",
      sessionId: "session-1",
      title: "Grok session",
      cwd: "/repo",
      createdAt: 1_600_000_000_000,
      updatedAt: 1_600_000_000_000,
      executionMode: "default",
      status: "idle",
    });

    await client.initialize();
    transport.emitSessionUpdate("session-1", {
      kind: "agent_message_chunk",
      content: "This update has a provider timestamp.",
      timestamp: 1_700_000_000,
    });

    expect(store.getSession("acp:grok", "session-1")).toMatchObject({
      hasConversationHistory: true,
      updatedAt: 1_700_000_000_000,
    });
  });

  it("records Kimi snake_case assistant chunks as active turn text", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const sessionUpdates: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ update }) => {
        sessionUpdates.push(String(update.session_update ?? update.kind));
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "hello",
      turnId: "turn-1",
    });
    expect(client.hasActiveTurns()).toBe(true);
    transport.emitSessionUpdate(session.sessionId, {
      session_update: "agent_message_chunk",
      content: { type: "text", text: "Kimi says hi." },
    });
    promptResponse.resolve({});
    await vi.waitFor(() => {
      expect(client.readReplay(session.sessionId).lastAssistantMessage).toBe(
        "Kimi says hi.",
      );
      expect(store.getSession("acp:kimi", session.sessionId)?.status).toBe(
        "idle",
      );
    });

    expect(sessionUpdates).toContain("agent_message_chunk");
    expect(client.hasActiveTurns()).toBe(false);
    expect(transport.requests[2]?.timeoutMs).toBe(2_147_483_647);
  });

  it("sends control prompts without recording transcript updates", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const sessionUpdates: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ sessionId }) => {
        sessionUpdates.push(sessionId);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
      title: "Kimi ACP",
    });
    const controlPrompt = client.sendControlPrompt({
      sessionId: session.sessionId,
      prompt: "/yolo",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "You only live once! All actions will be auto-approved.",
      },
    });
    promptResponse.resolve({ stopReason: "end_turn" });
    await expect(controlPrompt).resolves.toEqual({
      text: "You only live once! All actions will be auto-approved.",
    });

    expect(transport.requests.at(-1)).toEqual({
      method: "session/prompt",
      params: {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "/yolo" }],
      },
      timeoutMs: 60 * 60_000,
    });
    expect(client.readReplay("session-1").messages).toEqual([]);
    expect(store.getSession("acp:kimi", "session-1")).not.toHaveProperty(
      "hasConversationHistory",
    );
    expect(
      readRawAcpSessionPayload("acp:kimi", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
    expect(sessionUpdates).toEqual([]);
  });

  it("ignores thought chunks while capturing control prompt output", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    const controlPrompt = client.sendControlPrompt({
      sessionId: session.sessionId,
      prompt: "name this thread",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: {
        type: "text",
        text: "The user wants a concise title. I should return JSON.",
      },
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: '{ "title": "Favorite cereal" }' },
    });
    transport.emitSessionUpdate(session.sessionId, {
      kind: "turn_finished",
      outputText: '{ "title": "Favorite cereal" }',
    });
    promptResponse.resolve({ stopReason: "end_turn" });

    await expect(controlPrompt).resolves.toEqual({
      text: '{ "title": "Favorite cereal" }',
    });
    expect(client.readReplay("session-1").messages).toEqual([]);
  });

  it("returns suppressed control prompt usage without adding it to the transcript", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const sessionUpdates: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ sessionId }) => {
        sessionUpdates.push(sessionId);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    const controlPrompt = client.sendControlPrompt({
      sessionId: session.sessionId,
      prompt: "name this thread",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: '{ "title": "Favorite cereal" }' },
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "turn_completed",
      usage: {
        inputTokens: 120,
        outputTokens: 8,
        totalTokens: 128,
        cachedReadTokens: 20,
        reasoningTokens: 3,
        modelUsage: {
          "grok-4.5-build": {
            inputTokens: 120,
            outputTokens: 8,
          },
        },
      },
    });
    promptResponse.resolve({ stopReason: "end_turn" });

    await expect(controlPrompt).resolves.toEqual({
      text: '{ "title": "Favorite cereal" }',
      model: "grok-4.5-build",
      tokenUsage: {
        inputTokens: 120,
        cachedInputTokens: 20,
        outputTokens: 8,
        reasoningOutputTokens: 3,
        totalTokens: 128,
      },
    });
    expect(client.readReplay(session.sessionId).messages).toEqual([]);
    expect(sessionUpdates).toEqual([]);
  });

  it("aggregates suppressed Qwen model-call usage and preserves its selected model", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const client = new AcpAgentClient({
      backendId: "acp:qwen",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
      acpRuntime: {
        currentModelId: "qwen3-coder-plus",
      },
    });
    const controlPrompt = client.sendControlPrompt({
      sessionId: session.sessionId,
      prompt: "name this thread",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: '{ "title": "Favorite cereal" }' },
      _meta: {
        usage: {
          inputTokens: 23_851,
          outputTokens: 222,
          totalTokens: 24_073,
          thoughtTokens: 29,
          cachedReadTokens: 0,
        },
      },
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "" },
      _meta: {
        usage: {
          inputTokens: 120,
          outputTokens: 8,
          totalTokens: 128,
          thoughtTokens: 3,
          cachedReadTokens: 20,
        },
      },
    });
    promptResponse.resolve({ stopReason: "end_turn" });

    await expect(controlPrompt).resolves.toEqual({
      text: '{ "title": "Favorite cereal" }',
      model: "qwen3-coder-plus",
      tokenUsage: {
        inputTokens: 23_971,
        cachedInputTokens: 20,
        outputTokens: 230,
        reasoningOutputTokens: 32,
        totalTokens: 24_201,
      },
    });
    expect(client.readReplay(session.sessionId).messages).toEqual([]);
  });

  it("normalizes Antigravity session/prompt result usage on suppressed control prompts", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const client = new AcpAgentClient({
      backendId: "acp:antigravity",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
      acpRuntime: {
        currentModelId: "gemini-4-neon",
      },
    });
    const controlPrompt = client.sendControlPrompt({
      sessionId: session.sessionId,
      prompt: "name this thread",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "OK" },
    });
    promptResponse.resolve({
      stopReason: "end_turn",
      usage: {
        inputTokens: 2_161,
        outputTokens: 25,
        cachedReadTokens: 12_358,
        cachedWriteTokens: 0,
        thoughtTokens: 23,
        totalTokens: 14_544,
      },
    });

    await expect(controlPrompt).resolves.toEqual({
      text: "OK",
      model: "gemini-4-neon",
      tokenUsage: {
        cachedInputTokens: 12_358,
        inputTokens: 14_519,
        outputTokens: 25,
        reasoningOutputTokens: 23,
        totalTokens: 14_544,
      },
    });
  });

  it("preserves split JSON control prompt chunks without inserted newlines", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const client = new AcpAgentClient({
      backendId: "acp:qwen",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    const controlPrompt = client.sendControlPrompt({
      sessionId: session.sessionId,
      prompt: "name this thread",
    });
    for (const text of ['{ "title": "', "Favorite cereal question", '" }']) {
      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      });
    }
    promptResponse.resolve({ stopReason: "end_turn" });

    await expect(controlPrompt).resolves.toEqual({
      text: '{ "title": "Favorite cereal question" }',
    });
    expect(client.readReplay("session-1").messages).toEqual([]);
  });

  it("uses turn-finished output for suppressed control prompts without message chunks", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const client = new AcpAgentClient({
      backendId: "acp:qwen",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    const controlPrompt = client.sendControlPrompt({
      sessionId: session.sessionId,
      prompt: "name this thread",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Thinking out loud." },
    });
    transport.emitSessionUpdate(session.sessionId, {
      kind: "turn_finished",
      outputText: '{ "title": "Favorite cereal" }',
    });
    promptResponse.resolve({ stopReason: "end_turn" });

    await expect(controlPrompt).resolves.toEqual({
      text: '{ "title": "Favorite cereal" }',
    });
    expect(client.readReplay("session-1").messages).toEqual([]);
  });

  it("passes configured MCP servers when an ACP session id is known", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      mcpServers: ({ backendId, cwd, sessionId }) =>
        sessionId
          ? [
              {
                name: "pwragent_automations",
                command: "pwragent-automation-tools",
                args: [backendId, cwd, sessionId],
              },
            ]
          : [],
    });

    await client.initialize();
    await client.startSession({
      sessionId: "app-session-1",
      cwd: "/repo",
      executionMode: "default",
    });
    store.upsertSession({
      backendId: "acp:gemini",
      sessionId: "loaded-session-1",
      title: "Loaded ACP session",
      cwd: "/repo",
      createdAt: 900,
      updatedAt: 950,
      executionMode: "default",
      status: "idle",
    });
    await client.refreshSession(
      store.getSession("acp:gemini", "loaded-session-1")!,
    );

    expect(transport.requests[1]?.params).toEqual({
      cwd: "/repo",
      mcpServers: [
        {
          name: "pwragent_automations",
          command: "pwragent-automation-tools",
          args: ["acp:gemini", "/repo", "app-session-1"],
          env: [],
        },
      ],
    });
    expect(transport.requests[2]?.params).toEqual({
      cwd: "/repo",
      mcpServers: [
        {
          name: "pwragent_automations",
          command: "pwragent-automation-tools",
          args: ["acp:gemini", "/repo", "loaded-session-1"],
          env: [],
        },
      ],
      sessionId: "loaded-session-1",
    });
  });

  it("starts minimal helper sessions without configured MCP servers", async () => {
    const mcpServers = vi.fn(() => [
      {
        name: "pwragent",
        command: "pwragent-mcp",
      },
    ]);
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      store,
      transport,
      now: () => 1000,
      mcpServers,
    });

    await client.initialize();
    await client.startSession({
      cwd: "/repo",
      executionMode: "default",
      mcpServers: "none",
      sessionMeta: {
        agentProfile: {
          discoverSkills: false,
          toolConfig: { tools: [] },
        },
        systemPromptOverride: "Return only the requested result.",
      },
    });

    expect(mcpServers).not.toHaveBeenCalled();
    expect(transport.requests[1]).toEqual({
      method: "session/new",
      params: {
        cwd: "/repo",
        mcpServers: [],
        _meta: {
          agentProfile: {
            discoverSkills: false,
            toolConfig: { tools: [] },
          },
          systemPromptOverride: "Return only the requested result.",
        },
      },
    });
  });

  it("binds a pending HTTP MCP registration after session/new returns", async () => {
    const transport = new FakeAcpAgentTransport();
    const bindThread = vi.fn();
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      mcpServers: () => ({
        servers: [
          {
            name: "pwragent",
            type: "http",
            url: "http://127.0.0.1:43123/mcp",
            headers: [
              {
                name: "Authorization",
                value: "Bearer test-token",
              },
            ],
          },
        ],
        bindThread,
      }),
    });

    await client.initialize();
    await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });

    expect(transport.requests[1]?.params).toEqual({
      cwd: "/repo",
      mcpServers: [
        {
          name: "pwragent",
          type: "http",
          url: "http://127.0.0.1:43123/mcp",
          headers: [
            {
              name: "Authorization",
              value: "Bearer test-token",
            },
          ],
        },
      ],
    });
    expect(bindThread).toHaveBeenCalledWith("session-1");
  });

  it("composes a selected stdio connection with the default ACP MCP servers", async () => {
    const transport = new FakeAcpAgentTransport();
    const bindConnectionThread = vi.fn();
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      mcpServers: () => [{ name: "pwragent", command: "pwragent-mcp" }],
    });

    await client.initialize();
    await client.startSession({
      cwd: "/repo",
      executionMode: "default",
      additionalMcpRegistration: {
        servers: [{
          name: "pwrsnap",
          command: process.execPath,
          args: ["/app/mcp-connection-bridge.js"],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            PWRAGENT_MCP_CONNECTION_TOKEN: "local-grant",
          },
        }],
        bindThread: bindConnectionThread,
      },
    });

    expect(transport.requests[1]?.params).toEqual({
      cwd: "/repo",
      mcpServers: [
        { name: "pwragent", command: "pwragent-mcp", args: [], env: [] },
        {
          name: "pwrsnap",
          command: process.execPath,
          args: ["/app/mcp-connection-bridge.js"],
          env: [
            { name: "ELECTRON_RUN_AS_NODE", value: "1" },
            { name: "PWRAGENT_MCP_CONNECTION_TOKEN", value: "local-grant" },
          ],
        },
      ],
    });
    expect(bindConnectionThread).toHaveBeenCalledWith("session-1");
  });

  it("sends pasted images as ACP image content and keeps structured parts in live replay", async () => {
    const transport = new FakeAcpAgentTransport();
    const imageUrl = "data:image/png;base64,aGVsbG8=";
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "What's in this image?",
      promptContent: [
        { type: "text", text: "What's in this image?" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ],
      parts: [
        { type: "text", text: "What's in this image?" },
        { type: "image", url: imageUrl },
      ],
      turnId: "turn-1",
    });

    expect(transport.requests[2]?.params).toEqual({
      sessionId: "session-1",
      prompt: [
        { type: "text", text: "What's in this image?" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ],
    });
    expect(client.readReplay("session-1").messages).toEqual([
      expect.objectContaining({
        role: "user",
        text: "What's in this image?",
        parts: [
          { type: "text", text: "What's in this image?" },
          { type: "image", url: imageUrl },
        ],
      }),
    ]);
    expect(store.getSession("acp:gemini", "session-1")).toMatchObject({
      hasConversationHistory: true,
    });
    expect(
      readRawAcpSessionPayload("acp:gemini", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
  });

  it("preserves Antigravity MCP approval choices and displays only reported MCP names as tools", async () => {
    const transport = new FakeAcpAgentTransport();
    const onRequest = vi.fn((request: AppServerPendingRequestNotification) => {
      const allow = buildPendingRequestActions(request).find((action) => action.decision === "accept")!;
      return buildPendingRequestResponse(request, allow);
    });
    const client = new AcpAgentClient({ backendId: "acp:antigravity", store, transport, onRequest });
    await client.initialize();
    const session = await client.startSession({ cwd: "/repo", executionMode: "default" });

    async function checkRequest(
      name: string,
      kind: string,
      mcp: boolean,
      title = `Run ${name}`,
      content?: unknown,
    ) {
      const outcome = await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: { toolCallId: "tool", kind, name, title, content, status: "pending" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 1);
      const request = onRequest.mock.lastCall![0];
      expect(request.params.acpMcpToolName).toBe(mcp ? name : undefined);
      expect(request.params.command).toBe(mcp ? undefined : title);
      expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
      return request.params.prompt;
    }

    const tool = "mcp_pwragent_get_pull_request";
    expect(await checkRequest(tool, "other", true)).toBe("Antigravity wants to use an MCP tool.");
    expect(await checkRequest(tool, "other", true, "Read PR #42", [
      { type: "content", content: { type: "text", text: "Check the release notes." } },
    ])).toBe("Antigravity wants to use an MCP tool.\n\nRead PR #42\n\nCheck the release notes.");
    await fc.assert(fc.asyncProperty(
      fc.stringMatching(/^[a-z][a-z0-9_-]{2,40}$/),
      fc.integer({ min: 1, max: 1000 }),
      async (name, number) => {
        const title = `Read PR #${number}`;
        const prompt = await checkRequest(`mcp_${name}`, "other", true, title, title);
        expect(prompt?.split(title)).toHaveLength(2);
        await checkRequest(name, "other", false);
        await checkRequest(`mcp_${name}`, "execute", false);
      },
    ));
  });

  // Antigravity 1.5.16's ask_question, captured live with form elicitation
  // advertised (see apps/desktop/docs/protocol-captures.md).
  const antigravityAskQuestion = {
    sessionId: "session-1",
    toolCallId: "call_14875168372478126767",
    mode: "form",
    message: "The agent has 2 questions.",
    requestedSchema: {
      type: "object",
      properties: {
        q1: {
          type: "string",
          title: "Pick a color",
          oneOf: [
            { const: "1", title: "Red" },
            { const: "2", title: "Green" },
            { const: "3", title: "Blue" },
          ],
        },
        q1_other: { type: "string", title: "Other", description: "Optional free-form answer to: Pick a color" },
        q2: {
          type: "array",
          title: "Pick fruits",
          items: {
            anyOf: [
              { const: "1", title: "Apple" },
              { const: "2", title: "Pear" },
              { const: "3", title: "Plum" },
            ],
          },
        },
        q2_other: { type: "string", title: "Other", description: "Optional free-form answer to: Pick fruits" },
      },
    },
  };

  it("asks Antigravity's ask_question one question at a time and returns the form answer", async () => {
    const transport = new FakeAcpAgentTransport();
    const onRequest = vi.fn((_request: AppServerPendingRequestNotification): unknown => ({
      answers: { q1: { answers: ["Teal"] }, q2: { answers: ["Apple", "Plum"] } },
    }));
    const client = new AcpAgentClient({ backendId: "acp:antigravity", store, transport, onRequest });
    await client.initialize();
    const session = await client.startSession({ cwd: "/repo", executionMode: "full-access" });

    const answer = await transport.emitRequest("elicitation/create", {
      ...antigravityAskQuestion,
      sessionId: session.sessionId,
    }, "jetski-acp-front:2");

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest.mock.lastCall![0]).toEqual({
      method: "item/tool/requestUserInput",
      params: {
        threadId: session.sessionId,
        itemId: "call_14875168372478126767",
        requestId: "jetski-acp-front:2",
        questions: [
          { id: "q1", header: "", question: "Pick a color", isOther: true, isSecret: false, options: [
            { label: "Red", description: "" }, { label: "Green", description: "" }, { label: "Blue", description: "" },
          ] },
          { id: "q2", header: "", question: "Pick fruits", isOther: true, isSecret: false, multiSelect: true, options: [
            { label: "Apple", description: "" }, { label: "Pear", description: "" }, { label: "Plum", description: "" },
          ] },
        ],
      },
    });
    expect(answer).toEqual({ action: "accept", content: { q1_other: "Teal", q2: ["1", "3"] } });
  });

  it("cancels an asked form unless the operator answered it (oracle)", async () => {
    let reply: unknown;
    const transport = new FakeAcpAgentTransport();
    const onRequest = vi.fn((_request: AppServerPendingRequestNotification): unknown => reply);
    const client = new AcpAgentClient({ backendId: "acp:antigravity", store, transport, onRequest });
    await client.initialize();
    const session = await client.startSession({ cwd: "/repo", executionMode: "default" });
    const operatorReply = fc.oneof(
      fc.constant({ answers: { q1: { answers: ["Green"] } } }),
      // A turn interrupt or a headless automation settles a pending request this way.
      fc.constant({ decision: "cancel" }),
      fc.constantFrom(undefined, null, "accept", ["accept"], { answers: null }, { answers: [] }),
    );
    await fc.assert(fc.asyncProperty(operatorReply, fc.integer({ min: 0, max: 1000 }), async (generated, requestId) => {
      reply = generated;
      onRequest.mockClear();
      const answer = await transport.emitRequest("elicitation/create", {
        ...antigravityAskQuestion,
        sessionId: session.sessionId,
      }, requestId);
      expect(onRequest.mock.lastCall![0].params.requestId).toBe(String(requestId));
      const answered = generated && typeof generated === "object" && !Array.isArray(generated)
        && (generated as { answers?: unknown }).answers
        && typeof (generated as { answers?: unknown }).answers === "object"
        && !Array.isArray((generated as { answers?: unknown }).answers);
      expect(answer).toEqual(answered ? { action: "accept", content: { q1: "2" } } : { action: "cancel" });
    }));
  });

  it("shows a form the questionnaire cannot ask on the form card, answering only what the operator chose (oracle)", async () => {
    let reply: unknown;
    const transport = new FakeAcpAgentTransport();
    const onRequest = vi.fn((_request: AppServerPendingRequestNotification): unknown => reply);
    const client = new AcpAgentClient({ backendId: "acp:antigravity", store, transport, onRequest });
    await client.initialize();
    const session = await client.startSession({ cwd: "/repo", executionMode: "default" });
    const countForm = {
      sessionId: session.sessionId,
      mode: "form",
      message: "How many replicas?",
      requestedSchema: { type: "object", properties: { replicas: { type: "integer", title: "Replicas" } } },
    };
    const content = fc.dictionary(
      fc.string({ minLength: 1, maxLength: 8 }),
      fc.oneof(fc.string(), fc.boolean(), fc.integer(), fc.array(fc.string(), { maxLength: 3 })),
      { maxKeys: 4 },
    );
    const operatorReply = fc.oneof(
      fc.record({ action: fc.constant("accept"), content: fc.option(content, { nil: undefined }) }),
      fc.record({ action: fc.constantFrom("decline", "cancel"), content: fc.constant(null) }),
      fc.constant({ decision: "cancel" }),
      fc.constantFrom(undefined, null, "accept", ["accept"]),
    );
    const id = fc.oneof(fc.integer({ min: 1, max: 1000 }), fc.string({ minLength: 1, maxLength: 20 }));

    await fc.assert(fc.asyncProperty(operatorReply, id, async (generated, requestId) => {
      reply = generated;
      onRequest.mockClear();
      const answer = await transport.emitRequest("elicitation/create", countForm, requestId);

      expect(onRequest).toHaveBeenCalledTimes(1);
      expect(onRequest.mock.lastCall![0]).toMatchObject({
        method: "mcpServer/elicitation/request",
        params: {
          requestId: String(requestId),
          serverName: "Antigravity",
          _meta: { pwragent_acp_agent_elicitation: true },
          requestedSchema: countForm.requestedSchema,
        },
      });
      // Oracle: only an explicit accept carries content, and only the
      // operator's own object; only an explicit decline declines.
      const record = generated && typeof generated === "object" && !Array.isArray(generated)
        ? generated as { action?: unknown; content?: unknown }
        : undefined;
      if (record?.action === "accept") {
        expect(answer).toEqual({ action: "accept", content: record.content ?? {} });
      } else if (record?.action === "decline") {
        expect(answer).toEqual({ action: "decline" });
      } else {
        expect(answer).toEqual({ action: "cancel" });
      }
    }));
  });

  it("asks Grok's ask_user_question on the questionnaire and answers in Grok's shape", async () => {
    let reply: unknown = { answers: { "0": { answers: ["Teal"] }, "1": { answers: ["Apple", "Pear"] } } };
    const transport = new FakeAcpAgentTransport();
    const onRequest = vi.fn((_request: AppServerPendingRequestNotification): unknown => reply);
    const client = new AcpAgentClient({ backendId: "acp:grok", store, transport, onRequest });
    await client.initialize();
    const session = await client.startSession({ cwd: "/repo", executionMode: "default" });
    // Grok Build 1.0.45-pwragent.2, captured live; its first request id is 0.
    const request = {
      sessionId: session.sessionId,
      toolCallId: "call-a01b1553-613e-48be-b800-b4769d8603a2-0",
      questions: [
        { question: "Pick a color", options: [{ label: "Red", description: "Red" }, { label: "Green", description: "Green" }], multiSelect: null },
        { question: "Pick fruits", options: [{ label: "Apple", description: "Apple" }, { label: "Pear", description: "Pear" }], multiSelect: true },
      ],
      mode: "default",
    };

    await expect(transport.emitRequest("_x.ai/ask_user_question", request, 0)).resolves.toEqual({
      outcome: "accepted",
      answers: { "Pick a color": ["Other"], "Pick fruits": ["Apple", "Pear"] },
      annotations: { "Pick a color": { notes: "Teal" } },
    });
    expect(onRequest.mock.lastCall![0]).toMatchObject({
      method: "item/tool/requestUserInput",
      params: {
        threadId: session.sessionId,
        itemId: request.toolCallId,
        requestId: "0",
        questions: [
          { id: "0", question: "Pick a color", isOther: true },
          { id: "1", question: "Pick fruits", isOther: true, multiSelect: true },
        ],
      },
    });

    reply = { decision: "cancel" };
    await expect(transport.emitRequest("x.ai/ask_user_question", request, 1)).resolves.toEqual({ outcome: "cancelled" });
  });

  it("declines an ACP elicitation it cannot show without asking the operator", async () => {
    const transport = new FakeAcpAgentTransport();
    const onRequest = vi.fn((_request: AppServerPendingRequestNotification): unknown => ({ action: "accept" }));
    const client = new AcpAgentClient({ backendId: "acp:antigravity", store, transport, onRequest });
    await client.initialize();
    const session = await client.startSession({ cwd: "/repo", executionMode: "default" });

    await fc.assert(fc.asyncProperty(
      fc.oneof(fc.constantFrom("url", "_custom", ""), fc.string().filter((mode) => mode !== "form")),
      async (mode) => {
        await expect(transport.emitRequest("elicitation/create", {
          ...antigravityAskQuestion,
          sessionId: session.sessionId,
          mode,
        }, 7)).resolves.toEqual({ action: "decline" });
      },
    ));
    // A request-scoped elicitation has no thread to show a card in.
    const { sessionId: _sessionId, ...withoutSession } = antigravityAskQuestion;
    await expect(transport.emitRequest("elicitation/create", {
      ...withoutSession,
      requestId: 3,
    }, 8)).resolves.toEqual({ action: "decline" });
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("resolves an Antigravity MCP name to one session server or none", () => {
    const segment = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,5}$/);
    const serverName = fc.array(segment, { minLength: 1, maxLength: 3 })
      .chain((parts) => fc.constantFrom(parts.join("_"), parts.join("-")));
    fc.assert(fc.property(
      fc.array(serverName, { minLength: 1, maxLength: 5 }),
      fc.nat(),
      fc.array(segment, { minLength: 1, maxLength: 3 }),
      (servers, pick, toolParts) => {
        const reported = `mcp_${servers[pick % servers.length]}_${toolParts.join("_")}`;
        const fold = (value: string) => value.replace(/-/gu, "_").toLowerCase();
        // Oracle: every server whose name, before or after Antigravity folds
        // `-` to `_` or changes case, prefixes the reported name could have
        // produced it.
        const sources = [...new Set(servers)].filter((server) =>
          fold(reported).startsWith(`mcp_${fold(server)}_`)
          && fold(reported).length > `mcp_${fold(server)}_`.length);
        const target = resolveAntigravityMcpToolTarget(reported, servers);
        if (sources.length !== 1) {
          expect(target).toBeUndefined();
          return;
        }
        if (target) {
          expect(target.serverName).toBe(sources[0]);
          expect(`mcp_${target.serverName}_${target.toolName}`).toBe(reported);
        } else {
          expect(reported.startsWith(`mcp_${sources[0]}_`)).toBe(false);
        }
      },
    ));
  });

  it("asks the operator about an Antigravity MCP call only when PwrAgent cannot decide it (model)", async () => {
    // PwrAgent's own tools as its MCP server lists them.
    const ownTools = [
      { name: "list_ci_runs", annotations: { readOnlyHint: true } },
      { name: "merge_pull_request", annotations: { readOnlyHint: false, destructiveHint: true } },
      { name: "call_mcp_tool", annotations: { readOnlyHint: false } },
      { name: "add_todo", annotations: { readOnlyHint: false } },
      { name: "purge_cache", annotations: { readOnlyHint: true, destructiveHint: true } },
    ];
    // Model: the gateway and forge cards decide these calls, or they only read.
    const decidedByPwrAgent = new Set(["list_ci_runs", "merge_pull_request", "call_mcp_tool"]);
    const reportedNames = [
      ...ownTools.map((tool) => `mcp_pwragent_${tool.name}`),
      "mcp_pwragent_unlisted",
      "mcp_linear_list_issues",
    ];
    type Choice = "accept" | "accept_for_session" | "decline";
    await fc.assert(fc.asyncProperty(
      // A connection named `pwragent_list` makes `mcp_pwragent_list_ci_runs`
      // ambiguous: its `ci_runs` tool flattens to the same name.
      fc.boolean(),
      fc.array(fc.record({
        name: fc.constantFrom(...reportedNames),
        choice: fc.constantFrom<Choice>("accept", "accept_for_session", "decline"),
      }), { minLength: 1, maxLength: 12 }),
      async (withCollidingServer, calls) => {
        const transport = new FakeAcpAgentTransport();
        const asked: AppServerPendingRequestNotification[] = [];
        let choice: Choice = "accept";
        const onRequest = vi.fn((request: AppServerPendingRequestNotification) => {
          asked.push(request);
          const action = buildPendingRequestActions(request).find((entry) => entry.decision === choice)!;
          return buildPendingRequestResponse(request, action);
        });
        const client = new AcpAgentClient({
          backendId: "acp:antigravity",
          store,
          transport,
          onRequest,
          mcpServers: () => ({
            servers: [
              { name: "pwragent", type: "http", url: "http://127.0.0.1:1/mcp", headers: [] },
              { name: "linear", type: "http", url: "http://127.0.0.1:2/mcp", headers: [] },
              ...withCollidingServer
                ? [{ name: "pwragent_list", type: "http" as const, url: "http://127.0.0.1:3/mcp", headers: [] }]
                : [],
            ],
            hostApprovesToolCall: async (server, tool) => server === "pwragent"
              && pwragentToolSkipsAgentApproval(ownTools.find((entry) => entry.name === tool)),
          }),
        });
        await client.initialize();
        const session = await client.startSession({ cwd: "/repo", executionMode: "default" });
        const granted = new Set<string>();
        for (const [index, call] of calls.entries()) {
          choice = call.choice;
          const askedBefore = asked.length;
          const outcome = await transport.emitRequest("session/request_permission", {
            sessionId: session.sessionId,
            toolCall: { toolCallId: `tool-${index}`, kind: "other", name: call.name, status: "pending" },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          }, index + 1);
          const ambiguous = withCollidingServer && call.name === "mcp_pwragent_list_ci_runs";
          const ownTool = call.name.replace(/^mcp_pwragent_/u, "");
          const answeredByPwrAgent = granted.has(call.name)
            || (!ambiguous && call.name.startsWith("mcp_pwragent_") && decidedByPwrAgent.has(ownTool));
          if (answeredByPwrAgent) {
            expect(asked).toHaveLength(askedBefore);
            expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
            continue;
          }
          expect(asked).toHaveLength(askedBefore + 1);
          const expectedGrantLabel = call.name === "mcp_pwragent_add_todo"
            ? "Allow add_todo for this conversation"
            : call.name === "mcp_pwragent_purge_cache"
              ? "Allow purge_cache for this conversation"
              : call.name === "mcp_pwragent_unlisted"
                ? "Allow unlisted for this conversation"
                : call.name === "mcp_linear_list_issues"
                  ? "Allow list_issues for this conversation"
                  : "Allow for this conversation";
          expect(buildPendingRequestActions(asked.at(-1)!).map((action) => action.label))
            .toEqual(["Allow", expectedGrantLabel, "Deny", "Cancel turn"]);
          if (call.choice === "accept_for_session") granted.add(call.name);
          // Antigravity hears only options it offered.
          expect(outcome).toEqual({
            outcome: { outcome: "selected", optionId: call.choice === "decline" ? "deny" : "allow" },
          });
        }
      },
    ), { numRuns: 60 });
  });

  it("applies Antigravity's deferred tool approval to the selected operation only", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.uniqueArray(fc.constantFrom("add_todo", "handoff_task", "start_review"), {
      minLength: 2,
    }), async (offersAlways, writes) => {
      const transport = new FakeAcpAgentTransport();
      const onRequest = vi.fn((request: AppServerPendingRequestNotification) => {
        const expectedTool = writes[onRequest.mock.calls.length - 1]!;
        expect(buildPendingRequestActions(request).map(({ label }) => label)).toEqual([
          "Allow",
          `Allow ${expectedTool} for this conversation`,
          "Deny",
          "Cancel turn",
        ]);
        expect(request.params.acpMcpToolName).toBe(expectedTool);
        expect(request.params.prompt).toContain(expectedTool);
        // Choosing conversation approval for the first write must grant only
        // that wrapped tool, return allow_once to Antigravity, and still ask
        // for every other wrapped write.
        return onRequest.mock.calls.length === 1
          ? { decision: "accept_for_session" }
          : { decision: "accept" };
      });
      const hostApprovesToolCall = vi.fn(async (_server: string, _name: string, input: unknown) =>
        (input as { toolName?: string })?.toolName === "get_pull_request");
      const client = new AcpAgentClient({
        backendId: "acp:antigravity",
        store,
        transport,
        onRequest,
        mcpServers: () => ({
          servers: [{ name: "pwragent", type: "http", url: "http://127.0.0.1:1/mcp", headers: [] }],
          hostApprovesToolCall,
        }),
      });
      try {
        await client.initialize();
        const session = await client.startSession({ cwd: "/repo", executionMode: "default" });
        for (const [index, toolName] of ["get_pull_request", ...writes].entries()) {
          const outcome = await transport.emitRequest("session/request_permission", {
            sessionId: session.sessionId,
            toolCall: {
              toolCallId: `tool-${index}`, kind: "other", name: "mcp_pwragent_call_pwragent_tool",
              rawInput: { toolName, arguments: {} },
            },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              ...(offersAlways ? [{ optionId: "always", name: "Always allow", kind: "allow_always" }] : []),
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          }, index + 1);
          expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
        }
        expect(onRequest).toHaveBeenCalledTimes(writes.length);
      } finally {
        await client.dispose();
      }
    }), { numRuns: 10 });
  });

  it("keeps Antigravity's own allow-always choice instead of a thread grant", async () => {
    const transport = new FakeAcpAgentTransport();
    const onRequest = vi.fn((request: AppServerPendingRequestNotification) => {
      const always = buildPendingRequestActions(request).find((action) => action.decision === "accept_for_session")!;
      return buildPendingRequestResponse(request, always);
    });
    const client = new AcpAgentClient({ backendId: "acp:antigravity", store, transport, onRequest });
    await client.initialize();
    const session = await client.startSession({ cwd: "/repo", executionMode: "default" });
    const request = {
      sessionId: session.sessionId,
      toolCall: { toolCallId: "tool", kind: "other", name: "mcp_linear_list_issues", status: "pending" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    };
    expect(await transport.emitRequest("session/request_permission", request, 1))
      .toEqual({ outcome: { outcome: "selected", optionId: "always" } });
    expect(buildPendingRequestActions(onRequest.mock.lastCall![0]).map((action) => action.label))
      .toEqual(["Allow", "Always allow", "Deny", "Cancel turn"]);
    // Antigravity remembers its own choice; PwrAgent does not answer for it.
    await transport.emitRequest("session/request_permission", request, 2);
    expect(onRequest).toHaveBeenCalledTimes(2);
  });

  it.each([
    { reloadServers: ["Case-Probe"], retained: true },
    { reloadServers: ["Case-Probe", "Another-Server"], retained: false },
  ])("rechecks tool grants when a transferred Antigravity session reloads with $reloadServers", async ({ reloadServers, retained }) => {
    let serverNames = ["Case-Probe"];
    const transport = new FakeAcpAgentTransport({
      initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } },
    });
    const onRequest = vi.fn()
      .mockImplementationOnce(() => ({ decision: "accept_for_session" }))
      .mockImplementation(() => ({ decision: "decline" }));
    const client = new AcpAgentClient({
      backendId: "acp:antigravity", store, transport, onRequest,
      mcpServers: () => ({ servers: serverNames.map((name) => ({
        name, type: "http", url: "http://127.0.0.1:1/mcp", headers: [],
      })) }),
    });
    await client.initialize();
    const session = await client.startSession({ cwd: "/repo", executionMode: "default" });
    const request = {
      sessionId: session.sessionId,
      toolCall: { toolCallId: "tool", kind: "other", name: "mcp_Case-Probe_list_probe", status: "pending" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    };
    try {
      expect(await transport.emitRequest("session/request_permission", request, 1))
        .toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
      await client.closeSessionForTransfer(session.sessionId);
      serverNames = reloadServers;
      await client.loadSession(session);
      expect(await transport.emitRequest("session/request_permission", request, 2))
        .toEqual({ outcome: { outcome: "selected", optionId: retained ? "allow" : "deny" } });
      expect(onRequest).toHaveBeenCalledTimes(retained ? 1 : 2);
    } finally {
      await client.dispose();
    }
  });

  it("signals transfer readiness only once all Antigravity native background work ends", async () => {
    const transport = new FakeAcpAgentTransport({
      initialize: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } },
    });
    const client = new AcpAgentClient({ backendId: "acp:antigravity", store, transport });
    try {
      await client.initialize();
      const { sessionId } = await client.startSession({ cwd: "/repo", executionMode: "default", mcpServers: "none" });
      const emit = (toolCallId: string, status: string) => transport.emitSessionUpdate(sessionId, {
        sessionUpdate: "tool_call_update", toolCallId, name: "run_command", status,
      });
      emit("first", "in_progress");
      emit("second", "in_progress");
      const busy = await client.closeSessionForTransfer(sessionId).catch((error: unknown) => error);
      expect(busy).toBeInstanceOf(AcpSessionTransferBusyError);
      const ready = vi.fn();
      void (busy as AcpSessionTransferBusyError).ready.then(ready);
      emit("first", "completed");
      await Promise.resolve();
      expect(ready).not.toHaveBeenCalled();
      expect(transport.requests.some(({ method }) => method === "session/close")).toBe(false);
      emit("second", "completed");
      await (busy as AcpSessionTransferBusyError).ready;
      expect(ready).toHaveBeenCalledTimes(1);
      await client.closeSessionForTransfer(sessionId);
      expect(transport.requests.filter(({ method }) => method === "session/close")).toHaveLength(1);
    } finally {
      await client.dispose();
    }
  });

  it("maps generic session approvals to ACP allow-always options", async () => {
    const transport = new FakeAcpAgentTransport();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      agentDisplayName: "Kimi Code CLI",
      store,
      transport,
      now: () => 1000,
      onRequest: (request) => {
        requests.push(request);
        return { decision: "accept_for_session" };
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Run npm view openclaw",
      turnId: "turn-1",
    });

    const response = await transport.emitRequest(
      "session/request_permission",
      {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "run_shell_command_1",
          kind: "execute",
          title: "npm view openclaw",
          status: "pending",
        },
        options: [
          {
            optionId: "proceed_always",
            name: "Allow for this session",
            kind: "allow_always",
          },
          {
            optionId: "proceed_once",
            name: "Allow",
            kind: "allow_once",
          },
          {
            optionId: "cancel",
            name: "Reject",
            kind: "reject_once",
          },
        ],
      },
      0,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "session-1",
        turnId: "turn-1",
        requestId: "0",
        prompt: "Kimi Code CLI wants to run execute: npm view openclaw",
        reason: "Kimi Code CLI wants to run execute: npm view openclaw",
        command: "npm view openclaw",
        acpMethod: "session/request_permission",
        acpToolCallId: "run_shell_command_1",
        acpToolKind: "execute",
        acpPermissionOptions: [
          {
            optionId: "proceed_always",
            name: "Allow for this session",
            kind: "allow_always",
          },
          {
            optionId: "proceed_once",
            name: "Allow",
            kind: "allow_once",
          },
          {
            optionId: "cancel",
            name: "Reject",
            kind: "reject_once",
          },
        ],
      },
    });
    expect(response).toEqual({
      outcome: {
        outcome: "selected",
        optionId: "proceed_always",
      },
    });
  });

  it("round-trips Grok MCP and command-prefix allow-always options", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      agentDisplayName: "Grok",
      store,
      transport,
      now: () => 1000,
      onRequest: (request) => {
        const actions = buildPendingRequestActions(request);
        const action = actions.find(
          (candidate) =>
            candidate.decision === "accept_for_session" ||
            candidate.decision === "accept_with_execpolicy_amendment",
        );
        expect(action).toBeDefined();
        return buildPendingRequestResponse(request, action!);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Search threads, then inspect npm",
      turnId: "turn-1",
    });

    const mcpResponse = await transport.emitRequest(
      "session/request_permission",
      {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "mcp_1",
          kind: "other",
          title: "pwragent__search_threads",
          status: "pending",
        },
        options: [
          {
            optionId: "allow-once-mcp",
            name: "Allow once: pwragent__search_threads",
            kind: "allow_once",
          },
          {
            optionId: "allow-always-mcp",
            name: "Always allow: pwragent__search_threads",
            kind: "allow_always",
          },
          {
            optionId: "reject-once-mcp",
            name: "Reject",
            kind: "reject_once",
          },
        ],
      },
      0,
    );
    const commandResponse = await transport.emitRequest(
      "session/request_permission",
      {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "bash_1",
          kind: "execute",
          title: "npm view openclaw",
          status: "pending",
        },
        options: [
          {
            optionId: "allow-once-command",
            name: "Allow once",
            kind: "allow_once",
          },
          {
            optionId: "allow-always-command",
            name: "Always allow: npm view",
            kind: "allow_always",
          },
          {
            optionId: "reject-once-command",
            name: "Reject",
            kind: "reject_once",
          },
        ],
      },
      1,
    );

    expect(mcpResponse).toEqual({
      outcome: {
        outcome: "selected",
        optionId: "allow-always-mcp",
      },
    });
    expect(commandResponse).toEqual({
      outcome: {
        outcome: "selected",
        optionId: "allow-always-command",
      },
    });
  });

  it("extracts Kimi shell commands from nested ACP permission content", async () => {
    const transport = new FakeAcpAgentTransport();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      agentDisplayName: "Kimi Code CLI",
      store,
      transport,
      now: () => 1000,
      onRequest: (request) => {
        requests.push(request);
        return { decision: "accept" };
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Check versions",
      turnId: "turn-1",
    });

    await transport.emitRequest(
      "session/request_permission",
      {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "run_shell_command_1",
          kind: "execute",
          title: "Bash",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "{\"command\": \"node --version && pnpm --version\"}",
              },
            },
          ],
        },
        options: [{ optionId: "proceed_once", kind: "allow_once" }],
      },
      0,
    );

    expect(requests[0]).toMatchObject({
      method: "item/commandExecution/requestApproval",
      params: {
        prompt: "Kimi Code CLI wants to run execute: Bash",
        reason: "Kimi Code CLI wants to run execute: Bash",
        command: "node --version && pnpm --version",
        displayCommand: "node --version && pnpm --version",
      },
    });
  });

  it("extracts Kimi shell commands from approval prompt text", async () => {
    const transport = new FakeAcpAgentTransport();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      agentDisplayName: "Kimi Code CLI",
      store,
      transport,
      now: () => 1000,
      onRequest: (request) => {
        requests.push(request);
        return { decision: "accept" };
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });

    await transport.emitRequest(
      "session/request_permission",
      {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "run_shell_command_1",
          kind: "execute",
          title: "Bash",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Requesting approval to Running: npm view pnpm",
              },
            },
          ],
        },
        options: [{ optionId: "proceed_once", kind: "allow_once" }],
      },
      0,
    );

    expect(requests[0]).toMatchObject({
      params: {
        prompt: "Requesting approval to Running: npm view pnpm",
        command: "npm view pnpm",
        displayCommand: "npm view pnpm",
      },
    });
  });

  it("captures ACP runtime modes and models from session setup", async () => {
    const runtimeEvents: unknown[] = [];
    const transport = new FakeAcpAgentTransport({
      "session/new": {
        sessionId: "gemini-session",
        modes: {
          currentModeId: "default",
          availableModes: [
            {
              id: "default",
              name: "Default",
              description: "Prompts for approval",
            },
            {
              id: "yolo",
              name: "YOLO",
              description: "Auto-approves all tools",
            },
          ],
        },
        models: {
          currentModelId: "gemini-3-flash-preview",
          availableModels: [
            {
              modelId: "gemini-3-flash-preview",
              name: "gemini-3-flash-preview",
            },
          ],
        },
      },
    });
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      onRuntimeCapabilities: (event) => {
        runtimeEvents.push(event);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });

    expect(session).toMatchObject({
      sessionId: "gemini-session",
      acpRuntime: {
        currentModeId: "default",
        currentModelId: "gemini-3-flash-preview",
      },
    });
    expect(store.getSession("acp:gemini", "gemini-session")).toMatchObject({
      acpRuntime: {
        currentModeId: "default",
        currentModelId: "gemini-3-flash-preview",
      },
    });
    expect(runtimeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "gemini-session",
          runtimeCapabilities: expect.objectContaining({
            status: "discovered",
            source: "session-new",
            modes: expect.objectContaining({
              currentModeId: "default",
              availableModes: expect.arrayContaining([
                expect.objectContaining({ id: "default", label: "Default" }),
                expect.objectContaining({ id: "yolo", label: "YOLO" }),
              ]),
            }),
            models: expect.objectContaining({
              currentModelId: "gemini-3-flash-preview",
              availableModels: expect.arrayContaining([
                expect.objectContaining({
                  id: "gemini-3-flash-preview",
                  label: "gemini-3-flash-preview",
                }),
              ]),
            }),
          }),
        }),
      ]),
    );
  });

  it("updates ACP runtime state without rendering runtime notifications", async () => {
    const runtimeUpdates: unknown[] = [];
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      onSessionRuntimeStateChange: (event) => {
        runtimeUpdates.push(event);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    transport.emitSessionUpdate(session.sessionId, {
      kind: "current_mode_update",
      currentModeId: "yolo",
    });
    transport.emitSessionUpdate(session.sessionId, {
      kind: "config_option_update",
      configOption: {
        id: "approval-mode",
        currentValue: "yolo",
      },
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "model_changed",
      model_id: "grok-4.5",
      reasoning_effort: "low",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "model_changed",
      model_id: "gemini-3-pro-preview",
    });

    expect(store.getSession("acp:gemini", session.sessionId)).toMatchObject({
      acpRuntime: {
        currentModeId: "yolo",
        currentModelId: "gemini-3-pro-preview",
        configValues: {
          "approval-mode": "yolo",
        },
      },
    });
    expect(
      store.getSession("acp:gemini", session.sessionId)?.acpRuntime
        ?.reasoningEffort,
    ).toBeUndefined();
    expect(client.readReplay(session.sessionId).entries).toEqual([]);
    expect(runtimeUpdates).toHaveLength(4);
  });

  it("keeps requested ACP mode when set_mode returns no fresh runtime state", async () => {
    const transport = new FakeAcpAgentTransport({
      "session/new": {
        sessionId: "gemini-session",
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "yolo", name: "YOLO" },
          ],
        },
      },
      "session/set_mode": {},
    });
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });

    await expect(
      client.setRuntimeOption({
        sessionId: session.sessionId,
        source: "mode",
        optionId: "mode",
        value: "yolo",
      }),
    ).resolves.toMatchObject({
      currentModeId: "yolo",
    });
    expect(store.getSession("acp:gemini", session.sessionId)).toMatchObject({
      acpRuntime: {
        currentModeId: "yolo",
      },
    });
  });

  it("keeps requested ACP model and clears stale effort without fresh runtime state", async () => {
    const transport = new FakeAcpAgentTransport({
      "session/new": {
        sessionId: "gemini-session",
        models: {
          currentModelId: "gemini-3-flash-preview",
          availableModels: [
            {
              modelId: "gemini-3-flash-preview",
              name: "Gemini 3 Flash Preview",
              _meta: {
                reasoningEffort: "high",
                reasoningEfforts: [
                  { value: "low" },
                  { value: "high", default: true },
                ],
              },
            },
            { modelId: "gemini-3-pro-preview", name: "Gemini 3 Pro Preview" },
          ],
        },
      },
      "session/set_model": {},
    });
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    expect(session.acpRuntime?.reasoningEffort).toBe("high");

    await expect(
      client.setRuntimeOption({
        sessionId: session.sessionId,
        source: "model",
        optionId: "model",
        value: "gemini-3-pro-preview",
      }),
    ).resolves.toMatchObject({
      currentModelId: "gemini-3-pro-preview",
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "session/set_model",
      params: {
        sessionId: "gemini-session",
        modelId: "gemini-3-pro-preview",
      },
    });
    expect(store.getSession("acp:gemini", session.sessionId)).toMatchObject({
      acpRuntime: {
        currentModelId: "gemini-3-pro-preview",
      },
    });
    expect(
      store.getSession("acp:gemini", session.sessionId)?.acpRuntime
        ?.reasoningEffort,
    ).toBeUndefined();
  });

  it("sends reasoning effort through ACP model metadata", async () => {
    const transport = new FakeAcpAgentTransport({
      "session/new": {
        sessionId: "grok-session",
        models: {
          currentModelId: "grok-4.5",
          availableModels: [
            {
              modelId: "grok-4.5",
              name: "Grok 4.5",
              _meta: {
                supportsReasoningEffort: true,
                reasoningEffort: "high",
                reasoningEfforts: [
                  { value: "low" },
                  { value: "medium" },
                  { value: "high" },
                ],
              },
            },
          ],
        },
      },
      "session/set_model": {},
    });
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });

    await expect(
      client.setRuntimeOption({
        sessionId: session.sessionId,
        source: "model",
        optionId: "model",
        value: "grok-4.5",
        reasoningEffort: "medium",
      }),
    ).resolves.toMatchObject({
      currentModelId: "grok-4.5",
      reasoningEffort: "medium",
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "session/set_model",
      params: {
        sessionId: "grok-session",
        modelId: "grok-4.5",
        _meta: {
          reasoningEffort: "medium",
        },
      },
    });
    expect(store.getSession("acp:grok", session.sessionId)).toMatchObject({
      acpRuntime: {
        currentModelId: "grok-4.5",
        reasoningEffort: "medium",
      },
    });
  });

  it("sets Kimi model and thinking through advertised config options", async () => {
    const transport = new FakeAcpAgentTransport({
      "session/new": {
        sessionId: "kimi-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            currentValue: "kimi-code/kimi-for-coding",
            options: [
              {
                value: "kimi-code/kimi-for-coding",
                name: "K2.7 Coding",
              },
              { value: "kimi-code/k3", name: "K3" },
            ],
          },
          {
            id: "thinking",
            name: "Thinking",
            category: "thought_level",
            currentValue: "on",
            options: [{ value: "on", name: "On" }],
          },
        ],
      },
      "session/set_config_option": {
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            currentValue: "kimi-code/k3",
            options: [
              {
                value: "kimi-code/kimi-for-coding",
                name: "K2.7 Coding",
              },
              { value: "kimi-code/k3", name: "K3" },
            ],
          },
          {
            id: "thinking",
            name: "Thinking",
            category: "thought_level",
            currentValue: "high",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
              { value: "max", name: "Max" },
            ],
          },
        ],
      },
    });
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });

    await expect(
      client.setRuntimeOption({
        sessionId: session.sessionId,
        source: "model",
        optionId: "model",
        value: "kimi-code/k3",
        reasoningEffort: "high",
      }),
    ).resolves.toMatchObject({
      currentModelId: "kimi-code/k3",
      configValues: {
        model: "kimi-code/k3",
        thinking: "high",
      },
      reasoningEffort: "high",
    });
    expect(transport.requests.slice(-2)).toEqual([
      {
        method: "session/set_config_option",
        params: {
          sessionId: "kimi-session",
          configId: "model",
          value: "kimi-code/k3",
        },
      },
      {
        method: "session/set_config_option",
        params: {
          sessionId: "kimi-session",
          configId: "thinking",
          value: "high",
        },
      },
    ]);
  });

  it("does not send a thought level the newly selected model does not offer", async () => {
    // A caller can pair a model with a level chosen for another model: a
    // review child re-selects its parent's model with the review's level.
    const transport = new KimiConfigOptionTransport();
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    await client.setRuntimeOption({
      sessionId: session.sessionId,
      source: "model",
      optionId: "model",
      value: "kimi-code/k3",
      reasoningEffort: "low",
    });
    expect(transport.thinking).toBe("low");

    await expect(
      client.setRuntimeOption({
        sessionId: session.sessionId,
        source: "model",
        optionId: "model",
        value: "kimi-code/kimi-for-coding",
        reasoningEffort: "high",
      }),
    ).resolves.toMatchObject({
      configValues: {
        model: "kimi-code/kimi-for-coding",
        thinking: "low",
      },
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "session/set_config_option",
      params: {
        sessionId: "kimi-session",
        configId: "model",
        value: "kimi-code/kimi-for-coding",
      },
    });
    const acpRuntime = store.getSession("acp:kimi", session.sessionId)
      ?.acpRuntime;
    expect(acpRuntime).toMatchObject({
      currentModelId: "kimi-code/kimi-for-coding",
      configValues: {
        model: "kimi-code/kimi-for-coding",
        thinking: "low",
      },
    });
    expect(acpRuntime?.reasoningEffort).toBeUndefined();
  });

  it("does not replay a thought level the session's model does not offer", async () => {
    // A thread that switched from K3 to K2.7 records thinking=low, because
    // Kimi keeps it. Review and monitor children replay the parent's runtime
    // into a fresh K2.7 session, which refuses that level.
    const transport = new KimiConfigOptionTransport();
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    const requestCount = transport.requests.length;

    await expect(
      client.setRuntimeOption({
        sessionId: session.sessionId,
        source: "configOption",
        optionId: "thinking",
        value: "low",
      }),
    ).resolves.toMatchObject({
      configValues: { thinking: "on" },
    });
    expect(transport.requests).toHaveLength(requestCount);
    expect(
      store.getSession("acp:kimi", session.sessionId)?.acpRuntime?.configValues,
    ).toMatchObject({ thinking: "on" });
  });

  it("refuses an explicit thought level the session's model does not offer", async () => {
    // A skip resolves with the unchanged state. A caller recording an
    // operator's explicit choice would report the level as applied, though
    // it was never sent. K2.7 Coding offers only `on`.
    const transport = new KimiConfigOptionTransport();
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    const requestCount = transport.requests.length;

    await expect(
      client.setRuntimeOption({
        sessionId: session.sessionId,
        source: "configOption",
        optionId: "thinking",
        value: "low",
        rejectUnofferedThoughtLevel: true,
      }),
    ).rejects.toThrow('does not offer "low" for thinking');
    expect(transport.requests).toHaveLength(requestCount);
    expect(
      store.getSession("acp:kimi", session.sessionId)?.acpRuntime?.configValues,
    ).toMatchObject({ thinking: "on" });

    // The flag refuses an unoffered level, not every write: switching to K3,
    // which offers `low`, and then setting it both go through.
    await client.setRuntimeOption({
      sessionId: session.sessionId,
      source: "configOption",
      optionId: "model",
      value: "kimi-code/k3",
      rejectUnofferedThoughtLevel: true,
    });
    await client.setRuntimeOption({
      sessionId: session.sessionId,
      source: "configOption",
      optionId: "thinking",
      value: "low",
      rejectUnofferedThoughtLevel: true,
    });
    expect(transport.thinking).toBe("low");
  });

  it("forgets a session's thought levels when the agent changes its options", async () => {
    // The agent can change a session's model on its own. The menu the last
    // reply reported is then stale, and must not refuse a level the new
    // model offers.
    const transport = new KimiConfigOptionTransport();
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    transport.model = "kimi-code/k3";
    transport.emitSessionUpdate("kimi-session", {
      sessionUpdate: "config_option_update",
      configOptions: transport.configOptions(),
    });

    await client.setRuntimeOption({
      sessionId: session.sessionId,
      source: "configOption",
      optionId: "thinking",
      value: "high",
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "session/set_config_option",
      params: {
        sessionId: "kimi-session",
        configId: "thinking",
        value: "high",
      },
    });
    expect(transport.thinking).toBe("high");
  });

  it("answers whether a model write would keep a thought level by the session's own menu", async () => {
    // The registry skips a turn-start model write whose only change would be
    // a level this client drops.
    const transport = new KimiConfigOptionTransport();
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    await client.setRuntimeOption({
      sessionId: session.sessionId,
      source: "model",
      optionId: "model",
      value: "kimi-code/k3",
      reasoningEffort: "high",
    });

    expect(client.offersThoughtLevel(session.sessionId, "max")).toBe(true);
    expect(client.offersThoughtLevel(session.sessionId, "on")).toBe(false);

    // An unknown menu leaves the decision to the agent.
    transport.emitSessionUpdate("kimi-session", {
      sessionUpdate: "config_option_update",
      configOptions: transport.configOptions(),
    });
    expect(client.offersThoughtLevel(session.sessionId, "on")).toBe(true);
  });

  it("keeps requested ACP config-option mode when response reports stale current mode", async () => {
    const transport = new FakeAcpAgentTransport({
      "session/new": {
        sessionId: "qwen-session",
        configOptions: [
          {
            id: "mode",
            label: "Mode",
            category: "mode",
            currentValue: "default",
            values: [
              { value: "default", label: "Default" },
              { value: "auto", label: "Auto" },
            ],
          },
        ],
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", label: "Default" },
            { id: "auto", label: "Auto" },
          ],
        },
      },
      "session/set_config_option": {
        configOptions: [
          {
            id: "mode",
            label: "Mode",
            category: "mode",
            currentValue: "default",
            values: [
              { value: "default", label: "Default" },
              { value: "auto", label: "Auto" },
            ],
          },
        ],
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", label: "Default" },
            { id: "auto", label: "Auto" },
          ],
        },
      },
    });
    const client = new AcpAgentClient({
      backendId: "acp:qwen",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "full-access",
    });

    await expect(
      client.setRuntimeOption({
        sessionId: session.sessionId,
        source: "configOption",
        optionId: "mode",
        value: "auto",
      }),
    ).resolves.toMatchObject({
      configValues: { mode: "auto" },
      currentModeId: "auto",
    });
    expect(store.getSession("acp:qwen", session.sessionId)).toMatchObject({
      acpRuntime: {
        configValues: { mode: "auto" },
        currentModeId: "auto",
      },
    });
  });

  it("rejects a second active prompt for the same ACP session", async () => {
    const pendingPrompt = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": pendingPrompt.promise,
    });
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "first",
    });

    expect(() =>
      client.startPrompt({
        sessionId: session.sessionId,
        prompt: "second",
      }),
    ).toThrow("A turn is already active for this ACP session.");

    pendingPrompt.resolve({ turnId: "turn-1" });
  });

  it("treats Gemini mode marker chunks as runtime updates instead of assistant text", async () => {
    const runtimeUpdates: unknown[] = [];
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      onSessionRuntimeStateChange: (event) => {
        runtimeUpdates.push(event);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    transport.emitSessionUpdate(session.sessionId, {
      kind: "agent_message_chunk",
      content: "[MODE_UPDATE] yolo",
    });

    expect(store.getSession("acp:gemini", session.sessionId)).toMatchObject({
      acpRuntime: {
        currentModeId: "yolo",
      },
    });
    expect(client.readReplay(session.sessionId).entries).toEqual([]);
    expect(runtimeUpdates).toEqual([
      {
        sessionId: session.sessionId,
        runtimeState: {
          currentModeId: "yolo",
          updatedAt: 1000,
        },
      },
    ]);
  });

  it("stores available command updates as session metadata", async () => {
    let now = 1000;
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      store,
      transport,
      now: () => now,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
      title: "Kimi ACP",
    });

    now = 2000;
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        {
          name: "skill:frontend-design",
          description: "Load frontend-design",
          aliases: ["fd", "frontend"],
        },
        {
          name: "help",
        },
        // Shapes captured from Kimi Code 0.31, Qwen, and ACP v2.
        { name: "compact", input: { hint: "<optional custom summarization instructions>" } },
        { name: "skills", input: { hint: "" } },
        { name: "review", input: { type: "text", hint: " [--pr <number>] " } },
        { name: "context", input: null },
      ],
    });

    expect(store.getSession("acp:kimi", "session-1")?.availableCommands).toEqual([
      {
        name: "skill:frontend-design",
        description: "Load frontend-design",
        aliases: ["fd", "frontend"],
        backend: "acp:kimi",
        scope: "session",
        source: "provider",
      },
      {
        name: "help",
        backend: "acp:kimi",
        scope: "session",
        source: "provider",
      },
      {
        name: "compact",
        argumentHint: "<optional custom summarization instructions>",
        backend: "acp:kimi",
        scope: "session",
        source: "provider",
      },
      { name: "skills", backend: "acp:kimi", scope: "session", source: "provider" },
      {
        name: "review",
        argumentHint: "[--pr <number>]",
        backend: "acp:kimi",
        scope: "session",
        source: "provider",
      },
      { name: "context", backend: "acp:kimi", scope: "session", source: "provider" },
    ]);
    expect(readRawAcpSessionPayload("acp:kimi", "session-1")?.availableCommands).toEqual(
      store.getSession("acp:kimi", "session-1")?.availableCommands,
    );
    expect(store.getSession("acp:kimi", "session-1")?.updatedAt).toBe(1000);
  });

  it("loads ACP transcript replay from provider session/load without storing it in the DB", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport: {
        request: async (method, params) => {
          const result = await transport.request(method, params);
          if (method === "session/load") {
            transport.emitSessionUpdate("session-1", {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "first" },
            });
            transport.emitSessionUpdate("session-1", {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "reply" },
            });
          }
          return result;
        },
        notify: (method, params) => transport.notify(method, params),
        close: () => transport.close(),
        onNotification: (listener) => transport.onNotification(listener),
      },
      now: () => 2000,
    });
    store.upsertSession({
      backendId: "acp:gemini",
      sessionId: "session-1",
      title: "Untitled thread",
      cwd: "/repo",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
    });

    await client.initialize();
    const firstReplay = await client.loadSession(store.getSession("acp:gemini", "session-1")!);
    const secondReplay = await client.loadSession(store.getSession("acp:gemini", "session-1")!);

    expect(firstReplay.messages.map((message) => message.text)).toEqual([
      "first",
      "reply",
    ]);
    expect(secondReplay.messages.map((message) => message.text)).toEqual([
      "first",
      "reply",
    ]);
    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/load",
    ]);
    expect(
      readRawAcpSessionPayload("acp:gemini", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
  });

  it("filters ACP system reminders when rehydrating provider session/load replay", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      store,
      transport: {
        request: async (method, params) => {
          const result = await transport.request(method, params);
          if (method === "session/load") {
            transport.emitSessionUpdate("session-1", {
              session_update: "user_message_chunk",
              content: { type: "text", text: "Run npm view pwrdrvr" },
            });
            transport.emitSessionUpdate("session-1", {
              session_update: "user_message_chunk",
              content: {
                type: "text",
                text: "<system-reminder> Auto permission mode is no longer active. Tool approvals and permission checks are back to the current mode. </system-reminder>",
              },
            });
            transport.emitSessionUpdate("session-1", {
              session_update: "agent_message_chunk",
              content: { type: "text", text: "pwrdrvr exists on npm." },
            });
          }
          return result;
        },
        notify: (method, params) => transport.notify(method, params),
        close: () => transport.close(),
        onNotification: (listener) => transport.onNotification(listener),
      },
      now: () => 2000,
    });
    store.upsertSession({
      backendId: "acp:kimi",
      sessionId: "session-1",
      title: "Kimi session",
      cwd: "/repo",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
    });

    await client.initialize();
    const replay = await client.loadSession(
      store.getSession("acp:kimi", "session-1")!,
    );

    expect(replay.messages.map((message) => message.text)).toEqual([
      "Run npm view pwrdrvr",
      "pwrdrvr exists on npm.",
    ]);
    expect(
      replay.entries.some(
        (entry) =>
          entry.type === "message" && entry.text.includes("system-reminder"),
      ),
    ).toBe(false);
    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/load",
    ]);
  });

  it("preserves local rollout timestamps when provider session/load replays old messages", async () => {
    const rolloutStore = new AcpRolloutStore(path.join(tempDir, "rollouts"));
    rolloutStore.appendUpdate({
      backendId: "acp:kimi",
      sessionId: "session-1",
      receivedAt: 1100,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "What have we here?",
        turnId: "turn-1",
      },
    });
    rolloutStore.appendUpdate({
      backendId: "acp:kimi",
      sessionId: "session-1",
      receivedAt: 1200,
      update: {
        session_update: "agent_message_chunk",
        content: { type: "text", text: "This is PwrAgent." },
      },
    });
    rolloutStore.appendUpdate({
      backendId: "acp:kimi",
      sessionId: "session-1",
      receivedAt: 1900,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "what time is it?",
        turnId: "turn-2",
      },
    });
    rolloutStore.appendUpdate({
      backendId: "acp:kimi",
      sessionId: "session-1",
      receivedAt: 1950,
      update: {
        session_update: "agent_message_chunk",
        content: { type: "text", text: "It's 10:57 PM." },
      },
    });
    rolloutStore.appendUpdate({
      backendId: "acp:kimi",
      sessionId: "session-1",
      receivedAt: 1960,
      update: {
        session_update: "turn_finished",
        turnId: "turn-2",
      },
    });
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      rolloutStore,
      store,
      transport: {
        request: async (method, params) => {
          const result = await transport.request(method, params);
          if (method === "session/load") {
            transport.emitSessionUpdate("session-1", {
              session_update: "user_message_chunk",
              content: { type: "text", text: "What have we here?" },
            });
            transport.emitSessionUpdate("session-1", {
              session_update: "agent_message_chunk",
              content: { type: "text", text: "This is PwrAgent." },
            });
            transport.emitSessionUpdate("session-1", {
              session_update: "user_message_chunk",
              content: { type: "text", text: "what time is it?" },
            });
            transport.emitSessionUpdate("session-1", {
              session_update: "agent_message_chunk",
              content: { type: "text", text: "It's 10:57 PM." },
            });
            transport.emitSessionUpdate("session-1", {
              session_update: "turn_finished",
              turnId: "turn-2",
            });
          }
          return result;
        },
        notify: (method, params) => transport.notify(method, params),
        close: () => transport.close(),
        onNotification: (listener) => transport.onNotification(listener),
      },
      now: () => 2000,
    });
    store.upsertSession({
      backendId: "acp:kimi",
      sessionId: "session-1",
      title: "Kimi session",
      cwd: "/repo",
      createdAt: 1000,
      updatedAt: 1950,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
    });

    await client.initialize();
    const replay = await client.loadSession(
      store.getSession("acp:kimi", "session-1")!,
    );

    expect(
      replay.messages.map((message) => ({
        createdAt: message.createdAt,
        text: message.text,
      })),
    ).toEqual([
      { createdAt: 1100, text: "What have we here?" },
      { createdAt: 1200, text: "This is PwrAgent." },
      { createdAt: 1900, text: "what time is it?" },
      { createdAt: 1950, text: "It's 10:57 PM." },
    ]);
    expect(
      rolloutStore.readUpdates({
        backendId: "acp:kimi",
        sessionId: "session-1",
      }),
    ).toHaveLength(5);
  });

  it("anchors untimestamped session/load updates to historical provider timestamps instead of reload time", async () => {
    const edit1Ts = Date.parse("2026-11-25T17:17:00Z");
    const edit2Ts = Date.parse("2026-11-25T17:20:00Z");
    const reloadTs = Date.parse("2026-11-26T01:06:00Z");

    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      },
    });
    const client = new AcpAgentClient({
      backendId: "acp:antigravity",
      store,
      transport: {
        request: async (method, params) => {
          const result = await transport.request(method, params);
          if (method === "session/load") {
            transport.emitSessionUpdate("session-mixed-ts", {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "Check submodule counts" },
            });
            transport.emitSessionUpdate("session-mixed-ts", {
              sessionUpdate: "tool_call",
              toolCallId: "t1",
              title: "Edited 1 file",
              status: "completed",
              timestamp: edit1Ts,
            });
            transport.emitSessionUpdate("session-mixed-ts", {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Tests passed; waiting for lint." },
            });
            transport.emitSessionUpdate("session-mixed-ts", {
              sessionUpdate: "tool_call",
              toolCallId: "t2",
              title: "Edited 1 file",
              status: "completed",
              timestamp: edit2Ts,
            });
            transport.emitSessionUpdate("session-mixed-ts", {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "All done." },
            });
          }
          return result;
        },
        notify: (method, params) => transport.notify(method, params),
        close: () => transport.close(),
        onNotification: (listener) => transport.onNotification(listener),
      },
      now: () => reloadTs,
    });
    store.upsertSession({
      backendId: "acp:antigravity",
      sessionId: "session-mixed-ts",
      title: "Mixed timestamps",
      cwd: "/repo",
      createdAt: edit1Ts,
      updatedAt: edit2Ts,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
    });

    await client.initialize();
    const replay = await client.loadSession(
      store.getSession("acp:antigravity", "session-mixed-ts")!,
    );

    expect(
      replay.messages.map((message) => ({
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
      })),
    ).toEqual([
      { role: "user", text: "Check submodule counts", createdAt: edit1Ts },
      { role: "assistant", text: "Tests passed; waiting for lint.", createdAt: edit1Ts },
      { role: "assistant", text: "All done.", createdAt: edit2Ts },
    ]);
    expect(replay.entries.every((entry) => entry.createdAt !== reloadTs)).toBe(true);
    expect(replay.entries.map((entry) => entry.createdAt)).toEqual([
      edit1Ts,
      edit1Ts,
      edit1Ts,
      edit2Ts,
      edit2Ts,
    ]);
  });

  it("does not run endProviderPromptReplay on restored fallbackNormalizer when session/load fails", async () => {
    const rolloutStore = new AcpRolloutStore(path.join(tempDir, "rollouts-failed-load"));
    rolloutStore.appendUpdate({
      backendId: "acp:grok",
      sessionId: "session-fail-load",
      receivedAt: 1_500,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "Original prompt",
        turnId: "turn-1",
      },
    });
    rolloutStore.appendUpdate({
      backendId: "acp:grok",
      sessionId: "session-fail-load",
      receivedAt: 1_600,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "In-progress reply" },
      },
    });
    rolloutStore.flushAll();

    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      },
    });
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      rolloutStore,
      store,
      transport: {
        request: async (method, params) => {
          const result = await transport.request(method, params);
          if (method === "session/load") {
            transport.emitSessionUpdate("session-fail-load", {
              sessionUpdate: "tool_call",
              toolCallId: "late-tool",
              title: "Ran check",
              status: "completed",
              timestamp: 1_200,
            });
          }
          return result;
        },
        notify: (method, params) => transport.notify(method, params),
        close: () => transport.close(),
        onNotification: (listener) => transport.onNotification(listener),
      },
      mcpServers: () => ({
        servers: [],
        bindThread: async () => {
          throw new Error("bindThread failed after session/load");
        },
      }),
      now: () => 5_000,
    });
    store.upsertSession({
      backendId: "acp:grok",
      sessionId: "session-fail-load",
      title: "Failed load fallback",
      cwd: "/repo",
      createdAt: 1_500,
      updatedAt: 1_600,
      executionMode: "default",
      status: "active",
      hasConversationHistory: true,
    });

    await client.initialize();
    await expect(
      client.loadSession(store.getSession("acp:grok", "session-fail-load")!),
    ).rejects.toThrow("bindThread failed after session/load");

    // Restored fallback normalizer must not have its open turn finished or timestamps clamped.
    const restoredReplay = client.readReplay("session-fail-load");
    expect(restoredReplay.messages.map((message) => message.createdAt)).toEqual([1_500, 1_600]);
    expect(restoredReplay.entries.every((entry) => entry.createdAt !== 1_200)).toBe(true);
    expect(restoredReplay.entries[0]?.turn?.status).not.toBe("completed");
  });

  it("preserves newer metadata activity over complete local rollout history", async () => {
    const rolloutStore = new AcpRolloutStore(path.join(tempDir, "rollouts"));
    rolloutStore.appendUpdate({
      backendId: "acp:grok",
      sessionId: "session-1",
      receivedAt: 1100,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "Was this really sent now?",
        turnId: "turn-1",
      },
    });
    rolloutStore.appendUpdate({
      backendId: "acp:grok",
      sessionId: "session-1",
      receivedAt: 1200,
      update: {
        session_update: "agent_message_chunk",
        content: { type: "text", text: "No, it was sent earlier." },
      },
    });
    rolloutStore.appendUpdate({
      backendId: "acp:grok",
      sessionId: "session-1",
      receivedAt: 1201,
      update: {
        session_update: "turn_finished",
        turnId: "turn-1",
      },
    });
    rolloutStore.appendUpdate({
      backendId: "acp:grok",
      sessionId: "session-1",
      receivedAt: 1900,
      update: {
        kind: "provider_runtime_snapshot",
        state: "ready",
      },
    });
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
        },
      },
    });
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      rolloutStore,
      store,
      transport,
      now: () => 2000,
    });
    store.upsertSession({
      backendId: "acp:grok",
      sessionId: "session-1",
      title: "Grok session",
      cwd: "/repo",
      createdAt: 1000,
      // A rename and runtime-option change legitimately happened after the
      // last conversation event in the rollout.
      updatedAt: 2000,
      executionMode: "default",
      titleSource: "explicit",
      acpRuntime: {
        currentModelId: "grok-4.5",
        updatedAt: 2000,
      },
      status: "idle",
      hasConversationHistory: true,
    });

    await client.initialize();
    const staleMetadata = store.getSession("acp:grok", "session-1")!;
    const replay = await client.loadSession(staleMetadata);
    await client.refreshSession(staleMetadata);

    expect(replay.messages.map((message) => message.createdAt)).toEqual([
      1100,
      1200,
    ]);
    expect(store.getSession("acp:grok", "session-1")?.updatedAt).toBe(2000);
    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/load",
    ]);
  });

  it("uses timestamped Grok session/load notifications over a complete rollout", async () => {
    const rolloutStore = new AcpRolloutStore(path.join(tempDir, "rollouts"));
    rolloutStore.appendUpdate({
      backendId: "acp:grok",
      sessionId: "session-1",
      receivedAt: 1100,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "Old local prompt",
        turnId: "turn-1",
      },
    });
    rolloutStore.appendUpdate({
      backendId: "acp:grok",
      sessionId: "session-1",
      receivedAt: 1200,
      update: {
        session_update: "agent_message_chunk",
        content: { type: "text", text: "Old local reply" },
      },
    });
    rolloutStore.appendUpdate({
      backendId: "acp:grok",
      sessionId: "session-1",
      receivedAt: 1201,
      update: {
        session_update: "turn_finished",
        turnId: "turn-1",
      },
    });
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
        },
      },
    });
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      rolloutStore,
      store,
      transport: {
        request: async (method, params) => {
          const result = await transport.request(method, params);
          if (method === "session/load") {
            transport.emitSessionUpdate(
              "session-1",
              {
                session_update: "user_message_chunk",
                content: { type: "text", text: "Provider prompt" },
              },
              { agentTimestampMs: 1_785_000_001_300, isReplay: true },
            );
            transport.emitSessionUpdate(
              "session-1",
              {
                session_update: "agent_message_chunk",
                content: { type: "text", text: "Provider reply" },
              },
              { agentTimestampMs: 1_785_000_001_400, isReplay: true },
            );
            transport.emitSessionUpdate(
              "session-1",
              {
                session_update: "turn_completed",
                turnId: "turn-1",
              },
              { agentTimestampMs: 1_785_000_001_401, isReplay: true },
            );
          }
          return result;
        },
        notify: (method, params) => transport.notify(method, params),
        close: () => transport.close(),
        onNotification: (listener) => transport.onNotification(listener),
      },
      now: () => 1_800_000_000_000,
    });
    store.upsertSession({
      backendId: "acp:grok",
      sessionId: "session-1",
      title: "Grok session",
      cwd: "/repo",
      createdAt: 1_785_000_000_000,
      updatedAt: 1_800_000_000_000,
      executionMode: "default",
      status: "active",
      hasConversationHistory: true,
    });

    await client.initialize();
    const replay = await client.loadSession(
      store.getSession("acp:grok", "session-1")!,
    );
    const cachedReplay = await client.loadSession(
      store.getSession("acp:grok", "session-1")!,
    );

    expect(
      replay.messages.map((message) => ({
        createdAt: message.createdAt,
        text: message.text,
      })),
    ).toEqual([
      { createdAt: 1_785_000_001_300, text: "Provider prompt" },
      { createdAt: 1_785_000_001_400, text: "Provider reply" },
    ]);
    expect(
      cachedReplay.messages.map((message) => ({
        createdAt: message.createdAt,
        text: message.text,
      })),
    ).toEqual([
      { createdAt: 1_785_000_001_300, text: "Provider prompt" },
      { createdAt: 1_785_000_001_400, text: "Provider reply" },
    ]);
    client.startPrompt({
      sessionId: "session-1",
      prompt: "Provider-owned follow-up",
      turnId: "turn-2",
    });
    await vi.waitFor(() => {
      expect(
        transport.requests.filter(
          (request) => request.method === "session/prompt",
        ),
      ).toHaveLength(1);
    });
    await vi.waitFor(() => {
      expect(client.readReplay("session-1").threadStatus).toBe("idle");
    });
    expect(client.didSessionLoadReplayHistory("session-1")).toBe(true);
    expect(store.getSession("acp:grok", "session-1")?.updatedAt).toBe(
      1_800_000_000_000,
    );
    expect(store.getSession("acp:grok", "session-1")?.status).toBe("idle");
    expect(
      rolloutStore.readUpdates({
        backendId: "acp:grok",
        sessionId: "session-1",
      }),
    ).toHaveLength(3);
    expect(
      transport.requests.filter((request) => request.method === "session/load"),
    ).toHaveLength(1);
  });

  it("merges provider session/load replay when local rollout history is incomplete", async () => {
    const rolloutStore = new AcpRolloutStore(path.join(tempDir, "rollouts"));
    rolloutStore.appendUpdate({
      backendId: "acp:kimi",
      sessionId: "session-1",
      receivedAt: 1100,
      update: {
        kind: "pwragent_user_prompt",
        prompt: "what time is it?",
        turnId: "turn-1",
      },
    });
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      rolloutStore,
      store,
      transport: {
        request: async (method, params) => {
          const result = await transport.request(method, params);
          if (method === "session/load") {
            transport.emitSessionUpdate("session-1", {
              session_update: "user_message_chunk",
              content: { type: "text", text: "what time is it?" },
            });
            transport.emitSessionUpdate("session-1", {
              session_update: "agent_message_chunk",
              content: { type: "text", text: "It's 10:57 PM." },
            });
            transport.emitSessionUpdate("session-1", {
              session_update: "turn_finished",
              turnId: "turn-1",
            });
          }
          return result;
        },
        notify: (method, params) => transport.notify(method, params),
        close: () => transport.close(),
        onNotification: (listener) => transport.onNotification(listener),
      },
      now: () => 2000,
    });
    store.upsertSession({
      backendId: "acp:kimi",
      sessionId: "session-1",
      title: "Kimi session",
      cwd: "/repo",
      createdAt: 1000,
      updatedAt: 1100,
      executionMode: "default",
      status: "active",
      hasConversationHistory: true,
    });

    await client.initialize();
    const replay = await client.loadSession(
      store.getSession("acp:kimi", "session-1")!,
    );

    expect(
      replay.messages.map((message) => ({
        createdAt: message.createdAt,
        text: message.text,
      })),
    ).toEqual([
      { createdAt: 1100, text: "what time is it?" },
      { createdAt: 2000, text: "It's 10:57 PM." },
    ]);
    expect(replay.threadStatus).toBe("idle");
    expect(
      rolloutStore.readUpdates({
        backendId: "acp:kimi",
        sessionId: "session-1",
      }),
    ).toHaveLength(1);
  });

  it("does not let synthetic PwrAgent messages suppress provider session/load history", async () => {
    const rolloutStore = new AcpRolloutStore(path.join(tempDir, "rollouts"));
    rolloutStore.appendUpdate({
      backendId: "acp:kimi",
      sessionId: "session-1",
      receivedAt: 1100,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Monitor completed.",
        },
        messageId: "monitor-1:message:1100",
        _meta: {
          pwragentSynthetic: true,
          source: "pwragent_task_monitor",
        },
      },
    });
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      rolloutStore,
      store,
      transport: {
        request: async (method, params) => {
          const result = await transport.request(method, params);
          if (method === "session/load") {
            transport.emitSessionUpdate("session-1", {
              session_update: "user_message_chunk",
              content: { type: "text", text: "What is the status?" },
            });
            transport.emitSessionUpdate("session-1", {
              session_update: "agent_message_chunk",
              content: { type: "text", text: "Still running." },
            });
          }
          return result;
        },
        notify: (method, params) => transport.notify(method, params),
        close: () => transport.close(),
        onNotification: (listener) => transport.onNotification(listener),
      },
      now: () => 2000,
    });
    store.upsertSession({
      backendId: "acp:kimi",
      sessionId: "session-1",
      title: "Kimi session",
      cwd: "/repo",
      createdAt: 1000,
      updatedAt: 1100,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
    });

    await client.initialize();
    const replay = await client.loadSession(
      store.getSession("acp:kimi", "session-1")!,
    );

    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/load",
    ]);
    expect(replay.messages.map((message) => message.text)).toEqual([
      "What is the status?",
      "Still running.",
    ]);
  });

  it("returns empty replay when no provider session/load support is advertised", async () => {
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
        },
      },
    });
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 2000,
    });
    store.upsertSession({
      backendId: "acp:gemini",
      sessionId: "session-1",
      title: "Untitled thread",
      cwd: "/repo",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
    });

    await client.initialize();
    expect(client.supportsSessionLoad()).toBe(false);
    const replay = await client.loadSession(
      store.getSession("acp:gemini", "session-1")!,
    );

    expect(replay.messages).toEqual([]);
    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
    ]);
  });

  it.each([
    { text: ["hello"] },
    { text: ["[PwrAgent review sub-agent results — context for this turn]\n\nHere is my diagnostic excerpt."] },
    { text: [
      "[PwrAgent review sub-agent results — context for this turn]\n\nHere is an example.\n\n[End PwrAgent review sub-agent results]",
      "Explain this diagnostic excerpt.",
    ] },
  ])("restores the sent ACP prompt from local rollout history (%j)", async ({ text }) => {
    const rolloutStore = new AcpRolloutStore(path.join(tempDir, "rollouts"));
    const firstTransport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
        },
      },
    });
    const firstClient = new AcpAgentClient({
      backendId: "acp:kimi",
      rolloutStore,
      store,
      transport: firstTransport,
      now: () => 1000,
    });

    await firstClient.initialize();
    const session = await firstClient.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    const prompt = text.join("\n");
    const parts = text.map((block) => ({ type: "text" as const, text: block }));
    await firstClient.startPrompt({
      sessionId: session.sessionId,
      prompt,
      promptContent: parts,
      parts,
      turnId: "turn-1",
    });
    const sent = firstTransport.requests.find(({ method }) => method === "session/prompt");
    expect(sent?.params?.prompt).toEqual(parts);
    firstTransport.emitSessionUpdate(session.sessionId, {
      session_update: "agent_message_chunk",
      content: { type: "text", text: "Kimi says hi." },
    });

    const secondTransport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
        },
      },
    });
    const secondClient = new AcpAgentClient({
      backendId: "acp:kimi",
      rolloutStore,
      store,
      transport: secondTransport,
      now: () => 2000,
    });

    await secondClient.initialize();
    const replay = await secondClient.loadSession(
      store.getSession("acp:kimi", session.sessionId)!,
    );

    expect(replay.messages.map((message) => message.text)).toEqual([
      prompt,
      "Kimi says hi.",
    ]);
    expect(replay.messages[0]?.parts).toEqual(sent?.params?.prompt);
    expect(secondTransport.requests.map((request) => request.method)).toEqual([
      "initialize",
    ]);
    expect(
      readRawAcpSessionPayload("acp:kimi", session.sessionId)?.transcriptUpdates,
    ).toBeUndefined();
  });

  it("retains fallback history when advertised session replay returns no transcript", async () => {
    const rolloutStore = {
      appendUpdate: vi.fn(),
      readUpdates: vi.fn(() => []),
      flushAll: vi.fn(),
    };
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
        },
        sessionCapabilities: {
          _meta: {
            kimi: {
              sessionHistoryReplay: true,
            },
          },
        },
      },
    });
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      rolloutStore,
      store,
      transport,
      now: () => 1000,
    });
    store.upsertSession({
      backendId: "acp:kimi",
      sessionId: "session-1",
      title: "Kimi session",
      cwd: "/repo",
      createdAt: 900,
      updatedAt: 900,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
    });

    await client.initialize();
    await client.loadSession(store.getSession("acp:kimi", "session-1")!);
    client.startPrompt({
      sessionId: "session-1",
      prompt: "hello",
      turnId: "turn-1",
    });
    transport.emitSessionUpdate("session-1", {
      session_update: "agent_message_chunk",
      content: { type: "text", text: "Kimi says hi." },
    });

    await vi.waitFor(() => {
      expect(client.readReplay("session-1").lastAssistantMessage).toBe(
        "Kimi says hi.",
      );
    });
    await vi.waitFor(() => {
      expect(client.readReplay("session-1").threadStatus).toBe("idle");
    });

    expect(client.didSessionLoadReplayHistory("session-1")).toBe(false);
    expect(rolloutStore.appendUpdate).toHaveBeenCalled();
  });

  it("retains fallback history after a rejected partial session replay", async () => {
    const rolloutStore = {
      appendUpdate: vi.fn(),
      readUpdates: vi.fn(() => []),
      flushAll: vi.fn(),
    };
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
        },
      },
    });
    let loadAttempts = 0;
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      rolloutStore,
      store,
      transport: {
        request: async (method, params) => {
          if (method === "session/load") {
            loadAttempts += 1;
            if (loadAttempts === 1) {
              transport.emitSessionUpdate(
                "session-1",
                {
                  session_update: "agent_message_chunk",
                  content: { type: "text", text: "Partial replay" },
                },
                { agentTimestampMs: 1_700_000_000_000, isReplay: true },
              );
              throw new Error("session/load failed");
            }
            return {};
          }
          return await transport.request(method, params);
        },
        notify: (method, params) => transport.notify(method, params),
        close: () => transport.close(),
        onNotification: (listener) => transport.onNotification(listener),
      },
      now: () => 1_800_000_000_000,
    });
    store.upsertSession({
      backendId: "acp:grok",
      sessionId: "session-1",
      title: "Grok session",
      cwd: "/repo",
      createdAt: 1_600_000_000_000,
      updatedAt: 1_600_000_000_000,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
    });

    await client.initialize();
    const metadata = store.getSession("acp:grok", "session-1")!;
    await expect(client.loadSession(metadata)).rejects.toThrow(
      "session/load failed",
    );
    expect(client.didSessionLoadReplayHistory("session-1")).toBe(false);

    await client.refreshSession(metadata);
    expect(loadAttempts).toBe(2);
    expect(client.didSessionLoadReplayHistory("session-1")).toBe(false);

    rolloutStore.appendUpdate.mockClear();
    client.startPrompt({
      sessionId: "session-1",
      prompt: "Continue after retry",
      turnId: "turn-2",
    });
    transport.emitSessionUpdate("session-1", {
      session_update: "agent_message_chunk",
      content: { type: "text", text: "Fallback remains active." },
    });

    expect(rolloutStore.appendUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          kind: "pwragent_user_prompt",
          prompt: "Continue after retry",
        }),
      }),
    );
    expect(rolloutStore.appendUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          session_update: "agent_message_chunk",
        }),
      }),
    );
  });

  it("does not call session/load when the ACP agent says loading is unsupported", async () => {
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
        },
      },
    });
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 2000,
    });
    store.upsertSession({
      backendId: "acp:gemini",
      sessionId: "session-1",
      title: "Untitled thread",
      cwd: "/repo",
      createdAt: 1000,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
    });

    await client.initialize();
    await client.ensureSession(store.getSession("acp:gemini", "session-1")!);
    await client.refreshSession(store.getSession("acp:gemini", "session-1")!);

    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
    ]);
  });

  it("cancels a pending memory read before sending an ACP prompt", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({ backendId: "acp:codex-acp", store, transport });
    try {
      const session = await client.startSession({ cwd: "/repo", executionMode: "default" });
      const memory = Promise.withResolvers<string>();
      const readAgentMemory = vi.fn(() => memory.promise);
      const cancelled = expect(client.startPrompt({ sessionId: session.sessionId, prompt: "stop this", readAgentMemory }))
        .rejects.toThrow("cancelled before it was sent");
      await vi.waitFor(() => expect(readAgentMemory).toHaveBeenCalledOnce());
      await client.cancelSession(session.sessionId);
      await cancelled;
      await vi.waitFor(() => expect(client.hasActiveTurns()).toBe(false));
      memory.resolve("private context");
      await memory.promise;
      expect(transport.requests.some(({ method }) => method === "session/prompt")).toBe(false);
      expect(transport.notifications).toEqual([]);
    } finally {
      await client.dispose();
    }
  });

  it("can start prompts without waiting for completion and cancel sessions", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:codex-acp",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    const prompt = client.startPrompt({
      sessionId: session.sessionId,
      prompt: "keep going",
    });
    const activeReplay = client.readReplay(session.sessionId);
    const persistedSession = store.getSession("acp:codex-acp", session.sessionId);
    await client.cancelSession(session.sessionId);

    await expect(prompt).resolves.toEqual({
      sessionId: "session-1",
      turnId: "pending:session-1:1000",
    });
    expect(activeReplay).toMatchObject({
      lastUserMessage: "keep going",
      threadStatus: "active",
    });
    expect(persistedSession).toMatchObject({
      hasConversationHistory: true,
    });
    expect(
      readRawAcpSessionPayload("acp:codex-acp", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
    ]);
    expect(transport.requests[2]?.params).toEqual({
      sessionId: "session-1",
      prompt: [{ type: "text", text: "keep going" }],
    });
    expect(transport.notifications).toEqual([
      {
        method: "session/cancel",
        params: { sessionId: "session-1" },
      },
    ]);
  });

  it("can keep a stable app session id while rebinding the ACP protocol session", async () => {
    const transport = new FakeAcpAgentTransport();
    const updateSessionIds: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ sessionId }) => {
        updateSessionIds.push(sessionId);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      sessionId: "app-session-1",
      cwd: "/repo/worktree",
      executionMode: "default",
      title: "Stable thread",
    });
    client.startPrompt({
      sessionId: "app-session-1",
      prompt: "hello",
      turnId: "pending:app-session-1",
    });
    transport.emitSessionUpdate("session-1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello from rebound session." },
    });
    await client.cancelSession("app-session-1");

    expect(session).toMatchObject({
      sessionId: "app-session-1",
      agentSessionId: "session-1",
      cwd: "/repo/worktree",
    });
    expect(transport.requests[2]?.params).toEqual({
      sessionId: "session-1",
      prompt: [{ type: "text", text: "hello" }],
    });
    expect(updateSessionIds[0]).toBe("app-session-1");
    expect(client.readReplay("app-session-1").lastAssistantMessage).toBe(
      "Hello from rebound session.",
    );
    expect(transport.notifications).toEqual([
      {
        method: "session/cancel",
        params: { sessionId: "session-1" },
      },
    ]);
  });

  it("reports fire-and-forget prompt chunks and completion with turn context", async () => {
    const transport = new FakeAcpAgentTransport();
    let resolvePrompt: ((value: unknown) => void) | undefined;
    const updates: Array<{
      outputText?: string;
      text?: string;
      turnId?: string;
      updateKind?: string;
    }> = [];
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport: {
        request: async (method, params) => {
          if (method === "session/prompt") {
            transport.requests.push({ method, params });
            return await new Promise((resolve) => {
              resolvePrompt = resolve;
            });
          }
          return await transport.request(method, params);
        },
        notify: (method, params) => transport.notify(method, params),
        onNotification: (listener) => transport.onNotification(listener),
      },
      now: () => 1000,
      onSessionUpdate: ({ replay, turnId, update }) => {
        const content = update.content as { text?: string } | undefined;
        updates.push({
          ...(typeof update.outputText === "string"
            ? { outputText: update.outputText }
            : {}),
          ...(typeof content?.text === "string" ? { text: content.text } : {}),
          turnId,
          updateKind:
            typeof update.kind === "string"
              ? update.kind
              : typeof update.sessionUpdate === "string"
                ? update.sessionUpdate
                : undefined,
        });
        expect(replay.threadStatus).toBeDefined();
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "hello",
      turnId: "pending:session-1",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello " },
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "world" },
    });
    resolvePrompt?.({});

    await vi.waitFor(() => {
      expect(updates.map((update) => update.updateKind)).toEqual([
        "agent_message_chunk",
        "agent_message_chunk",
        "turn_finished",
      ]);
    });
    expect(updates).toEqual([
      {
        text: "Hello ",
        turnId: "pending:session-1",
        updateKind: "agent_message_chunk",
      },
      {
        text: "world",
        turnId: "pending:session-1",
        updateKind: "agent_message_chunk",
      },
      {
        outputText: "Hello world",
        turnId: "pending:session-1",
        updateKind: "turn_finished",
      },
    ]);
  });

  it("names a live edit's diff relative to the session's workspace", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "write-1",
      kind: "edit",
      status: "completed",
      locations: [{ path: "/repo/docs/a.md" }],
      content: [{ type: "diff", path: "/repo/docs/a.md", oldText: null, newText: "a\n" }],
    });

    const activity = client
      .readReplay(session.sessionId)
      .entries.find((entry) => entry.type === "activity");
    const detail = activity?.type === "activity" ? activity.details[0] : undefined;
    expect(detail?.path).toBe("/repo/docs/a.md");
    expect(detail?.fileDiff?.diff.split("\n")[0]).toBe(
      "diff --git a/docs/a.md b/docs/a.md",
    );
  });

  it("names edits relative to the workspace when an update precedes the session's metadata", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    // An agent may announce its commands before session/new answers, so the
    // session's normalizer exists before its metadata does.
    transport.emitSessionUpdate("session-1", {
      sessionUpdate: "available_commands_update",
      availableCommands: [],
    });
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "write-1",
      kind: "edit",
      status: "completed",
      locations: [{ path: "/repo/docs/a.md" }],
      content: [{ type: "diff", path: "/repo/docs/a.md", oldText: null, newText: "a\n" }],
    });

    const activity = client
      .readReplay(session.sessionId)
      .entries.find((entry) => entry.type === "activity");
    const detail = activity?.type === "activity" ? activity.details[0] : undefined;
    expect(detail?.fileDiff?.diff.split("\n")[0]).toBe(
      "diff --git a/docs/a.md b/docs/a.md",
    );
  });

  it("persists ACP topic updates as session titles", async () => {
    const transport = new FakeAcpAgentTransport();
    const titleUpdates: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ title }) => {
        if (title) {
          titleUpdates.push(title);
        }
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "update_topic_1",
      kind: "think",
      title: 'Update topic to: "Exploring PwrSnap Project"',
      status: "in_progress",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "update_topic_1",
      kind: "think",
      title: 'Update topic to: "Exploring PwrSnap Project"',
      status: "completed",
    });

    expect(store.getSession("acp:gemini", session.sessionId)?.title).toBe(
      "Exploring PwrSnap Project",
    );
    expect(client.readReplay(session.sessionId).entries).toEqual([]);
    expect(titleUpdates).toEqual(["Exploring PwrSnap Project"]);
  });

  it.each(["acp:gemini", "acp:claude"] as const)("does not overwrite an explicit %s session title with topic updates", async (backendId) => {
    const transport = new FakeAcpAgentTransport();
    const titleUpdates: string[] = [];
    const client = new AcpAgentClient({
      backendId,
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ title }) => {
        if (title) {
          titleUpdates.push(title);
        }
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
      title: "Manual thread name",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "update_topic_1",
      kind: "think",
      title: 'Update topic to: "Agent Suggested Name"',
      status: "completed",
    });

    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "session_info_update",
      title: "Provider generated name",
    });

    expect(store.getSession(backendId, session.sessionId)).toMatchObject({
      title: "Manual thread name",
      titleSource: "explicit",
    });
    expect(titleUpdates).toEqual([]);
  });

  it("keeps the first ACP topic title instead of treating later topics as renames", async () => {
    const transport = new FakeAcpAgentTransport();
    const titleUpdates: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ title }) => {
        if (title) {
          titleUpdates.push(title);
        }
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "update_topic_1",
      kind: "think",
      title: 'Update topic to: "Cleaning up formatting"',
      status: "completed",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "update_topic_2",
      kind: "think",
      title: 'Update topic to: "Running npm audit"',
      status: "completed",
    });

    expect(store.getSession("acp:gemini", session.sessionId)).toMatchObject({
      title: "Cleaning up formatting",
      titleSource: "derived",
    });
    expect(titleUpdates).toEqual(["Cleaning up formatting"]);
  });

  it("adopts Grok's session_summary_generated vendor notification as the thread title", async () => {
    // Grok ACP doesn't use Gemini/Kimi's "Update topic to: …" tool-call
    // convention. Instead, at the end of the first real turn, Grok pushes
    // a vendor notification `_x.ai/session_notification` carrying an
    // auto-generated 5-7 word summary in `session_summary`. The ACP client
    // routes that vendor method through the same applySessionUpdate path
    // as a standard session/update, and readAcpTopicTitle picks the title
    // out of the `session_summary_generated` kind without parsing.
    const transport = new FakeAcpAgentTransport();
    const titleUpdates: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ title }) => {
        if (title) {
          titleUpdates.push(title);
        }
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    transport.emitVendorNotification({
      method: "_x.ai/session_notification",
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "session_summary_generated",
        session_summary: "Haiku About Debugging Code in Software",
      },
    });

    expect(store.getSession("acp:grok", session.sessionId)).toMatchObject({
      title: "Haiku About Debugging Code in Software",
      titleSource: "derived",
    });
    expect(titleUpdates).toEqual(["Haiku About Debugging Code in Software"]);
    // Vendor session-summary notifications must not show up as transcript
    // entries — the normalizer's readAcpTopicTitle fallthrough at line 118
    // routes them to thread metadata instead.
    expect(client.readReplay(session.sessionId).entries).toEqual([]);
  });

  it("does not mark a seen Grok thread unread for last_turn_summary metadata", async () => {
    let now = 1000;
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      store,
      transport,
      now: () => now,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    now = 1100;
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Finished the requested work." },
    });
    const seenUpdatedAt =
      store.getSession("acp:grok", session.sessionId)?.updatedAt ?? 0;
    expect(seenUpdatedAt).toBe(1100);

    now = 1200;
    transport.emitVendorNotification({
      method: "_x.ai/session_notification",
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "last_turn_summary",
        summary: "Requested work complete",
      },
    });

    const metadata = store.getSession("acp:grok", session.sessionId);
    expect(metadata?.updatedAt).toBe(seenUpdatedAt);
    expect(
      deriveInboxState({
        firstSnapshot: false,
        isNewThread: false,
        overlay: {
          backend: "acp:grok",
          executionMode: "default",
          extraLinkedDirectories: [],
          lastSeenUpdatedAt: seenUpdatedAt,
          threadId: session.sessionId,
        },
        thread: {
          id: session.sessionId,
          linkedDirectories: [],
          source: "acp:grok",
          title: "Untitled thread",
          titleSource: "fallback",
          updatedAt: metadata?.updatedAt,
        },
      }),
    ).toMatchObject({ inInbox: false });
  });

  describe.each(["acp:grok", "acp:gemini", "acp:kimi", "acp:qwen"] as const)(
    "%s live/replay message boundaries",
    (backendId) => {
      it.each([
        { sessionUpdate: "session_info_update", title: "Example title" },
        { sessionUpdate: "available_commands_update", availableCommands: [] },
        { sessionUpdate: "config_option_update", configOptions: [] },
        { sessionUpdate: "current_mode_update", currentModeId: "default" },
        { sessionUpdate: "model_changed", modelId: "example-model" },
        { sessionUpdate: "session_summary_generated", session_summary: "Example title" },
        { sessionUpdate: "memory_flush_started" },
        { sessionUpdate: "future_provider_metadata" },
        { sessionUpdate: "tool_call_delta_chunk" },
        { sessionUpdate: "response_completed" },
        { sessionUpdate: "last_turn_summary" },
        {
          sessionUpdate: "tool_call",
          toolCallId: "topic-1",
          title: 'Update topic to: "Example title"',
        },
      ])("preserves identity across $sessionUpdate", async (interleavedUpdate) => {
        const promptResponse = createDeferred<unknown>();
        const transport = new FakeAcpAgentTransport({
          "session/prompt": promptResponse.promise,
        });
        const rolloutStore = new AcpRolloutStore(path.join(tempDir, "rollouts"));
        const liveMessages = new Map<string | undefined, string>();
        const client = new AcpAgentClient({
          backendId,
          store,
          rolloutStore,
          transport,
          onSessionUpdate: ({ assistantMessageItemId, update }) => {
            if (update.sessionUpdate === "agent_message_chunk") {
              const text = (update.content as { text: string }).text;
              liveMessages.set(
                assistantMessageItemId,
                (liveMessages.get(assistantMessageItemId) ?? "") + text,
              );
            }
          },
        });
        await client.initialize();
        const session = await client.startSession({ cwd: "/repo", executionMode: "default" });
        client.startPrompt({ sessionId: session.sessionId, prompt: "Explain this", turnId: "turn-1" });
        const emitText = (text: string) => transport.emitSessionUpdate(session.sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
        emitText("One ");
        transport.emitSessionUpdate(session.sessionId, interleavedUpdate);
        // Whitespace is part of an existing message, not a new empty bubble.
        emitText(" ");
        emitText("paragraph.");
        transport.emitSessionUpdate(session.sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "read-1",
          title: "Read fixture",
          status: "in_progress",
        });
        emitText("After ");
        transport.emitSessionUpdate(session.sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "read-1",
          status: "completed",
        });
        emitText("the tool.");

        const replayMessages = client.readReplay(session.sessionId).messages
          .filter((message) => message.role === "assistant")
          .map(({ id, text }) => [id, text]);
        expect(replayMessages).toEqual([
          ["assistant:turn-1:0", "One  paragraph."],
          ["assistant:turn-1:1", "After the tool."],
        ]);
        expect([...liveMessages]).toEqual(replayMessages);
        promptResponse.resolve({});
        await vi.waitFor(() => {
          expect(store.getSession(backendId, session.sessionId)?.status).toBe("idle");
        });
        await client.dispose();
        const reloadedClient = new AcpAgentClient({
          backendId,
          store,
          rolloutStore,
          transport: new FakeAcpAgentTransport(),
        });
        await reloadedClient.initialize();
        const reloaded = await reloadedClient.loadSession(store.getSession(backendId, session.sessionId)!);
        expect(reloaded.messages.filter((message) => message.role === "assistant")
          .map(({ id, text }) => [id, text])).toEqual(replayMessages);
        await reloadedClient.dispose();
      });
    },
  );

  it.each(["acp:grok", "acp:gemini", "acp:kimi", "acp:qwen"] as const)(
    "keeps explicit IDs and visible thought boundaries aligned for %s",
    async (backendId) => {
      const promptResponse = createDeferred<unknown>();
      const transport = new FakeAcpAgentTransport({ "session/prompt": promptResponse.promise });
      const liveMessages = new Map<string, string>();
      const client = new AcpAgentClient({
        backendId,
        store,
        transport,
        onSessionUpdate: ({ assistantMessageItemId, update }) => {
          if (assistantMessageItemId) {
            liveMessages.set(
              assistantMessageItemId,
              (liveMessages.get(assistantMessageItemId) ?? "") + update.content,
            );
          }
        },
      });
      await client.initialize();
      const session = await client.startSession({ cwd: "/repo", executionMode: "default" });
      client.startPrompt({ sessionId: session.sessionId, prompt: "Explain this", turnId: "turn-1" });
      for (const update of [
        { sessionUpdate: "agent_message_chunk", content: "Before." },
        { sessionUpdate: "agent_thought_chunk", content: "Considering." },
        { sessionUpdate: "agent_message_chunk", content: "After." },
        { sessionUpdate: "agent_message_chunk", messageId: "provider-1", content: "Explicit " },
        { sessionUpdate: "agent_message_chunk", content: "continuation." },
        { sessionUpdate: "agent_message_chunk", message_id: "provider-2", content: "New message." },
      ]) {
        transport.emitSessionUpdate(session.sessionId, update);
      }
      const visibleThoughts = backendId === "acp:gemini" || backendId === "acp:kimi";
      const expected = [
        ...(visibleThoughts ? [
          ["assistant:turn-1:0", "Before."],
          ["assistant:turn-1:1", "Considering."],
          ["assistant:turn-1:2", "After."],
        ] : [["assistant:turn-1:0", "Before.After."]]),
        ["provider-1", "Explicit continuation."],
        ["provider-2", "New message."],
      ];
      expect([...liveMessages]).toEqual(expected);
      expect(client.readReplay(session.sessionId).messages
        .filter((message) => message.role === "assistant")
        .map(({ id, text }) => [id, text])).toEqual(expected);
      promptResponse.resolve({});
      await client.dispose();
    },
  );

  it("distinguishes known tool progress from standalone tool updates", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const assistantMessageItemIds: Array<string | undefined> = [];
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ assistantMessageItemId, update }) => {
        if (update.sessionUpdate === "agent_message_chunk") {
          assistantMessageItemIds.push(assistantMessageItemId);
        }
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Inspect this",
      turnId: "turn-1",
    });
    transport.emitVendorNotification({
      method: "_x.ai/session_notification",
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "background-tool",
        title: "Background check",
        status: "in_progress",
      },
    });
    transport.emitVendorNotification({
      method: "_x.ai/session_notification",
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: "Before ",
      },
    });
    for (const sessionUpdate of [
      "tool_call_delta_chunk",
      "pending_interaction",
      "interaction_resolved",
    ]) {
      transport.emitVendorNotification({
        method: "_x.ai/session_notification",
        sessionId: session.sessionId,
        update: { sessionUpdate },
      });
    }
    transport.emitVendorNotification({
      method: "_x.ai/session_notification",
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "background-tool",
        title: "Background check",
        status: "completed",
      },
    });
    transport.emitVendorNotification({
      method: "_x.ai/session_notification",
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: "after",
      },
    });
    transport.emitVendorNotification({
      method: "_x.ai/session_notification",
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "standalone-tool",
        title: "Standalone check",
        status: "completed",
      },
    });
    transport.emitVendorNotification({
      method: "_x.ai/session_notification",
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: "Later",
      },
    });

    expect(assistantMessageItemIds).toEqual([
      "assistant:turn-1:0",
      "assistant:turn-1:0",
      "assistant:turn-1:1",
    ]);
    expect(
      client
        .readReplay(session.sessionId)
        .entries.filter((entry) => entry.type === "message"),
    ).toEqual([
      expect.objectContaining({
        type: "message",
        role: "user",
        text: "Inspect this",
      }),
      expect.objectContaining({
        type: "message",
        role: "assistant",
        text: "Before after",
      }),
      expect.objectContaining({
        type: "message",
        role: "assistant",
        text: "Later",
      }),
    ]);

    promptResponse.resolve({ turnId: "turn-1" });
    await vi.waitFor(() => {
      expect(client.readReplay(session.sessionId).threadStatus).toBe("idle");
    });
  });

  it("keeps a tracked Grok turn active until session/prompt resolves", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const statuses: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ replay }) => {
        statuses.push(replay.threadStatus ?? "unknown");
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Inspect this",
      turnId: "turn-1",
    });
    transport.emitVendorNotification({
      method: "_x.ai/session_notification",
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "turn-1",
        stop_reason: "end_turn",
      },
    });

    expect(client.readReplay(session.sessionId).threadStatus).toBe("active");
    expect(statuses.at(-1)).toBe("active");
    expect(() =>
      client.startPrompt({
        sessionId: session.sessionId,
        prompt: "Second turn",
        turnId: "turn-2",
      }),
    ).toThrow("A turn is already active for this ACP session.");

    promptResponse.resolve({ turnId: "turn-1" });
    await vi.waitFor(() => {
      expect(client.readReplay(session.sessionId).threadStatus).toBe("idle");
    });
  });

  it("reports a Kimi turn that resolves without an assistant response", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      initialize: {
        protocolVersion: 1,
        agentInfo: {
          name: "Kimi Code CLI",
          version: "1.46.0",
        },
      },
      "session/prompt": promptResponse.promise,
    });
    const errors: Array<{ sessionId: string; turnId: string; error: unknown }> = [];
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      agentDisplayName: "Kimi Code CLI",
      store,
      transport,
      now: () => 1000,
      onPromptError: (event) => {
        errors.push(event);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Inspect this",
      turnId: "turn-1",
    });
    promptResponse.resolve({ stopReason: "end_turn" });

    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    const errorMessage =
      "Kimi Code CLI ended the turn without a response. Kimi Code CLI 1.46.0 may be out of date or incompatible with the selected model. Update Kimi, refresh the model catalog, and try again.";
    expect((errors[0]!.error as Error).message).toBe(errorMessage);
    expect(store.getSession("acp:kimi", session.sessionId)).toMatchObject({
      lastError: errorMessage,
      status: "idle",
    });
    expect(client.readReplay(session.sessionId).entries).toEqual([
      expect.objectContaining({
        type: "message",
        role: "user",
        text: "Inspect this",
        turn: expect.objectContaining({ status: "failed" }),
      }),
      expect.objectContaining({
        type: "activity",
        summary: "Turn failed",
        status: "failed",
        details: [
          expect.objectContaining({
            label: errorMessage,
            status: "failed",
          }),
        ],
      }),
    ]);
  });

  it("accepts a cancelled fire-and-forget prompt without assistant output", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const errors: unknown[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      store,
      transport,
      now: () => 1000,
      onPromptError: ({ error }) => {
        errors.push(error);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Inspect this",
      turnId: "turn-1",
    });
    promptResponse.resolve({ stopReason: "cancelled" });

    await vi.waitFor(() => {
      expect(store.getSession("acp:kimi", session.sessionId)?.status).toBe(
        "idle",
      );
    });
    expect(errors).toEqual([]);
    expect(
      store.getSession("acp:kimi", session.sessionId)?.lastError,
    ).toBeUndefined();
    expect(
      client.readReplay(session.sessionId).entries.some(
        (entry) => entry.type === "activity" && entry.summary === "Turn failed",
      ),
    ).toBe(false);
  });

  it("accepts a cancelled awaited prompt without assistant output", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    const promptPromise = client.prompt({
      sessionId: session.sessionId,
      prompt: "Inspect this",
    });
    promptResponse.resolve({ stopReason: "cancelled" });

    await expect(promptPromise).resolves.toEqual({
      sessionId: session.sessionId,
      turnId: `pending:${session.sessionId}:1000`,
    });
    expect(store.getSession("acp:kimi", session.sessionId)).toMatchObject({
      status: "idle",
    });
    expect(
      store.getSession("acp:kimi", session.sessionId)?.lastError,
    ).toBeUndefined();
  });

  it("accepts an ACP response delivered only by a terminal update", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const errors: unknown[] = [];
    const settlement = createAcpPromptSettlement();
    const earlyTerminalUpdate = createDeferred<void>();
    const client = new AcpAgentClient({
      backendId: "acp:test-agent",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate(event) {
        settlement.callbacks.onSessionUpdate?.(event);
        if (event.update.kind === "turn_finished" && event.replay.threadStatus === "active") {
          earlyTerminalUpdate.resolve();
        }
      },
      onPromptError(event) {
        errors.push(event.error);
        settlement.callbacks.onPromptError?.(event);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    let settled = false;
    const finished = settlement.finish(client, {
      sessionId: session.sessionId,
      prompt: "Inspect this",
    }).then(() => { settled = true; });
    try {
      const terminal = Promise.race([earlyTerminalUpdate.promise, finished]);
      transport.emitSessionUpdate(session.sessionId, {
        kind: "turn_finished",
        outputText: "Finished from the terminal update.",
      });
      await terminal;
      await new Promise((resolve) => setImmediate(resolve));
      expect(client.hasActiveTurns()).toBe(true);
      expect(settled).toBe(false);
      promptResponse.resolve({ stopReason: "end_turn" });
      await finished;
      expect(store.getSession("acp:test-agent", session.sessionId)?.status).toBe("idle");
      expect(errors).toEqual([]);
      expect(client.readReplay(session.sessionId).threadStatus).toBe("idle");
    } finally {
      promptResponse.resolve({ stopReason: "end_turn" });
      await client.dispose();
    }
  });

  it("fails a turn when a terminal update is not followed by a prompt response", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const errors: unknown[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      agentDisplayName: "Grok Build",
      store,
      transport,
      now: () => 1000,
      onPromptError: ({ error }) => {
        errors.push(error);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Are you there?",
      turnId: "turn-1",
    });
    transport.emitSessionUpdate(session.sessionId, {
      kind: "turn_finished",
    });

    expect(client.readReplay(session.sessionId).threadStatus).toBe("active");
    expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain(
      "Grok Build reported that the turn ended, but its ACP prompt request did not close",
    );
    // The agent never answered the prompt, so it is told to stop before
    // PwrAgent forgets the turn.
    expect(transport.notifications).toEqual([
      { method: "session/cancel", params: { sessionId: session.sessionId } },
    ]);
    expect(store.getSession("acp:grok", session.sessionId)).toMatchObject({
      status: "idle",
      lastError: expect.stringContaining("provider connection may be unavailable"),
    });
    expect(
      client.readReplay(session.sessionId).entries,
    ).toContainEqual(expect.objectContaining({
      type: "activity",
      summary: "Turn failed",
    }));
  });

  it("keeps a working turn open for hours, so Stop can still cancel it", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const transport = new DeadlineEnforcingAcpTransport();
    const errors: unknown[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      agentDisplayName: "Grok Build",
      store,
      transport,
      now: () => 1000,
      onPromptError: ({ error }) => {
        errors.push(error);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Research the winning kernels",
      turnId: "turn-1",
    });
    // A Grok research turn has run for more than three and a half hours,
    // streaming the whole time.
    for (let hour = 1; hour <= 4; hour += 1) {
      transport.emitSessionUpdate(session.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Hour ${hour}. ` },
      });
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    }

    expect(errors).toEqual([]);
    expect(store.getSession("acp:grok", session.sessionId)?.status).toBe("active");
    expect(client.readReplay(session.sessionId).threadStatus).toBe("active");

    await client.cancelSession(session.sessionId);
    expect(transport.notifications).toEqual([
      { method: "session/cancel", params: { sessionId: session.sessionId } },
    ]);
    transport.settlePrompt({ stopReason: "cancelled" });
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toEqual([]);
    expect(store.getSession("acp:grok", session.sessionId)?.status).toBe("idle");
  });

  it("tells the agent to stop when its prompt request times out", async () => {
    const transport = new FakeAcpAgentTransport();
    const errors: unknown[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      store,
      transport: {
        request: async (method, params, timeoutMs) => {
          if (method === "session/prompt") {
            throw new Error("json-rpc timeout: session/prompt");
          }
          return await transport.request(method, params, timeoutMs);
        },
        notify: (method, params) => transport.notify(method, params),
        onNotification: (listener) => transport.onNotification(listener),
      },
      now: () => 1000,
      onPromptError: ({ error }) => {
        errors.push(error);
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "keep going",
      turnId: "turn-1",
    });

    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    expect(transport.notifications).toEqual([
      { method: "session/cancel", params: { sessionId: session.sessionId } },
    ]);
    expect(store.getSession("acp:grok", session.sessionId)?.status).toBe("idle");
  });

  it("reports fire-and-forget prompt failures", async () => {
    const transport = new FakeAcpAgentTransport();
    const quotaError =
      "json-rpc error (500): You have exhausted your capacity on this model. Your quota will reset after 22h38m3s.";
    const errors: Array<{ sessionId: string; turnId: string; error: unknown }> = [];
    const sessionUpdateKinds: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:codex-acp",
      store,
      transport: {
        request: async (method, params) => {
          if (method === "session/prompt") {
            throw new Error(quotaError);
          }
          return transport.request(method, params);
        },
        notify: (method, params) => transport.notify(method, params),
        onNotification: (listener) => transport.onNotification(listener),
      },
      now: () => 1000,
      onPromptError: (event) => {
        errors.push(event);
      },
      onSessionUpdate: ({ update }) => {
        const record =
          update && typeof update === "object" && !Array.isArray(update)
            ? (update as Record<string, unknown>)
            : undefined;
        if (typeof record?.kind === "string") {
          sessionUpdateKinds.push(record.kind);
        }
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    const prompt = client.startPrompt({
      sessionId: session.sessionId,
      prompt: "keep going",
      turnId: "pending:session-1",
    });

    await expect(prompt).resolves.toEqual({
      sessionId: "session-1",
      turnId: "pending:session-1",
    });
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    expect(errors[0]).toMatchObject({
      sessionId: "session-1",
      turnId: "pending:session-1",
    });
    expect(errors[0]?.error).toBeInstanceOf(Error);
    expect((errors[0]!.error as Error).message).toBe(quotaError);
    // The agent answered the prompt with an error, so it has nothing to cancel.
    expect(transport.notifications).toEqual([]);
    expect(sessionUpdateKinds).not.toContain("turn_finished");
    expect(store.getSession("acp:codex-acp", "session-1")).toMatchObject({
      hasConversationHistory: true,
      lastError: quotaError,
      status: "idle",
    });
    expect(
      readRawAcpSessionPayload("acp:codex-acp", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
    const expectedEntries = [
      expect.objectContaining({
        type: "message",
        role: "user",
        text: "keep going",
      }),
      expect.objectContaining({
        type: "activity",
        summary: "Turn failed",
        tone: "warning",
        status: "failed",
        details: [
          expect.objectContaining({
            label: quotaError,
            status: "failed",
          }),
        ],
      }),
    ];
    expect(client.readReplay("session-1").entries).toEqual(expectedEntries);

    const reloadedClient = new AcpAgentClient({
      backendId: "acp:codex-acp",
      store,
      transport,
      now: () => 1000,
    });
    expect(reloadedClient.readReplay("session-1").entries).toEqual([]);
  });

  it("refreshes stored session metadata without ingesting returned session/load payloads", async () => {
    const transport = new FakeAcpAgentTransport();
    const loadRequests: Array<Record<string, unknown> | undefined> = [];
    const client = new AcpAgentClient({
      backendId: "acp:codex-acp",
      store,
      transport: {
        request: async (method, params) => {
          if (method === "session/load") {
            loadRequests.push(params);
            return {
              updates: [
                {
                  kind: "agent_message_chunk",
                  content: "Restored transcript",
                },
              ],
            };
          }
          return await transport.request(method, params);
        },
        notify: (method, params) => transport.notify(method, params),
        close: () => transport.close(),
        onNotification: (listener) => transport.onNotification(listener),
      },
      now: () => 1000,
    });

    await client.initialize();
    const replay = await client.loadSession({
      backendId: "acp:codex-acp",
      sessionId: "session-1",
      title: "Stored ACP session",
      cwd: "/repo",
      createdAt: 900,
      updatedAt: 950,
      executionMode: "full-access",
      status: "idle",
    });
    await client.refreshSession(
      store.getSession("acp:codex-acp", "session-1")!,
    );
    await client.dispose();

    expect(replay.lastAssistantMessage).toBeUndefined();
    expect(store.getSession("acp:codex-acp", "session-1")).toMatchObject({
      title: "Stored ACP session",
      cwd: "/repo",
      executionMode: "full-access",
    });
    expect(loadRequests).toEqual([
      {
        cwd: "/repo",
        mcpServers: [],
        sessionId: "session-1",
      },
    ]);
    expect(transport.closeCount).toBe(1);
  });

  it("applies ACP updates replayed during provider session/load refresh", async () => {
    let notificationListener:
      | ((method: string, params: Record<string, unknown>) => void)
      | undefined;
    const titleUpdates: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport: {
        request: async (method) => {
          if (method === "initialize") {
            return { protocolVersion: 1 };
          }
          if (method === "session/load") {
            notificationListener?.("session/update", {
              sessionId: "session-1",
              update: {
                kind: "current_mode_update",
                currentModeId: "yolo",
              },
            });
            notificationListener?.("session/update", {
              sessionId: "session-1",
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "update_topic_1",
                kind: "think",
                title: 'Update topic to: "Loaded Project Research"',
                status: "completed",
              },
            });
            notificationListener?.("session/update", {
              sessionId: "session-1",
              update: {
                kind: "agent_message_chunk",
                content: "Loaded replay response",
              },
            });
            return {};
          }
          return {};
        },
        notify: async () => undefined,
        close: async () => undefined,
        onNotification: (listener) => {
          notificationListener = listener;
          return () => {
            if (notificationListener === listener) {
              notificationListener = undefined;
            }
          };
        },
      },
      now: () => 1000,
      onSessionUpdate: ({ title }) => {
        if (title) {
          titleUpdates.push(title);
        }
      },
    });

    await client.initialize();
    const replay = await client.loadSession({
      backendId: "acp:gemini",
      sessionId: "session-1",
      title: "Untitled thread",
      cwd: "/repo",
      createdAt: 900,
      updatedAt: 950,
      executionMode: "default",
      status: "idle",
    });
    await client.refreshSession(store.getSession("acp:gemini", "session-1")!);

    expect(replay.lastAssistantMessage).toBe("Loaded replay response");
    expect(store.getSession("acp:gemini", "session-1")?.title).toBe(
      "Loaded Project Research",
    );
    expect(store.getSession("acp:gemini", "session-1")).toMatchObject({
      acpRuntime: {
        currentModeId: "yolo",
      },
      hasConversationHistory: true,
      updatedAt: 950,
    });
    expect(
      readRawAcpSessionPayload("acp:gemini", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
    expect(titleUpdates).toEqual(["Loaded Project Research"]);
  });

  it("reloads stored sessions at a changed cwd before prompting", async () => {
    const transport = new FakeAcpAgentTransport();
    const updateEvents: string[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:gemini",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ update }) => {
        updateEvents.push(String(update.sessionUpdate ?? update.kind));
      },
    });

    await client.initialize();
    store.upsertSession({
      backendId: "acp:gemini",
      sessionId: "session-1",
      title: "Untitled thread",
      cwd: "/repo/worktree",
      createdAt: 900,
      updatedAt: 950,
      executionMode: "default",
      status: "idle",
      hasConversationHistory: true,
    });
    const ensurePromise = client.ensureSession(
      store.getSession("acp:gemini", "session-1")!,
    );
    transport.emitSessionUpdate("session-1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Replayed from load." },
    });
    await ensurePromise;
    transport.emitSessionUpdate("session-1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Late replay from load." },
    });
    client.startPrompt({
      sessionId: "session-1",
      prompt: "What is the CWD?",
      turnId: "pending:session-1:1000",
    });

    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/load",
      "session/prompt",
    ]);
    expect(transport.requests[1]?.params).toEqual({
      cwd: "/repo/worktree",
      mcpServers: [],
      sessionId: "session-1",
    });
    expect(updateEvents).toEqual([
      "agent_message_chunk",
      "agent_message_chunk",
    ]);
    expect(client.readReplay("session-1").lastAssistantMessage).toBe(
      "Replayed from load.Late replay from load.",
    );
  });

  it("does not write streaming transcript updates into ACP session metadata", async () => {
    const promptResponse = createDeferred<unknown>();
    const transport = new FakeAcpAgentTransport({
      "session/prompt": promptResponse.promise,
    });
    const upsertSession = vi.spyOn(store, "upsertSession");
    const client = new AcpAgentClient({
      backendId: "acp:kimi",
      store,
      transport,
      now: () => 1000,
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    const upsertCountAfterStart = upsertSession.mock.calls.length;
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "hello",
      turnId: "turn-1",
    });
    const upsertCountAfterPrompt = upsertSession.mock.calls.length;

    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hel" },
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "lo" },
    });

    expect(upsertSession.mock.calls.length).toBe(upsertCountAfterPrompt);
    expect(store.getSession("acp:kimi", session.sessionId)).toMatchObject({
      hasConversationHistory: true,
    });
    expect(
      readRawAcpSessionPayload("acp:kimi", session.sessionId)?.transcriptUpdates,
    ).toBeUndefined();
    expect(client.readReplay(session.sessionId).lastAssistantMessage).toBe("Hello");
    expect(upsertCountAfterStart).toBeGreaterThan(0);

    promptResponse.resolve({ turnId: "turn-1" });
    await Promise.resolve();
    await client.dispose();
  });

  it("preserves a visible assistant stream across hidden ACP thought chunks", async () => {
    const assistantMessageItemIds: Array<string | undefined> = [];
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:qwen",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ assistantMessageItemId, update }) => {
        if (
          (update.sessionUpdate ?? update.session_update ?? update.kind) ===
          "agent_message_chunk"
        ) {
          assistantMessageItemIds.push(assistantMessageItemId);
        }
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "hello",
      turnId: "turn-1",
    });

    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Visible " },
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "hidden reasoning" },
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "answer." },
    });

    expect(assistantMessageItemIds).toEqual([
      "assistant:turn-1:0",
      "assistant:turn-1:0",
    ]);
    expect(client.readReplay(session.sessionId).lastAssistantMessage).toBe(
      "Visible answer.",
    );
    expect(
      client
        .readReplay(session.sessionId)
        .entries.some(
          (entry) =>
            entry.type === "message" && entry.text.includes("hidden reasoning"),
        ),
    ).toBe(false);
  });

  it("does not allocate a live assistant item for whitespace after a tool", async () => {
    const assistantMessageItemIds: Array<string | undefined> = [];
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:grok",
      store,
      transport,
      now: () => 1000,
      onSessionUpdate: ({ assistantMessageItemId, update }) => {
        if (update.sessionUpdate === "agent_message_chunk") {
          assistantMessageItemIds.push(assistantMessageItemId);
        }
      },
    });

    await client.initialize();
    const session = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    client.startPrompt({
      sessionId: session.sessionId,
      prompt: "Inspect this",
      turnId: "turn-1",
    });

    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Before the tool." },
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "read-1",
      kind: "read",
      title: "Read `README.md`",
      status: "completed",
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "\n" },
    });
    transport.emitSessionUpdate(session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "After the tool." },
    });

    expect(assistantMessageItemIds).toEqual([
      "assistant:turn-1:0",
      undefined,
      "assistant:turn-1:1",
    ]);
    expect(
      client
        .readReplay(session.sessionId)
        .messages.filter((message) => message.role === "assistant"),
    ).toEqual([
      expect.objectContaining({ role: "assistant", text: "Before the tool." }),
      expect.objectContaining({ role: "assistant", text: "After the tool." }),
    ]);
  });

  it("strips legacy transcript updates when upserting stored sessions", () => {
    store.upsertSession({
      backendId: "acp:kimi",
      sessionId: "session-1",
      title: "Untitled thread",
      cwd: "/repo",
      createdAt: 900,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
      transcriptUpdates: [
        {
          receivedAt: 950,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Thinking " },
          },
        },
        {
          receivedAt: 975,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "hard." },
          },
        },
        {
          receivedAt: 1000,
          update: {
            sessionUpdate: "turn_finished",
          },
        },
      ],
    } as Parameters<AcpSessionStore["upsertSession"]>[0] & {
      transcriptUpdates: unknown[];
    });

    expect(store.getSession("acp:kimi", "session-1")).not.toHaveProperty(
      "transcriptUpdates",
    );
    expect(
      readRawAcpSessionPayload("acp:kimi", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
  });

  it("derives conversation metadata while stripping legacy transcript updates", () => {
    store.upsertSession({
      backendId: "acp:kimi",
      sessionId: "session-1",
      title: "Untitled thread",
      cwd: "/repo",
      createdAt: 900,
      updatedAt: 1000,
      executionMode: "default",
      status: "idle",
      transcriptUpdates: [
        {
          receivedAt: 950,
          update: {
            kind: "pwragent_user_prompt",
            prompt: "hello",
          },
        },
      ],
    } as Parameters<AcpSessionStore["upsertSession"]>[0] & {
      transcriptUpdates: unknown[];
    });

    expect(store.getSession("acp:kimi", "session-1")).toMatchObject({
      hasConversationHistory: true,
    });
    expect(
      readRawAcpSessionPayload("acp:kimi", "session-1")?.transcriptUpdates,
    ).toBeUndefined();
  });

  it("defaults new sessions to 'Untitled thread' and lets a provider topic update replace a prompt placeholder once", async () => {
    const transport = new FakeAcpAgentTransport();
    const client = new AcpAgentClient({
      backendId: "acp:antigravity",
      store,
      transport,
      now: () => 2000,
    });
    await client.initialize();

    const unnamed = await client.startSession({
      cwd: "/repo",
      executionMode: "default",
    });
    expect(unnamed).toMatchObject({
      title: "Untitled thread",
      titleSource: "fallback",
    });
    expect(unnamed.promptPlaceholderTitle).toBeUndefined();

    const seeded = await client.startSession({
      sessionId: "session-placeholder",
      cwd: "/repo",
      executionMode: "default",
      title: "Investigate flaky auth retry",
      titleSource: "derived",
      promptPlaceholderTitle: true,
    });
    expect(seeded).toMatchObject({
      title: "Investigate flaky auth retry",
      titleSource: "derived",
      promptPlaceholderTitle: true,
    });

    transport.emitSessionUpdate(seeded.agentSessionId ?? seeded.sessionId, {
      sessionUpdate: "session_info_update",
      title: "Auth Retry Fix",
    });
    expect(store.getSession("acp:antigravity", seeded.sessionId)).toMatchObject({
      title: "Auth Retry Fix",
      titleSource: "derived",
    });
    expect(
      store.getSession("acp:antigravity", seeded.sessionId)?.promptPlaceholderTitle,
    ).toBeUndefined();

    // A later topic update must not overwrite the durable provider title.
    transport.emitSessionUpdate(seeded.agentSessionId ?? seeded.sessionId, {
      sessionUpdate: "session_info_update",
      title: "Stale Late Title",
    });
    expect(store.getSession("acp:antigravity", seeded.sessionId)).toMatchObject({
      title: "Auth Retry Fix",
      titleSource: "derived",
    });
  });
});
