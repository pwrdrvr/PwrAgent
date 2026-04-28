import { describe, expect, it } from "vitest";
import { readReviewPrompt } from "../app-server/review-prompt.js";
import { createTestHarness, FakeProvider } from "../testing/test-harness.js";

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const reviewOutput = {
  findings: [
    {
      title: "Wrong branch comparison",
      body: "The review checks the wrong base branch when main is requested.",
      confidence_score: 0.9,
      priority: 2,
      code_location: {
        absolute_file_path: "/repo/workspace/src/review.ts",
        line_range: {
          start: 12,
          end: 12,
        },
      },
    },
  ],
  overall_correctness: "patch is incorrect",
  overall_explanation: "The patch has one review issue.",
  overall_confidence_score: 0.88,
} as const;

describe("Codex review start", () => {
  it("keeps the committed review prompt aligned with the Codex review schema", () => {
    const prompt = readReviewPrompt();

    expect(prompt).toContain("findings");
    expect(prompt).toContain("title");
    expect(prompt).toContain("body");
    expect(prompt).toContain("confidence_score");
    expect(prompt).toContain("priority");
    expect(prompt).toContain("code_location");
    expect(prompt).toContain("absolute_file_path");
    expect(prompt).toContain("line_range");
    expect(prompt).toContain("start");
    expect(prompt).toContain("end");
    expect(prompt).toContain("overall_correctness");
    expect(prompt).toContain("overall_explanation");
    expect(prompt).toContain("overall_confidence_score");
  });

  it("starts an inline review run and emits structured review completion notifications", async () => {
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
      threadId: "thread-1",
      reviewThreadId: "thread-1",
      turnId: "turn-2",
      turn: {
        id: "turn-2",
        status: "inProgress",
      },
    });
    expect(provider.runs[1]?.previousResponseId).toBe("resp_turn_1");
    expect(provider.runs[1]?.input).toEqual([
      {
        type: "text",
        text: expect.stringContaining(
          "You are acting as a reviewer for a proposed code change",
        ),
      },
    ]);
    expect(provider.runs[1]?.input[0]).toEqual({
      type: "text",
      text: expect.stringContaining("Review the current code changes"),
    });
    expect(provider.runs[1]?.input[0]).toEqual({
      type: "text",
      text: expect.stringContaining("overall_confidence_score"),
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
      assistantText: JSON.stringify(reviewOutput),
      providerResponseId: "resp_review_1",
    });
    await flushAsync();

    const replay = await server.request("thread/read", {
      threadId: "thread-1",
      includeTurns: true,
    });

    expect(notifications).toEqual([
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-2",
          item: {
            id: "turn-2-item-entered",
            type: "enteredReviewMode",
            review: "Review current changes",
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-2",
          item: {
            id: "turn-2-item",
            type: "exitedReviewMode",
            review: expect.stringContaining("The patch has one review issue."),
            data: { reviewOutput },
          },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-2",
          turn: {
            id: "turn-2",
            status: "completed",
            output: [
              {
                type: "text",
                text: expect.stringContaining("The patch has one review issue."),
              },
            ],
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
      messages: [
        { role: "user", text: "Please review the current diff." },
        { role: "assistant", text: "Ready to review." },
      ],
      items: [
        {
          id: expect.any(String),
          type: "userMessage",
          status: "completed",
          role: "user",
          text: "Please review the current diff.",
        },
        {
          id: expect.any(String),
          type: "agentMessage",
          status: "completed",
          role: "assistant",
          text: "Ready to review.",
        },
        {
          id: "turn-2-item-entered",
          type: "enteredReviewMode",
          status: "completed",
          review: "Review current changes",
        },
        {
          id: "turn-2-item",
          type: "exitedReviewMode",
          status: "completed",
          review: expect.stringContaining("The patch has one review issue."),
          data: { reviewOutput },
        },
      ],
      lastUserMessage: "Please review the current diff.",
      lastAssistantMessage: "Ready to review.",
    });
  });

  it("routes interactive review requests through the client before completing", async () => {
    const provider = new FakeProvider();
    const { server, notifications } = createTestHarness({
      provider,
      requestHandler: async () => ({ decision: "approve" }),
    });
    await server.request("thread/start", { cwd: "/repo/workspace" });

    await server.request("review/start", {
      threadId: "thread-1",
      target: { type: "uncommittedChanges" },
      delivery: "inline",
    });

    await provider.runs[0]?.emit({
      type: "request_input",
      requestId: "review-req-1",
      method: "review/requestApproval",
      params: {
        prompt: "Approve this review check?",
      },
      respond: async () => {
        return;
      },
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "Review complete.",
      providerResponseId: "resp_review_approval",
    });
    await flushAsync();

    expect(provider.runs[0]?.eventResponses).toEqual([{ decision: "approve" }]);
    expect(notifications).toEqual([
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "turn-1-item-entered",
            type: "enteredReviewMode",
            review: "Review current changes",
          },
        },
      },
      {
        method: "serverRequest/resolved",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "review-req-1",
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "turn-1-item",
            type: "exitedReviewMode",
            review: "Review complete.",
          },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [{ type: "text", text: "Review complete." }],
          },
        },
      },
    ]);
  });

  it("builds review context from a prior tool-bearing turn replay", async () => {
    const provider = new FakeProvider();
    const { server } = createTestHarness({ provider });
    await server.request("thread/start", {
      cwd: "/repo/workspace",
      model: "grok-4.20-reasoning",
    });

    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Search for the Grok tool usage plan." }],
    });
    await provider.runs[0]?.emit({
      type: "item_started",
      item: {
        id: "tool-1",
        type: "dynamicToolCall",
        text: "search_code",
        toolName: "search_code",
        arguments: { query: "tool usage plan" },
      },
    });
    await provider.runs[0]?.emit({
      type: "item_completed",
      item: {
        id: "tool-1",
        type: "dynamicToolCall",
        text: "Found docs/plans/2026-04-16-003-feat-grok-tool-usage-code-search-plan.md.",
        toolName: "search_code",
        success: true,
        arguments: { query: "tool usage plan" },
        commandAction: "search",
      },
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "I found the tool usage plan.",
      providerResponseId: "resp_turn_1",
    });
    await flushAsync();

    await server.request("review/start", {
      threadId: "thread-1",
      target: {
        type: "uncommittedChanges",
      },
      delivery: "inline",
    });

    expect(provider.runs[1]?.previousResponseId).toBe("resp_turn_1");
    expect(provider.runs[1]?.input).toEqual([
      {
        type: "text",
        text: expect.stringContaining("USER: Search for the Grok tool usage plan."),
      },
    ]);
    expect(provider.runs[1]?.input[0]).toEqual({
      type: "text",
      text: expect.stringContaining("ASSISTANT: I found the tool usage plan."),
    });

    const replay = await server.request("thread/read", {
      threadId: "thread-1",
      includeTurns: true,
    });
    expect(replay).toEqual(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            id: "tool-1",
            type: "dynamicToolCall",
            status: "completed",
            toolName: "search_code",
            success: true,
            commandAction: "search",
          }),
          expect.objectContaining({
            id: "turn-2-item-entered",
            type: "enteredReviewMode",
            review: "Review current changes",
          }),
        ]),
        lastAssistantMessage: "I found the tool usage plan.",
      }),
    );
  });

  it("normalizes snake_case base branch targets at the protocol boundary", async () => {
    const provider = new FakeProvider();
    const { server, notifications } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });

    await server.request("review/start", {
      threadId: "thread-1",
      target: {
        type: "base_branch",
        base_branch: "develop",
      },
      delivery: "inline",
    });

    expect(provider.runs[0]?.input).toEqual([
      {
        type: "text",
        text: expect.stringContaining("base branch 'develop'"),
      },
    ]);
    expect(notifications[0]).toEqual({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "turn-1-item-entered",
          type: "enteredReviewMode",
          review: "Review changes against develop",
        },
      },
    });
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
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "turn-1-item-entered",
            type: "enteredReviewMode",
            review: "Review current changes",
          },
        },
      },
      {
        method: "turn/failed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
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
      items: [
        {
          id: "turn-1-item-entered",
          type: "enteredReviewMode",
          status: "completed",
          review: "Review current changes",
        },
      ],
      lastUserMessage: undefined,
      lastAssistantMessage: undefined,
    });
  });
});
