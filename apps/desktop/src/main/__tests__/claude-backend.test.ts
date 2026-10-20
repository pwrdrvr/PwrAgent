import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options, Query, SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@pwragent/shared";
import { ClaudeBackend } from "../claude/claude-backend";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { createClaudePermissionHandler, claudePermissionMode } from "../claude/claude-permissions";
import { buildLiveToolDetails, getNotificationItem } from "../../renderer/src/features/thread-detail/live-transcript-activity";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(messages?: (options: Options) => AsyncGenerator<SDKMessage>, controls: Partial<Query> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-"));
  roots.push(root);
  const store = new ClaudeSessionStore(root);
  const events: AgentEvent[] = [];
  const queries: Options[] = [];
  const close = vi.fn();
  const run = vi.fn((args: Parameters<typeof query>[0]) => {
    const options = args.options!;
    queries.push(options);
    async function* normal(): AsyncGenerator<SDKMessage> {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "stream_event", parent_tool_use_id: null, event: {
        type: "message_start", message: { id: "answer" },
      } } as SDKMessage;
      yield { type: "stream_event", parent_tool_use_id: null, event: {
        type: "content_block_delta", delta: { type: "text_delta", text: "Hello" },
      } } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "answer", content: [{ type: "text", text: "Hello world" }],
      } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "Hello world" } as SDKMessage;
    }
    return Object.assign(messages ? messages(options) : normal(), {
      close, setPermissionMode: vi.fn().mockResolvedValue(undefined), ...controls,
    }) as unknown as Query;
  });
  const backendOptions = {
    store,
    query: run,
    inspectInstallation: vi.fn(async (_options?: Parameters<typeof import("../claude/claude-executable").inspectClaudeInstallation>[0]) => ({
      executable: "/fixture/claude", authStatus: "signed-in" as const,
    })),
    emit: async (event: AgentEvent) => { events.push(event); },
    request: async () => ({ decision: "accept" }),
    cancelRequest: async () => {},
    resolveEnv: async () => ({ PATH: "/fixture", ANTHROPIC_API_KEY: "must-not-reach-child", CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-child" }),
  };
  const backend = new ClaudeBackend(backendOptions);
  async function waitForTurn() {
    await vi.waitFor(() => expect(events.some((event) => ["turn/completed", "turn/failed", "turn/cancelled"].includes(event.notification.method))).toBe(true));
  }
  return { backend, backendOptions, store, events, queries, run, close, waitForTurn, root };
}

describe("Claude SDK backend", () => {
  it("streams steering without losing a follow-up at the native result boundary", async () => {
    const firstResult = Promise.withResolvers<void>();
    const firstProcessed = Promise.withResolvers<void>();
    const lastResult = Promise.withResolvers<void>();
    let steerUuid: string | undefined;
    const model = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      costUSD: 0.1, contextWindow: 200_000, maxOutputTokens: 32_000, webSearchRequests: 0 };
    const f = await fixture(async function* () {
      await firstResult.promise;
      yield { type: "result", subtype: "success", is_error: false, modelUsage: { opus: model } } as unknown as SDKMessage;
      firstProcessed.resolve();
      await lastResult.promise;
      yield { type: "result", subtype: "success", is_error: false, user_message_uuids: [steerUuid],
        modelUsage: { opus: { ...model, inputTokens: 30, costUSD: 0.3 } },
      } as unknown as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    const started = await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Start" }] });
    const prompt = f.run.mock.calls[0][0].prompt;
    if (typeof prompt === "string") throw new Error("Expected streaming input");
    const iterator = prompt[Symbol.asyncIterator]();
    expect((await iterator.next()).value.message.content).toEqual([{ type: "text", text: "Start" }]);
    await expect(f.backend.steerTurn({ threadId, expectedTurnId: "stale", input: [] })).rejects.toThrow("expected active turn id");
    const steered = await f.backend.steerTurn({ threadId, expectedTurnId: started.turnId,
      input: [{ type: "text", text: "Focus on the PR" }, { type: "image", url: "data:image/png;base64,aGVsbG8=" }] });
    const streamed = (await iterator.next()).value;
    steerUuid = streamed.uuid;
    expect(streamed).toMatchObject({ type: "user", priority: "now", uuid: expect.any(String),
      message: { content: [{ type: "text", text: "Focus on the PR" }, { type: "image" }] } });
    expect(f.backend.summary().capabilities.steerTurn).toBe(true);
    firstResult.resolve();
    await firstProcessed.promise;
    expect(f.close).not.toHaveBeenCalled();
    expect(f.events.some((event) => event.notification.method === "turn/completed")).toBe(false);
    expect(f.events.some((event) => event.notification.method === "thread/tokenUsage/updated")).toBe(false);
    lastResult.resolve();
    await f.waitForTurn();
    expect(f.events.filter((event) => event.notification.method === "turn/completed")).toHaveLength(1);
    expect(f.events.find((event) => event.notification.method === "thread/tokenUsage/updated")?.notification)
      .toMatchObject({ params: { tokenUsage: { claudeCostUSD: 0.3, last: { inputTokens: 30, outputTokens: 5 } } } });
    expect((await f.backend.readThread(threadId)).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: steered.messageId, text: "Focus on the PR", parts: [
        { type: "text", text: "Focus on the PR" }, { type: "image", url: "data:image/png;base64,aGVsbG8=" },
      ], turn: expect.objectContaining({ id: started.turnId, status: "completed" }) }),
    ]));
    expect(await iterator.next()).toMatchObject({ done: true });
    await expect(f.backend.steerTurn({ threadId, expectedTurnId: started.turnId, input: [] })).rejects.toThrow("no active turn");
  });

  it.each([true, false])("handles a legacy resumed session with baseline probe available=%s", async (available) => {
    const model = { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 200, cacheCreationInputTokens: 50,
      costUSD: 0.25, contextWindow: 200_000, maxOutputTokens: 32_000, webSearchRequests: 0 };
    const probe = vi.fn(async () => {
      if (!available) throw new Error("Unsupported control");
      return { session: { model_usage: { opus: model } }, rate_limits_available: false, rate_limits: null };
    });
    const f = await fixture(async function* () {
      yield { type: "result", subtype: "success", is_error: false,
        modelUsage: { opus: { ...model, inputTokens: 120, costUSD: 0.30 } },
      } as unknown as SDKMessage;
    }, { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: probe as unknown as Query["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"] });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    const saved = await f.store.read(threadId);
    saved.sdkSessionId = threadId;
    await f.store.save(saved);
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Continue" }] });
    await f.waitForTurn();
    const event = f.events.find((event) => event.notification.method === "thread/tokenUsage/updated");
    if (available) {
      expect(event?.notification).toMatchObject({ params: { tokenUsage: { last: { totalTokens: 20 }, claudeCostUSD: expect.closeTo(0.05) } } });
    } else expect(event).toBeUndefined();
    expect((await f.store.read(threadId)).modelUsage?.opus.costUSD).toBe(0.30);
  });

  it("retains streamed limits when the optional usage probe returns no windows", async () => {
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "seven_day", utilization: 0.35 } } as SDKMessage;
      yield { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.10 } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
    }, { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn().mockResolvedValue({ rate_limits_available: true, rate_limits: null }) });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
    await f.waitForTurn();
    expect(f.backend.summary().rateLimits).toEqual(expect.arrayContaining([
      expect.objectContaining({ limitId: "seven_day", usedPercent: 35 }),
      expect.objectContaining({ limitId: "five_hour", usedPercent: 10 }),
    ]));
  });

  it("records only new resumed usage, exposes Claude limits, and restores the context moon", async () => {
    let count = 0;
    const context = vi.fn().mockResolvedValue({ totalTokens: 1200, maxTokens: 200_000 });
    const usage = vi.fn().mockResolvedValue({ rate_limits_available: true, rate_limits: {
      seven_day: { utilization: 35, resets_at: "2026-10-27T00:00:00Z" },
    }, session: { model_usage: {} } });
    const f = await fixture(async function* () {
      count += 1;
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "Done",
        modelUsage: { "claude-opus-5-5": { inputTokens: count * 100, outputTokens: count * 20,
          cacheReadInputTokens: count * 200, cacheCreationInputTokens: count * 50,
          costUSD: count * 0.25, contextWindow: 200_000, maxOutputTokens: 32_000, webSearchRequests: 0 } },
      } as unknown as SDKMessage;
    }, { getContextUsage: context, usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "auto" });
    for (let turn = 0; turn < 2; turn += 1) {
      f.events.length = 0;
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
      await f.waitForTurn();
      expect(f.events.find((event) => event.notification.method === "thread/tokenUsage/updated")?.notification)
        .toMatchObject({ params: { tokenUsage: { last: { inputTokens: 350, totalTokens: 370 }, claudeCostUSD: 0.25 } } });
      expect(f.queries[turn].permissionMode).toBe("auto");
    }
    expect(context).toHaveBeenCalledWith({ detail: "summary" });
    expect(usage).toHaveBeenCalledWith({ skipBehaviors: true });
    expect(f.backend.summary().rateLimits?.[0]).toMatchObject({ usedPercent: 35, name: "Weekly limit" });
    const restarted = new ClaudeBackend(f.backendOptions);
    expect((await restarted.readThread(threadId)).contextWindow).toEqual({ usedTokens: 1200, modelContextWindow: 200_000 });
  });

  it("uses Claude's active query to inspect MCP inventory", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const mcpServerStatus = vi.fn().mockResolvedValue([{ name: "pwragent", status: "connected", tools: [{ name: "search_mcp_tools" }] }]);
    const f = await fixture(async function* () {
      await gate;
      yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
    }, { mcpServerStatus, setPermissionMode });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
    await f.backend.setExecutionMode(threadId, "auto");
    expect(setPermissionMode).toHaveBeenCalledWith("auto");
    setPermissionMode.mockRejectedValueOnce(new Error("Unsupported mode"));
    await expect(f.backend.setExecutionMode(threadId, "full-access")).rejects.toThrow("Unsupported mode");
    expect(await f.backend.executionMode(threadId)).toBe("auto");
    expect(await f.backend.listMcpServers(threadId)).toEqual([{ name: "pwragent", authStatus: "unsupported", startupStatus: "ready", tools: ["search_mcp_tools"] }]);
    finish();
    await f.waitForTurn();
    await expect(f.backend.listMcpServers(threadId)).rejects.toThrow("while a turn is running");
  });

  it("discovers the model catalog only on an explicit refresh and retains it when a later refresh fails", async () => {
    const f = await fixture();
    const models = [{ id: "fable", label: "Fable 5.1", current: true }];
    const discoverModels = vi.fn().mockResolvedValue(models);
    const backend = new ClaudeBackend({ ...f.backendOptions, discoverModels });
    await backend.startThread({ cwd: f.root, executionMode: "default" });
    expect(discoverModels).not.toHaveBeenCalled();
    await backend.discover();
    expect(discoverModels).toHaveBeenCalledWith({ executable: "/fixture/claude", env: { PATH: "/fixture" } });
    expect(backend.summary().launchpadOptions?.models).toEqual(models);
    discoverModels.mockRejectedValueOnce(new Error("Discovery failed"));
    await expect(backend.discover()).rejects.toThrow("Discovery failed");
    expect(backend.summary().launchpadOptions?.models).toEqual(models);
  });

  it.each(["max", "default"])("passes an explicit effort and preserves the CLI default (%s)", async (reasoningEffort) => {
    const f = await fixture();
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, model: "claude-opus-4-8", reasoningEffort, input: [{ type: "text", text: "Hi" }] });
    await f.waitForTurn();
    expect(f.queries[0].model).toBe("claude-opus-4-8");
    if (reasoningEffort === "default") expect(f.queries[0]).not.toHaveProperty("effort");
    else expect(f.queries[0].effort).toBe("max");
  });

  it.each([false, true])("renders completed tool output before the turn ends (is_error=%s)", async (isError) => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const f = await fixture(async function* () {
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "tool-message", content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "git status" } }],
      } } as SDKMessage;
      yield { type: "user", message: { content: [{
        type: "tool_result", tool_use_id: "tool-1", content: "fixture output", is_error: isError,
      }] } } as SDKMessage;
      await gate;
      yield { type: "result", subtype: "success", is_error: false, result: "Done" } as SDKMessage;
    });
    try {
      const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Run" }] });
      await vi.waitFor(() => expect(f.events.some((event) => event.notification.method === "item/completed"
        && getNotificationItem(event.notification.params)?.id === "tool-1")).toBe(true));
      const event = f.events.find((event) => event.notification.method === "item/completed"
        && getNotificationItem(event.notification.params)?.id === "tool-1")!;
      if (event.notification.method !== "item/completed") throw new Error("Expected tool completion");
      expect(buildLiveToolDetails(getNotificationItem(event.notification.params)!)).toEqual([expect.objectContaining({
        status: isError ? "failed" : "completed", command: expect.objectContaining({ output: "fixture output" }),
      })]);
      expect(f.events.some((event) => event.notification.method === "turn/completed")).toBe(false);
      expect((await f.backend.readThread(threadId)).entries).toEqual(expect.arrayContaining([expect.objectContaining({
        id: "tool-1", status: isError ? "failed" : "completed",
        details: [expect.objectContaining({ markdown: "fixture output" })],
      })]));
    } finally {
      finish();
      await f.waitForTurn();
      await f.backend.close();
    }
  });

  it("preserves local images, inline images and named files in live and restarted replay", async () => {
    const f = await fixture();
    const imagePath = path.join(f.root, "image.png");
    await writeFile(imagePath, Buffer.from("fixture image"));
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [
      { type: "text", text: "Read these" },
      { type: "localImage", path: imagePath, name: "local.png" },
      { type: "image", url: "data:image/png;base64,aW1hZ2U=", name: "inline.png" },
      { type: "localFile", path: path.join(f.root, "report.txt"), name: "Report.txt", mimeType: "text/plain", sizeBytes: 12, textPreview: "Hello report" },
    ] });
    await f.waitForTurn();
    const restarted = new ClaudeBackend({ ...f.backendOptions, store: new ClaudeSessionStore(f.root) });
    const replay = await restarted.readThread(threadId);
    const parts = [
      { type: "text", text: "Read these" },
      { type: "image", url: expect.stringMatching(/^pwragent-image:/), alt: "local.png" },
      { type: "image", url: "data:image/png;base64,aW1hZ2U=", alt: "inline.png" },
      { type: "file", name: "Report.txt", mimeType: "text/plain", sizeBytes: 12 },
    ];
    expect(replay.messages[0]).toMatchObject({ text: "Read these", parts });
    expect(replay.entries[0]).toMatchObject({ text: "Read these", parts });
    expect(f.events).toEqual(expect.arrayContaining([expect.objectContaining({ notification: expect.objectContaining({
      method: "item/completed", params: expect.objectContaining({ item: expect.objectContaining({ type: "userMessage", content: parts }) }),
    }) })]));
  });

  it("uses the local harness, streams without duplicate messages, and resumes after restart", async () => {
    const f = await fixture();
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }], instructions: "PwrAgent instructions" });
    await f.waitForTurn();
    expect(f.queries[0]).toMatchObject({
      pathToClaudeCodeExecutable: "/fixture/claude",
      sessionId: threadId,
      systemPrompt: { type: "preset", preset: "claude_code", append: "PwrAgent instructions" },
      settingSources: ["user", "project", "local"],
      permissionMode: "default",
      includePartialMessages: true,
    });
    expect(f.queries[0].env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(f.queries[0].env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(f.backendOptions.inspectInstallation).toHaveBeenCalledWith({ env: f.queries[0].env });
    expect(f.queries[0].env?.PATH).toBe("/fixture");
    expect(f.queries[0]).not.toHaveProperty("bare");
    expect(f.events.some((event) => event.notification.method === "item/agentMessage/delta")).toBe(true);
    const replay = await f.backend.readThread(threadId);
    expect(replay.messages.map((message) => message.text)).toEqual(["Hi", "Hello world"]);
    expect((await f.store.read(threadId)).sdkSessionId).toBe("5a85c1ad-85c1-4930-ae19-50f721ad13dd");
    f.events.length = 0;
    const restarted = new ClaudeBackend(f.backendOptions);
    await restarted.startTurn({ threadId, input: [{ type: "text", text: "Continue" }] });
    await f.waitForTurn();
    expect(f.queries[1].resume).toBe("5a85c1ad-85c1-4930-ae19-50f721ad13dd");
    expect(f.queries[1]).not.toHaveProperty("sessionId");
    expect(f.close).toHaveBeenCalledTimes(2);
  });

  it("does not start a query when no usable binary exists or the selected CLI is logged out", async () => {
    const f = await fixture();
    for (const installation of [
      { authStatus: "unknown" as const },
      { executable: "/fixture/claude", authStatus: "sign-in-required" as const, message: "Run claude auth login" },
    ]) {
      const backend = new ClaudeBackend({ ...f.backendOptions, inspectInstallation: async () => installation });
      await expect(backend.startThread({ cwd: f.root, executionMode: "default" })).rejects.toThrow(/claude auth login/);
    }
    expect(f.run).not.toHaveBeenCalled();
    expect(await f.store.list()).toEqual([]);
  });

  it.each(["error_during_execution", "success"] as const)("fails the turn on an SDK %s error result and preserves replay", async (subtype) => {
    const f = await fixture(async function* () {
      yield subtype === "success"
        ? { type: "result", subtype: "success", is_error: true, result: "Sign in with claude auth login" } as SDKMessage
        : { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Sign in with claude auth login"] } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hello" }] });
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification).toMatchObject({ method: "turn/failed", params: { turn: { error: { message: "Sign in with claude auth login" } } } });
    expect((await f.backend.readThread(threadId)).messages[0].text).toBe("Hello");
  });

  it("aborts a running query and rejects a stale interrupt", async () => {
    const f = await fixture(async function* (options) {
      yield { type: "system", subtype: "init", session_id: options.sessionId } as SDKMessage;
      await new Promise<void>((resolve) => {
        options.abortController!.signal.addEventListener("abort", () => resolve(), { once: true });
        if (options.abortController!.signal.aborted) resolve();
      });
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    const turn = await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hello" }] });
    await expect(f.backend.interruptTurn({ threadId, turnId: "stale" })).rejects.toThrow("changed");
    const prompt = f.run.mock.calls[0][0].prompt;
    if (typeof prompt === "string") throw new Error("Expected streaming input");
    const input = prompt[Symbol.asyncIterator]();
    await input.next();
    await f.backend.steerTurn({ threadId, expectedTurnId: turn.turnId, input: [{ type: "text", text: "Correction" }] });
    await f.backend.interruptTurn(turn);
    expect(await input.next()).toMatchObject({ done: true });
    expect(f.events.at(-1)?.notification.method).toBe("turn/cancelled");
    expect((await f.backend.readThread(threadId)).threadStatus).toBe("idle");
  });

  it("fails rather than reporting success when the CLI exits before answering a steer", async () => {
    const finish = Promise.withResolvers<void>();
    const f = await fixture(async function* () {
      await finish.promise;
      yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    const turn = await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Start" }] });
    await f.backend.steerTurn({ threadId, expectedTurnId: turn.turnId, input: [{ type: "text", text: "Correction" }] });
    finish.resolve();
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification).toMatchObject({ method: "turn/failed", params: {
      turn: { error: { message: "Claude exited before completing the turn." } },
    } });
  });
});

describe("Claude permission bridge", () => {
  it("maps the existing execution modes onto SDK modes", () => {
    expect(["default", "auto", "full-access"].map((mode) => claudePermissionMode(mode as "default" | "auto" | "full-access")))
      .toEqual(["default", "auto", "bypassPermissions"]);
  });

  it.each([
    ["accept", "allow"], ["approve", "allow"], ["decline", "deny"], ["cancel", "deny"], ["unexpected", "deny"],
  ])("maps %s to %s without persisting permission rules", async (decision, behavior) => {
    const request = vi.fn().mockResolvedValue({ decision });
    const handler = createClaudePermissionHandler({ threadId: "thread", turnId: "turn", request, cancelRequest: async () => {} });
    const result = await handler("Bash", { command: "git status" }, { signal: new AbortController().signal, toolUseID: "tool", requestId: "sdk-request" });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: "item/commandExecution/requestApproval",
      params: expect.objectContaining({ command: "git status", threadId: "thread", turnId: "turn" }),
    }), expect.any(AbortSignal));
    expect(result?.behavior).toBe(behavior);
    expect(result).not.toHaveProperty("updatedPermissions");
  });

  it("settles and removes a pending approval on cancellation", async () => {
    const controller = new AbortController();
    const cancelRequest = vi.fn().mockResolvedValue(undefined);
    const handler = createClaudePermissionHandler({
      threadId: "thread", turnId: "turn", cancelRequest,
      request: async () => await new Promise(() => {}),
    });
    const result = handler("Write", { file_path: "/fixture/file" }, { signal: controller.signal, toolUseID: "tool", requestId: "sdk-request" });
    controller.abort();
    await expect(result).resolves.toMatchObject({ behavior: "deny", interrupt: true });
    expect(cancelRequest).toHaveBeenCalledOnce();
  });

  it("returns questionnaire answers in the SDK tool input", async () => {
    const handler = createClaudePermissionHandler({
      threadId: "thread", turnId: "turn", cancelRequest: async () => {},
      request: async () => ({ answers: { "0": { answers: ["Blue"] } } }),
    });
    await expect(handler("AskUserQuestion", { questions: [{ question: "Color?", header: "Color", options: [{ label: "Blue", description: "Blue" }] }] },
      { signal: new AbortController().signal, toolUseID: "question", requestId: "sdk-request" }))
      .resolves.toMatchObject({ behavior: "allow", updatedInput: { answers: { "Color?": "Blue" } } });
  });
});
