import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options, Query, SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, BackendModelOption } from "@pwragent/shared";
import { ClaudeBackend } from "../claude/claude-backend";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { createClaudePermissionHandler, claudePermissionMode } from "../claude/claude-permissions";
import { createClaudeElicitationHandler } from "../claude/claude-elicitation";
import { buildLiveToolDetails, getNotificationItem } from "../../renderer/src/features/thread-detail/live-transcript-activity";
import { completedThreadReview, reportedThreadReviewOutcomes } from "../thread-reviews/thread-review-events";

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
  const turnCompletions = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  let latestTurnId: string | undefined;
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
    emit: async (event: AgentEvent) => {
      events.push(event);
      const method = event.notification.method;
      if (method === "turn/started") {
        const { turn } = event.notification.params as { turn: { id: string } };
        latestTurnId = turn.id;
        turnCompletions.set(turn.id, Promise.withResolvers<void>());
      } else if (["turn/completed", "turn/failed", "turn/cancelled"].includes(method)) {
        const { turn } = event.notification.params as { turn: { id: string } };
        turnCompletions.get(turn.id)?.resolve();
      }
    },
    request: async () => ({ decision: "accept" }),
    cancelRequest: async () => {},
    resolveEnv: async (): Promise<NodeJS.ProcessEnv> => ({ PATH: "/fixture", ANTHROPIC_API_KEY: "must-not-reach-child", CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-child" }),
  };
  const backend = new ClaudeBackend(backendOptions);
  async function waitForTurn() {
    // Join the current turn's persisted terminal event. The test timeout
    // bounds a stuck turn; a separate polling deadline races filesystem I/O
    // on Windows and an older terminal event can release a later turn early.
    const completion = latestTurnId && turnCompletions.get(latestTurnId);
    if (!completion) throw new Error("No Claude turn has started in this fixture.");
    await completion.promise;
  }
  return { backend, backendOptions, store, events, queries, run, close, waitForTurn, root };
}

