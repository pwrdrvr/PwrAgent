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

async function fixture(messages?: (options: Options) => AsyncGenerator<SDKMessage>) {
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
      close, setPermissionMode: vi.fn().mockResolvedValue(undefined),
    }) as unknown as Query;
  });
  const backendOptions = {
    store,
    query: run,
    inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" as const }),
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
    await f.backend.interruptTurn(turn);
    expect(f.events.at(-1)?.notification.method).toBe("turn/cancelled");
    expect((await f.backend.readThread(threadId)).threadStatus).toBe("idle");
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
