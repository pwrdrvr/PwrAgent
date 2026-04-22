import { describe, expect, it } from "vitest";
import { AppServerSessionState } from "../app-server/session-state.js";
import { GrokRolloutStore } from "../persistence/grok-rollout-store.js";
import { Deferred, createTemporaryTestDirectory } from "../testing/test-harness.js";
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

    state.createThread({ threadId: "thread-2", cwd: "/repo/two", model: "grok-4.20-non-reasoning" });
    state.appendAssistant("thread-2", "latest reply");
    state.setThreadName("thread-2", "Second thread");

    expect(state.listThreads()).toEqual([
      {
        threadId: "thread-2",
        title: "Second thread",
        titleSource: "explicit",
        summary: "latest reply",
        projectKey: "/repo/two",
        model: "grok-4.20-non-reasoning",
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
      {
        threadId: "thread-1",
        title: "First thread",
        titleSource: "explicit",
        summary: "first prompt",
        projectKey: "/repo/one",
        model: "grok-4.20-reasoning",
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it("derives the title from the first user message until a real name exists", () => {
    const state = new AppServerSessionState();

    state.createThread({ threadId: "thread-1", cwd: "/repo/workspace" });
    state.appendInput("thread-1", [{ type: "text", text: "Ship Unit 3" }]);

    expect(state.listThreads()).toEqual([
      {
        threadId: "thread-1",
        title: "Ship Unit 3",
        titleSource: "derived",
        summary: undefined,
        projectKey: "/repo/workspace",
        model: undefined,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    ]);

    state.appendAssistant("thread-1", "Done.");

    expect(state.listThreads()[0]).toEqual({
      threadId: "thread-1",
      title: "Ship Unit 3",
      titleSource: "derived",
      summary: "Done.",
      projectKey: "/repo/workspace",
      model: undefined,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
  });

  it("shortens long derived titles without surfacing the full first prompt as summary", () => {
    const state = new AppServerSessionState();

    state.createThread({ threadId: "thread-1", cwd: "/repo/workspace" });
    state.appendInput("thread-1", [
      {
        type: "text",
        text: "I need a bedtime story about Nvidia and building AI through programmable shaders as an accident.",
      },
    ]);

    expect(state.listThreads()).toEqual([
      {
        threadId: "thread-1",
        title: "A bedtime story about Nvidia and building AI through programmable...",
        titleSource: "derived",
        summary: undefined,
        projectKey: "/repo/workspace",
        model: undefined,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it("keeps thread replay and touches timestamps as thread activity changes", () => {
    const state = new AppServerSessionState();

    const created = state.createThread({ threadId: "thread-1", cwd: "/repo/workspace" });
    state.createRun({ turnId: "turn-1", threadId: "thread-1", handle: createActiveTurn() });
    state.appendInput("thread-1", [{ type: "text", text: "Ship it" }]);
    state.appendAssistant("thread-1", "Done.");

    const replay = state.readThread("thread-1");

    expect(replay).toEqual({
      threadId: "thread-1",
      thread: expect.objectContaining({
        threadId: "thread-1",
        firstUserMessage: "Ship it",
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
      items: [
        {
          id: expect.any(String),
          type: "userMessage",
          status: "completed",
          role: "user",
          text: "Ship it",
        },
        {
          id: expect.any(String),
          type: "agentMessage",
          status: "completed",
          role: "assistant",
          text: "Done.",
        },
      ],
      lastUserMessage: "Ship it",
      lastAssistantMessage: "Done.",
    });
    expect(replay.thread.updatedAt).toBeGreaterThanOrEqual(created.updatedAt ?? 0);
  });

  it("preserves image input parts in replay messages", () => {
    const state = new AppServerSessionState();

    state.createThread({ threadId: "thread-1" });
    state.appendInput("thread-1", [
      { type: "text", text: "What is this?" },
      { type: "image", url: "data:image/jpeg;base64,AQID" },
    ]);

    expect(state.readThread("thread-1")).toEqual(
      expect.objectContaining({
        messages: [
          {
            role: "user",
            text: "What is this?",
            parts: [
              { type: "text", text: "What is this?" },
              { type: "image", url: "data:image/jpeg;base64,AQID" },
            ],
          },
        ],
        items: [
          expect.objectContaining({
            type: "userMessage",
            role: "user",
            text: "What is this?",
            parts: [
              { type: "text", text: "What is this?" },
              { type: "image", url: "data:image/jpeg;base64,AQID" },
            ],
          }),
        ],
      }),
    );
  });

  it("hydrates persisted threads from the rollout store on startup", async () => {
    const temp = await createTemporaryTestDirectory();

    try {
      const initialState = new AppServerSessionState({
        store: new GrokRolloutStore(temp.path),
      });
      initialState.createThread({
        threadId: "thread-1",
        cwd: "/repo/workspace",
        model: "grok-4.20-non-reasoning",
      });
      initialState.appendInput("thread-1", [{ type: "text", text: "Ship it" }]);
      initialState.appendAssistant("thread-1", "Done.");
      initialState.setPreviousResponseId("thread-1", "resp_1");

      const hydratedState = new AppServerSessionState({
        store: new GrokRolloutStore(temp.path),
      });

      expect(hydratedState.listThreads()).toEqual([
        {
          threadId: "thread-1",
          title: "Untitled thread",
          titleSource: "fallback",
          summary: "Done.",
          projectKey: "/repo/workspace",
          model: "grok-4.20-non-reasoning",
          createdAt: expect.any(Number),
          updatedAt: expect.any(Number),
        },
      ]);
      expect(hydratedState.readThread("thread-1")).toEqual({
        threadId: "thread-1",
        thread: expect.objectContaining({
          threadId: "thread-1",
          cwd: "/repo/workspace",
          model: "grok-4.20-non-reasoning",
        }),
        messages: [
          { role: "user", text: "Ship it" },
          { role: "assistant", text: "Done." },
        ],
        items: [
          {
            id: expect.any(String),
            type: "userMessage",
            status: "completed",
            role: "user",
            text: "Ship it",
          },
          {
            id: expect.any(String),
            type: "agentMessage",
            status: "completed",
            role: "assistant",
            text: "Done.",
          },
        ],
        lastUserMessage: "Ship it",
        lastAssistantMessage: "Done.",
      });
      expect(hydratedState.getPreviousResponseId("thread-1")).toBe("resp_1");
    } finally {
      await temp.cleanup();
    }
  });

  it("keeps repeated tool ids from separate turns as distinct replay items", () => {
    const state = new AppServerSessionState();

    state.createThread({ threadId: "thread-1", cwd: "/repo/workspace" });
    state.appendInput("thread-1", [{ type: "text", text: "First turn" }]);
    state.upsertItem("thread-1", {
      id: "tool-1",
      type: "dynamicToolCall",
      status: "completed",
      text: "first result",
    });
    state.appendAssistant("thread-1", "Done.");

    state.appendInput("thread-1", [{ type: "text", text: "Second turn" }]);
    state.upsertItem("thread-1", {
      id: "tool-1",
      type: "dynamicToolCall",
      status: "completed",
      text: "second result",
    });

    expect(state.readThread("thread-1").items).toEqual([
      {
        id: expect.any(String),
        type: "userMessage",
        status: "completed",
        role: "user",
        text: "First turn",
      },
      {
        id: "tool-1",
        type: "dynamicToolCall",
        status: "completed",
        text: "first result",
      },
      {
        id: expect.any(String),
        type: "agentMessage",
        status: "completed",
        role: "assistant",
        text: "Done.",
      },
      {
        id: expect.any(String),
        type: "userMessage",
        status: "completed",
        role: "user",
        text: "Second turn",
      },
      {
        id: "tool-1#2",
        type: "dynamicToolCall",
        status: "completed",
        text: "second result",
      },
    ]);
  });
});