describe("Claude SDK backend", () => {
  it("publishes a native title during the first turn without blocking assistant streaming", async () => {
    const pendingTitle = Promise.withResolvers<string>();
    const finishTurn = Promise.withResolvers<void>();
    const generateSessionTitle = vi.fn(() => pendingTitle.promise);
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "stream_event", parent_tool_use_id: null, event: {
        type: "message_start", message: { id: "answer" },
      } } as SDKMessage;
      yield { type: "stream_event", parent_tool_use_id: null, event: {
        type: "content_block_delta", delta: { type: "text_delta", text: "Still working" },
      } } as SDKMessage;
      await finishTurn.promise;
      yield { type: "result", subtype: "success", is_error: false, result: "Done" } as SDKMessage;
    }, { generateSessionTitle });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    try {
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate title behavior" }] });
      await vi.waitFor(() => {
        expect(generateSessionTitle).toHaveBeenCalledOnce();
        expect(f.events.some((event) => event.notification.method === "item/agentMessage/delta")).toBe(true);
      });
      pendingTitle.resolve("Fix Claude naming");
      await vi.waitFor(() => expect(f.events.some((event) => event.notification.method === "thread/name/updated"
        && event.notification.params.threadName === "Fix Claude naming")).toBe(true));
      expect((await f.store.read(threadId)).thread.title).toBe("Fix Claude naming");
      expect(f.events.some((event) => event.notification.method === "turn/completed")).toBe(false);
      expect(f.close).not.toHaveBeenCalled();
    } finally {
      pendingTitle.resolve("Fix Claude naming");
      finishTurn.resolve();
      await f.waitForTurn();
    }
    expect(generateSessionTitle).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledOnce();
  });

  it("requests a native title in the query account without reading another config directory", async () => {
    const generateSessionTitle = vi.fn().mockResolvedValue("Account-scoped title");
    const f = await fixture(undefined, { generateSessionTitle });
    f.backendOptions.resolveEnv = async () => ({ PATH: "/fixture", CLAUDE_CONFIG_DIR: path.join(f.root, "claude-account") });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate title behavior" }] });
    await f.waitForTurn();
    expect(f.backendOptions.getSessionInfo).not.toHaveBeenCalled();
    expect(generateSessionTitle).toHaveBeenCalledOnce();
    expect((await f.store.read(threadId)).thread.title).toBe("Account-scoped title");
  });

  it("adopts a provider title at turn end if the early request returned no title", async () => {
    const generateSessionTitle = vi.fn().mockResolvedValue(null);
    const f = await fixture(undefined, { generateSessionTitle });
    f.backendOptions.getSessionInfo.mockResolvedValueOnce(undefined).mockResolvedValue({ customTitle: "Late provider title" });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate title behavior" }] });
    await f.waitForTurn();
    expect((await f.store.read(threadId)).thread.title).toBe("Late provider title");
    expect(generateSessionTitle).toHaveBeenCalledOnce();
  });

  it("cancels a pending title request and prevents late persistence after interruption", async () => {
    const pendingTitle = Promise.withResolvers<string>();
    const generateSessionTitle = vi.fn(() => pendingTitle.promise);
    const f = await fixture(async function* (options) {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      await new Promise<void>((resolve) => {
        const signal = options.abortController!.signal;
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }, { generateSessionTitle });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    try {
      const turn = await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate title behavior" }] });
      await vi.waitFor(() => expect(generateSessionTitle).toHaveBeenCalledOnce());
      await f.backend.interruptTurn(turn);
      pendingTitle.resolve("Too late");
      expect((await f.store.read(threadId)).thread.title).toBe("Investigate title behavior");
      expect(f.events.some((event) => event.notification.method === "turn/cancelled")).toBe(true);
      expect(f.events.some((event) => event.notification.method === "thread/name/updated"
        && event.notification.params.threadName === "Too late")).toBe(false);
    } finally {
      pendingTitle.resolve("Too late");
      await f.backend.close();
    }
  });

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

  it("requests a native title even when provider metadata cannot be read", async () => {
    const generateSessionTitle = vi.fn().mockResolvedValue("Native title");
    const f = await fixture(undefined, { generateSessionTitle });
    f.backendOptions.getSessionInfo.mockRejectedValue(new Error("unreadable session"));
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate title behavior" }] });
    await f.waitForTurn();
    expect(generateSessionTitle).toHaveBeenCalledOnce();
    expect((await f.store.read(threadId)).thread.title).toBe("Native title");
    expect(f.events.some((event) => event.notification.method === "turn/completed")).toBe(true);
  });

  it("drains a pending SDK metadata read before shutdown releases the workspace", async () => {
    const pending = Promise.withResolvers<undefined>();
    const f = await fixture();
    f.backendOptions.getSessionInfo.mockReturnValue(pending.promise);
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    // Keep real filesystem scheduling out of this control-operation race.
    let session = await f.store.read(threadId);
    vi.spyOn(f.store, "read").mockImplementation(async () => structuredClone(session));
    vi.spyOn(f.store, "save").mockImplementation(async (value) => { session = structuredClone(value); });
    vi.spyOn(f.store, "append").mockResolvedValue(undefined);
    vi.useFakeTimers();
    let closing: Promise<void> | undefined;
    try {
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate title behavior" }] });
      await vi.waitFor(() => expect(f.backendOptions.getSessionInfo).toHaveBeenCalledOnce());
      let closed = false;
      closing = f.backend.close().then(() => { closed = true; });
      await vi.advanceTimersByTimeAsync(1600);
      expect(closed).toBe(false);
      expect(f.events.some((event) => ["turn/completed", "turn/cancelled"].includes(event.notification.method))).toBe(false);
      pending.resolve(undefined);
      await closing;
      expect(closed).toBe(true);
    } finally {
      pending.resolve(undefined);
      await closing;
      vi.useRealTimers();
    }
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

  it("does not let a background title failure mask a failed turn", async () => {
    const generateSessionTitle = vi.fn().mockRejectedValue(new Error("title unavailable"));
    const totals = { haiku: { inputTokens: 25, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      costUSD: 0.002, contextWindow: 200_000, maxOutputTokens: 32_000, webSearchRequests: 0 } };
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["usage limit"] } as SDKMessage;
    }, { generateSessionTitle,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn().mockResolvedValue({ session: { model_usage: totals } }),
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate title behavior" }] });
    await f.waitForTurn();
    expect(generateSessionTitle).toHaveBeenCalledOnce();
    expect(f.events.some((event) => event.notification.method === "turn/failed")).toBe(true);
    expect(f.events.find((event) => event.notification.method === "thread/tokenUsage/updated")?.notification)
      .toMatchObject({ params: { tokenUsage: { claudeCostUSD: 0.002 } } });
  });

  it("waits for the current turn when an earlier turn already completed", async () => {
    const enteredSecondTurn = Promise.withResolvers<void>();
    const finishSecondTurn = Promise.withResolvers<void>();
    let turns = 0;
    const f = await fixture(async function* () {
      if (++turns === 2) {
        enteredSecondTurn.resolve();
        await finishSecondTurn.promise;
      }
      yield { type: "result", subtype: "success", is_error: false, result: "Done" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "First" }] });
    await f.waitForTurn();
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Second" }] });
    await enteredSecondTurn.promise;
    let completed = false;
    const waiting = f.waitForTurn().then(() => { completed = true; });
    try {
      // Flush promise callbacks while the second SDK result is held. A
      // terminal event from the first turn cannot satisfy this wait.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
    } finally {
      finishSecondTurn.resolve();
      await waiting;
      await f.backend.close();
    }
    expect(completed).toBe(true);
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

  describe("code-review findings", () => {
    const findings = [
      { file: "src/state.ts", line: 12, summary: "Stamps every row.", short_summary: "Stamps every row",
        failure_scenario: "Empty rows show up as Directories rows.", category: "correctness" },
      { file: "src/migrate.ts", line: 40, summary: "Unguarded parse.", failure_scenario: "A corrupt row fails startup." },
    ];
    const report = (id: string, input: unknown): SDKMessage[] => [
      { type: "assistant", parent_tool_use_id: null, message: {
        id: `message-${id}`, model: "claude-opus-5-5", content: [{ type: "tool_use", id, name: "ReportFindings", input }],
      } } as SDKMessage,
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "2 findings reported." }] } } as SDKMessage,
      { type: "result", subtype: "success", is_error: false, result: "" } as SDKMessage,
    ];
    const turns = (...scripts: SDKMessage[][]) => {
      let turn = 0;
      return async function* () { yield* scripts[turn++] ?? []; };
    };
    const reviewItems = (events: AgentEvent[]) => events.flatMap((event) => {
      if (event.notification.method !== "item/completed") return [];
      const item = getNotificationItem(event.notification.params) as Record<string, unknown> | undefined;
      return item?.type === "exitedReviewMode" ? [item] : [];
    });

    it("turns a ReportFindings call into a review card instead of a tool row", async () => {
      const f = await fixture(turns(report("review-1", { level: "high", findings })));
      const context = { workspacePath: f.root, gitBranch: "feature" };
      const resolveReviewContext = vi.fn().mockResolvedValue(context);
      const backend = new ClaudeBackend({ ...f.backendOptions, resolveReviewContext });
      const { threadId } = await backend.startThread({ cwd: f.root, executionMode: "default" });
      await backend.startTurn({ threadId, input: [{ type: "text", text: "/code-review high" }] });
      await f.waitForTurn();

      expect(resolveReviewContext).toHaveBeenCalledWith({ threadId, cwd: f.root });
      const [item] = reviewItems(f.events);
      expect(item).toEqual(expect.objectContaining({ id: "review-1", type: "exitedReviewMode" }));
      const data = item.data as { reviewOutput: { findings: Array<{ title: string; code_location: unknown }> }; reviewer: unknown; context: unknown };
      expect(data.reviewer).toEqual({ backend: "claude", model: "claude-opus-5-5", reasoningEffort: "high" });
      expect(data.context).toEqual(context);
      expect(data.reviewOutput.findings.map((finding) => finding.title)).toEqual(["Stamps every row", "Unguarded parse."]);
      expect(data.reviewOutput.findings[0].code_location).toEqual({
        absolute_file_path: path.join(f.root, "src/state.ts"), line_range: { start: 12, end: 12 },
      });
      // The live event is what review tracking imports into To-dos.
      const event = f.events.find((candidate) => getNotificationItem(
        (candidate.notification as { params: Record<string, unknown> }).params)?.id === "review-1")!;
      expect(completedThreadReview(event)).toEqual(expect.objectContaining({
        identity: { backend: "claude", threadId },
        entry: expect.objectContaining({ id: "review-1", output: data.reviewOutput }),
      }));
      // No generic tool row: neither a started item nor a stored activity.
      expect(f.events.some((candidate) => candidate.notification.method === "item/started"
        && getNotificationItem(candidate.notification.params)?.id === "review-1")).toBe(false);
      const entries = (await new ClaudeBackend(f.backendOptions).readThread(threadId)).entries;
      expect(entries.filter((entry) => entry.id === "review-1")).toEqual([expect.objectContaining({
        type: "review", output: data.reviewOutput, context,
        reviewer: { backend: "claude", model: "claude-opus-5-5", reasoningEffort: "high" },
        turn: expect.objectContaining({ status: "completed" }),
      })]);
      await backend.close();
    });

    it("records a re-report's outcomes against the review it repeats", async () => {
      const f = await fixture(turns(
        report("review-1", { level: "high", findings }),
        report("review-2", { level: "high", findings: [
          { ...findings[1], outcome: "skipped" },
          { ...findings[0], outcome: "fixed" },
        ] }),
      ));
      const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "/code-review high" }] });
      await f.waitForTurn();
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Fix the first one." }] });
      await f.waitForTurn();

      expect(reviewItems(f.events).map((item) => item.id)).toEqual(["review-1"]);
      const reported = f.events.filter((event) => event.notification.method === "thread/review/outcomesReported");
      expect(reported).toHaveLength(1);
      expect(reported[0].notification.params).toEqual(expect.objectContaining({
        threadId, reviewId: "review-1",
        outcomes: [{ index: 0, outcome: "fixed" }, { index: 1, outcome: "skipped" }],
      }));
      expect(reportedThreadReviewOutcomes(reported[0])).toEqual({
        identity: { backend: "claude", threadId }, sourceKey: "review-1",
        outcomes: [{ index: 0, outcome: "fixed" }, { index: 1, outcome: "skipped" }],
      });
      const entries = (await f.backend.readThread(threadId)).entries;
      expect(entries.filter((entry) => entry.type === "review").map((entry) => entry.id)).toEqual(["review-1"]);
      expect(entries.some((entry) => entry.id === "review-2")).toBe(false);
      await f.backend.close();
    });

    it("records an outcome report that repeats no earlier review as a new review", async () => {
      const f = await fixture(turns(report("review-1", { findings: [{ ...findings[0], outcome: "fixed" }, findings[1]] })));
      const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "/code-review --fix" }] });
      await f.waitForTurn();

      expect(reviewItems(f.events).map((item) => item.id)).toEqual(["review-1"]);
      const reported = f.events.find((event) => event.notification.method === "thread/review/outcomesReported");
      expect(reported?.notification.params).toEqual(expect.objectContaining({
        reviewId: "review-1", outcomes: [{ index: 0, outcome: "fixed" }],
      }));
      // The card comes first, so tracking has a review to apply them to.
      expect(f.events.indexOf(reported!)).toBeGreaterThan(f.events.findIndex((event) =>
        getNotificationItem((event.notification as { params: Record<string, unknown> }).params)?.id === "review-1"));
      await f.backend.close();
    });

    it("still shows the review when its context cannot be resolved", async () => {
      const f = await fixture(turns(report("review-1", { findings })));
      const backend = new ClaudeBackend({ ...f.backendOptions, resolveReviewContext: vi.fn().mockRejectedValue(new Error("git failed")) });
      const { threadId } = await backend.startThread({ cwd: f.root, executionMode: "default" });
      await backend.startTurn({ threadId, input: [{ type: "text", text: "/code-review" }] });
      await f.waitForTurn();
      const [item] = reviewItems(f.events);
      expect(item.data).not.toHaveProperty("context");
      expect((await backend.readThread(threadId)).entries.find((entry) => entry.id === "review-1"))
        .toEqual(expect.objectContaining({ type: "review", reviewer: { backend: "claude", model: "claude-opus-5-5" } }));
      await backend.close();
    });

    it("records no review for a call the CLI rejected, so its retry is the only card", async () => {
      const rejected: SDKMessage[] = [
        { type: "assistant", parent_tool_use_id: null, message: {
          id: "message-rejected", model: "claude-opus-5-5",
          content: [{ type: "tool_use", id: "review-0", name: "ReportFindings", input: { findings } }],
        } } as SDKMessage,
        { type: "user", message: { content: [{
          type: "tool_result", tool_use_id: "review-0", is_error: true, content: "InputValidationError",
        }] } } as SDKMessage,
      ];
      const f = await fixture(turns([...rejected, ...report("review-1", { findings })]));
      const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "/code-review" }] });
      await f.waitForTurn();

      expect(reviewItems(f.events).map((item) => item.id)).toEqual(["review-1"]);
      const entries = (await f.backend.readThread(threadId)).entries;
      expect(entries.filter((entry) => entry.type === "review").map((entry) => entry.id)).toEqual(["review-1"]);
      expect(entries).toContainEqual(expect.objectContaining({
        id: "review-0", type: "activity", summary: "ReportFindings", status: "failed",
      }));
      await f.backend.close();
    });

    it("does not pair a later turn's same-length outcome report with an unrelated review by position", async () => {
      const unrelated = [
        { file: "src/other.ts", line: 3, summary: "Other.", failure_scenario: "x", outcome: "fixed" },
        { file: "src/third.ts", line: 9, summary: "Third.", failure_scenario: "y" },
      ];
      const f = await fixture(turns(
        report("review-1", { findings }),
        report("review-2", { findings: unrelated }),
      ));
      const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "/code-review" }] });
      await f.waitForTurn();
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "/code-review --fix" }] });
      await f.waitForTurn();

      expect(reviewItems(f.events).map((item) => item.id)).toEqual(["review-1", "review-2"]);
      const reported = f.events.filter((event) => event.notification.method === "thread/review/outcomesReported");
      expect(reported.map((event) => (event.notification.params as { reviewId: string }).reviewId)).toEqual(["review-2"]);
      await f.backend.close();
    });

    it("keeps a malformed ReportFindings call as an ordinary tool row", async () => {
      const f = await fixture(turns(report("review-1", { level: "high" })));
      const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "/code-review" }] });
      await f.waitForTurn();
      expect(reviewItems(f.events)).toEqual([]);
      expect((await f.backend.readThread(threadId)).entries).toContainEqual(expect.objectContaining({
        id: "review-1", type: "activity", summary: "ReportFindings",
      }));
      await f.backend.close();
    });
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
    expect(streamed).toMatchObject({ type: "user", priority: "next", uuid: expect.any(String),
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
        await f.backendOptions.emit(event);
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
    expect(discoverModels).toHaveBeenCalledWith({ executable: "/fixture/claude", env: { PATH: "/fixture", CLAUDE_CODE_REPORT_FINDINGS: "1", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" } });
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
    expect(f.queries[0].env?.CLAUDE_CODE_REPORT_FINDINGS).toBe("1");
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

  it("keeps the turn and its query open while a background command runs, then finishes after Claude's follow-up", async () => {
    const commandDone = Promise.withResolvers<void>();
    const stopTask = vi.fn().mockResolvedValue(undefined);
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "launch", content: [{ type: "tool_use", id: "tool-bash", name: "Bash", input: { command: "pnpm test --watch=false", run_in_background: true } }],
      } } as SDKMessage;
      yield { type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "tool-bash",
        description: "Run the tests", task_type: "local_bash", is_backgrounded: true } as SDKMessage;
      yield { type: "system", subtype: "background_tasks_changed", tasks: [
        { task_id: "task-1", task_type: "local_bash", description: "Run the tests" },
      ] } as SDKMessage;
      yield { type: "user", parent_tool_use_id: null, tool_use_result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "task-1" },
        message: { content: [{ type: "tool_result", tool_use_id: "tool-bash", content: "Command running in background with ID: task-1" }] } } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "waiting", content: [{ type: "text", text: "The tests are running. I'll resume when they report back." }],
      } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "waiting" } as SDKMessage;
      await commandDone.promise;
      yield { type: "system", subtype: "task_notification", task_id: "task-1", tool_use_id: "tool-bash",
        status: "completed", output_file: "", summary: "Tests passed" } as SDKMessage;
      yield { type: "system", subtype: "background_tasks_changed", tasks: [] } as unknown as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "resumed", content: [{ type: "text", text: "All tests passed." }],
      } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "done" } as SDKMessage;
    }, { stopTask });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Run the tests" }] });
    await vi.waitFor(() => expect(f.events.some((event) => event.notification.method === "item/completed"
      && JSON.stringify(event.notification.params).includes("resume when they report back"))).toBe(true));
    await vi.waitFor(() => expect(f.backend.listBackgroundTasks(threadId).terminals).toEqual([{
      itemId: "tool-bash", processId: "task-1", command: "pnpm test --watch=false", cwd: f.root,
    }]));
    expect(f.events.some((event) => event.notification.method === "thread/backgroundTasks/updated"
      && (event.notification.params as { tasks: unknown[] }).tasks.length === 1)).toBe(true);
    expect(f.events.some((event) => ["turn/completed", "turn/failed"].includes(event.notification.method))).toBe(false);
    expect(f.close).not.toHaveBeenCalled();
    expect((await f.backend.readThread(threadId)).threadStatus).toBe("active");
    // The placeholder result does not complete the command's row.
    expect(f.events.some((event) => event.notification.method === "item/completed"
      && (event.notification.params.item as { id?: string }).id === "tool-bash")).toBe(false);
    await f.backend.stopBackgroundTask(threadId, "task-1");
    expect(stopTask).toHaveBeenCalledWith("task-1");

    commandDone.resolve();
    await f.waitForTurn();
    expect(f.events.filter((event) => event.notification.method === "turn/completed")).toHaveLength(1);
    expect(f.events.at(-1)?.notification.method).toBe("turn/completed");
    const command = f.events.find((event) => event.notification.method === "item/completed"
      && (event.notification.params.item as { id?: string }).id === "tool-bash");
    expect(command?.notification.params).toMatchObject({ item: { status: "completed", aggregatedOutput: expect.stringContaining("Tests passed") } });
    expect(f.events.filter((event) => event.notification.method === "thread/backgroundTasks/updated").at(-1)?.notification.params)
      .toMatchObject({ tasks: [] });
    expect(f.backend.listBackgroundTasks(threadId).terminals).toEqual([]);
    const replay = await f.backend.readThread(threadId);
    expect(replay.threadStatus).toBe("idle");
    expect(replay.lastAssistantMessage).toBe("All tests passed.");
  });

  it("follows Claude Code 2.1.301's captured background-command sequence to its follow-up turn", async () => {
    // Recorded from the bundled CLI with session state events enabled.
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "session_state_changed", state: "running" } as SDKMessage;
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "launch", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "sleep 4; echo probe-finished", run_in_background: true } }],
      } } as SDKMessage;
      yield { type: "system", subtype: "background_tasks_changed", tasks: [
        { task_id: "bh1fh5c3h", run_id: "run-1", task_type: "local_bash", description: "Sleep 4 seconds then echo probe-finished" },
      ] } as SDKMessage;
      yield { type: "system", subtype: "task_started", task_id: "bh1fh5c3h", run_id: "run-1", tool_use_id: "toolu_1",
        description: "Sleep 4 seconds then echo probe-finished", is_backgrounded: true } as SDKMessage;
      yield { type: "user", parent_tool_use_id: null, tool_use_result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bh1fh5c3h" },
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Command running in background with ID: bh1fh5c3h" }] } } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: { id: "waiting", content: [{ type: "text", text: "WAITING" }] } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "WAITING" } as SDKMessage;
      yield { type: "system", subtype: "session_state_changed", state: "idle" } as SDKMessage;
      yield { type: "system", subtype: "task_updated", task_id: "bh1fh5c3h", run_id: "run-1", patch: { status: "completed", end_time: 1 } } as SDKMessage;
      yield { type: "system", subtype: "task_notification", task_id: "bh1fh5c3h", run_id: "run-1", tool_use_id: "toolu_1",
        status: "completed", output_file: "", summary: "Background command completed" } as SDKMessage;
      yield { type: "system", subtype: "background_tasks_changed", tasks: [] } as unknown as SDKMessage;
      yield { type: "system", subtype: "session_state_changed", state: "running" } as SDKMessage;
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: { id: "done", content: [{ type: "text", text: "DONE" }] } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "DONE" } as SDKMessage;
      yield { type: "system", subtype: "session_state_changed", state: "idle" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Probe" }] });
    await f.waitForTurn();
    expect(f.events.filter((event) => event.notification.method === "turn/completed")).toHaveLength(1);
    expect((await f.backend.readThread(threadId)).lastAssistantMessage).toBe("DONE");
    expect(f.events.find((event) => event.notification.method === "item/completed"
      && (event.notification.params.item as { id?: string }).id === "toolu_1")?.notification.params)
      .toMatchObject({ item: { status: "completed" } });
  });

  it("reports a background sub-agent as running work with its progress", async () => {
    const agentDone = Promise.withResolvers<void>();
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "spawn", content: [{ type: "tool_use", id: "tool-agent", name: "Agent", input: { description: "Audit the SDK", prompt: "..." } }],
      } } as SDKMessage;
      yield { type: "system", subtype: "task_started", task_id: "agent-1", tool_use_id: "tool-agent", description: "Audit the SDK",
        task_type: "local_agent", subagent_type: "Explore", is_backgrounded: true } as SDKMessage;
      yield { type: "user", parent_tool_use_id: null, tool_use_result: { status: "async_launched", agentId: "agent-1", description: "Audit the SDK", prompt: "..." },
        message: { content: [{ type: "tool_result", tool_use_id: "tool-agent", content: "Async agent launched." }] } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "waiting" } as SDKMessage;
      yield { type: "system", subtype: "task_progress", task_id: "agent-1", tool_use_id: "tool-agent", description: "Audit the SDK",
        usage: { total_tokens: 10, tool_uses: 3, duration_ms: 5 }, last_tool_name: "Grep" } as SDKMessage;
      await agentDone.promise;
      yield { type: "system", subtype: "task_notification", task_id: "agent-1", tool_use_id: "tool-agent",
        status: "stopped", output_file: "", summary: "Stopped" } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "noted" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Audit" }] });
    await vi.waitFor(() => expect(f.backend.listBackgroundTasks(threadId).terminals).toEqual([{
      itemId: "tool-agent", processId: "agent-1", command: "Audit the SDK", cwd: f.root,
      kind: "agent", agentType: "Explore", progress: "3 tool uses · last Grep",
    }]));
    agentDone.resolve();
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification.method).toBe("turn/completed");
    expect(f.events.find((event) => event.notification.method === "item/completed"
      && (event.notification.params.item as { id?: string }).id === "tool-agent")?.notification.params)
      .toMatchObject({ item: { status: "cancelled" } });
  });

  it("does not wait on a foreground task that sends no notification", async () => {
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "run", content: [{ type: "tool_use", id: "tool-fg", name: "Bash", input: { command: "ls" } }],
      } } as SDKMessage;
      yield { type: "system", subtype: "task_started", task_id: "fg-1", tool_use_id: "tool-fg", description: "ls",
        task_type: "local_bash", is_backgrounded: false } as SDKMessage;
      yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tool-fg", content: "README.md" }] } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "done" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "List" }] });
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification.method).toBe("turn/completed");
    expect(f.events.find((event) => event.notification.method === "item/completed"
      && (event.notification.params.item as { id?: string }).id === "tool-fg")?.notification.params)
      .toMatchObject({ item: { status: "completed" } });
  });

  it("ends the turn at Claude's idle state once it reports one", async () => {
    const idle = Promise.withResolvers<void>();
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "system", subtype: "session_state_changed", state: "running" } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "done" } as SDKMessage;
      await idle.promise;
      yield { type: "system", subtype: "session_state_changed", state: "idle" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hello" }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.events.some((event) => event.notification.method === "turn/completed")).toBe(false);
    idle.resolve();
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification.method).toBe("turn/completed");
  });

  it("ends the turn when Claude runs no follow-up for a settled task", async () => {
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "system", subtype: "task_started", task_id: "task-1", description: "sleep", task_type: "local_bash", is_backgrounded: true } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "waiting" } as SDKMessage;
      yield { type: "system", subtype: "task_notification", task_id: "task-1", status: "completed", output_file: "", summary: "done" } as SDKMessage;
      // The CLI stays connected; nothing else arrives.
      await new Promise<void>(() => {});
    });
    const backend = new ClaudeBackend({ ...f.backendOptions, taskFollowUpGraceMs: 50 });
    const { threadId } = await backend.startThread({ cwd: f.root, executionMode: "default" });
    const started = Date.now();
    await backend.startTurn({ threadId, input: [{ type: "text", text: "Sleep" }] });
    await f.waitForTurn();
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(f.events.at(-1)?.notification.method).toBe("turn/completed");
  });

  it("reports Claude's error when a turn fails before acknowledging a steer", async () => {
    const finish = Promise.withResolvers<void>();
    const f = await fixture(async function* () {
      await finish.promise;
      yield { type: "result", subtype: "error_during_execution", is_error: true,
        errors: ["Claude API request failed"] } as unknown as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    const turn = await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Start" }] });
    await f.backend.steerTurn({ threadId, expectedTurnId: turn.turnId, input: [{ type: "text", text: "Correction" }] });
    finish.resolve();
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification).toMatchObject({ method: "turn/failed", params: {
      turn: { error: { message: "Claude API request failed" } },
    } });
  });

  it("fails a turn whose error result has no text", async () => {
    const f = await fixture(async function* () {
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [] } as unknown as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Start" }] });
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification).toMatchObject({ method: "turn/failed", params: {
      turn: { error: { message: "Claude ended the turn with an error." } },
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

describe("Claude MCP elicitation bridge", () => {
  const signal = () => ({ signal: new AbortController().signal, requestId: "sdk-request" });

  it("shows a turn's MCP elicitation on the operator's card instead of declining it", async () => {
    const f = await fixture();
    const request = vi.fn().mockResolvedValue({ action: "accept", content: { region: "us-east-1" }, _meta: null });
    f.backendOptions.request = request;
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    const { turnId } = await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Deploy" }] });
    await f.waitForTurn();

    const onElicitation = f.queries[0]?.onElicitation;
    expect(onElicitation).toBeTypeOf("function");
    await expect(onElicitation!({
      serverName: "deploy", message: "Which region?", mode: "form",
      requestedSchema: { type: "object", properties: { region: { type: "string" } }, required: ["region"] },
    }, signal())).resolves.toEqual({ action: "accept", content: { region: "us-east-1" } });
    expect(request).toHaveBeenCalledWith({
      method: "mcpServer/elicitation/request",
      params: {
        threadId, turnId, requestId: expect.any(String), serverName: "deploy", mode: "form",
        message: "Which region?", _meta: null,
        requestedSchema: { type: "object", properties: { region: { type: "string" } }, required: ["region"] },
      },
    }, expect.any(AbortSignal));
  });

  it("sends a 2026-07-28 URL request without an elicitationId and accepts it without content", async () => {
    const request = vi.fn().mockResolvedValue({ action: "accept", content: {}, _meta: null });
    const handler = createClaudeElicitationHandler({ threadId: "thread", turnId: "turn", request, cancelRequest: async () => {} });

    await expect(handler({
      serverName: "billing", message: "Confirm the refund.", mode: "url",
      url: "https://pay.example.com/refunds/4417", displayName: "Billing",
    }, signal())).resolves.toEqual({ action: "accept" });
    expect(request.mock.calls[0]?.[0]).toEqual({
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread", turnId: "turn", requestId: expect.any(String), serverName: "billing", mode: "url",
        message: "Confirm the refund.", url: "https://pay.example.com/refunds/4417",
        _meta: { connector_name: "Billing" },
      },
    });
  });

  it("treats a schema-less form as a confirmation", async () => {
    const request = vi.fn().mockResolvedValue({ action: "accept", content: {}, _meta: null });
    const handler = createClaudeElicitationHandler({ threadId: "thread", turnId: "turn", request, cancelRequest: async () => {} });

    await expect(handler({ serverName: "crm", message: "Close the ticket?" }, signal()))
      .resolves.toEqual({ action: "accept", content: {} });
    expect(request.mock.calls[0]?.[0].params).toMatchObject({
      mode: "form", requestedSchema: { type: "object", properties: {} },
    });
  });

  it.each([
    [{ action: "decline", content: null, _meta: null }, { action: "decline" }],
    [{ action: "cancel", content: null, _meta: null }, { action: "cancel" }],
    // The registry settles a withdrawn request with a generic cancel.
    [{ decision: "cancel" }, { action: "cancel" }],
    [undefined, { action: "cancel" }],
  ])("returns %o as %o with no content", async (response, expected) => {
    const handler = createClaudeElicitationHandler({
      threadId: "thread", turnId: "turn", cancelRequest: async () => {},
      request: vi.fn().mockResolvedValue(response),
    });

    await expect(handler({ serverName: "crm", message: "Continue?", mode: "form",
      requestedSchema: { type: "object", properties: {} } }, signal())).resolves.toEqual(expected);
  });

  it("withdraws the card and dismisses the request when the turn stops", async () => {
    const controller = new AbortController();
    const cancelRequest = vi.fn().mockResolvedValue(undefined);
    const handler = createClaudeElicitationHandler({
      threadId: "thread", turnId: "turn", cancelRequest,
      request: async () => await new Promise(() => {}),
    });
    const result = handler({ serverName: "crm", message: "Continue?" }, { signal: controller.signal, requestId: "sdk-request" });
    controller.abort();

    await expect(result).resolves.toEqual({ action: "cancel" });
    expect(cancelRequest).toHaveBeenCalledOnce();
  });
});
