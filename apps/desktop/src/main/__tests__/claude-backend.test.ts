import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options, Query, SDKMessage, SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, BackendModelOption } from "@pwragent/shared";
import { ClaudeBackend, ClaudeTurnActiveError } from "../claude/claude-backend";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { createClaudePermissionHandler, claudePermissionMode } from "../claude/claude-permissions";
import { createClaudeElicitationHandler } from "../claude/claude-elicitation";
import { buildLiveToolDetails, getNotificationItem } from "../../renderer/src/features/thread-detail/live-transcript-activity";
import { completedThreadReview, reportedThreadReviewOutcomes } from "../thread-reviews/thread-review-events";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(messages?: (options: Options, prompt: AsyncIterable<SDKUserMessage>) => AsyncGenerator<SDKMessage>, controls: Partial<Query> & {
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
    return Object.assign(messages ? messages(options, args.prompt as AsyncIterable<SDKUserMessage>) : normal(), {
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
  it("isolates a monitor's MCP configuration from inherited native servers", async () => {
    const f = await fixture();
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "full-access", ephemeral: { title: "Task monitor" } });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Inspect status" }], strictMcpConfig: true, mcpServers: {} });
    await f.waitForTurn();
    expect(f.queries[0]).toMatchObject({ strictMcpConfig: true, mcpServers: {} });
    await f.backend.close();
  });

  it("moves a thread to another folder and resumes the same session there", async () => {
    const f = await fixture();
    const previous = path.join(f.root, "checkout");
    const secondary = path.join(f.root, "other-repo");
    const worktree = path.join(f.root, "worktrees", "checkout");
    const { threadId } = await f.backend.startThread({
      cwd: previous, executionMode: "default",
      linkedDirectories: [
        { id: previous, kind: "local", label: "checkout", path: previous },
        { id: secondary, kind: "local", label: "other-repo", path: secondary },
      ],
    });
    // Builds before this one stored a refusal on every Claude thread.
    const stored = await f.store.read(threadId);
    await f.store.save({ ...stored, thread: { ...stored.thread, workspaceHandoff: { available: false, unavailableReason: "old" } } });
    expect((await f.backend.listThreads())[0]?.workspaceHandoff).toBeUndefined();

    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Remember PINEAPPLE" }] });
    await f.waitForTurn();
    const linkedDirectory = {
      id: `pwragent-handoff:claude:${threadId}`, kind: "worktree" as const, label: "checkout",
      path: previous, worktreePath: worktree,
    };
    await f.backend.moveWorkspace({ threadId, cwd: worktree, linkedDirectory });

    const moved = await f.store.read(threadId);
    expect(moved.cwd).toBe(worktree);
    expect(moved.sdkSessionId).toBe("5a85c1ad-85c1-4930-ae19-50f721ad13dd");
    expect(moved.sdkSessionDir).toBe(previous);
    expect(moved.thread.linkedDirectories).toEqual([
      linkedDirectory,
      { id: secondary, kind: "local", label: "other-repo", path: secondary },
    ]);
    expect(f.backend.liveSessionThreadIds()).toEqual([]);

    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Where are you?" }] });
    await f.waitForTurn();
    expect(f.queries[1]).toMatchObject({ cwd: worktree, resume: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" });
    expect(f.queries[1].additionalDirectories).toEqual([path.resolve(secondary)]);
  });

  it("refuses to move a thread while its turn runs", async () => {
    const finish = Promise.withResolvers<void>();
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      await finish.promise;
      yield { type: "result", subtype: "success", is_error: false, result: "Done" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Work" }] });
    try {
      expect(() => f.backend.assertWorkspaceMovable(threadId)).toThrow("Wait for the active Claude turn to finish");
      await expect(f.backend.moveWorkspace({
        threadId, cwd: path.join(f.root, "elsewhere"),
        linkedDirectory: { id: "elsewhere", kind: "local", label: "elsewhere", path: path.join(f.root, "elsewhere") },
      })).rejects.toThrow("Wait for the active Claude turn to finish");
      expect((await f.store.read(threadId)).cwd).toBe(f.root);
    } finally {
      finish.resolve();
      await f.waitForTurn();
    }
  });

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

  it("reports when a turn started, since a UUIDv4 turn id carries no time", async () => {
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["usage limit"] } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    const before = Date.now();
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Investigate" }] });
    await f.waitForTurn();
    const after = Date.now();
    const turnOf = (method: string) => {
      const event = f.events.find((candidate) => candidate.notification.method === method);
      return (event?.notification.params as { turn?: { startedAt?: number } } | undefined)?.turn;
    };
    const startedAt = turnOf("turn/started")?.startedAt;
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(startedAt).toBeLessThanOrEqual(after);
    expect(turnOf("turn/failed")?.startedAt).toBe(startedAt);
    const entries = await f.store.entries(threadId);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.turn?.startedAt).toBe(startedAt);
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

    it("registers the hooks for skipped findings and for CI waits", async () => {
      const f = await fixture();
      const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "/code-review high" }] });
      await f.waitForTurn();
      expect(f.queries[0]!.hooks?.PostToolUse?.map((matcher) => matcher.matcher))
        .toEqual(["ReportFindings", "Bash|Monitor"]);
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

    it("resolves the card's context from the pull requests the /code-review named", async () => {
      const f = await fixture(turns(report("review-1", { level: "medium", findings })));
      const resolveReviewContext = vi.fn().mockResolvedValue({ workspacePath: f.root });
      const backend = new ClaudeBackend({ ...f.backendOptions, resolveReviewContext });
      const { threadId } = await backend.startThread({ cwd: f.root, executionMode: "default" });
      await backend.startTurn({ threadId, input: [{ type: "text", text: "/code-review medium --fix 2947,2948" }] });
      await f.waitForTurn();

      // One report covers both pull requests, and it names neither.
      expect(resolveReviewContext).toHaveBeenCalledWith({
        threadId, cwd: f.root, pullRequests: [{ number: 2947 }, { number: 2948 }],
      });
      expect(reviewItems(f.events).map((item) => item.id)).toEqual(["review-1"]);
      await backend.close();
    });

    it("records a re-report's outcomes against the review it repeats", async () => {
      const f = await fixture(turns(
        report("review-1", { level: "high", findings }),
        report("review-2", { level: "high", findings: [
          { ...findings[1], outcome: "skipped" },
          { ...findings[0], outcome: "fixed" },
        ] }),
        [{ type: "result", subtype: "success", is_error: false, result: "" } as SDKMessage],
      ));
      const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "/code-review high" }] });
      await f.waitForTurn();
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Fix the first one." }] });
      await f.waitForTurn();
      expect(f.events.at(-1)?.notification).toMatchObject({ method: "turn/completed" });

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
      expect(entries.findLast((entry) => entry.type === "message" && entry.role === "user")?.turn?.status).toBe("completed");

      // Completed tool activity belongs to its turn, not the whole session.
      await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Continue" }] });
      await f.waitForTurn();
      expect(f.events.at(-1)?.notification).toMatchObject({ method: "turn/failed", params: {
        turn: { error: { message: "Claude completed without a response or any tool activity. Try sending the message again." } },
      } });
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
        { type: "text", text: "Focus on the PR" }, { type: "image", url: expect.stringMatching(/^pwragent-image:/) },
      ], turn: expect.objectContaining({ id: started.turnId, status: "completed" }) }),
    ]));
    expect(await iterator.next()).toMatchObject({ done: true });
    await expect(f.backend.steerTurn({ threadId, expectedTurnId: started.turnId, input: [] })).rejects.toThrow("no active turn");
  });

  it("interrupts with priority now and keeps the turn open past the cut response", async () => {
    // Shapes measured from CLI 0.3.301: the cut response ends in a success
    // result with terminal_reason "aborted_streaming" that does not
    // acknowledge the interjection; the answer to it arrives in the next one.
    const cut = Promise.withResolvers<void>();
    const cutProcessed = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    let interruptUuid: string | undefined;
    const f = await fixture(async function* () {
      await cut.promise;
      yield { type: "result", subtype: "success", is_error: false, stop_reason: null,
        terminal_reason: "aborted_streaming", result: "1\n2\n3" } as unknown as SDKMessage;
      cutProcessed.resolve();
      await answer.promise;
      yield { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn",
        terminal_reason: "completed", result: "BANANA", user_message_uuids: [interruptUuid] } as unknown as SDKMessage;
    });
    expect(f.backend.summary().capabilities.interruptSteerTurn).toBe(true);
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    const started = await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Count to 300" }] });
    const prompt = f.run.mock.calls[0][0].prompt;
    if (typeof prompt === "string") throw new Error("Expected streaming input");
    const iterator = prompt[Symbol.asyncIterator]();
    await iterator.next();
    await f.backend.steerTurn({ threadId, expectedTurnId: started.turnId, delivery: "now",
      input: [{ type: "text", text: "Stop. Say BANANA." }] });
    const streamed = (await iterator.next()).value;
    interruptUuid = streamed.uuid;
    expect(streamed).toMatchObject({ type: "user", priority: "now",
      message: { content: [{ type: "text", text: "Stop. Say BANANA." }] } });
    cut.resolve();
    await cutProcessed.promise;
    expect(f.events.some((event) => event.notification.method === "turn/completed")).toBe(false);
    answer.resolve();
    await f.waitForTurn();
    const completed = f.events.filter((event) => event.notification.method === "turn/completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.notification).toMatchObject({ params: { turn: { status: "completed" } } });
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
      yield { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "seven_day_overage_included",
        utilization: 0.95, resetsAt: Math.round(resetsAt / 1000) + 3600 } } as SDKMessage;
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
      expect.objectContaining({ name: "Weekly Fable limit", limitId: "seven_day_overage_included", usedPercent: 96 }),
    ];
    expect(f.backend.summary().rateLimits).toEqual(expected);

    const restarted = new ClaudeBackend(f.backendOptions);
    expect(restarted.summary().rateLimits).toBeUndefined();
    await vi.waitFor(async () => expect((await f.store.readRateLimits()).limits).toHaveLength(3));
    await restarted.discover({ models: false });
    expect(restarted.summary().rateLimits).toEqual(expected);
  });

  it("describes its limits as a dated Usage Activity reading for the signed-in account", async () => {
    const resetsAt = Date.now() + 86_400_000;
    const snapshot = { rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 12, resets_at: new Date(resetsAt).toISOString() },
      seven_day: { utilization: 56, resets_at: new Date(resetsAt).toISOString() },
    }, session: { model_usage: {} } };
    const accountInfo = vi.fn().mockResolvedValue({ apiProvider: "firstParty", email: "first@example.com", subscriptionType: "max" });
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
    }, { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn().mockResolvedValue(snapshot), accountInfo });
    expect(f.backend.limitObservation()).toBeUndefined();
    const before = Date.now();
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
    await f.waitForTurn();
    const account = await f.backend.usageAccountKey();
    expect(account).toMatch(/^[0-9a-f]{16}$/);
    const reading = f.backend.limitObservation()!;
    expect(reading).toMatchObject({ provider: "anthropic", accountKey: account, planType: "max", limits: [
      { name: "5-hour limit", limitId: "five_hour", usedPercent: 12, windowMinutes: 300 },
      { name: "Weekly limit", limitId: "seven_day", usedPercent: 56, windowMinutes: 10_080 },
    ] });
    expect(reading.observedAt).toBeGreaterThanOrEqual(before);

    // A restart reads back when the limits were reported, and for which plan.
    await vi.waitFor(async () => expect((await f.store.readRateLimits()).plan).toBe("max"));
    const restarted = new ClaudeBackend(f.backendOptions);
    await restarted.discover({ models: false });
    expect(await restarted.usageAccountKey()).toBe(account);
    expect(restarted.limitObservation()).toMatchObject({ accountKey: account, planType: "max",
      observedAt: (await f.store.readRateLimits()).observedAt });
  });

  it("names a turn's account only after its session confirms the signed-in account", async () => {
    const resetsAt = Date.now() + 86_400_000;
    const snapshot = { rate_limits_available: true, rate_limits: {
      seven_day: { utilization: 56, resets_at: new Date(resetsAt).toISOString() },
    }, session: { model_usage: {} } };
    const accountInfo = vi.fn().mockResolvedValueOnce({ apiProvider: "firstParty", email: "first@example.com" })
      .mockResolvedValue({ apiProvider: "firstParty", email: "second@example.com" });
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
    }, { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn().mockResolvedValue(snapshot), accountInfo });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
    await f.waitForTurn();

    // The registry asks for the account when the turn starts, as here; the
    // new session names the second account only after that.
    const emit = f.backendOptions.emit;
    const atStart: Array<Promise<string | undefined>> = [];
    f.backendOptions.emit = async (event) => {
      if (event.notification.method === "turn/started") atStart.push(f.backend.usageAccountKey(threadId));
      await emit(event);
    };
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
    await f.waitForTurn();
    const second = createHash("sha256").update(JSON.stringify(["firstParty", "", "second@example.com"])).digest("hex").slice(0, 16);
    expect(atStart).toHaveLength(1);
    expect(await atStart[0]).toBe(second);
  });

  it("does not date windows a sparse stream update left out as read now", async () => {
    const resetsAt = Date.now() + 86_400_000;
    const snapshot = { rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 10, resets_at: new Date(resetsAt).toISOString() },
      seven_day: { utilization: 56, resets_at: new Date(resetsAt).toISOString() },
    }, session: { model_usage: {} } };
    // The first turn reads the snapshot; later probes fail.
    const usage = vi.fn().mockResolvedValueOnce(snapshot).mockRejectedValue(new Error("Probe unavailable"));
    let turn = 0;
    const f = await fixture(async function* () {
      turn += 1;
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      if (turn === 2) {
        yield { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour",
          utilization: 0.2, resetsAt: Math.round(resetsAt / 1000) } } as SDKMessage;
      }
      if (turn === 3) {
        yield { type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: {
          five_hour: { utilization: 0.3, resetsAt: Math.round(resetsAt / 1000) },
          seven_day: { utilization: 0.6, resetsAt: Math.round(resetsAt / 1000) },
        } } } as unknown as SDKMessage;
      }
      yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
    }, { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
    await f.waitForTurn();
    const first = f.backend.limitObservation()!.observedAt;

    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 60_000);
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
    await f.waitForTurn();
    // The weekly window was not reported again, so the reading keeps its time.
    expect(f.backend.limitObservation()).toMatchObject({ observedAt: first,
      limits: [expect.objectContaining({ limitId: "five_hour", usedPercent: 20 }), expect.objectContaining({ limitId: "seven_day" })] });

    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
    await f.waitForTurn();
    // An update naming every window is a reading of all of them.
    expect(f.backend.limitObservation()!.observedAt).toBeGreaterThanOrEqual(first + 60_000);
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
      seven_day: { utilization: 35, resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString() },
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
    // Once the turn ends there is no session, so Claude Code's own config is
    // read through a probe instead.
    const readMcpServers = vi.fn().mockResolvedValue([{ name: "acme-docs", status: "pending" }]);
    const idle = new ClaudeBackend({ ...f.backendOptions, readMcpServers });
    expect(await idle.listMcpServers(threadId)).toEqual([{ name: "acme-docs", authStatus: "unsupported", startupStatus: "starting", tools: [] }]);
    expect(readMcpServers).toHaveBeenCalledWith(expect.objectContaining({ cwd: f.root }));
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
      { type: "image", url: expect.stringMatching(/^pwragent-image:/), alt: "inline.png" },
      { type: "file", name: "Report.txt", mimeType: "text/plain", sizeBytes: 12 },
    ];
    expect(replay.messages[0]).toMatchObject({ text: "Read these", parts });
    expect(replay.entries[0]).toMatchObject({ text: "Read these", parts });
    expect(f.events).toEqual(expect.arrayContaining([expect.objectContaining({ notification: expect.objectContaining({
      method: "item/completed", params: expect.objectContaining({ item: expect.objectContaining({ type: "userMessage", content: [
        parts[0], parts[1], { type: "image", url: "data:image/png;base64,aW1hZ2U=", alt: "inline.png" }, parts[3],
      ] }) }),
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

  it.each([
    { subtype: "success", is_error: true, result: "", expected: "Claude reported an error without details (success)." },
    { subtype: "success", is_error: true, result: "  \n", expected: "Claude reported an error without details (success)." },
    { subtype: "error_during_execution", is_error: true, errors: [], expected: "Claude reported an error without details (error_during_execution)." },
    { subtype: "error_during_execution", is_error: false, errors: ["Resume failed"], expected: "Resume failed" },
    { subtype: "error_max_turns", is_error: false, errors: [], expected: "Claude reached the maximum number of turns." },
    { subtype: "error_max_budget_usd", is_error: false, errors: ["  "], expected: "Claude reached the configured spending limit." },
    { subtype: "error_max_structured_output_retries", is_error: false, errors: [], expected: "Claude could not produce the required structured output." },
  ])("reports $subtype with is_error=$is_error even without error text", async ({ expected, ...result }) => {
    const f = await fixture(async function* () {
      yield { type: "result", ...result } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    const turn = await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Continue" }] });
    await f.waitForTurn();
    expect(f.events.filter((event) => event.notification.method.startsWith("turn/")))
      .toMatchObject([
        { notification: { method: "turn/started" } },
        { notification: { method: "turn/failed", params: { turn: { id: turn.turnId, error: { message: expected } } } } },
      ]);
    const restarted = new ClaudeBackend(f.backendOptions);
    const replay = await restarted.readThread(threadId);
    expect(replay.entries?.find((entry) => entry.type === "message")?.turn?.status).toBe("failed");
    expect((await f.backend.readThread(threadId)).threadStatus).toBe("idle");
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("fails a silent empty success instead of presenting an unanswered send as complete", async () => {
    const f = await fixture(async function* () {
      yield { type: "result", subtype: "success", is_error: false, num_turns: 0, result: "" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "What happened?" }] });
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification).toMatchObject({ method: "turn/failed", params: {
      turn: { error: { message: "Claude completed without a response or any tool activity. Try sending the message again." } },
    } });
  });

  it.each(["refusal", "max_tokens"])("fails a success result stopped by %s and permits a later send", async (stopReason) => {
    let attempts = 0;
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false,
        stop_reason: attempts++ === 0 ? stopReason : "end_turn", result: "Response" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Continue" }] });
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification).toMatchObject({ method: "turn/failed", params: {
      turn: { error: { message: stopReason === "refusal" ? "Response"
        : "Claude reached the output token limit before completing the response. Send another message to continue." } },
    } });
    expect((await f.backend.readThread(threadId)).threadStatus).toBe("idle");
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Try this revised request" }] });
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification.method).toBe("turn/completed");
  });

  it("provides a reason for an empty refusal result", async () => {
    const f = await fixture(async function* () {
      yield { type: "result", subtype: "success", is_error: false, stop_reason: "refusal", result: "" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Continue" }] });
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification).toMatchObject({ method: "turn/failed", params: {
      turn: { error: { message: "Claude declined the request. Review the request before continuing." } },
    } });
  });

  it("allows a slash command to complete without assistant output", async () => {
    const f = await fixture(async function* () {
      yield { type: "result", subtype: "success", is_error: false, num_turns: 0, result: "" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "/clear" }] });
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification.method).toBe("turn/completed");
  });

  it("allows tool activity to complete with an empty final answer", async () => {
    const f = await fixture(async function* () {
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "tool-only", content: [{ type: "tool_use", id: "read-only", name: "Read", input: { file_path: "fixture.txt" } }],
      } } as SDKMessage;
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-only", content: "fixture" }] } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Read the file" }] });
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification.method).toBe("turn/completed");
  });

  it.each(["empty result", "stream exit"])("preserves the parent API error through a later %s", async (ending) => {
    const f = await fixture(async function* () {
      yield { type: "assistant", parent_tool_use_id: null, error: "authentication_failed", message: {
        id: "auth-error", content: [{ type: "text", text: "Sign in again" }],
      } } as SDKMessage;
      if (ending === "empty result") yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [] } as unknown as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Continue" }] });
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification).toMatchObject({ method: "turn/failed", params: {
      turn: { error: { message: "Sign in again" } },
    } });
  });

  it.each([null, "subagent-tool"])("handles assistant errors only for the parent turn (parent=%s)", async (parent) => {
    const f = await fixture(async function* () {
      yield { type: "assistant", parent_tool_use_id: parent, error: "rate_limit", message: {
        id: "api-error", content: [{ type: "text", text: "Usage limit reached" }],
      } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "Done" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Continue" }] });
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification).toMatchObject(parent
      ? { method: "turn/completed" }
      : { method: "turn/failed", params: { turn: { error: { message: "Usage limit reached" } } } });
  });

  it("reports empty thrown errors and retains bounded CLI stderr for diagnosis", async () => {
    const f = await fixture(async function* (options) {
      options.stderr?.("x".repeat(8_192));
      options.stderr?.("\nfixture transport failed");
      yield* [];
      throw new Error("");
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Continue" }] });
    await f.waitForTurn();
    const event = f.events.at(-1)?.notification;
    expect(event).toMatchObject({ method: "turn/failed", params: { turn: { error: { message: expect.stringContaining("fixture transport failed") } } } });
    const params = event?.params as { turn: { error: { message: string } } };
    expect(params.turn.error.message.length).toBeLessThanOrEqual(4_096);
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

  it("ends the turn at its result while a background command keeps the session open, then carries Claude's follow-up", async () => {
    const commandDone = Promise.withResolvers<void>();
    const followUpDone = Promise.withResolvers<void>();
    const stopTask = vi.fn().mockResolvedValue(undefined);
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "launch", content: [{ type: "tool_use", id: "tool-bash", name: "Bash", input: { command: "pnpm dev", run_in_background: true } }],
      } } as SDKMessage;
      yield { type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "tool-bash",
        description: "Run the dev server", task_type: "local_bash", is_backgrounded: true } as SDKMessage;
      yield { type: "system", subtype: "background_tasks_changed", tasks: [
        { task_id: "task-1", task_type: "local_bash", description: "Run the dev server" },
      ] } as SDKMessage;
      yield { type: "user", parent_tool_use_id: null, tool_use_result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "task-1" },
        message: { content: [{ type: "tool_result", tool_use_id: "tool-bash", content: "Command running in background with ID: task-1" }] } } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "waiting", content: [{ type: "text", text: "The dev server is starting. I'll check on it when it reports back." }],
      } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "waiting" } as SDKMessage;
      await commandDone.promise;
      yield { type: "system", subtype: "task_notification", task_id: "task-1", tool_use_id: "tool-bash",
        status: "completed", output_file: "", summary: "Server exited" } as SDKMessage;
      yield { type: "system", subtype: "background_tasks_changed", tasks: [] } as unknown as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "resumed", content: [{ type: "text", text: "The dev server exited cleanly." }],
      } } as SDKMessage;
      await followUpDone.promise;
      yield { type: "result", subtype: "success", is_error: false, result: "done" } as SDKMessage;
    }, { stopTask });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    const started = await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Start the dev server" }] });
    await f.waitForTurn();
    expect(f.events.filter((event) => event.notification.method === "turn/completed")).toHaveLength(1);
    // The task outlives its turn, and so does the process that runs it.
    expect(f.close).not.toHaveBeenCalled();
    expect(f.backend.liveSessionThreadIds()).toEqual([threadId]);
    // Navigation marks the thread as working while the task runs.
    expect(f.backend.backgroundTaskThreadIds()).toEqual([threadId]);
    expect(f.backend.listBackgroundTasks(threadId).terminals).toEqual([{
      itemId: "tool-bash", processId: "task-1", command: "pnpm dev", cwd: f.root,
    }]);
    const between = await f.backend.readThread(threadId);
    expect(between.threadStatus).toBe("idle");
    expect((await f.backend.listThreads()).find((thread) => thread.id === threadId)?.threadStatus).toBe("idle");
    // The placeholder result does not complete the command's row.
    expect(between.entries.find((entry) => entry.id === "tool-bash")).toMatchObject({ status: "in_progress" });
    expect(f.events.some((event) => event.notification.method === "item/completed"
      && (event.notification.params.item as { id?: string }).id === "tool-bash")).toBe(false);
    await expect(f.backend.steerTurn({ threadId, expectedTurnId: started.turnId, input: [{ type: "text", text: "Late" }] }))
      .rejects.toThrow("no active turn");
    await expect(f.backend.setArchived(threadId, true)).rejects.toThrow("Stop Claude's background tasks before archiving.");
    await f.backend.stopBackgroundTask(threadId, "task-1");
    expect(stopTask).toHaveBeenCalledWith("task-1");

    commandDone.resolve();
    await vi.waitFor(() => expect(f.events.filter((event) => event.notification.method === "turn/started")).toHaveLength(2));
    const followUpId = (f.events.filter((event) => event.notification.method === "turn/started").at(-1)!
      .notification.params as { turn: { id: string } }).turn.id;
    expect(followUpId).not.toBe(started.turnId);
    expect((await f.backend.readThread(threadId)).threadStatus).toBe("active");
    await expect(f.backend.startTurn({ threadId, input: [{ type: "text", text: "Queued" }] }))
      .rejects.toBeInstanceOf(ClaudeTurnActiveError);
    // The row settles in the turn that ran the command.
    expect(f.events.find((event) => event.notification.method === "item/completed"
      && (event.notification.params.item as { id?: string }).id === "tool-bash")?.notification.params)
      .toMatchObject({ turnId: started.turnId, item: { status: "completed", aggregatedOutput: expect.stringContaining("Server exited") } });
    followUpDone.resolve();
    await f.waitForTurn();
    expect(f.close).toHaveBeenCalled();
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.backend.liveSessionThreadIds()).toEqual([]);
    expect(f.backend.backgroundTaskThreadIds()).toEqual([]);
    expect(f.events.filter((event) => event.notification.method === "turn/completed")).toHaveLength(2);
    expect(f.events.at(-1)?.notification).toMatchObject({ method: "turn/completed", params: { turnId: followUpId } });
    expect(f.events.filter((event) => event.notification.method === "thread/backgroundTasks/updated").at(-1)?.notification.params)
      .toMatchObject({ tasks: [] });
    expect(f.backend.listBackgroundTasks(threadId).terminals).toEqual([]);
    const replay = await f.backend.readThread(threadId);
    expect(replay.threadStatus).toBe("idle");
    expect(replay.lastAssistantMessage).toBe("The dev server exited cleanly.");
    expect(replay.entries.find((entry) => entry.id === "tool-bash")).toMatchObject({
      status: "completed", turn: { id: started.turnId, status: "completed" },
    });
    expect(replay.entries.find((entry) => entry.id === "resumed")).toMatchObject({ turn: { id: followUpId, status: "completed" } });
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
    const started = await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Probe" }] });
    await vi.waitFor(() => expect(f.backend.liveSessionThreadIds()).toEqual([]));
    await f.waitForTurn();
    const methods = f.events.map((event) => event.notification.method)
      .filter((method) => ["turn/started", "turn/completed", "item/completed"].includes(method));
    // The first turn ends at idle, before the command does; the follow-up is a turn of its own.
    expect(methods.indexOf("turn/completed")).toBeLessThan(f.events.findIndex((event) =>
      event.notification.method === "item/completed" && (event.notification.params.item as { id?: string }).id === "toolu_1"
      && (event.notification.params.item as { status?: string }).status === "completed"));
    expect(f.events.filter((event) => event.notification.method === "turn/started")).toHaveLength(2);
    expect(f.events.filter((event) => event.notification.method === "turn/completed")).toHaveLength(2);
    expect((await f.backend.readThread(threadId)).lastAssistantMessage).toBe("DONE");
    expect(f.events.find((event) => event.notification.method === "item/completed"
      && (event.notification.params.item as { id?: string }).id === "toolu_1"
      && (event.notification.params.item as { status?: string }).status !== "in_progress")?.notification.params)
      .toMatchObject({ turnId: started.turnId, item: { status: "completed" } });
  });

  it("keeps a background monitor the live set names running past its native result", async () => {
    const monitorDone = Promise.withResolvers<void>();
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "system", subtype: "background_tasks_changed", tasks: [
        { task_id: "monitor-1", task_type: "monitor_mcp", description: "Watch the deploy" },
      ] } as SDKMessage;
      // Monitors carry no is_backgrounded flag.
      yield { type: "system", subtype: "task_started", task_id: "monitor-1", description: "Watch the deploy", task_type: "monitor_mcp" } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: { id: "watching", content: [{ type: "text", text: "Watching." }] } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "watching" } as SDKMessage;
      await monitorDone.promise;
      yield { type: "system", subtype: "task_notification", task_id: "monitor-1", status: "completed", output_file: "", summary: "Deployed" } as SDKMessage;
      yield { type: "system", subtype: "background_tasks_changed", tasks: [] } as unknown as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: { id: "done", content: [{ type: "text", text: "Deployed." }] } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "done" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Watch" }] });
    await f.waitForTurn();
    expect(f.backend.listBackgroundTasks(threadId).terminals).toMatchObject([{ processId: "monitor-1", kind: "task" }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.close).not.toHaveBeenCalled();
    monitorDone.resolve();
    await vi.waitFor(() => expect(f.backend.liveSessionThreadIds()).toEqual([]));
    await f.waitForTurn();
    expect(f.events.filter((event) => event.notification.method === "turn/completed")).toHaveLength(2);
    expect((await f.backend.readThread(threadId)).lastAssistantMessage).toBe("Deployed.");
  });

  it("sends a new message into the live session and bills each turn its own share of the totals", async () => {
    const model = { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      costUSD: 2, contextWindow: 200_000, maxOutputTokens: 32_000, webSearchRequests: 0 };
    let second: SDKUserMessage | undefined;
    const f = await fixture(async function* (options, prompt) {
      const input = prompt[Symbol.asyncIterator]();
      await input.next();
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "launch", content: [{ type: "tool_use", id: "tool-bash", name: "Bash", input: { command: "pnpm dev", run_in_background: true } }],
      } } as SDKMessage;
      yield { type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "tool-bash",
        description: "pnpm dev", task_type: "local_bash", is_backgrounded: true } as SDKMessage;
      yield { type: "user", parent_tool_use_id: null, tool_use_result: { backgroundTaskId: "task-1" },
        message: { content: [{ type: "tool_result", tool_use_id: "tool-bash", content: "Command running in background with ID: task-1" }] } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "running", modelUsage: { opus: model } } as unknown as SDKMessage;
      second = (await input.next()).value as SDKUserMessage;
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: { id: "status", content: [{ type: "text", text: "Still serving." }] } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "Still serving.", user_message_uuids: [second.uuid],
        modelUsage: { opus: { ...model, inputTokens: 250, costUSD: 5 } } } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        options.abortController!.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    const first = await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Start the dev server" }] });
    await f.waitForTurn();
    const onSessionClosed = vi.fn();
    const next = await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Is it still up?" }], onSessionClosed });
    await f.waitForTurn();
    expect(f.run).toHaveBeenCalledOnce();
    expect(second).toMatchObject({ type: "user", priority: "next", message: { content: [{ type: "text", text: "Is it still up?" }] } });
    expect(f.events.filter((event) => event.notification.method === "thread/tokenUsage/updated").map((event) => event.notification.params))
      .toMatchObject([
        { turnId: first.turnId, tokenUsage: { claudeCostUSD: 2, last: { inputTokens: 100 } } },
        { turnId: next.turnId, tokenUsage: { claudeCostUSD: 3, last: { inputTokens: 150 } } },
      ]);
    expect((await f.backend.readThread(threadId)).entries.flatMap((entry) =>
      entry.type === "message" ? [[entry.text, entry.turn?.id]] : [])).toEqual([
      ["Start the dev server", first.turnId], ["Is it still up?", next.turnId], ["Still serving.", next.turnId],
    ]);
    // The session holds the turn's MCP grants until it closes.
    expect(onSessionClosed).not.toHaveBeenCalled();
    await f.backend.close();
    expect(onSessionClosed).toHaveBeenCalledOnce();
    expect(f.backend.liveSessionThreadIds()).toEqual([]);
    // The command died with the process, after the turn that ran it ended.
    expect(f.events.findLast((event) => event.notification.method === "item/completed"
      && (event.notification.params.item as { id?: string }).id === "tool-bash")?.notification.params)
      .toMatchObject({ turnId: first.turnId, item: { status: "cancelled" } });
    expect((await f.store.read(threadId)).modelUsage?.opus.costUSD).toBe(5);
  });

  it("applies a later turn's settings to the live session without stopping its tasks", async () => {
    let answers = 0;
    const controls = {
      setModel: vi.fn().mockResolvedValue(undefined),
      applyFlagSettings: vi.fn().mockResolvedValue(undefined),
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
      setMcpServers: vi.fn().mockResolvedValue({ added: [], removed: [], errors: {} }),
    };
    const f = await fixture(async function* (_options, prompt) {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "system", subtype: "task_started", task_id: "task-1", description: "pnpm dev", task_type: "local_bash", is_backgrounded: true } as SDKMessage;
      for await (const message of prompt) {
        answers += 1;
        yield { type: "assistant", parent_tool_use_id: null, message: { id: `answer-${answers}`, content: [{ type: "text", text: "OK" }] } } as SDKMessage;
        yield { type: "result", subtype: "success", is_error: false, result: "OK",
          ...(message.uuid ? { user_message_uuids: [message.uuid] } : {}) } as unknown as SDKMessage;
      }
    }, controls);
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Start" }], model: "opus" });
    await f.waitForTurn();
    const mcpServers = { crm: { type: "http" as const, url: "http://127.0.0.1:9/mcp" } };
    const settings = { model: "sonnet", reasoningEffort: "high", executionMode: "auto" as const, mcpServers };
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Next" }], ...settings });
    await f.waitForTurn();
    expect(f.run).toHaveBeenCalledOnce();
    expect(controls.setModel).toHaveBeenCalledWith("sonnet");
    expect(controls.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: "high" });
    expect(controls.setPermissionMode).toHaveBeenCalledWith("auto");
    expect(controls.setMcpServers).toHaveBeenCalledWith(mcpServers);
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Again" }], ...settings });
    await f.waitForTurn();
    expect(controls.setModel).toHaveBeenCalledOnce();
    // Only a new process takes new instructions; the running task keeps this one.
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Be brief" }], ...settings, instructions: "Be brief." });
    await f.waitForTurn();
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.events.filter((event) => event.notification.method === "turn/completed")).toHaveLength(4);
    // A change Claude rejects fails the message rather than the task.
    controls.setPermissionMode.mockRejectedValueOnce(new Error("Unsupported mode"));
    await expect(f.backend.startTurn({ threadId, input: [{ type: "text", text: "Full access" }], ...settings,
      executionMode: "full-access" })).rejects.toThrow("Claude could not apply this message's settings while its background tasks run: Unsupported mode");
    expect(f.close).not.toHaveBeenCalled();
    expect(f.backend.listBackgroundTasks(threadId).terminals).toHaveLength(1);
    await f.backend.close();
  });

  it("relaunches for new instructions once no task would stop with the process", async () => {
    const firstGrants = vi.fn();
    const secondGrants = vi.fn();
    let releasedAtRelaunch: number | undefined;
    const f = await fixture(async function* (options) {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      if (options.resume) {
        releasedAtRelaunch = firstGrants.mock.calls.length;
        yield { type: "assistant", parent_tool_use_id: null, message: { id: "brief", content: [{ type: "text", text: "Brief." }] } } as SDKMessage;
        yield { type: "result", subtype: "success", is_error: false, result: "Brief." } as SDKMessage;
        return;
      }
      yield { type: "system", subtype: "task_started", task_id: "task-1", description: "sleep", task_type: "local_bash", is_backgrounded: true } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: { id: "waiting", content: [{ type: "text", text: "Waiting." }] } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "waiting" } as SDKMessage;
      yield { type: "system", subtype: "task_notification", task_id: "task-1", status: "completed", output_file: "", summary: "done" } as SDKMessage;
      // The session now waits for a follow-up, with no task left to lose.
      await new Promise<void>((resolve) => {
        options.abortController!.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const backend = new ClaudeBackend({ ...f.backendOptions, taskFollowUpGraceMs: 60_000 });
    const { threadId } = await backend.startThread({ cwd: f.root, executionMode: "default" });
    await backend.startTurn({ threadId, input: [{ type: "text", text: "Sleep" }], onSessionClosed: firstGrants });
    await f.waitForTurn();
    await vi.waitFor(() => expect(backend.listBackgroundTasks(threadId).terminals).toEqual([]));
    expect(backend.liveSessionThreadIds()).toEqual([threadId]);
    await backend.startTurn({ threadId, input: [{ type: "text", text: "Be brief" }], instructions: "Be brief.",
      onSessionClosed: secondGrants });
    await f.waitForTurn();
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.queries[1]).toMatchObject({ resume: "5a85c1ad-85c1-4930-ae19-50f721ad13dd", systemPrompt: { append: "Be brief." } });
    expect(f.events.at(-1)?.notification.method).toBe("turn/completed");
    // The relaunching turn registered the same thread grants again, so the
    // old session must not revoke them out from under the new one.
    expect(releasedAtRelaunch).toBe(0);
    // Both grants go when the relaunched session closes.
    await vi.waitFor(() => expect(secondGrants).toHaveBeenCalledOnce());
    expect(firstGrants).toHaveBeenCalledOnce();
  });

  it("relaunches with a newly set environment once no task would stop with the process", async () => {
    const f = await fixture(async function* (options) {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      if (options.resume) {
        yield { type: "assistant", parent_tool_use_id: null, message: { id: "built", content: [{ type: "text", text: "Built." }] } } as SDKMessage;
        yield { type: "result", subtype: "success", is_error: false, result: "Built." } as SDKMessage;
        return;
      }
      yield { type: "system", subtype: "task_started", task_id: "task-1", description: "sleep", task_type: "local_bash", is_backgrounded: true } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: { id: "waiting", content: [{ type: "text", text: "Waiting." }] } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "waiting" } as SDKMessage;
      yield { type: "system", subtype: "task_notification", task_id: "task-1", status: "completed", output_file: "", summary: "done" } as SDKMessage;
      await new Promise<void>((resolve) => {
        options.abortController!.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const backend = new ClaudeBackend({ ...f.backendOptions, taskFollowUpGraceMs: 60_000 });
    const { threadId } = await backend.startThread({ cwd: f.root, executionMode: "default" });
    await backend.startTurn({ threadId, input: [{ type: "text", text: "Sleep" }] });
    await f.waitForTurn();
    await vi.waitFor(() => expect(backend.listBackgroundTasks(threadId).terminals).toEqual([]));
    expect(f.queries[0]!.env?.NVM_DIR).not.toBe("/fixture/nvm");

    // The operator picked an environment; only a new process takes its PATH.
    await backend.startTurn({ threadId, input: [{ type: "text", text: "Build" }],
      shellEnvironment: { PATH: "/fixture/node/bin:/usr/bin", NVM_DIR: "/fixture/nvm" } });
    await f.waitForTurn();
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.queries[1]).toMatchObject({
      resume: "5a85c1ad-85c1-4930-ae19-50f721ad13dd",
      env: expect.objectContaining({ PATH: "/fixture/node/bin:/usr/bin", NVM_DIR: "/fixture/nvm" }),
    });
    expect(f.events.at(-1)?.notification.method).toBe("turn/completed");
  });

  it("runs a Plan turn in Claude's plan mode and shows its proposal as a plan card", async () => {
    const f = await fixture(async function* (options) {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      if (options.permissionMode === "plan") {
        yield { type: "assistant", parent_tool_use_id: null, message: { id: "propose", content: [
          { type: "tool_use", id: "exit-plan", name: "ExitPlanMode", input: { plan: "## Plan\n1. Fix the lock\n2. Add a test" } },
        ] } } as SDKMessage;
        yield { type: "user", parent_tool_use_id: null, message: { content: [
          { type: "tool_result", tool_use_id: "exit-plan", content: "The operator has your plan.", is_error: true },
        ] } } as SDKMessage;
      }
      yield { type: "assistant", parent_tool_use_id: null, message: { id: `reply-${options.permissionMode}`, content: [{ type: "text", text: "Ready." }] } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "Ready." } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Plan the fix" }], collaborationMode: { mode: "plan" } });
    await f.waitForTurn();
    expect(f.queries[0].permissionMode).toBe("plan");
    expect(f.events.find((event) => event.notification.method === "item/completed"
      && (event.notification.params.item as { type?: string }).type === "plan")?.notification.params)
      .toMatchObject({ threadId, item: { id: "exit-plan", type: "plan", text: "## Plan\n1. Fix the lock\n2. Add a test" } });
    const entries = (await f.backend.readThread(threadId)).entries;
    expect(entries.filter((entry) => entry.type === "activity")).toEqual([]);
    expect(entries.find((entry) => entry.type === "plan")).toMatchObject({ id: "exit-plan", markdown: "## Plan\n1. Fix the lock\n2. Add a test" });
    // Plan applies to its own turn only.
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Implement it" }] });
    await f.waitForTurn();
    expect(f.queries[1].permissionMode).toBe("default");
  });

  it("gives Claude every directory linked to the thread except its working directory", async () => {
    const f = await fixture();
    const other = path.join(f.root, "other");
    const worktree = path.join(f.root, "wt");
    const attached = path.join(f.root, "attached");
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default", linkedDirectories: [
      { id: f.root, kind: "local", label: "root", path: f.root },
      { id: other, kind: "worktree", label: "other", path: other, worktreePath: worktree },
    ] });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }], attachedDirectories: [
      { id: attached, kind: "local", label: "attached", path: attached },
      { id: f.root, kind: "local", label: "root", path: f.root },
    ] });
    await f.waitForTurn();
    expect(f.queries[0].additionalDirectories).toEqual([attached, worktree].sort());
  });

  it("relaunches to give Claude a newly attached directory once no task would stop", async () => {
    const f = await fixture(async function* (options) {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      if (options.resume) {
        yield { type: "assistant", parent_tool_use_id: null, message: { id: "seen", content: [{ type: "text", text: "Seen." }] } } as SDKMessage;
        yield { type: "result", subtype: "success", is_error: false, result: "Seen." } as SDKMessage;
        return;
      }
      yield { type: "system", subtype: "task_started", task_id: "task-1", description: "sleep", task_type: "local_bash", is_backgrounded: true } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "waiting" } as SDKMessage;
      yield { type: "system", subtype: "task_notification", task_id: "task-1", status: "completed", output_file: "", summary: "done" } as SDKMessage;
      await new Promise<void>((resolve) => {
        options.abortController!.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const backend = new ClaudeBackend({ ...f.backendOptions, taskFollowUpGraceMs: 60_000 });
    const { threadId } = await backend.startThread({ cwd: f.root, executionMode: "default" });
    await backend.startTurn({ threadId, input: [{ type: "text", text: "Sleep" }] });
    await f.waitForTurn();
    await vi.waitFor(() => expect(backend.listBackgroundTasks(threadId).terminals).toEqual([]));
    const attached = path.join(f.root, "attached");
    await backend.startTurn({ threadId, input: [{ type: "text", text: "Look there" }],
      attachedDirectories: [{ id: attached, kind: "local", label: "attached", path: attached }] });
    await f.waitForTurn();
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.queries[0].additionalDirectories).toBeUndefined();
    expect(f.queries[1]).toMatchObject({ resume: "5a85c1ad-85c1-4930-ae19-50f721ad13dd", additionalDirectories: [attached] });
  });

  it("refuses to fork a thread while its turn is running", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      await gate;
      yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Hi" }] });
    await expect(f.backend.forkThread({ sourceThreadId: threadId, cwd: f.root, executionMode: "default" }))
      .rejects.toThrow("finish before forking");
    finish();
    await f.waitForTurn();
    await expect(f.backend.forkThread({ sourceThreadId: threadId, cwd: f.root, executionMode: "default" })).resolves.toBeDefined();
  });

  it("forks a thread: copies its history and continues its session in a new one", async () => {
    let call = 0;
    const usage = vi.fn().mockResolvedValue({ session: { model_usage: { opus: {
      inputTokens: 40, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      costUSD: 0.4, contextWindow: 200_000, maxOutputTokens: 32_000, webSearchRequests: 0,
    } } } });
    const f = await fixture(async function* () {
      call += 1;
      const sessionId = call === 1 ? "5a85c1ad-85c1-4930-ae19-50f721ad13dd" : "f0f0f0f0-0000-4000-8000-000000000002";
      yield { type: "system", subtype: "init", session_id: sessionId } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: { id: `reply-${call}`, content: [{ type: "text", text: `Reply ${call}` }] } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: `Reply ${call}` } as SDKMessage;
    }, { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage } as Partial<Query>);
    const { threadId: sourceId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId: sourceId, input: [{ type: "text", text: "Remember PINEAPPLE" }] });
    await f.waitForTurn();
    await expect(f.backend.forkThread({ sourceThreadId: (await f.backend.startThread({ cwd: f.root, executionMode: "default" })).threadId,
      cwd: f.root, executionMode: "default" })).rejects.toThrow("no conversation to fork");

    const forkCwd = path.join(f.root, "fork-worktree");
    const { threadId } = await f.backend.forkThread({ sourceThreadId: sourceId, cwd: forkCwd, executionMode: "auto" });
    const fork = await f.backend.readThread(threadId);
    expect(fork.lastUserMessage).toBe("Remember PINEAPPLE");
    expect(fork.lastAssistantMessage).toBe("Reply 1");
    expect((await f.store.read(threadId)).thread).toMatchObject({ title: expect.stringContaining("(fork)"), executionMode: "auto" });
    // A fork of a fork that has not sent anything continues the same source.
    const { threadId: nestedId } = await f.backend.forkThread({ sourceThreadId: threadId, cwd: forkCwd, executionMode: "default" });
    expect((await f.store.read(nestedId)).forkFromSdkSessionId).toBe("5a85c1ad-85c1-4930-ae19-50f721ad13dd");
    expect((await f.backend.readThread(nestedId)).lastAssistantMessage).toBe("Reply 1");

    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "What did I ask?" }] });
    await f.waitForTurn();
    expect(f.queries[1]).toMatchObject({ cwd: forkCwd, resume: "5a85c1ad-85c1-4930-ae19-50f721ad13dd", forkSession: true });
    expect(f.queries[1].sessionId).toBeUndefined();
    // The fork reads its starting totals, so the copied history is not billed again.
    expect(usage).toHaveBeenCalled();
    const saved = await f.store.read(threadId);
    expect(saved.sdkSessionId).toBe("f0f0f0f0-0000-4000-8000-000000000002");
    expect(saved.forkFromSdkSessionId).toBeUndefined();
    // The source keeps its own session.
    expect((await f.store.read(sourceId)).sdkSessionId).toBe("5a85c1ad-85c1-4930-ae19-50f721ad13dd");

    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Again" }] });
    await f.waitForTurn();
    expect(f.queries[2]).toMatchObject({ resume: "f0f0f0f0-0000-4000-8000-000000000002" });
    expect(f.queries[2].forkSession).toBeUndefined();
  });

  describe("stopping a turn while a background task runs", () => {
    const capabilities = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1"];
    async function stoppable(params: { capabilities?: string[]; answer?: boolean; interruptGraceMs?: number } = {}) {
      const interrupted = Promise.withResolvers<void>();
      const interrupt = vi.fn(async () => {
        interrupted.resolve();
        return { still_queued: [], cancelled: [] };
      });
      const f = await fixture(async function* (options) {
        // The SDK ends its stream when the query is aborted.
        const aborted = new Promise<void>((resolve) => {
          options.abortController!.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd",
          ...(params.capabilities ? { capabilities: params.capabilities } : {}) } as SDKMessage;
        yield { type: "assistant", parent_tool_use_id: null, message: {
          id: "launch", content: [{ type: "tool_use", id: "tool-bash", name: "Bash", input: { command: "pnpm dev", run_in_background: true } }],
        } } as SDKMessage;
        yield { type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "tool-bash",
          description: "pnpm dev", task_type: "local_bash", is_backgrounded: true } as SDKMessage;
        yield { type: "user", parent_tool_use_id: null, tool_use_result: { backgroundTaskId: "task-1" },
          message: { content: [{ type: "tool_result", tool_use_id: "tool-bash", content: "Command running in background with ID: task-1" }] } } as SDKMessage;
        yield { type: "assistant", parent_tool_use_id: null, message: { id: "reading", content: [{ type: "text", text: "Reading the logs." }] } } as SDKMessage;
        await Promise.race([interrupted.promise, aborted]);
        if (options.abortController!.signal.aborted) return;
        if (params.answer !== false) {
          yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Request interrupted by user"] } as unknown as SDKMessage;
        }
        await aborted;
      }, { interrupt });
      const backend = new ClaudeBackend({ ...f.backendOptions, interruptGraceMs: params.interruptGraceMs ?? 5_000 });
      const { threadId } = await backend.startThread({ cwd: f.root, executionMode: "default" });
      const turn = await backend.startTurn({ threadId, input: [{ type: "text", text: "Start the dev server" }] });
      await vi.waitFor(() => expect(backend.listBackgroundTasks(threadId).terminals).toHaveLength(1));
      await vi.waitFor(() => expect((backend.readThread(threadId)).then((replay) => replay.lastAssistantMessage))
        .resolves.toBe("Reading the logs."));
      return { ...f, backend, threadId, turn, interrupt };
    }

    it("interrupts Claude and keeps the process for the task", async () => {
      const f = await stoppable({ capabilities });
      await f.backend.interruptTurn(f.turn);
      expect(f.interrupt).toHaveBeenCalledWith({ cancelQueued: true });
      expect(f.events.at(-1)?.notification).toMatchObject({ method: "turn/cancelled", params: { turnId: f.turn.turnId } });
      expect(f.close).not.toHaveBeenCalled();
      expect(f.backend.liveSessionThreadIds()).toEqual([f.threadId]);
      expect(f.backend.listBackgroundTasks(f.threadId).terminals).toMatchObject([{ processId: "task-1" }]);
      const replay = await f.backend.readThread(f.threadId);
      expect(replay.threadStatus).toBe("idle");
      expect(replay.entries.find((entry) => entry.id === "tool-bash")).toMatchObject({ status: "in_progress" });
      await f.backend.close();
      expect(f.events.findLast((event) => event.notification.method === "item/completed"
        && (event.notification.params.item as { id?: string }).id === "tool-bash")?.notification.params)
        .toMatchObject({ item: { status: "cancelled" } });
    });

    it("ends the turn itself when Claude does not answer the interrupt", async () => {
      const f = await stoppable({ capabilities, answer: false, interruptGraceMs: 20 });
      await f.backend.interruptTurn(f.turn);
      expect(f.events.at(-1)?.notification).toMatchObject({ method: "turn/cancelled", params: { turnId: f.turn.turnId } });
      expect(f.close).not.toHaveBeenCalled();
      expect(f.backend.liveSessionThreadIds()).toEqual([f.threadId]);
      await f.backend.close();
    });

    it("ends the query at shutdown even when the CLI could keep its tasks", async () => {
      const f = await stoppable({ capabilities });
      await f.backend.interruptTurn(f.turn, { keepTasks: false });
      expect(f.interrupt).not.toHaveBeenCalled();
      expect(f.close).toHaveBeenCalled();
      expect(f.events.at(-1)?.notification.method).toBe("turn/cancelled");
      expect(f.backend.liveSessionThreadIds()).toEqual([]);
    });

    it("ends the turn at once when the interrupt dropped a prompt Claude had not started", async () => {
      let queued: SDKUserMessage | undefined;
      const interrupt = vi.fn(async () => ({ still_queued: [], cancelled: [queued!.uuid!] }));
      const f = await fixture(async function* (options, prompt) {
        const input = prompt[Symbol.asyncIterator]();
        await input.next();
        yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd", capabilities } as SDKMessage;
        yield { type: "system", subtype: "session_state_changed", state: "running" } as SDKMessage;
        yield { type: "system", subtype: "task_started", task_id: "task-1", description: "pnpm dev", task_type: "local_bash", is_backgrounded: true } as SDKMessage;
        yield { type: "assistant", parent_tool_use_id: null, message: { id: "serving", content: [{ type: "text", text: "Serving." }] } } as SDKMessage;
        yield { type: "result", subtype: "success", is_error: false, result: "Serving." } as SDKMessage;
        yield { type: "system", subtype: "session_state_changed", state: "idle" } as SDKMessage;
        queued = (await input.next()).value as SDKUserMessage;
        await new Promise<void>((resolve) => {
          options.abortController!.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }, { interrupt });
      const backend = new ClaudeBackend({ ...f.backendOptions, interruptGraceMs: 60_000 });
      const { threadId } = await backend.startThread({ cwd: f.root, executionMode: "default" });
      await backend.startTurn({ threadId, input: [{ type: "text", text: "Start the dev server" }] });
      await f.waitForTurn();
      const next = await backend.startTurn({ threadId, input: [{ type: "text", text: "Never mind" }] });
      await vi.waitFor(() => expect(queued).toBeDefined());
      await backend.interruptTurn(next);
      expect(interrupt).toHaveBeenCalledWith({ cancelQueued: true });
      expect(f.events.at(-1)?.notification).toMatchObject({ method: "turn/cancelled", params: { turnId: next.turnId } });
      expect(f.close).not.toHaveBeenCalled();
      expect(backend.listBackgroundTasks(threadId).terminals).toHaveLength(1);
      await backend.close();
    });

    it("ends the query when the CLI cannot drop queued messages", async () => {
      const f = await stoppable();
      await f.backend.interruptTurn(f.turn);
      expect(f.interrupt).not.toHaveBeenCalled();
      expect(f.close).toHaveBeenCalled();
      expect(f.events.at(-1)?.notification.method).toBe("turn/cancelled");
      expect(f.backend.liveSessionThreadIds()).toEqual([]);
    });
  });

  it("closes a background launch row that no task event ever settled", async () => {
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "launch", content: [{ type: "tool_use", id: "tool-bg", name: "Bash", input: { command: "sleep 60", run_in_background: true } }],
      } } as SDKMessage;
      yield { type: "user", parent_tool_use_id: null, tool_use_result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bg-1" },
        message: { content: [{ type: "tool_result", tool_use_id: "tool-bg", content: "Command running in background with ID: bg-1" }] } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "started" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Start" }] });
    await f.waitForTurn();
    const row = (await f.backend.readThread(threadId)).entries.find((entry) => entry.type === "activity");
    expect(row).toMatchObject({ status: "failed" });
  });

  it("settles a completed background sub-agent's tool row with its summary", async () => {
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "spawn", content: [{ type: "tool_use", id: "tool-agent", name: "Agent", input: { description: "Audit the SDK" } }],
      } } as SDKMessage;
      yield { type: "system", subtype: "task_started", task_id: "agent-1", tool_use_id: "tool-agent", description: "Audit the SDK",
        task_type: "local_agent", subagent_type: "Explore", is_backgrounded: true } as SDKMessage;
      yield { type: "user", parent_tool_use_id: null, tool_use_result: { status: "async_launched", agentId: "agent-1" },
        message: { content: [{ type: "tool_result", tool_use_id: "tool-agent", content: "Async agent launched." }] } } as SDKMessage;
      yield { type: "system", subtype: "task_notification", task_id: "agent-1", tool_use_id: "tool-agent",
        status: "completed", output_file: "", summary: "Audit done" } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "done" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Audit" }] });
    await f.waitForTurn();
    await vi.waitFor(async () => expect((await f.backend.readThread(threadId)).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "tool-agent", status: "completed", details: [expect.objectContaining({
        label: "Agent", status: "completed",
        command: expect.objectContaining({ rawCommand: "Agent", source: "tool", output: "Async agent launched.\n\nAudit done" }),
      })] }),
    ])));
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
      // The sub-agent's own messages never open a turn.
      yield { type: "assistant", parent_tool_use_id: "tool-agent", message: {
        id: "sub", content: [{ type: "text", text: "Reading the SDK." }],
      } } as SDKMessage;
      yield { type: "system", subtype: "task_progress", task_id: "agent-1", tool_use_id: "tool-agent", description: "Audit the SDK",
        usage: { total_tokens: 10, tool_uses: 3, duration_ms: 5 }, last_tool_name: "Grep" } as SDKMessage;
      await agentDone.promise;
      yield { type: "system", subtype: "task_notification", task_id: "agent-1", tool_use_id: "tool-agent",
        status: "stopped", output_file: "", summary: "Stopped" } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "noted" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    const started = await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Audit" }] });
    await f.waitForTurn();
    await vi.waitFor(() => expect(f.backend.listBackgroundTasks(threadId).terminals).toEqual([{
      itemId: "tool-agent", processId: "agent-1", command: "Audit the SDK", cwd: f.root,
      kind: "agent", agentType: "Explore", progress: "3 tool uses · last Grep",
    }]));
    expect(f.events.filter((event) => event.notification.method === "turn/started")).toHaveLength(1);
    agentDone.resolve();
    await vi.waitFor(() => expect(f.backend.liveSessionThreadIds()).toEqual([]));
    expect(f.events.filter((event) => event.notification.method === "turn/completed")).toHaveLength(1);
    expect(f.events.find((event) => event.notification.method === "item/completed"
      && (event.notification.params.item as { id?: string }).id === "tool-agent")?.notification.params)
      .toMatchObject({ turnId: started.turnId, item: { status: "cancelled" } });
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

  it("closes the session when Claude runs no follow-up for a settled task", async () => {
    const f = await fixture(async function* () {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      yield { type: "system", subtype: "task_started", task_id: "task-1", description: "sleep", task_type: "local_bash", is_backgrounded: true } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: { id: "waiting", content: [{ type: "text", text: "Sleeping." }] } } as SDKMessage;
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
    expect(f.events.at(-1)?.notification.method).toBe("turn/completed");
    await vi.waitFor(() => expect(backend.liveSessionThreadIds()).toEqual([]));
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.events.filter((event) => event.notification.method === "turn/started")).toHaveLength(1);
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
      turn: { error: { message: "Claude reported an error without details (error_during_execution)." } },
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
    const handler = createClaudePermissionHandler({ threadId: "thread", turnId: () => "turn", request, cancelRequest: async () => {} });
    const result = await handler("Bash", { command: "git status" }, { signal: new AbortController().signal, toolUseID: "tool", requestId: "sdk-request" });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: "item/commandExecution/requestApproval",
      params: expect.objectContaining({ command: "git status", threadId: "thread", turnId: "turn" }),
    }), expect.any(AbortSignal));
    expect(result?.behavior).toBe(behavior);
    expect(result).not.toHaveProperty("updatedPermissions");
  });

  it("answers a request to leave plan mode without an approval card", async () => {
    const request = vi.fn();
    const handler = createClaudePermissionHandler({ threadId: "thread", turnId: () => "turn", planTurn: () => true, request, cancelRequest: async () => {} });
    const result = await handler("ExitPlanMode", { plan: "1. Do it" }, { signal: new AbortController().signal, toolUseID: "tool", requestId: "sdk-request" });
    expect(request).not.toHaveBeenCalled();
    expect(result).toMatchObject({ behavior: "deny", message: expect.stringContaining("end your turn") });
  });

  it("asks the operator before Claude leaves a plan mode it entered on its own", async () => {
    const request = vi.fn().mockResolvedValue({ decision: "accept" });
    const handler = createClaudePermissionHandler({ threadId: "thread", turnId: () => "turn", planTurn: () => false, request, cancelRequest: async () => {} });
    const result = await handler("ExitPlanMode", { plan: "1. Do it" }, { signal: new AbortController().signal, toolUseID: "tool", requestId: "sdk-request" });
    expect(request).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ behavior: "allow" });
  });

  it("settles and removes a pending approval on cancellation", async () => {
    const controller = new AbortController();
    const cancelRequest = vi.fn().mockResolvedValue(undefined);
    const handler = createClaudePermissionHandler({
      threadId: "thread", turnId: () => "turn", cancelRequest,
      request: async () => await new Promise(() => {}),
    });
    const result = handler("Write", { file_path: "/fixture/file" }, { signal: controller.signal, toolUseID: "tool", requestId: "sdk-request" });
    controller.abort();
    await expect(result).resolves.toMatchObject({ behavior: "deny", interrupt: true });
    expect(cancelRequest).toHaveBeenCalledOnce();
  });

  it("returns questionnaire answers in the SDK tool input", async () => {
    const handler = createClaudePermissionHandler({
      threadId: "thread", turnId: () => "turn", cancelRequest: async () => {},
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
    const handler = createClaudeElicitationHandler({ threadId: "thread", turnId: () => "turn", request, cancelRequest: async () => {} });

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
    const handler = createClaudeElicitationHandler({ threadId: "thread", turnId: () => "turn", request, cancelRequest: async () => {} });

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
      threadId: "thread", turnId: () => "turn", cancelRequest: async () => {},
      request: vi.fn().mockResolvedValue(response),
    });

    await expect(handler({ serverName: "crm", message: "Continue?", mode: "form",
      requestedSchema: { type: "object", properties: {} } }, signal())).resolves.toEqual(expected);
  });

  it("withdraws the card and dismisses the request when the turn stops", async () => {
    const controller = new AbortController();
    const cancelRequest = vi.fn().mockResolvedValue(undefined);
    const handler = createClaudeElicitationHandler({
      threadId: "thread", turnId: () => "turn", cancelRequest,
      request: async () => await new Promise(() => {}),
    });
    const result = handler({ serverName: "crm", message: "Continue?" }, { signal: controller.signal, requestId: "sdk-request" });
    controller.abort();

    await expect(result).resolves.toEqual({ action: "cancel" });
    expect(cancelRequest).toHaveBeenCalledOnce();
  });
});

