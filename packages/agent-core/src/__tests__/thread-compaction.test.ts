import { describe, expect, it } from "vitest";
import { createTestHarness, FakeProvider } from "../testing/test-harness.js";

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Codex thread compaction", () => {
  it("starts compaction, summarizes the thread, and emits completion notifications", async () => {
    const provider = new FakeProvider();
    const { server, notifications } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });

    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Investigate the Grok app server." }],
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "I investigated the Grok app server.",
      providerResponseId: "resp_turn_1",
    });
    await flushAsync();

    notifications.length = 0;

    const started = await server.request("thread/compact/start", {
      threadId: "thread-1",
    });

    expect(started).toEqual({
      threadId: "thread-1",
      runId: "turn-2",
      itemId: "turn-2-item",
    });
    expect(provider.runs[1]?.previousResponseId).toBe("resp_turn_1");
    expect(provider.runs[1]?.input).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Summarize this thread so it can be compacted"),
      },
    ]);
    expect(provider.runs[1]?.input[0]).toEqual({
      type: "text",
      text: expect.stringContaining("USER: Investigate the Grok app server."),
    });
    expect(provider.runs[1]?.input[0]).toEqual({
      type: "text",
      text: expect.stringContaining("ASSISTANT: I investigated the Grok app server."),
    });
    expect(notifications).toEqual([
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          runId: "turn-2",
          item: {
            id: "turn-2-item",
            type: "contextCompaction",
          },
        },
      },
    ]);

    provider.runs[1]?.deferred.resolve({
      assistantText: "Compact summary",
      providerResponseId: "resp_compact_1",
    });
    await flushAsync();

    expect(notifications).toEqual([
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          runId: "turn-2",
          item: {
            id: "turn-2-item",
            type: "contextCompaction",
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          runId: "turn-2",
          item: {
            id: "turn-2-item",
            type: "contextCompaction",
            text: "Compact summary",
          },
        },
      },
      {
        method: "thread/compacted",
        params: {
          threadId: "thread-1",
          itemId: "turn-2-item",
        },
      },
    ]);
  });

  it("compacts an otherwise empty thread deterministically", async () => {
    const provider = new FakeProvider();
    const { server, notifications } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });

    const started = await server.request("thread/compact/start", {
      threadId: "thread-1",
    });

    expect(started).toEqual({
      threadId: "thread-1",
      runId: "turn-1",
      itemId: "turn-1-item",
    });
    expect(provider.runs[0]?.input).toEqual([
      {
        type: "text",
        text: expect.stringContaining("No prior transcript is available."),
      },
    ]);

    provider.runs[0]?.deferred.resolve({
      assistantText: "Initial compact summary",
      providerResponseId: "resp_compact_2",
    });
    await flushAsync();

    expect(notifications).toEqual([
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          item: {
            id: "turn-1-item",
            type: "contextCompaction",
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          item: {
            id: "turn-1-item",
            type: "contextCompaction",
            text: "Initial compact summary",
          },
        },
      },
      {
        method: "thread/compacted",
        params: {
          threadId: "thread-1",
          itemId: "turn-1-item",
        },
      },
    ]);
  });

  it("emits a failed turn and keeps the thread readable when compaction fails", async () => {
    const provider = new FakeProvider();
    const { server, notifications } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });

    await server.request("thread/compact/start", {
      threadId: "thread-1",
    });
    provider.runs[0]?.deferred.reject(new Error("Compaction failed"));
    await flushAsync();

    const replay = await server.request("thread/read", {
      threadId: "thread-1",
      includeTurns: true,
    });

    expect(notifications).toEqual([
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          item: {
            id: "turn-1-item",
            type: "contextCompaction",
          },
        },
      },
      {
        method: "turn/failed",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          turn: {
            id: "turn-1",
            status: "failed",
            error: {
              message: "Compaction failed",
            },
          },
        },
      },
    ]);
    expect(replay).toEqual({
      threadId: "thread-1",
      thread: expect.objectContaining({
        threadId: "thread-1",
        cwd: "/repo/workspace",
      }),
      messages: [],
      lastUserMessage: undefined,
      lastAssistantMessage: undefined,
    });
  });
});
