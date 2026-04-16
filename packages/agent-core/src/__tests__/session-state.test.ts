import { describe, expect, it } from "vitest";
import { AppServerSessionState } from "../app-server/session-state.js";
import { Deferred } from "../testing/test-harness.js";
import type { ProviderActiveTurn } from "../providers/provider-contract.js";

function createActiveTurn(): ProviderActiveTurn {
  return {
    result: new Deferred<{ assistantText?: string; providerResponseId?: string }>().promise,
  };
}

describe("AppServerSessionState", () => {
  it("lists threads with title, summary, and most-recent-first ordering", () => {
    const state = new AppServerSessionState();

    state.createThread({ threadId: "thread-1", cwd: "/repo/one", model: "grok-4.20-reasoning" });
    state.appendInput("thread-1", [{ type: "text", text: "first prompt" }]);
    state.setThreadName("thread-1", "First thread");

    state.createThread({ threadId: "thread-2", cwd: "/repo/two", model: "grok-4.20-fast" });
    state.appendAssistant("thread-2", "latest reply");
    state.setThreadName("thread-2", "Second thread");

    expect(state.listThreads()).toEqual([
      {
        threadId: "thread-2",
        title: "Second thread",
        summary: "latest reply",
        projectKey: "/repo/two",
        model: "grok-4.20-fast",
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
      {
        threadId: "thread-1",
        title: "First thread",
        summary: "first prompt",
        projectKey: "/repo/one",
        model: "grok-4.20-reasoning",
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it("keeps thread replay and touches timestamps as thread activity changes", () => {
    const state = new AppServerSessionState();

    const created = state.createThread({ threadId: "thread-1", cwd: "/repo/workspace" });
    state.createRun({ runId: "turn-1", threadId: "thread-1", handle: createActiveTurn() });
    state.appendInput("thread-1", [{ type: "text", text: "Ship it" }]);
    state.appendAssistant("thread-1", "Done.");

    const replay = state.readThread("thread-1");

    expect(replay).toEqual({
      threadId: "thread-1",
      thread: expect.objectContaining({
        threadId: "thread-1",
        cwd: "/repo/workspace",
        modelProvider: "xai",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      }),
      messages: [
        { role: "user", text: "Ship it" },
        { role: "assistant", text: "Done." },
      ],
      lastUserMessage: "Ship it",
      lastAssistantMessage: "Done.",
    });
    expect(replay.thread.updatedAt).toBeGreaterThanOrEqual(created.updatedAt ?? 0);
  });
});
