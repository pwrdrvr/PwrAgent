import { describe, expect, it } from "vitest";
import { createTestHarness, FakeProvider } from "../testing/test-harness.js";

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Codex tool-bearing replay", () => {
  it("persists provider item progress into thread replay", async () => {
    const provider = new FakeProvider();
    const { server } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });

    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Search the repository." }],
    });

    await provider.runs[0]?.emit({
      type: "item_started",
      item: {
        id: "tool-1",
        type: "dynamicToolCall",
        text: "search_code",
      },
    });
    await provider.runs[0]?.emit({
      type: "item_completed",
      item: {
        id: "tool-1",
        type: "dynamicToolCall",
        text: "Found 3 matches",
      },
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "I found the references.",
      providerResponseId: "resp_tool_1",
    });
    await flushAsync();

    const replay = await server.request("thread/read", {
      threadId: "thread-1",
      includeTurns: true,
    });

    expect(replay).toEqual({
      threadId: "thread-1",
      thread: expect.objectContaining({
        threadId: "thread-1",
        cwd: "/repo/workspace",
      }),
      messages: [
        { role: "user", text: "Search the repository." },
        { role: "assistant", text: "I found the references." },
      ],
      items: [
        {
          id: expect.any(String),
          type: "userMessage",
          status: "completed",
          role: "user",
          text: "Search the repository.",
        },
        {
          id: "tool-1",
          type: "dynamicToolCall",
          status: "completed",
          text: "Found 3 matches",
        },
        {
          id: expect.any(String),
          type: "agentMessage",
          status: "completed",
          role: "assistant",
          text: "I found the references.",
        },
      ],
      lastUserMessage: "Search the repository.",
      lastAssistantMessage: "I found the references.",
    });
  });

  it("accumulates plan deltas into replay items before completion", async () => {
    const provider = new FakeProvider();
    const { server } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });

    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Plan the update." }],
    });

    await provider.runs[0]?.emit({
      type: "item_started",
      item: {
        id: "plan-1",
        type: "plan",
      },
    });
    await provider.runs[0]?.emit({
      type: "item_plan_delta",
      itemId: "plan-1",
      delta: "- inspect code\n",
    });
    await provider.runs[0]?.emit({
      type: "item_plan_delta",
      itemId: "plan-1",
      delta: "- update tests\n",
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "Plan ready.",
      providerResponseId: "resp_plan_1",
    });
    await flushAsync();

    const replay = await server.request("thread/read", {
      threadId: "thread-1",
      includeTurns: true,
    });

    expect(replay).toEqual(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            id: "plan-1",
            type: "plan",
            status: "in_progress",
            text: "- inspect code\n- update tests\n",
          }),
        ]),
      }),
    );
  });
});
