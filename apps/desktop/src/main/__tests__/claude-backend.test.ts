import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options, Query, SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, BackendModelOption } from "@pwragent/shared";
import { ClaudeBackend } from "../claude/claude-backend";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { createClaudePermissionHandler, claudePermissionMode } from "../claude/claude-permissions";
import { buildLiveToolDetails, getNotificationItem } from "../../renderer/src/features/thread-detail/live-transcript-activity";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(messages?: (options: Options) => AsyncGenerator<SDKMessage>, controls: Partial<Query> & {
  generateSessionTitle?: (description: string, options?: { persist?: boolean }) => Promise<string | null>;
} = {}) {
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
    getSessionInfo: vi.fn().mockResolvedValue(undefined),
    discoverModels: vi.fn().mockResolvedValue([]),
    inspectInstallation: vi.fn(async (_options?: Parameters<typeof import("../claude/claude-executable").inspectClaudeInstallation>[0]) => ({
      executable: "/fixture/claude", authStatus: "signed-in" as const,
    })),
    emit: async (event: AgentEvent) => { events.push(event); },
    request: async () => ({ decision: "accept" }),
    cancelRequest: async () => {},
    resolveEnv: async (): Promise<NodeJS.ProcessEnv> => ({ PATH: "/fixture", ANTHROPIC_API_KEY: "must-not-reach-child", CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-child" }),
  };
  const backend = new ClaudeBackend(backendOptions);
  async function waitForTurn() {
    await vi.waitFor(() => expect(events.some((event) => ["turn/completed", "turn/failed", "turn/cancelled"].includes(event.notification.method))).toBe(true));
  }
  return { backend, backendOptions, store, events, queries, run, close, waitForTurn, root };
}

describe("Claude SDK backend", () => {
  it("consumes a stored provider title without another title request", async () => {
    const generateSessionTitle = vi.fn().mockResolvedValue("Redundant title");
    const f = await fixture(undefined, { generateSessionTitle });
    f.backendOptions.getSessionInfo.mockResolvedValue({ customTitle: "Provider title", summary: "Raw prompt" });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate title behavior" }] });
    await f.waitForTurn();
    expect((await f.store.read(threadId)).thread).toMatchObject({ title: "Provider title", titleSource: "derived" });
    expect(f.backendOptions.getSessionInfo).toHaveBeenCalledWith("5a85c1ad-85c1-4930-ae19-50f721ad13dd", { dir: f.root });
    expect(generateSessionTitle).not.toHaveBeenCalled();
  });

  it("requests one native title across resumed turns and includes its usage", async () => {
    const generateSessionTitle = vi.fn().mockResolvedValue("  Fix\nClaude naming  ");
    const totals = { haiku: { inputTokens: 25, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      costUSD: 0.002, contextWindow: 200_000, maxOutputTokens: 32_000, webSearchRequests: 0 } };
    const f = await fixture(undefined, { generateSessionTitle,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn().mockResolvedValue({ session: { model_usage: totals } }),
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate title behavior" }] });
    await f.waitForTurn();
    expect((await f.store.read(threadId)).thread).toMatchObject({ title: "Fix Claude naming", titleSource: "derived" });
    expect(generateSessionTitle).toHaveBeenCalledWith("Investigate title behavior", { persist: true });
    expect(f.events.find((event) => event.notification.method === "thread/tokenUsage/updated")?.notification)
      .toMatchObject({ params: { tokenUsage: { claudeCostUSD: 0.002 } } });
    f.events.length = 0;
    const resumed = new ClaudeBackend(f.backendOptions);
    await resumed.startTurn({ threadId, input: [{ type: "text", text: "Follow up" }] });
    await f.waitForTurn();
    expect(generateSessionTitle).toHaveBeenCalledTimes(1);
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it("preserves an operator name and supplies it to a new native session", async () => {
    const generateSessionTitle = vi.fn().mockResolvedValue("Unwanted title");
    const f = await fixture(undefined, { generateSessionTitle });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.renameThread(threadId, "Operator name");
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate title behavior" }] });
    await f.waitForTurn();
    expect(f.queries[0].title).toBe("Operator name");
    expect((await f.store.read(threadId)).thread.title).toBe("Operator name");
    expect(generateSessionTitle).not.toHaveBeenCalled();
    expect(f.backendOptions.getSessionInfo).not.toHaveBeenCalled();
  });

  it("preserves an operator rename while a native title request is pending", async () => {
    const pending = Promise.withResolvers<string>();
    const generateSessionTitle = vi.fn(() => pending.promise);
    const f = await fixture(undefined, { generateSessionTitle });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate title behavior" }] });
    await vi.waitFor(() => expect(generateSessionTitle).toHaveBeenCalledOnce());
    await f.backend.renameThread(threadId, "Operator wins");
    pending.resolve("Generated title");
    await f.waitForTurn();
    expect((await f.store.read(threadId)).thread).toMatchObject({ title: "Operator wins", titleSource: "explicit" });
  });

  it("keeps a local fallback after a failed native title request without retrying", async () => {
    const generateSessionTitle = vi.fn().mockRejectedValue(new Error("usage limit"));
    const f = await fixture(undefined, { generateSessionTitle });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    for (let turn = 0; turn < 2; turn += 1) {
      f.events.length = 0;
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate title behavior" }] });
      await f.waitForTurn();
      expect(f.events.some((event) => event.notification.method === "turn/completed")).toBe(true);
    }
    expect((await f.store.read(threadId)).thread.title).toBe("Investigate title behavior");
    expect(generateSessionTitle).toHaveBeenCalledOnce();
  });

  it.each(["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_DISABLE_TERMINAL_TITLE"].flatMap((key) =>
    ["1", "true", "yes", "on", " true ", " ON "].map((value) => ({ key, value }))))(
    "respects $key=$value without making a native title request", async ({ key, value }) => {
      const generateSessionTitle = vi.fn().mockResolvedValue("Unwanted title");
      const f = await fixture(undefined, { generateSessionTitle });
      f.backendOptions.resolveEnv = async () => ({ PATH: "/fixture", [key]: value });
      const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate title behavior" }] });
      await f.waitForTurn();
      expect(generateSessionTitle).not.toHaveBeenCalled();
    },
  );

  it("keeps the prompt fallback when the SDK has no native title control", async () => {
    const f = await fixture();
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate title behavior" }] });
    await f.waitForTurn();
    expect((await f.store.read(threadId)).thread.title).toBe("Investigate title behavior");
    expect(f.run).toHaveBeenCalledOnce();
  });

  it("does not request a speculative title when provider metadata cannot be read", async () => {
    const generateSessionTitle = vi.fn().mockResolvedValue("Unwanted title");
    const f = await fixture(undefined, { generateSessionTitle });
    f.backendOptions.getSessionInfo.mockRejectedValue(new Error("unreadable session"));
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate title behavior" }] });
    await f.waitForTurn();
    expect(generateSessionTitle).not.toHaveBeenCalled();
    expect(f.events.some((event) => event.notification.method === "turn/completed")).toBe(true);
  });

  it("consumes a provider title arriving after a failed request without spending again", async () => {
    const generateSessionTitle = vi.fn().mockRejectedValue(new Error("temporary failure"));
    const f = await fixture(undefined, { generateSessionTitle });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate title behavior" }] });
    await f.waitForTurn();
    f.backendOptions.getSessionInfo.mockResolvedValue({ customTitle: "Late provider title" });
    f.events.length = 0;
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Follow up" }] });
    await f.waitForTurn();
    expect((await f.store.read(threadId)).thread.title).toBe("Late provider title");
    expect(generateSessionTitle).toHaveBeenCalledOnce();
  });

  it("does not request a native title after a failed turn", async () => {
    const generateSessionTitle = vi.fn().mockResolvedValue("Unwanted title");
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["usage limit"] } as SDKMessage;
    }, { generateSessionTitle });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate title behavior" }] });
    await f.waitForTurn();
    expect(generateSessionTitle).not.toHaveBeenCalled();
    expect(f.events.some((event) => event.notification.method === "turn/failed")).toBe(true);
  });

  it.each([false, true])("preserves all completed text blocks without duplicating deltas (streaming=%s)", async (streaming) => {
    const f = await fixture(async function* () {
      yield { type: "stream_event", parent_tool_use_id: null, event: {
        type: "message_start", message: { id: "multi" },
      } } as SDKMessage;
      for (const [index, text] of ["First block", "Second block"].entries()) {
        if (streaming) yield { type: "stream_event", parent_tool_use_id: null, event: {
          type: "content_block_delta", index, delta: { type: "text_delta", text },
        } } as SDKMessage;
        yield { type: "assistant", parent_tool_use_id: null, message: {
          id: "multi", content: [{ type: "text", text }],
        } } as SDKMessage;
      }
      yield { type: "result", subtype: "success", is_error: false, result: "Done" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hello" }] });
    await f.waitForTurn();
    expect((await f.backend.readThread(threadId)).lastAssistantMessage).toBe("First block\nSecond block");
    const restarted = new ClaudeBackend(f.backendOptions);
    expect((await restarted.readThread(threadId)).lastAssistantMessage).toBe("First block\nSecond block");
    expect(f.events.filter((event) => event.notification.method === "item/completed"
      && getNotificationItem(event.notification.params)?.id === "multi").at(-1)?.notification)
      .toMatchObject({ params: { item: { text: "First block\nSecond block" } } });
  });

  it("displays and persists local slash-command output", async () => {
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "local_command_output", content: "Weekly usage: 25%",
        uuid: "00c0bd21-53cf-49c9-b918-3d2d2b84e913", session_id: "session" } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "/usage" }] });
    await f.waitForTurn();
    expect((await new ClaudeBackend(f.backendOptions).readThread(threadId)).lastAssistantMessage).toBe("Weekly usage: 25%");
    expect(f.events).toContainEqual(expect.objectContaining({ notification: {
      method: "item/completed", params: expect.objectContaining({
        item: expect.objectContaining({ type: "agentMessage", text: "Weekly usage: 25%" }),
      }),
    } }));
  });

  it.each([["gif", "image/gif"], ["GIF", "image/gif"], ["jpeg", "image/jpeg"], ["webp", "image/webp"]])(
    "sends local %s attachments with their media type", async (extension, mediaType) => {
      const f = await fixture();
      const file = path.join(f.root, `image.${extension}`);
      const bytes = Buffer.from("GIF89a");
      await writeFile(file, bytes);
      const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
      await f.backend.startTurn({ threadId, input: [{ type: "localImage", path: file }] });
      const prompt = f.run.mock.calls[0][0].prompt;
      if (typeof prompt === "string") throw new Error("Expected streaming input");
      expect((await prompt[Symbol.asyncIterator]().next()).value.message.content).toEqual([{
        type: "image", source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") },
      }]);
      await f.waitForTurn();
    },
  );

  it("rejects unsupported local image extensions before launching Claude", async () => {
    const f = await fixture();
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await expect(f.backend.startTurn({ threadId, input: [{ type: "localImage", path: path.join(f.root, "image.bmp") }] }))
      .rejects.toThrow("PNG, JPEG, GIF, or WebP");
    expect(f.run).not.toHaveBeenCalled();
  });

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

  it("accepts a steer sent after turn/started but before the query launches", async () => {
    const result = Promise.withResolvers<void>();
    let steerUuid: string | undefined;
    const f = await fixture(async function* () {
      await result.promise;
      yield { type: "result", subtype: "success", is_error: false, user_message_uuids: [steerUuid] } as unknown as SDKMessage;
    });
    const envHeld = Promise.withResolvers<void>();
    let holdEnv = false;
    const backend = new ClaudeBackend({ ...f.backendOptions,
      emit: async (event: AgentEvent) => {
        f.events.push(event);
        if (event.notification.method === "turn/started") holdEnv = true;
      },
      resolveEnv: async () => {
        if (holdEnv) await envHeld.promise;
        return { PATH: "/fixture" };
      },
    });
    const { threadId } = await backend.startThread({ cwd: f.root, executionMode: "default" });
    const starting = backend.startTurn({ threadId, input: [{ type: "text", text: "Start" }] });
    await vi.waitFor(() => expect(holdEnv).toBe(true));
    const started = f.events.find((event) => event.notification.method === "turn/started")!.notification;
    const turnId = (started.params as { turn: { id: string } }).turn.id;
    expect(f.run).not.toHaveBeenCalled();
    const steered = await backend.steerTurn({ threadId, expectedTurnId: turnId,
      input: [{ type: "text", text: "Early correction" }] });
    envHeld.resolve();
    await starting;
    const prompt = f.run.mock.calls[0][0].prompt;
    if (typeof prompt === "string") throw new Error("Expected streaming input");
    const iterator = prompt[Symbol.asyncIterator]();
    expect((await iterator.next()).value.message.content).toEqual([{ type: "text", text: "Start" }]);
    const streamed = (await iterator.next()).value;
    steerUuid = streamed.uuid;
    expect(streamed.message.content).toEqual([{ type: "text", text: "Early correction" }]);
    result.resolve();
    await f.waitForTurn();
    expect(f.events.some((event) => event.notification.method === "turn/completed")).toBe(true);
    expect((await backend.readThread(threadId)).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: steered.messageId, text: "Early correction" }),
    ]));
  });

  it("does not hold the message stream for a context probe", async () => {
    const probe = Promise.withResolvers<{ totalTokens: number; maxTokens: number }>();
    const nextPulled = Promise.withResolvers<void>();
    const context = vi.fn()
      .mockReturnValueOnce(probe.promise)
      .mockResolvedValue({ totalTokens: 900, maxTokens: 200_000 });
    const f = await fixture(async function* () {
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "answer", content: [{ type: "text", text: "Working" }],
      } } as SDKMessage;
      nextPulled.resolve();
      yield { type: "result", subtype: "success", is_error: false, result: "Done" } as SDKMessage;
    }, { getContextUsage: context });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
    await nextPulled.promise;
    // The result waits for the in-flight probe, then reads the final value.
    expect(f.events.some((event) => event.notification.method === "turn/completed")).toBe(false);
    probe.resolve({ totalTokens: 500, maxTokens: 200_000 });
    await f.waitForTurn();
    const windows = f.events.flatMap((event) => event.notification.method === "thread/contextWindow/updated"
      ? [event.notification.params.usedTokens] : []);
    expect(windows).toEqual([500, 900]);
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

  it("keeps the full limit snapshot across turns, coarse stream events, and a restart", async () => {
    const resetsAt = Date.now() + 86_400_000;
    const snapshot = { rate_limits_available: true, rate_limits: {
      seven_day: { utilization: 56, resets_at: new Date(resetsAt).toISOString() },
      iguana_necktie: { utilization: 30, resets_at: new Date(resetsAt).toISOString() },
      model_scoped: [{ display_name: "Fable", utilization: 96, resets_at: new Date(resetsAt).toISOString() }],
    }, session: { model_usage: {} } };
    // The first turn reads the snapshot; every later probe times out or fails.
    const usage = vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(snapshot)
      .mockRejectedValue(new Error("Probe unavailable"));
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "seven_day",
        utilization: 0.55, resetsAt: Math.round(resetsAt / 1000) + 3600 } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
    }, { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    for (let turn = 0; turn < 3; turn += 1) {
      f.events.length = 0;
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
      await f.waitForTurn();
    }
    const expected = [
      expect.objectContaining({ limitId: "seven_day", usedPercent: 56, resetAt: resetsAt }),
      expect.objectContaining({ limitId: "iguana_necktie", usedPercent: 30 }),
      expect.objectContaining({ limitId: "model_scoped:Fable", usedPercent: 96 }),
    ];
    expect(f.backend.summary().rateLimits).toEqual(expected);

    const restarted = new ClaudeBackend(f.backendOptions);
    expect(restarted.summary().rateLimits).toBeUndefined();
    await vi.waitFor(async () => expect((await f.store.readRateLimits()).limits).toHaveLength(3));
    await restarted.discover({ models: false });
    expect(restarted.summary().rateLimits).toEqual(expected);
  });

  it("clears remembered limits when Claude is signed out", async () => {
    const f = await fixture();
    await f.store.saveRateLimits([{ name: "Weekly limit", limitId: "seven_day", usedPercent: 40 }]);
    f.backendOptions.inspectInstallation.mockResolvedValueOnce({ executable: "/fixture/claude", authStatus: "sign-in-required" } as never);
    await f.backend.discover({ models: false });
    expect(f.backend.summary().rateLimits).toEqual([]);
    await vi.waitFor(async () => expect(await f.store.readRateLimits()).toEqual({ limits: [] }));
  });

  it("hides remembered limits while Claude is unavailable, without forgetting them", async () => {
    const f = await fixture();
    const saved = [{ name: "Weekly limit", limitId: "seven_day", usedPercent: 40 }];
    await f.store.saveRateLimits(saved);
    f.backendOptions.inspectInstallation.mockResolvedValueOnce({ authStatus: "unknown" } as never);
    await f.backend.discover({ models: false });
    expect(f.backend.summary()).toMatchObject({ available: false, rateLimits: [] });
    await f.backend.discover({ models: false });
    expect(f.backend.summary()).toMatchObject({ available: true, rateLimits: saved });
    expect((await f.store.readRateLimits()).limits).toEqual(saved);
  });

  it("clears limits when Claude signs in to another account mid-session", async () => {
    const resetsAt = Date.now() + 86_400_000;
    const snapshot = { rate_limits_available: true, rate_limits: {
      seven_day: { utilization: 56, resets_at: new Date(resetsAt).toISOString() },
    }, session: { model_usage: {} } };
    // The new account's probe answers with no windows, which alone keeps a reading.
    const usage = vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(snapshot)
      .mockResolvedValue({ rate_limits_available: true, rate_limits: null, session: { model_usage: {} } });
    const accountInfo = vi.fn().mockResolvedValueOnce({ apiProvider: "firstParty", email: "first@example.com" })
      .mockResolvedValue({ apiProvider: "firstParty", email: "second@example.com" });
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
    }, { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage, accountInfo });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
    await f.waitForTurn();
    expect(f.backend.summary().rateLimits).toEqual([expect.objectContaining({ limitId: "seven_day", usedPercent: 56 })]);
    await vi.waitFor(async () => expect((await f.store.readRateLimits()).account).toMatch(/^[0-9a-f]{16}$/));
    // The file keeps a hash of the account, never its identifiers.
    expect(JSON.stringify(await f.store.readRateLimits())).not.toContain("example.com");

    f.events.length = 0;
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
    await f.waitForTurn();
    expect(f.backend.summary().rateLimits).toEqual([]);
    await vi.waitFor(async () => expect(await f.store.readRateLimits()).toEqual({ limits: [] }));
  });

  it("keeps limits when an account of unknown method reports none, and clears them for an API key", async () => {
    const saved = [{ name: "Weekly limit", limitId: "seven_day", usedPercent: 40, resetAt: Date.now() + 86_400_000 }];
    const f = await fixture(undefined, { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn()
      .mockResolvedValue({ rate_limits_available: false, rate_limits: null, session: { model_usage: {} } }) });
    await f.store.saveRateLimits(saved);
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
    await f.waitForTurn();
    expect(f.backend.summary().rateLimits).toEqual(saved);

    f.backendOptions.inspectInstallation.mockResolvedValueOnce(
      { executable: "/fixture/claude", authStatus: "signed-in", authMethod: "api-key" } as never);
    await f.backend.discover({ models: false });
    expect(f.backend.summary().rateLimits).toEqual([]);
  });

  it("reports a window passing its reset so event-driven surfaces drop it", async () => {
    const f = await fixture(undefined, { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn()
      .mockImplementation(async () => ({ rate_limits_available: true, rate_limits: {
        five_hour: { utilization: 98, resets_at: new Date(Date.now() + 400).toISOString() },
        seven_day: { utilization: 20, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
      }, session: { model_usage: {} } })) });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
    await f.waitForTurn();
    f.events.length = 0;
    await vi.waitFor(() => expect(f.events.map((event) => event.notification.method))
      .toContain("backend/providerStatus/updated"), { timeout: 3_000 });
    expect(f.backend.summary().rateLimits).toEqual([expect.objectContaining({ limitId: "seven_day" })]);
    await f.backend.close();
  });

  it("reads saved limits from the first file shape and drops malformed readings", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "rate-limits.json"), JSON.stringify([
      { name: "Weekly limit", limitId: "seven_day", usedPercent: 40, resetAt: 1_000 },
      { name: "5-hour limit", limitId: "five_hour", usedPercent: "high" },
      { name: "Weekly Opus limit", limitId: "seven_day_opus", usedPercent: 10, resetAt: "soon" },
      { name: "Unnamed" },
    ]));
    expect(await f.store.readRateLimits()).toEqual({ limits: [
      { name: "Weekly limit", limitId: "seven_day", usedPercent: 40, resetAt: 1_000 },
      { name: "Weekly Opus limit", limitId: "seven_day_opus", usedPercent: 10 },
    ] });
    await writeFile(path.join(f.root, "rate-limits.json"), JSON.stringify({ account: "abc", limits: [
      { name: "Weekly limit", limitId: "seven_day", usedPercent: null },
    ] }));
    expect(await f.store.readRateLimits()).toEqual({ account: "abc", limits: [] });
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

  it("publishes discovery immediately and retains the catalog when a later refresh fails", async () => {
    const f = await fixture();
    const models = [{ id: "fable", label: "Fable 5.1", current: true }];
    const discoverModels = vi.fn().mockResolvedValue(models);
    const backend = new ClaudeBackend({ ...f.backendOptions, discoverModels });
    await backend.startThread({ cwd: f.root, executionMode: "default" });
    expect(discoverModels).not.toHaveBeenCalled();
    await backend.discover();
    expect(discoverModels).toHaveBeenCalledWith({ executable: "/fixture/claude", env: { PATH: "/fixture" } });
    expect(backend.summary().launchpadOptions?.models).toEqual(models);
    expect(f.events).toEqual([{ backend: "claude", notification: {
      method: "backend/providerStatus/updated", params: { backend: "claude" },
    } }]);
    discoverModels.mockRejectedValueOnce(new Error("Discovery failed"));
    await expect(backend.discover()).rejects.toThrow("Discovery failed");
    expect(backend.summary().launchpadOptions?.models).toEqual(models);
  });

  it("shares pending global discovery across differently configured projects without publishing either session catalog", async () => {
    const supportedModels = vi.fn()
      .mockResolvedValueOnce([{ value: "haiku", displayName: "Haiku 5.5", description: "Project A only" }])
      .mockResolvedValue([{ value: "sonnet", displayName: "Sonnet 5.5", description: "Project B only" }]);
    const f = await fixture(undefined, { supportedModels });
    let resolveDiscovery!: (models: BackendModelOption[]) => void;
    const discoverModels = vi.fn(() => new Promise<BackendModelOption[]>((resolve) => { resolveDiscovery = resolve; }));
    const backend = new ClaudeBackend({ ...f.backendOptions, discoverModels });
    const discovery = backend.discover();
    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(1));
    const directories = [path.join(f.root, "project-a"), path.join(f.root, "project-b")];
    for (const cwd of directories) {
      f.events.length = 0;
      const { threadId } = await backend.startThread({ cwd, executionMode: "default" });
      await backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
      await f.waitForTurn();
      expect(backend.summary().launchpadOptions?.models?.map((model) => model.label)).toEqual(["Sonnet", "Opus", "Haiku"]);
    }
    expect(discoverModels).toHaveBeenCalledTimes(1);
    expect(supportedModels).not.toHaveBeenCalled();
    expect(f.queries.map((options) => options.cwd)).toEqual(directories);
    for (const options of f.queries) expect(options.settingSources).toEqual(["user", "project", "local"]);
    const globalModels = [{ id: "opus", label: "Opus 5.5" }, { id: "fable", label: "Fable 5.1" }];
    resolveDiscovery(globalModels);
    await discovery;
    expect(backend.summary().launchpadOptions?.models).toEqual(globalModels);
    // Subsequent turns in the restricted project keep the shared global catalog.
    f.events.length = 0;
    const { threadId } = await backend.startThread({ cwd: directories[0], executionMode: "default" });
    await backend.startTurn({ threadId, input: [{ type: "text", text: "Hi again" }] });
    await f.waitForTurn();
    expect(backend.summary().launchpadOptions?.models).toEqual(globalModels);
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "signed-out"])("recovers the global catalog in the background after %s startup discovery", async (startup) => {
    const supportedModels = vi.fn().mockResolvedValue([
      { value: "haiku", displayName: "Haiku 5.5", description: "Restricted project" },
    ]);
    const f = await fixture(undefined, { supportedModels });
    const globalModels = [
      { id: "opus", label: "Opus 5.5" },
      { id: "fable", label: "Fable 5.1", reasoningEfforts: ["default", "high"] },
    ];
    const discoverModels = vi.fn().mockResolvedValue(globalModels);
    if (startup === "failed") discoverModels.mockRejectedValueOnce(new Error("Startup discovery unavailable"));
    const inspectInstallation = vi.fn()
      .mockResolvedValueOnce({ executable: "/fixture/claude", authStatus: startup === "signed-out" ? "sign-in-required" : "signed-in" })
      .mockResolvedValue({ executable: "/fixture/claude", authStatus: "signed-in" });
    const backend = new ClaudeBackend({ ...f.backendOptions, inspectInstallation, discoverModels });
    if (startup === "failed") await expect(backend.discover()).rejects.toThrow("Startup discovery unavailable");
    else await backend.discover();
    expect(backend.summary().launchpadOptions?.models?.map((model) => model.label)).toEqual(["Sonnet", "Opus", "Haiku"]);
    const { threadId } = await backend.startThread({ cwd: f.root, executionMode: "default" });
    await backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
    await f.waitForTurn();
    expect(backend.summary().launchpadOptions?.models).toEqual(globalModels);
    expect(f.events).toContainEqual({ backend: "claude", notification: {
      method: "backend/providerStatus/updated", params: { backend: "claude" },
    } });
    expect(supportedModels).not.toHaveBeenCalled();
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(startup === "failed" ? 2 : 1);
  });

  it("streams during global recovery and throttles later failed or empty probes while retaining the catalog", async () => {
    const f = await fixture();
    let resolveModels!: (models: BackendModelOption[]) => void;
    const discoverModels = vi.fn().mockImplementationOnce(() => new Promise<BackendModelOption[]>((resolve) => { resolveModels = resolve; }))
      .mockRejectedValueOnce(new Error("Metadata unavailable")).mockResolvedValue([]);
    const backend = new ClaudeBackend({ ...f.backendOptions, discoverModels });
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { threadId } = await backend.startThread({ cwd: f.root, executionMode: "default" });
      const turn = async () => {
        f.events.length = 0;
        await backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
        await f.waitForTurn();
      };
      await turn();
      expect((await backend.readThread(threadId)).lastAssistantMessage).toBe("Hello world");
      expect(discoverModels).toHaveBeenCalledTimes(1);
      resolveModels([{ id: "opus", label: "Opus 5.5" }]);
      await vi.waitFor(() => expect(backend.summary().launchpadOptions?.models?.[0].label).toBe("Opus 5.5"));
      await turn();
      expect(discoverModels).toHaveBeenCalledTimes(1);
      for (const attempt of [2, 3]) {
        now += 60_001;
        await turn();
        expect(discoverModels).toHaveBeenCalledTimes(attempt);
        expect(backend.summary().launchpadOptions?.models?.[0].label).toBe("Opus 5.5");
        await turn();
        expect(discoverModels).toHaveBeenCalledTimes(attempt);
      }
    } finally { clock.mockRestore(); }
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
        status: isError ? "failed" : "completed", command: expect.objectContaining({ displayCommand: "git status", rawCommand: "git status", output: "fixture output" }),
      })]);
      expect(f.events.some((event) => event.notification.method === "turn/completed")).toBe(false);
      expect((await f.backend.readThread(threadId)).entries).toEqual(expect.arrayContaining([expect.objectContaining({
        id: "tool-1", status: isError ? "failed" : "completed",
        details: [
          expect.objectContaining({ command: expect.objectContaining({
            rawCommand: "git status", output: "fixture output",
          }) }),
        ],
      })]));
    } finally {
      finish();
      await f.waitForTurn();
      await f.backend.close();
    }
  });

  it("groups adjacent Bash calls in replay without crossing messages", async () => {
    const f = await fixture(async function* () {
      for (const [index, command] of ["git status", "git diff", "git log"].entries()) {
        if (index === 2) yield { type: "assistant", parent_tool_use_id: null, message: {
          id: "commentary", content: [{ type: "text", text: "Checking history next." }],
        } } as SDKMessage;
        yield { type: "assistant", parent_tool_use_id: null, message: {
          id: `call-${index}`, content: [{ type: "tool_use", id: `bash-${index}`, name: "Bash", input: { command } }],
        } } as SDKMessage;
        yield { type: "user", message: { content: [{
          type: "tool_result", tool_use_id: `bash-${index}`, content: `output-${index}`,
        }] } } as SDKMessage;
      }
      yield { type: "result", subtype: "success", is_error: false, result: "Done" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Inspect" }] });
    await f.waitForTurn();
    for (const backend of [f.backend, new ClaudeBackend(f.backendOptions)]) {
      const replay = await backend.readThread(threadId);
      expect(replay.entries.map((entry) => entry.type)).toEqual(["message", "activity", "message", "activity"]);
      expect(replay.entries[1]).toMatchObject({
        summary: "Ran 2 commands", details: [
          { id: "bash-0", command: { rawCommand: "git status", output: "output-0" } },
          { id: "bash-1", command: { rawCommand: "git diff", output: "output-1" } },
        ],
      });
    }
    const starts = f.events.filter((event) => event.notification.method === "item/started");
    expect(starts).toHaveLength(3);
    expect(starts.map((event) => buildLiveToolDetails(getNotificationItem(event.notification.params)!)[0].command?.rawCommand))
      .toEqual(["git status", "git diff", "git log"]);
  });

  it("recovers saved Bash invocations and groups them without rewriting old records", async () => {
    const f = await fixture();
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    const saved = ["git status", "git diff"].map((command, index) => ({
      type: "activity" as const, id: `old-${index}`, summary: "Bash",
      status: index === 0 ? "completed" as const : "failed" as const,
      turn: { id: "old-turn" },
      details: [
        { id: `old-${index}`, kind: "command" as const, label: "Bash", markdown: JSON.stringify({ command }) },
        { id: `old-${index}:output`, kind: "command" as const, label: "Bash output", markdown: `output-${index}` },
      ],
    }));
    await f.store.append(threadId, saved);
    const replay = await f.backend.readThread(threadId);
    expect(replay.entries).toHaveLength(1);
    expect(replay.entries[0]).toMatchObject({
      summary: "Ran 2 commands", status: "failed", details: [
        { command: { rawCommand: "git status", output: "output-0" } },
        { command: { rawCommand: "git diff", output: "output-1" } },
      ],
    });
    expect(await f.store.entries(threadId)).toEqual(saved);
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