describe("Claude transcript fidelity", () => {
  const init = { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
  const result = { type: "result", subtype: "success", is_error: false, result: "done" } as SDKMessage;
  const call = (id: string, name: string, input: Record<string, unknown>) => ({
    type: "assistant", parent_tool_use_id: null, message: { id: `message-${id}`, content: [{ type: "tool_use", id, name, input }] },
  }) as SDKMessage;
  const answer = (id: string, content: string, toolUseResult?: unknown) => ({
    type: "user", parent_tool_use_id: null, tool_use_result: toolUseResult,
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
  }) as SDKMessage;

  it("shows a successful edit as a diff, live and in the replay", async () => {
    let cwd = "";
    const f = await fixture(async function* () {
      yield init;
      yield call("edit-1", "Edit", { file_path: path.join(cwd, "src", "app.ts"), old_string: "a", new_string: "b" });
      yield answer("edit-1", "The file has been updated.", {
        filePath: path.join(cwd, "src", "app.ts"), oldString: "a", newString: "b", originalFile: "a\n",
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
        userModified: false, replaceAll: false,
      });
      yield result;
    });
    cwd = f.root;
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Edit" }] });
    await f.waitForTurn();
    const diffEvent = f.events.find((event) => event.notification.method === "turn/diff/updated");
    expect(diffEvent?.notification.params).toMatchObject({
      threadId, diff: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-a\n+b",
    });
    const row = (await f.backend.readThread(threadId)).entries.find((entry) => entry.type === "activity");
    expect(row).toMatchObject({ summary: "Edited app.ts", status: "completed", details: [{
      kind: "write", label: "Edited app.ts", path: path.join(f.root, "src", "app.ts"),
      fileDiff: { kind: "update", additions: 1, removals: 1, diff: expect.stringContaining("+b") },
    }] });
  });

  it("draws a tool result's images on its row instead of their base64, live and in the replay", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    let cwd = "";
    const f = await fixture(async function* () {
      yield init;
      // Read answers a PNG with one image block and no text; this one also
      // omits media_type, as the transcript that reported the bug did.
      yield call("read-1", "Read", { file_path: path.join(cwd, "shot.png") });
      yield { type: "user", parent_tool_use_id: null, message: { content: [
        { type: "tool_result", tool_use_id: "read-1", content: [{ type: "image", source: { type: "base64", data: png } }] },
      ] } } as SDKMessage;
      // An MCP screenshot tool can answer text and images in any order.
      yield call("shot-1", "mcp__browser__screenshot", {});
      yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "shot-1", content: [
        { type: "text", text: "Captured the page." },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } },
      ] }] } } as SDKMessage;
      yield result;
    });
    cwd = f.root;
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Look" }] });
    await f.waitForTurn();

    const pngUrl = `data:image/png;base64,${png}`;
    const live = (id: string) => {
      const event = f.events.find((event) => event.notification.method === "item/completed"
        && getNotificationItem(event.notification.params)?.id === id);
      return buildLiveToolDetails(getNotificationItem(event!.notification.params)!);
    };
    expect(live("read-1")).toEqual([expect.objectContaining({ images: [expect.objectContaining({ url: pngUrl })] })]);
    expect(live("shot-1")).toEqual([expect.objectContaining({
      images: [expect.objectContaining({ url: "data:image/jpeg;base64,/9j/4AAQ" })],
    })]);

    // The replay groups adjacent tool rows, so look the details up across rows.
    const details = (await f.backend.readThread(threadId)).entries
      .flatMap((entry) => entry.type === "activity" ? entry.details : []);
    const detail = (id: string) => details.find((candidate) => candidate.id === id);
    expect(detail("read-1:output")).toEqual({
      id: "read-1:output", kind: "read", label: "Read shot.png output", status: "completed",
      images: [{ type: "image", url: expect.stringMatching(/^pwragent-image:/), alt: "Read shot.png" }],
    });
    expect(detail("shot-1")).toMatchObject({
      label: "Used MCP browser/screenshot",
      command: { rawCommand: "browser/screenshot", source: "tool", output: "Captured the page." },
      images: [{ url: expect.stringMatching(/^pwragent-image:/) }],
    });
    // No row keeps the image as text.
    expect(JSON.stringify(details.map((candidate) => [candidate.markdown, candidate.command?.output])))
      .not.toContain("base64");
    expect(await readFile(path.join(f.root, `${threadId}.jsonl`), "utf8")).not.toContain("data:image/");
  });

  it("names an MCP call's tool and keeps its arguments and result inside the row", async () => {
    const sandboxer = "mcp__pwragent_builtin_sandboxer_e96ab96f1443b1279de4ece773af16df__stop_sandbox";
    const f = await fixture(async function* () {
      yield init;
      yield call("search-1", "ToolSearch", { query: "select:stop_sandbox" });
      yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "search-1",
        content: [{ type: "tool_reference", tool_name: sandboxer }] }] } } as SDKMessage;
      yield call("stop-1", sandboxer, { sandboxId: "sb_fixture" });
      yield answer("stop-1", "{\"status\":\"archiving\"}");
      yield result;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Stop it" }] });
    await f.waitForTurn();

    const [group] = (await f.backend.readThread(threadId)).entries.filter((entry) => entry.type === "activity");
    if (group?.type !== "activity") throw new Error("Expected the tools' row");
    expect(group.summary).toBe("Used 2 tools");
    expect(group.details).toEqual([
      expect.objectContaining({
        id: "search-1", kind: "command", label: "ToolSearch", status: "completed",
        command: expect.objectContaining({ rawCommand: "ToolSearch", source: "tool", output: "sandboxer/stop_sandbox" }),
      }),
      expect.objectContaining({
        id: "stop-1", kind: "command", label: "Used MCP sandboxer/stop_sandbox", status: "completed",
        command: {
          displayCommand: "sandboxer/stop_sandbox\n{\n  \"sandboxId\": \"sb_fixture\"\n}",
          rawCommand: "sandboxer/stop_sandbox", source: "tool", output: "{\"status\":\"archiving\"}",
        },
      }),
    ]);
    const completed = f.events.find((event) => event.notification.method === "item/completed"
      && getNotificationItem(event.notification.params)?.id === "stop-1");
    expect(buildLiveToolDetails(getNotificationItem(completed!.notification.params)!)).toEqual([expect.objectContaining({
      command: expect.objectContaining({ rawCommand: "sandboxer/stop_sandbox", output: "{\"status\":\"archiving\"}" }),
    })]);
  });

  it("shows tool rows saved as raw JSON as named rows with their images, without rewriting them", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const f = await fixture();
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    const saved = [{
      type: "activity" as const, id: "old-mcp", summary: "mcp__pwragent__attach_thread_pull_request",
      status: "completed" as const, turn: { id: "old-turn" },
      details: [
        { id: "old-mcp", kind: "read" as const, label: "mcp__pwragent__attach_thread_pull_request", markdown: "{\"number\":140}" },
        { id: "old-mcp:output", kind: "read" as const, label: "mcp__pwragent__attach_thread_pull_request output",
          markdown: "{\"attached\":true}", status: "completed" as const },
      ],
    }, {
      type: "activity" as const, id: "old-read", summary: "Read shot.png", status: "completed" as const, turn: { id: "old-turn" },
      details: [
        { id: "old-read", kind: "read" as const, label: "Read shot.png", path: "/repo/shot.png", status: "in_progress" as const },
        { id: "old-read:output", kind: "read" as const, label: "Read shot.png output", status: "completed" as const,
          markdown: JSON.stringify([{ type: "image", source: { type: "base64", data: png } }]) },
      ],
    }];
    await f.store.append(threadId, saved);

    const [group] = (await f.backend.readThread(threadId)).entries;
    expect(group).toMatchObject({ type: "activity", summary: "Used 2 tools", details: [
      { id: "old-mcp", label: "Used MCP pwragent/attach_thread_pull_request", command: {
        rawCommand: "pwragent/attach_thread_pull_request", source: "tool", output: "{\"attached\":true}",
      } },
      { id: "old-read", path: "/repo/shot.png" },
      { id: "old-read:output", images: [{ type: "image", url: `data:image/png;base64,${png}`, alt: "Read shot.png" }] },
    ] });
    if (group?.type !== "activity") throw new Error("Expected the tools' row");
    expect(group.details[2]).not.toHaveProperty("markdown");
    expect(await f.store.entries(threadId)).toEqual(saved);
  });

  it("diffs a new file's content when its patch is empty, and keeps a failed edit's error", async () => {
    let cwd = "";
    const f = await fixture(async function* () {
      yield init;
      yield call("write-1", "Write", { file_path: path.join(cwd, "notes.md"), content: "one\ntwo\n" });
      yield answer("write-1", "File created.", {
        type: "create", filePath: path.join(cwd, "notes.md"), content: "one\ntwo\n", structuredPatch: [], originalFile: null,
      });
      yield call("edit-2", "Edit", { file_path: path.join(cwd, "notes.md"), old_string: "x", new_string: "y" });
      yield { type: "user", parent_tool_use_id: null, message: { content: [
        { type: "tool_result", tool_use_id: "edit-2", content: "String to replace not found", is_error: true },
      ] } } as SDKMessage;
      yield result;
    });
    cwd = f.root;
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Write" }] });
    await f.waitForTurn();
    const [group] = (await f.backend.readThread(threadId)).entries.filter((entry) => entry.type === "activity");
    if (group?.type !== "activity") throw new Error("Expected the edits' row");
    expect(group.details[0]).toMatchObject({ label: "Wrote notes.md", fileDiff: {
      kind: "add", additions: 2, removals: 0, diff: "diff --git a/notes.md b/notes.md\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+one\n+two",
    } });
    expect(group.details.find((detail) => detail.id === "edit-2:output")).toMatchObject({ markdown: "String to replace not found", status: "failed" });
  });

  it("folds repeat edits of one file into one section of the turn's live diff", async () => {
    let cwd = "";
    const patch = (from: string, to: string) => ({
      filePath: path.join(cwd, "a.ts"), oldString: from, newString: to, originalFile: from,
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${from}`, `+${to}`] }],
      userModified: false, replaceAll: false,
    });
    const f = await fixture(async function* () {
      yield init;
      yield call("e1", "Edit", { file_path: path.join(cwd, "a.ts"), old_string: "x", new_string: "y" });
      yield answer("e1", "Updated.", patch("x", "y"));
      yield call("e2", "Edit", { file_path: path.join(cwd, "a.ts"), old_string: "y", new_string: "z" });
      yield answer("e2", "Updated.", patch("y", "z"));
      yield result;
    });
    cwd = f.root;
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Edit twice" }] });
    await f.waitForTurn();
    const diffs = f.events.filter((event) => event.notification.method === "turn/diff/updated")
      .map((event) => (event.notification.params as { diff: string }).diff);
    expect(diffs.at(-1)).toBe([
      "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts",
      "@@ -1,1 +1,1 @@", "-x", "+y", "@@ -1,1 +1,1 @@", "-y", "+z",
    ].join("\n"));
  });

  it("keeps an emptied TodoWrite list as a tool row rather than an empty plan", async () => {
    const f = await fixture(async function* () {
      yield init;
      yield call("todo-empty", "TodoWrite", { todos: [] });
      yield answer("todo-empty", "Todos have been modified successfully.");
      yield result;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Clear" }] });
    await f.waitForTurn();
    expect(f.events.some((event) => event.notification.method === "turn/plan/updated")).toBe(false);
    const entries = (await f.backend.readThread(threadId)).entries;
    expect(entries.filter((entry) => entry.type === "plan")).toEqual([]);
    expect(entries.find((entry) => entry.type === "activity")).toMatchObject({ summary: "TodoWrite" });
  });

  it("shows TodoWrite as the turn's plan instead of a tool row", async () => {
    const f = await fixture(async function* () {
      yield init;
      yield call("todo-1", "TodoWrite", { todos: [
        { content: "Read the code", status: "completed", activeForm: "Reading the code" },
        { content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" },
      ] });
      yield answer("todo-1", "Todos have been modified successfully.");
      yield call("todo-2", "TodoWrite", { todos: [
        { content: "Read the code", status: "completed", activeForm: "Reading the code" },
        { content: "Fix the bug", status: "completed", activeForm: "Fixing the bug" },
      ] });
      yield answer("todo-2", "Todos have been modified successfully.");
      yield result;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Plan" }] });
    await f.waitForTurn();
    const plans = f.events.filter((event) => event.notification.method === "turn/plan/updated");
    expect(plans).toHaveLength(2);
    expect(plans[0].notification.params).toMatchObject({ plan: { steps: [
      { step: "Read the code", status: "completed" }, { step: "Fix the bug", status: "in_progress" },
    ] } });
    const entries = (await f.backend.readThread(threadId)).entries;
    expect(entries.filter((entry) => entry.type === "activity")).toEqual([]);
    expect(entries.filter((entry) => entry.type === "plan")).toMatchObject([{ steps: [
      { step: "Read the code", status: "completed" }, { step: "Fix the bug", status: "completed" },
    ] }]);
  });

  it("names what file and web tools read", async () => {
    const f = await fixture(async function* () {
      yield init;
      yield call("read-1", "Read", { file_path: "/repo/src/index.ts" });
      yield answer("read-1", "1\texport {}");
      yield call("grep-1", "Grep", { pattern: "TODO", path: "/repo/src" });
      yield answer("grep-1", "src/index.ts");
      yield call("fetch-1", "WebFetch", { url: "https://example.com/docs", prompt: "Summarize" });
      yield answer("fetch-1", "A summary");
      yield result;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Look" }] });
    await f.waitForTurn();
    const [group] = (await f.backend.readThread(threadId)).entries.filter((entry) => entry.type === "activity");
    if (group?.type !== "activity") throw new Error("Expected the tools' row");
    expect(group.details.filter((detail) => !detail.id.endsWith(":output")).map((detail) => detail.label)).toEqual([
      "Read index.ts", "Searched for TODO in src", "Fetched https://example.com/docs",
    ]);
    expect(group.details.find((detail) => detail.id === "fetch-1")).toMatchObject({ url: "https://example.com/docs" });
  });

  it("keeps refusals as warning rows and reports denials and notifications without a toast", async () => {
    const f = await fixture(async function* () {
      yield init;
      yield { type: "system", subtype: "model_refusal_fallback", uuid: "refusal-1", trigger: "refusal", direction: "retry",
        original_model: "claude-opus-5-5", fallback_model: "claude-sonnet-5-5", request_id: null, content: "" } as unknown as SDKMessage;
      yield { type: "system", subtype: "permission_denied", uuid: "denied-1", tool_name: "Bash", tool_use_id: "t1",
        decision_reason_type: "classifier", decision_reason: "Deletes files outside the workspace",
        message: "Permission to use Bash has been denied." } as unknown as SDKMessage;
      yield { type: "system", subtype: "notification", uuid: "n1", key: "a", text: "Context is nearly full", priority: "high" } as unknown as SDKMessage;
      yield { type: "system", subtype: "notification", uuid: "n2", key: "b", text: "Tip of the day", priority: "low" } as unknown as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: { id: "reply", content: [{ type: "text", text: "Done" }] } } as SDKMessage;
      yield result;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Go" }] });
    await f.waitForTurn();
    expect(f.events.filter((event) => event.notification.method === "warning").map((event) => (event.notification.params as { message: string }).message)).toEqual([
      "claude-opus-5-5 declined the request; Claude used claude-sonnet-5-5 instead.",
      "Claude could not use Bash: Deletes files outside the workspace",
      "Context is nearly full",
    ]);
    expect((await f.backend.readThread(threadId)).entries.find((entry) => entry.type === "activity")).toMatchObject({
      id: "notice:refusal-1", summary: "Switched to claude-sonnet-5-5", tone: "warning",
    });
  });

  it("shows and persists an output-limit recovery banner while the turn continues", async () => {
    const resume = Promise.withResolvers<void>();
    const banner = Promise.withResolvers<void>();
    const text = "Output token limit hit. Retrying with a smaller response.";
    const f = await fixture(async function* () {
      yield init;
      yield { type: "system", subtype: "informational", uuid: "00000000-0000-4000-8000-000000000001",
        session_id: "session", content: text, level: "notice" } as SDKMessage;
      banner.resolve();
      await resume.promise;
      yield result;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Work" }] });
    try {
      await banner.promise;
      expect(f.events.find((event) => event.notification.method === "warning")?.notification).toMatchObject({
        params: { message: text, presentation: "activity-only" },
      });
      expect((await f.store.entries(threadId)).find((entry) => entry.id === "notice:00000000-0000-4000-8000-000000000001"))
        .toMatchObject({ summary: text, status: "completed" });
      expect(f.events.some((event) => event.notification.method === "turn/completed")).toBe(false);
    } finally {
      resume.resolve();
    }
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification.method).toBe("turn/completed");
  });

  it.each(["informational", "output-limit", "compaction"])("fails an empty successful result after only a %s notice", async (notice) => {
    const f = await fixture(async function* () {
      yield init;
      if (notice === "informational") {
        yield { type: "system", subtype: "informational", uuid: "00000000-0000-4000-8000-000000000001",
          session_id: "session", content: "Retrying the response", level: "notice" } as SDKMessage;
      } else if (notice === "output-limit") {
        yield { type: "assistant", parent_tool_use_id: null, message: {
          id: "limited", stop_reason: "max_tokens", content: [],
        } } as unknown as SDKMessage;
      } else {
        yield { type: "system", subtype: "compact_boundary", uuid: "00000000-0000-4000-8000-000000000002",
          session_id: "session", compact_metadata: { trigger: "auto", pre_tokens: 100 } } as SDKMessage;
      }
      yield { ...result, result: "" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Work" }] });
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification).toMatchObject({ method: "turn/failed", params: {
      turn: { error: { message: "Claude completed without a response or any tool activity. Try sending the message again." } },
    } });
    expect((await f.store.entries(threadId)).filter((entry) => entry.id.startsWith("notice:"))).toHaveLength(1);
  });

  it("accepts assistant output after a notice even when the result text is empty", async () => {
    const f = await fixture(async function* () {
      yield init;
      yield { type: "system", subtype: "informational", uuid: "00000000-0000-4000-8000-000000000001",
        session_id: "session", content: "Retrying the response", level: "notice" } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "answer", content: [{ type: "text", text: "Finished" }],
      } } as SDKMessage;
      yield { ...result, result: "" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Work" }] });
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification.method).toBe("turn/completed");
  });

  it("retains the latest informational progress per tool use across replay", async () => {
    const f = await fixture(async function* () {
      yield init;
      const notices = [
        { uuid: "00000000-0000-4000-8000-000000000001", tool_use_id: "tool-1", content: "Preparing" },
        { uuid: "00000000-0000-4000-8000-000000000002", tool_use_id: "tool-2", content: "Other progress" },
        { uuid: "00000000-0000-4000-8000-000000000003", tool_use_id: "tool-1", content: "Ready" },
        { uuid: "00000000-0000-4000-8000-000000000004", content: "Status" },
        { uuid: "00000000-0000-4000-8000-000000000005", content: "Status" },
      ] as const;
      for (const notice of notices) {
        yield { type: "system", subtype: "informational", session_id: "session", level: "notice", ...notice } as SDKMessage;
      }
      yield result;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Work" }] });
    await f.waitForTurn();
    const replay = await new ClaudeSessionStore(f.root).entries(threadId);
    const notices = replay.filter((entry) => entry.type === "activity");
    expect(notices.map((entry) => ({ id: entry.id, summary: entry.summary }))).toEqual([
      { id: "notice:informational:tool:tool-1", summary: "Ready" },
      { id: "notice:informational:tool:tool-2", summary: "Other progress" },
      { id: "notice:00000000-0000-4000-8000-000000000004", summary: "Status" },
      { id: "notice:00000000-0000-4000-8000-000000000005", summary: "Status" },
    ]);
  });

  it.each(["A hook stopped continuation", ""])("ends a stopped turn without waiting for a result (%s)", async (content) => {
    const f = await fixture(async function* () {
      yield init;
      yield { type: "system", subtype: "session_state_changed", state: "running" } as SDKMessage;
      yield { type: "system", subtype: "informational", uuid: "00000000-0000-4000-8000-000000000002", session_id: "session", content,
        level: "warning", prevent_continuation: true } as SDKMessage;
      // An interactive query may remain open waiting for its next input.
      await new Promise<void>(() => {});
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Work" }] });
    await f.waitForTurn();
    expect(f.events.at(-1)?.notification).toMatchObject({ method: "turn/failed", params: {
      turn: { error: { message: content || "Claude stopped execution without providing a reason." } },
    } });
    expect(f.close).toHaveBeenCalledOnce();
    expect((await f.backend.readThread(threadId)).threadStatus).toBe("idle");
  });

  it("reports an intermediate output limit without ending the recovering turn", async () => {
    const f = await fixture(async function* () {
      yield init;
      yield { type: "stream_event", parent_tool_use_id: null, event: {
        type: "message_start", message: { id: "limited" },
      } } as SDKMessage;
      yield { type: "stream_event", parent_tool_use_id: null, event: {
        type: "message_delta", delta: { stop_reason: "max_tokens" },
      } } as SDKMessage;
      yield { type: "assistant", uuid: "00000000-0000-4000-8000-000000000003", session_id: "session", parent_tool_use_id: null, message: {
        id: "limited", stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "", signature: "" }],
      } } as unknown as SDKMessage;
      expect(f.events.some((event) => event.notification.method === "turn/failed")).toBe(false);
      yield { type: "assistant", parent_tool_use_id: null, message: {
        id: "recovered", content: [{ type: "text", text: "Finished after retry" }],
      } } as SDKMessage;
      yield { ...result, stop_reason: "end_turn", result: "Finished after retry" } as SDKMessage;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Work" }] });
    await f.waitForTurn();
    expect(f.events.find((event) => event.notification.method === "warning")?.notification).toMatchObject({
      params: { message: expect.stringContaining("Waiting for Claude to continue"), presentation: "activity-only" },
    });
    expect(f.events.filter((event) => event.notification.method === "warning")).toHaveLength(1);
    expect((await f.store.entries(threadId)).find((entry) => entry.id === "notice:output-limit:limited"))
      .toMatchObject({ summary: "Reached output token limit", tone: "warning" });
    expect(f.events.at(-1)?.notification.method).toBe("turn/completed");
  });

  it("records compaction as its own row and a compaction boundary, and reports retries without a toast", async () => {
    const f = await fixture(async function* () {
      yield init;
      yield call("read-1", "Read", { file_path: "/repo/a.ts" });
      yield answer("read-1", "a");
      yield { type: "system", subtype: "status", status: "compacting" } as SDKMessage;
      yield { type: "system", subtype: "compact_boundary", uuid: "boundary-1",
        compact_metadata: { trigger: "auto", pre_tokens: 180_000, post_tokens: 12_000 } } as unknown as SDKMessage;
      yield { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 2_000,
        error_status: 529, error: "server_error" } as unknown as SDKMessage;
      yield call("read-2", "Read", { file_path: "/repo/b.ts" });
      yield answer("read-2", "b");
      yield result;
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Work" }] });
    await f.waitForTurn();
    expect(f.events.find((event) => event.notification.method === "thread/compacted")?.notification.params)
      .toEqual({ threadId, itemId: "boundary-1" });
    const warnings = f.events.filter((event) => event.notification.method === "warning").map((event) => event.notification.params);
    expect(warnings).toEqual([
      { threadId, message: "Claude is compacting the conversation.", presentation: "activity-only" },
      { threadId, message: "A Claude API request failed (HTTP 529). Retrying in 2s, attempt 1 of 10.", presentation: "activity-only" },
    ]);
    const activities = (await f.backend.readThread(threadId)).entries.filter((entry) => entry.type === "activity");
    expect(activities.map((entry) => entry.type === "activity" ? entry.summary : "")).toEqual([
      "Read a.ts", "Compacted context", "Read b.ts",
    ]);
    expect(activities[1]).toMatchObject({ details: [{ label: "180,000 → 12,000 tokens, automatically" }] });
  });
});

describe("Claude thread rewind", () => {
  const SDK_SESSION = "5a85c1ad-85c1-4930-ae19-50f721ad13dd";

  /** Each turn's query: record the prompt Claude was sent, answer it, finish. */
  function promptRecorder(prompts: SDKUserMessage[]) {
    return async function* (_options: Options, prompt: AsyncIterable<SDKUserMessage>): AsyncGenerator<SDKMessage> {
      const sent = (await prompt[Symbol.asyncIterator]().next()).value as SDKUserMessage;
      prompts.push(sent);
      const turn = prompts.length;
      yield { type: "system", subtype: "init", session_id: SDK_SESSION } as SDKMessage;
      yield { type: "assistant", parent_tool_use_id: null, uuid: `assistant-${turn}`, message: {
        id: `answer-${turn}`, content: [{ type: "text", text: `Answer ${turn}` }],
      } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: `Answer ${turn}` } as SDKMessage;
    };
  }

  /** What Claude's session holds for the prompts sent so far. */
  function sessionMessages(prompts: SDKUserMessage[]) {
    return vi.fn(async () => prompts.flatMap((prompt, index) => [
      { type: "user" as const, uuid: prompt.uuid!, session_id: SDK_SESSION, message: {}, parent_tool_use_id: null, parent_agent_id: null },
      { type: "assistant" as const, uuid: `assistant-${index + 1}`, session_id: SDK_SESSION, message: {}, parent_tool_use_id: null, parent_agent_id: null },
    ]));
  }

  async function runTurns(f: Awaited<ReturnType<typeof fixture>>, texts: string[]) {
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    const turnIds: string[] = [];
    for (const text of texts) {
      const { turnId } = await f.backend.startTurn({ threadId, input: [{ type: "text", text }] });
      turnIds.push(turnId);
      await f.waitForTurn();
    }
    return { threadId, turnIds };
  }

  it("checkpoints files and sends each prompt with its turn id as its UUID", async () => {
    const prompts: SDKUserMessage[] = [];
    const f = await fixture(promptRecorder(prompts));
    const { turnIds } = await runTurns(f, ["First prompt", "Second prompt"]);

    expect(prompts.map((prompt) => prompt.uuid)).toEqual(turnIds);
    expect(f.queries.every((options) => options.enableFileCheckpointing === true)).toBe(true);
  });

  it("rewinds the conversation to before a prompt and resumes there on the next turn", async () => {
    const prompts: SDKUserMessage[] = [];
    const f = await fixture(promptRecorder(prompts));
    Object.assign(f.backendOptions, { getSessionMessages: sessionMessages(prompts) });
    const { threadId, turnIds } = await runTurns(f, ["First prompt", "Second prompt"]);

    const result = await f.backend.rewindThread({
      threadId,
      target: { messageId: `user:${turnIds[1]}`, turnId: turnIds[1] },
      mode: "conversation",
    });

    expect(result.promptText).toBe("Second prompt");
    // A conversation rewind needs no query.
    expect(f.run).toHaveBeenCalledTimes(2);
    const stored = await f.store.read(threadId);
    expect(stored.resumeSessionAt).toBe("assistant-1");
    expect(stored.rewinds).toEqual([{
      at: expect.any(Number), beforeTurnId: turnIds[1], sdkSessionId: SDK_SESSION, removedLeafUuid: "assistant-2",
    }]);
    // The truncation is in the append-only history, so a restart keeps it.
    const reopened = new ClaudeSessionStore(f.root);
    expect((await reopened.entries(threadId)).map((entry) => entry.id)).toEqual([`user:${turnIds[0]}`, "answer-1"]);
    expect((await f.backend.readThread(threadId)).entries.map((entry) => entry.id)).toEqual([`user:${turnIds[0]}`, "answer-1"]);

    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Try another way" }] });
    await f.waitForTurn();
    expect(f.queries.at(-1)).toMatchObject({ resume: SDK_SESSION, resumeSessionAt: "assistant-1" });
    expect((await f.store.read(threadId)).resumeSessionAt).toBeUndefined();
  });

  it("records where a second rewind's branch ends before any turn resumed", async () => {
    const prompts: SDKUserMessage[] = [];
    const f = await fixture(promptRecorder(prompts));
    Object.assign(f.backendOptions, { getSessionMessages: sessionMessages(prompts) });
    const { threadId, turnIds } = await runTurns(f, ["First prompt", "Second prompt", "Third prompt"]);

    await f.backend.rewindThread({
      threadId, target: { messageId: `user:${turnIds[2]}`, turnId: turnIds[2] }, mode: "conversation",
    });
    await f.backend.rewindThread({
      threadId, target: { messageId: `user:${turnIds[1]}`, turnId: turnIds[1] }, mode: "conversation",
    });

    const stored = await f.store.read(threadId);
    expect(stored.resumeSessionAt).toBe("assistant-1");
    // The first rewind had already cut the conversation after "assistant-2".
    expect(stored.rewinds?.map((rewind) => rewind.removedLeafUuid)).toEqual(["assistant-3", "assistant-2"]);
  });

  it("starts a new session after rewinding the first prompt", async () => {
    const prompts: SDKUserMessage[] = [];
    const f = await fixture(promptRecorder(prompts));
    Object.assign(f.backendOptions, { getSessionMessages: sessionMessages(prompts) });
    const { threadId, turnIds } = await runTurns(f, ["First prompt"]);

    await f.backend.rewindThread({
      threadId, target: { messageId: `user:${turnIds[0]}`, turnId: turnIds[0] }, mode: "conversation",
    });
    expect((await f.store.read(threadId)).sdkSessionId).toBeUndefined();
    expect((await f.backend.readThread(threadId)).entries).toEqual([]);

    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Start over" }] });
    await f.waitForTurn();
    const next = f.queries.at(-1)!;
    expect(next.resume).toBeUndefined();
    // The thread id named the first session, which still holds the old turns.
    expect(next.sessionId).toEqual(expect.any(String));
    expect(next.sessionId).not.toBe(threadId);
  });

  it("previews and restores files through a checkpointing control query", async () => {
    const prompts: SDKUserMessage[] = [];
    const rewindFiles = vi.fn(async (_id: string, options?: { dryRun?: boolean }) => options?.dryRun
      ? { canRewind: true, filesChanged: ["src/queue/lock.ts", "src/queue/lock.test.ts"], insertions: 59, deletions: 6 }
      : { canRewind: true, filesChanged: ["src/queue/lock.ts", "src/queue/lock.test.ts"] });
    const f = await fixture(promptRecorder(prompts), { rewindFiles });
    Object.assign(f.backendOptions, { getSessionMessages: sessionMessages(prompts) });
    const { threadId, turnIds } = await runTurns(f, ["First prompt", "Second prompt"]);
    const target = { messageId: `user:${turnIds[1]}`, turnId: turnIds[1] };

    await expect(f.backend.previewRewind(threadId, target)).resolves.toEqual({
      files: { paths: ["src/queue/lock.ts", "src/queue/lock.test.ts"], insertions: 59, deletions: 6 },
    });
    expect(rewindFiles).toHaveBeenLastCalledWith(turnIds[1], { dryRun: true });
    // A control query: Claude's session, with checkpoints, and no prompt.
    expect(f.queries[2]).toMatchObject({ resume: SDK_SESSION, enableFileCheckpointing: true, cwd: f.root });
    expect(prompts).toHaveLength(2);

    const result = await f.backend.rewindThread({ threadId, target, mode: "conversation-and-files" });
    expect(rewindFiles).toHaveBeenLastCalledWith(turnIds[1]);
    expect(result.restoredFileCount).toBe(2);
    expect((await f.store.read(threadId)).rewinds?.[0]?.restoredFiles).toEqual(["src/queue/lock.ts", "src/queue/lock.test.ts"]);
    expect(f.close).toHaveBeenCalledTimes(4);
  });

  it("leaves the conversation alone when Claude cannot restore the files", async () => {
    const prompts: SDKUserMessage[] = [];
    const rewindFiles = vi.fn(async () => ({ canRewind: false, error: "No file checkpoint for this message." }));
    const f = await fixture(promptRecorder(prompts), { rewindFiles });
    Object.assign(f.backendOptions, { getSessionMessages: sessionMessages(prompts) });
    const { threadId, turnIds } = await runTurns(f, ["First prompt", "Second prompt"]);
    const target = { messageId: `user:${turnIds[1]}`, turnId: turnIds[1] };

    await expect(f.backend.previewRewind(threadId, target)).resolves.toEqual({
      filesUnavailableReason: "No file checkpoint for this message.",
    });
    await expect(f.backend.rewindThread({ threadId, target, mode: "conversation-and-files" }))
      .rejects.toThrow("No file checkpoint for this message.");
    const stored = await f.store.read(threadId);
    expect(stored.resumeSessionAt).toBeUndefined();
    expect(stored.rewinds).toBeUndefined();
    expect((await f.backend.readThread(threadId)).entries).toHaveLength(4);
  });

  it("refuses a prompt Claude's conversation lacks, and refuses while a turn runs", async () => {
    const prompts: SDKUserMessage[] = [];
    const f = await fixture(promptRecorder(prompts));
    // A prompt sent before PwrAgent supplied UUIDs, or one compacted away.
    Object.assign(f.backendOptions, { getSessionMessages: vi.fn(async () => []) });
    const { threadId, turnIds } = await runTurns(f, ["First prompt"]);
    const target = { messageId: `user:${turnIds[0]}`, turnId: turnIds[0] };

    expect((await f.backend.previewRewind(threadId, target)).unavailableReason)
      .toContain("does not have this prompt");
    await expect(f.backend.rewindThread({ threadId, target, mode: "conversation" }))
      .rejects.toThrow("does not have this prompt");

    const answered = Promise.withResolvers<void>();
    const busy = await fixture(async function* (_options, prompt) {
      await prompt[Symbol.asyncIterator]().next();
      yield { type: "system", subtype: "init", session_id: SDK_SESSION } as SDKMessage;
      await answered.promise;
      yield { type: "result", subtype: "success", is_error: false, result: "Done" } as SDKMessage;
    });
    const thread = await busy.backend.startThread({ cwd: busy.root, executionMode: "default" });
    const { turnId } = await busy.backend.startTurn({ threadId: thread.threadId, input: [{ type: "text", text: "Work" }] });
    try {
      await expect(busy.backend.rewindThread({
        threadId: thread.threadId, target: { messageId: `user:${turnId}`, turnId }, mode: "conversation",
      })).rejects.toThrow("Wait for the active Claude turn");
    } finally {
      answered.resolve();
      await busy.waitForTurn();
    }
  });

  it("starts a turn only after a file preview's control query closes", async () => {
    const prompts: SDKUserMessage[] = [];
    const answer = Promise.withResolvers<{ canRewind: boolean; filesChanged: string[] }>();
    const rewindFiles = vi.fn(async () => await answer.promise);
    const f = await fixture(promptRecorder(prompts), { rewindFiles });
    Object.assign(f.backendOptions, { getSessionMessages: sessionMessages(prompts) });
    const { threadId, turnIds } = await runTurns(f, ["First prompt"]);

    const preview = f.backend.previewRewind(threadId, { messageId: `user:${turnIds[0]}`, turnId: turnIds[0] });
    await vi.waitFor(() => expect(rewindFiles).toHaveBeenCalledOnce());
    const started = f.backend.startTurn({ threadId, input: [{ type: "text", text: "Meanwhile" }] });
    // Long enough for an unheld turn to reach query(); a held one waits forever.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Only the turn and the control query so far: no second process on the session.
    expect(f.run).toHaveBeenCalledTimes(2);

    answer.resolve({ canRewind: true, filesChanged: [] });
    await preview;
    await started;
    await f.waitForTurn();
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(f.close.mock.invocationCallOrder[1]).toBeLessThan(f.run.mock.invocationCallOrder[2]!);
  });

  it("gives up on a file dry run Claude does not answer", async () => {
    const prompts: SDKUserMessage[] = [];
    const rewindFiles = vi.fn(() => new Promise<never>(() => {}));
    const f = await fixture(promptRecorder(prompts), { rewindFiles });
    Object.assign(f.backendOptions, { getSessionMessages: sessionMessages(prompts), rewindPreviewTimeoutMs: 20 });
    const { threadId, turnIds } = await runTurns(f, ["First prompt"]);

    await expect(f.backend.previewRewind(threadId, { messageId: `user:${turnIds[0]}`, turnId: turnIds[0] }))
      .resolves.toEqual({ filesUnavailableReason: "Claude did not answer which files it can restore." });
    // The control query's process does not outlive the check.
    expect(f.close).toHaveBeenCalledTimes(2);
  });

  it("undoes a rewind until the next turn starts, resuming on the kept branch", async () => {
    const prompts: SDKUserMessage[] = [];
    const f = await fixture(promptRecorder(prompts));
    Object.assign(f.backendOptions, { getSessionMessages: sessionMessages(prompts) });
    const { threadId, turnIds } = await runTurns(f, ["First prompt", "Second prompt"]);
    const rewindId = "0b7f1c52-6a52-4c5e-9f0e-3b0f2f0c9e11";

    const result = await f.backend.rewindThread({
      threadId, target: { messageId: `user:${turnIds[1]}`, turnId: turnIds[1] }, mode: "conversation", rewindId,
    });
    expect(result.undoable).toBe(true);
    expect((await f.backend.readThread(threadId)).entries).toHaveLength(2);

    await f.backend.undoRewind({ threadId, rewindId });
    const stored = await f.store.read(threadId);
    expect(stored.sdkSessionId).toBe(SDK_SESSION);
    // The next turn continues where the removed branch ended.
    expect(stored.resumeSessionAt).toBe("assistant-2");
    expect(stored.rewinds?.[0]?.undoneAt).toEqual(expect.any(Number));
    const reopened = new ClaudeSessionStore(f.root);
    expect((await reopened.entries(threadId)).map((entry) => entry.id))
      .toEqual([`user:${turnIds[0]}`, "answer-1", `user:${turnIds[1]}`, "answer-2"]);
    await expect(f.backend.undoRewind({ threadId, rewindId })).rejects.toThrow("can no longer be undone");

    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Third prompt" }] });
    await f.waitForTurn();
    expect(f.queries.at(-1)).toMatchObject({ resume: SDK_SESSION, resumeSessionAt: "assistant-2" });
  });

  it("refuses to undo a rewind once a turn has continued the rewound conversation", async () => {
    const prompts: SDKUserMessage[] = [];
    const f = await fixture(promptRecorder(prompts));
    Object.assign(f.backendOptions, { getSessionMessages: sessionMessages(prompts) });
    const { threadId, turnIds } = await runTurns(f, ["First prompt", "Second prompt"]);
    const rewindId = "0b7f1c52-6a52-4c5e-9f0e-3b0f2f0c9e12";
    await f.backend.rewindThread({
      threadId, target: { messageId: `user:${turnIds[1]}`, turnId: turnIds[1] }, mode: "conversation", rewindId,
    });

    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "Another way" }] });
    await f.waitForTurn();
    await expect(f.backend.undoRewind({ threadId, rewindId }))
      .rejects.toThrow("Claude has continued the conversation since");
    expect((await f.backend.readThread(threadId)).entries.map((entry) => entry.type === "message" ? entry.text : entry.id))
      .toEqual(["First prompt", "Answer 1", "Another way", "Answer 3"]);
  });

  it("keeps what a file rewind overwrote and puts it back on undo", async () => {
    const prompts: SDKUserMessage[] = [];
    const f = await fixture(promptRecorder(prompts), {
      rewindFiles: vi.fn(async (_id: string, options?: { dryRun?: boolean }) => {
        if (!options?.dryRun) {
          // Claude restores the files to before the prompt.
          await writeFile(path.join(f.root, "lock.ts"), "before");
          await rm(path.join(f.root, "lock.test.ts"));
        }
        return { canRewind: true, filesChanged: ["lock.ts", "lock.test.ts"] };
      }),
    });
    Object.assign(f.backendOptions, { getSessionMessages: sessionMessages(prompts) });
    const { threadId, turnIds } = await runTurns(f, ["First prompt", "Second prompt"]);
    await writeFile(path.join(f.root, "lock.ts"), "edited");
    await writeFile(path.join(f.root, "lock.test.ts"), "created");
    const target = { messageId: `user:${turnIds[1]}`, turnId: turnIds[1] };

    const first = await f.backend.rewindThread({
      threadId, target, mode: "conversation-and-files", rewindId: "0b7f1c52-6a52-4c5e-9f0e-3b0f2f0c9e13",
    });
    expect(first).toMatchObject({ restoredFileCount: 2, undoable: true });
    await f.backend.undoRewind({ threadId, rewindId: "0b7f1c52-6a52-4c5e-9f0e-3b0f2f0c9e13" });
    expect(await readFile(path.join(f.root, "lock.ts"), "utf8")).toBe("edited");
    expect(await readFile(path.join(f.root, "lock.test.ts"), "utf8")).toBe("created");

    // A file changed after the rewind is the operator's; undo leaves it be.
    await f.backend.rewindThread({
      threadId, target, mode: "conversation-and-files", rewindId: "0b7f1c52-6a52-4c5e-9f0e-3b0f2f0c9e14",
    });
    await writeFile(path.join(f.root, "lock.ts"), "operator's own edit");
    await expect(f.backend.undoRewind({ threadId, rewindId: "0b7f1c52-6a52-4c5e-9f0e-3b0f2f0c9e14" }))
      .rejects.toThrow("lock.ts changed after the rewind");
    expect(await readFile(path.join(f.root, "lock.ts"), "utf8")).toBe("operator's own edit");
    expect((await f.backend.readThread(threadId)).entries).toHaveLength(2);
  });

  it("drops a file rewind's copies when Claude fails it, and explains copies that are gone", async () => {
    const prompts: SDKUserMessage[] = [];
    let fail = true;
    const f = await fixture(promptRecorder(prompts), {
      rewindFiles: vi.fn(async (_id: string, options?: { dryRun?: boolean }) => {
        if (!options?.dryRun && fail) throw new Error("Claude exited");
        return { canRewind: true, filesChanged: ["lock.ts"] };
      }),
    });
    Object.assign(f.backendOptions, { getSessionMessages: sessionMessages(prompts) });
    const { threadId, turnIds } = await runTurns(f, ["First prompt", "Second prompt"]);
    await writeFile(path.join(f.root, "lock.ts"), "edited");
    const target = { messageId: `user:${turnIds[1]}`, turnId: turnIds[1] };
    const rewindId = "0b7f1c52-6a52-4c5e-9f0e-3b0f2f0c9e15";

    await expect(f.backend.rewindThread({ threadId, target, mode: "conversation-and-files", rewindId }))
      .rejects.toThrow("Claude exited");
    await expect(readFile(path.join(f.store.rewindBackupDirectory(threadId, rewindId), "manifest.json")))
      .rejects.toMatchObject({ code: "ENOENT" });

    fail = false;
    await f.backend.rewindThread({ threadId, target, mode: "conversation-and-files", rewindId });
    await rm(f.store.rewindBackupDirectory(threadId, rewindId), { recursive: true, force: true });
    await expect(f.backend.undoRewind({ threadId, rewindId }))
      .rejects.toThrow("no longer has the files this rewind replaced");
  });

  it("holds a message sent during a rewind for the queue", async () => {
    const prompts: SDKUserMessage[] = [];
    const f = await fixture(promptRecorder(prompts));
    const reading = Promise.withResolvers<void>();
    const messages = sessionMessages(prompts);
    Object.assign(f.backendOptions, { getSessionMessages: vi.fn(async (...args: Parameters<typeof messages>) => {
      await reading.promise;
      return await messages(...args);
    }) });
    const { threadId, turnIds } = await runTurns(f, ["First prompt", "Second prompt"]);

    const rewind = f.backend.rewindThread({
      threadId, target: { messageId: `user:${turnIds[1]}`, turnId: turnIds[1] }, mode: "conversation",
    });
    // The rewind claims the thread before its first await.
    await expect(f.backend.startTurn({ threadId, input: [{ type: "text", text: "Too soon" }] }))
      .rejects.toBeInstanceOf(ClaudeTurnActiveError);
    reading.resolve();
    await rewind;
  });
});
