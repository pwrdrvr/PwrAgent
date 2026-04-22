import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppServerSessionState } from "../app-server/session-state.js";
import { GrokRolloutStore } from "../persistence/grok-rollout-store.js";
import {
  createTemporaryTestDirectory,
  createTestHarness,
  FakeProvider,
} from "../testing/test-harness.js";

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
            status: "in_progress",
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
            status: "completed",
            text: "- inspect the code",
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

  it("emits command output deltas without completing the turn", async () => {
    const provider = new FakeProvider();
    const { server, notifications } = createTestHarness({ provider });
    await server.request("thread/start", { cwd: "/repo/workspace" });

    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Run command" }],
    });

    await provider.runs[0]?.emit({
      type: "item_started",
      item: {
        id: "command-1",
        type: "commandExecution",
        command: "echo hello",
      },
    });
    await provider.runs[0]?.emit({
      type: "item_command_output_delta",
      itemId: "command-1",
      delta: "hello\n",
      stream: "stdout",
      bytes: 6,
    });

    expect(notifications.at(-1)).toEqual({
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread-1",
        runId: "turn-1",
        itemId: "command-1",
        delta: "hello\n",
        stream: "stdout",
        bytes: 6,
      },
    });
  });

  it("does not persist streamed command output deltas into rollout state", async () => {
    const temp = await createTemporaryTestDirectory();

    try {
      const provider = new FakeProvider();
      const sessionState = new AppServerSessionState({
        store: new GrokRolloutStore(temp.path),
      });
      const { server } = createTestHarness({ provider, sessionState });
      await server.request("thread/start", { cwd: "/repo/workspace" });

      await server.request("turn/start", {
        threadId: "thread-1",
        input: [{ type: "text", text: "Run noisy command" }],
      });

      await provider.runs[0]?.emit({
        type: "item_started",
        item: {
          id: "command-1",
          type: "commandExecution",
          command: "yes",
        },
      });
      await provider.runs[0]?.emit({
        type: "item_command_output_delta",
        itemId: "command-1",
        delta: "NOISY_OUTPUT\n",
        stream: "stdout",
        bytes: 13,
      });

      expect(
        sessionState.readThread("thread-1").items.find((item) => item.id === "command-1"),
      ).toEqual({
        id: "command-1",
        type: "commandExecution",
        status: "in_progress",
        command: "yes",
      });
      await expect(
        fs.readFile(path.join(temp.path, "threads/thread-1/rollout.jsonl"), "utf8"),
      ).resolves.not.toContain("NOISY_OUTPUT");
    } finally {
      await temp.cleanup();
    }
  });
});
