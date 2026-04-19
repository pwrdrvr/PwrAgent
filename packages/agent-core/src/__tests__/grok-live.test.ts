import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAppServer } from "../app-server/codex-app-server.js";
import { resolveGrokAppServerRuntimeConfig } from "../config/grok-app-server-config.js";
import type { AppServerNotification } from "../app-server/protocol.js";
import { GrokProvider } from "../providers/grok-provider.js";
import { createTemporaryTestDirectory } from "../testing/test-harness.js";

const runtimeConfig = resolveGrokAppServerRuntimeConfig();
const xaiApiKey = runtimeConfig.apiKey?.trim();
const xaiBaseUrl = runtimeConfig.baseUrl?.trim() || "https://api.x.ai/v1";
const grokModel = runtimeConfig.model?.trim() || "grok-4.20-reasoning";
const liveSkipReason = xaiApiKey
  ? undefined
  : `XAI_API_KEY is not set in the environment or runtime config at ${runtimeConfig.configPath}`;

const itLive = liveSkipReason ? it.skip : it;
const liveNotificationTimeoutMs = 60_000;

function completedOutput(notification: AppServerNotification): string {
  if (notification.method !== "turn/completed") {
    throw new Error(`Expected a completed notification, received ${notification.method}`);
  }
  return notification.params.turn.output[0]?.text ?? "";
}

function completedItemText(notification: AppServerNotification): string {
  if (notification.method !== "item/completed") {
    throw new Error(`Expected a completed item notification, received ${notification.method}`);
  }
  return notification.params.item.text ?? notification.params.item.review ?? "";
}

