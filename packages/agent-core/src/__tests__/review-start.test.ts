import { describe, expect, it } from "vitest";
import { createTestHarness, FakeProvider } from "../testing/test-harness.js";

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Codex review start", () => {
  it("starts an inline review run and emits the review completion notifications", async () => {
    const provider = new FakeProvider();
    const { server, notifications } = createTestHarness({ provider });
    await server.request("thread/start", {
      cwd: "/repo/workspace",
      model: "grok-4.20-reasoning",
    });

    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Please review the current diff." }],
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "Ready to review.",
      providerResponseId: "resp_turn_1",
    });
    await flushAsync();

    notifications.length = 0;

    const started = await server.request("review/start", {
      threadId: "thread-1",
      target: {
        type: "uncommittedChanges",
      },
      delivery: "inline",
    });

    expect(started).toEqual({
      reviewThreadId: "thread-1",
      runId: "turn-2",
    });
    expect(provider.runs[1]?.previousResponseId).toBe("resp_turn_1");
    expect(provider.runs[1]?.input).toEqual([
      {
        type: "text",
        text: expect.stringContaining(
          "Review the requested target and respond with inline review feedback.",
        ),
      },
    ]);
    expect(provider.runs[1]?.input[0]).toEqual({
      type: "text",
      text: expect.stringContaining('"type": "uncommittedChanges"'),
    });
    expect(provider.runs[1]?.input[0]).toEqual({
      type: "text",
      text: expect.stringContaining("USER: Please review the current diff."),
    });
    expect(provider.runs[1]?.input[0]).toEqual({
      type: "text",
      text: expect.stringContaining("ASSISTANT: Ready to review."),
    });

    provider.runs[1]?.deferred.resolve({
      assistantText: "Looks good overall.",
      providerResponseId: "resp_review_1",
    });
    await flushAsync();

    expect(notifications).toEqual([
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          runId: "turn-2",
          item: {
            id: "turn-2-item",
            type: "exitedReviewMode",
            review: "Looks good overall.",
          },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          runId: "turn-2",
          turn: {
            id: "turn-2",
            status: "completed",
            output: [{ type: "text", text: "Looks good overall." }],
          },
        },
      },
    ]);
  });

  it("emits a failed turn when the provider review run rejects", async () => {
    const provider = new FakeProvider();
    const { server, notifications } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });

    await server.request("review/start", {
      threadId: "thread-1",
      target: { type: "uncommittedChanges" },
      delivery: "inline",
    });
    provider.runs[0]?.deferred.reject(new Error("Review failed"));
    await flushAsync();

    const replay = await server.request("thread/read", {
      threadId: "thread-1",
      includeTurns: true,
    });

    expect(notifications).toEqual([
      {
        method: "turn/failed",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          turn: {
            id: "turn-1",
            status: "failed",
            error: {
              message: "Review failed",
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
