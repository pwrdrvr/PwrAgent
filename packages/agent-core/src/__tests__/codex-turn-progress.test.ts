import { describe, expect, it } from "vitest";
import { createTestHarness, FakeProvider } from "../testing/test-harness.js";

async function flushNotifications(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Codex turn progress", () => {
  it("emits plan-related progress notifications before terminal completion", async () => {
    const provider = new FakeProvider();
    const { server, notifications } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });

    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Plan this change" }],
    });

    await provider.runs[0]?.emit({
      type: "item_started",
      item: {
        id: "plan-item-1",
        type: "plan",
      },
    });
    await provider.runs[0]?.emit({
      type: "turn_plan_updated",
      explanation: "Break the work down first.",
      steps: [
        { step: "Inspect the code", status: "completed" },
        { step: "Update the server", status: "in_progress" },
      ],
    });
    await provider.runs[0]?.emit({
      type: "item_plan_delta",
      itemId: "plan-item-1",
      delta: "- inspect the code\n",
    });
    await provider.runs[0]?.emit({
      type: "item_completed",
      item: {
        id: "plan-item-1",
        type: "plan",
        text: "- inspect the code",
      },
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "Done.",
      providerResponseId: "resp_plan",
    });
    await flushNotifications();

    expect(notifications).toEqual([
      {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          turn: {
            id: "turn-1",
            status: "in_progress",
          },
        },
      },
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          item: {
            id: "plan-item-1",
            type: "plan",
            text: undefined,
            review: undefined,
            command: undefined,
            commandAction: undefined,
            toolName: undefined,
            success: undefined,
            arguments: undefined,
          },
        },
      },
      {
        method: "turn/plan/updated",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          plan: {
            explanation: "Break the work down first.",
            steps: [
              { step: "Inspect the code", status: "completed" },
              { step: "Update the server", status: "in_progress" },
            ],
          },
        },
      },
      {
        method: "item/plan/delta",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          item: {
            id: "plan-item-1",
            type: "plan",
          },
          delta: "- inspect the code\n",
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          item: {
            id: "plan-item-1",
            type: "plan",
            text: "- inspect the code",
            review: undefined,
            command: undefined,
            commandAction: undefined,
            toolName: undefined,
            success: undefined,
            arguments: undefined,
          },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [{ type: "text", text: "Done." }],
          },
        },
      },
    ]);
  });
});