async function waitForNotification(
  notifications: AppServerNotification[],
  predicate: (notification: AppServerNotification) => boolean,
  description: string,
): Promise<AppServerNotification> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < liveNotificationTimeoutMs) {
    const failed = notifications.find(
      (notification) => notification.method === "turn/failed",
    );
    if (failed?.method === "turn/failed") {
      throw new Error(
        `Received turn/failed while waiting for ${description}: ${failed.params.turn.error?.message ?? "unknown error"}`,
      );
    }
    const match = notifications.find((notification) => predicate(notification));
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function createLiveServer(): {
  notifications: AppServerNotification[];
  server: CodexAppServer;
} {
  const notifications: AppServerNotification[] = [];
  const provider = new GrokProvider({
    apiKey: xaiApiKey!,
    baseUrl: xaiBaseUrl,
    model: grokModel,
  });
  const server = new CodexAppServer({
    provider,
    threadIdGenerator: () => "thread-live",
    runIdGenerator: (() => {
      let index = 0;
      return () => `turn-live-${++index}`;
    })(),
  });
  server.onNotification(async (notification) => {
    notifications.push(notification);
  });
  return { notifications, server };
}

describe("Grok live smoke", () => {
  itLive(
    "runs a real Grok-backed thread through start, resume, and follow-up turns",
    { timeout: 90_000 },
    async () => {
      const { notifications, server } = createLiveServer();

      const marker = "sunny meadow checkpoint";
      const created = await server.request("thread/start", {
        cwd: "/tmp/live-smoke",
        model: grokModel,
      });
      expect(created).toMatchObject({
        threadId: "thread-live",
        model: grokModel,
      });

      const firstTurn = (await server.request("turn/start", {
        threadId: "thread-live",
        input: [
          {
            type: "text",
            text: `Reply with only these words: ${marker}`,
          },
        ],
      })) as { threadId: string; runId: string };
      const firstCompleted = await waitForNotification(
        notifications,
        (notification) =>
          notification.method === "turn/completed" &&
          notification.params.runId === firstTurn.runId,
        `turn/completed for ${firstTurn.runId}`,
      );
      const firstOutput = completedOutput(firstCompleted);

      expect(firstOutput).toContain(marker);

      const resumed = await server.request("thread/resume", {
        threadId: "thread-live",
        model: grokModel,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        persistExtendedHistory: false,
      });
      expect(resumed).toMatchObject({
        threadId: "thread-live",
        model: grokModel,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });

      const secondTurn = (await server.request("turn/start", {
        threadId: "thread-live",
        input: [
          {
            type: "text",
            text: "Repeat the same words from your previous reply.",
          },
        ],
      })) as { threadId: string; runId: string };
      const secondCompleted = await waitForNotification(
        notifications,
        (notification) =>
          notification.method === "turn/completed" &&
          notification.params.runId === secondTurn.runId,
        `turn/completed for ${secondTurn.runId}`,
      );
      const secondOutput = completedOutput(secondCompleted);

      expect(secondOutput).toContain(marker);

      const replay = await server.request("thread/read", { threadId: "thread-live" });
      expect(replay).toMatchObject({
        threadId: "thread-live",
        lastUserMessage: "Repeat the same words from your previous reply.",
      });
      expect((replay as { lastAssistantMessage?: string }).lastAssistantMessage).toContain(marker);
    },
  );

  itLive(
    "runs a real Grok-backed compaction flow through the public app-server harness",
    { timeout: 90_000 },
    async () => {
      const { notifications, server } = createLiveServer();

      const marker = `compact-${Date.now().toString(36)}`;
      await server.request("thread/start", {
        cwd: "/tmp/live-smoke",
        model: grokModel,
      });

      const seedTurn = (await server.request("turn/start", {
        threadId: "thread-live",
        input: [
          {
            type: "text",
            text: `Remember this token for the thread summary: ${marker}`,
          },
        ],
      })) as { threadId: string; runId: string };
      await waitForNotification(
        notifications,
        (notification) =>
          notification.method === "turn/completed" &&
          notification.params.runId === seedTurn.runId,
        `turn/completed for ${seedTurn.runId}`,
      );

      const compaction = (await server.request("thread/compact/start", {
        threadId: "thread-live",
      })) as { threadId: string; runId: string; itemId: string };

      const started = await waitForNotification(
        notifications,
        (notification) =>
          notification.method === "item/started" &&
          notification.params.runId === compaction.runId &&
          notification.params.item.id === compaction.itemId &&
          notification.params.item.type === "contextCompaction",
        `item/started for ${compaction.itemId}`,
      );
      const completed = await waitForNotification(
        notifications,
        (notification) =>
          notification.method === "item/completed" &&
          notification.params.runId === compaction.runId &&
          notification.params.item.id === compaction.itemId,
        `item/completed for ${compaction.itemId}`,
      );
      const compacted = await waitForNotification(
        notifications,
        (notification) =>
          notification.method === "thread/compacted" &&
          notification.params.threadId === "thread-live" &&
          notification.params.itemId === compaction.itemId,
        `thread/compacted for ${compaction.itemId}`,
      );

      expect(compaction).toEqual({
        threadId: "thread-live",
        runId: expect.stringMatching(/^turn-live-/),
        itemId: expect.stringMatching(/^turn-live-\d+-item$/),
      });
      expect(started).toEqual({
        method: "item/started",
        params: {
          threadId: "thread-live",
          runId: compaction.runId,
          item: {
            id: compaction.itemId,
            type: "contextCompaction",
          },
        },
      });
      expect(completedItemText(completed)).toBeTruthy();
      expect(compacted).toEqual({
        method: "thread/compacted",
        params: {
          threadId: "thread-live",
          itemId: compaction.itemId,
        },
      });
    },
  );

  itLive(
    "uses repository tools against a temporary workspace and reports the discovered marker",
    { timeout: 90_000 },
    async () => {
      const workspace = await createTemporaryTestDirectory();
      try {
        await fs.mkdir(path.join(workspace.path, "src"), { recursive: true });
        const marker = `tool-${Date.now().toString(36)}`;
        await fs.writeFile(
          path.join(workspace.path, "src", "marker.ts"),
          `export const TOOL_TARGET = "${marker}";\n`,
          "utf8",
        );

        const { notifications, server } = createLiveServer();
        await server.request("thread/start", {
          cwd: workspace.path,
          model: grokModel,
        });

        const turn = (await server.request("turn/start", {
          threadId: "thread-live",
          input: [
            {
              type: "text",
              text:
                "Use the repository tools to inspect this workspace and find the exact string value assigned to TOOL_TARGET in src/marker.ts. Reply with the value only.",
            },
          ],
        })) as { threadId: string; runId: string };

        const startedTool = await waitForNotification(
          notifications,
          (notification) =>
            notification.method === "item/started" &&
            notification.params.runId === turn.runId &&
            notification.params.item.type === "dynamicToolCall" &&
            ["read_file", "search_code", "list_files"].includes(
              notification.params.item.toolName ?? "",
            ),
          `tool item/started for ${turn.runId}`,
        );
        const completedTool = await waitForNotification(
          notifications,
          (notification) =>
            notification.method === "item/completed" &&
            notification.params.runId === turn.runId &&
            notification.params.item.type === "dynamicToolCall" &&
            notification.params.item.success === true &&
            ["read_file", "search_code", "list_files"].includes(
              notification.params.item.toolName ?? "",
            ),
          `tool item/completed for ${turn.runId}`,
        );
        const completedTurn = await waitForNotification(
          notifications,
          (notification) =>
            notification.method === "turn/completed" &&
            notification.params.runId === turn.runId,
          `turn/completed for ${turn.runId}`,
        );

        expect(startedTool.method).toBe("item/started");
        expect(completedTool.method).toBe("item/completed");
        expect(completedOutput(completedTurn)).toContain(marker);

        const replay = await server.request("thread/read", { threadId: "thread-live" });
        expect((replay as { lastAssistantMessage?: string }).lastAssistantMessage).toContain(
          marker,
        );
        expect((replay as { items?: Array<{ toolName?: string; success?: boolean }> }).items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              toolName: expect.stringMatching(/^(read_file|search_code|list_files)$/),
              success: true,
            }),
          ]),
        );
      } finally {
        await workspace.cleanup();
      }
    },
  );
});
