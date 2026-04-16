import { describe, expect, it } from "vitest";
import { CodexAppServer } from "../app-server/codex-app-server.js";
import type { AppServerNotification } from "../app-server/protocol.js";
import { GrokProvider } from "../providers/grok-provider.js";
import { loadLocalEnv } from "../testing/load-local-env.js";

const envResult = loadLocalEnv({ override: true });
const xaiApiKey = process.env.XAI_API_KEY?.trim();
const xaiBaseUrl = process.env.XAI_BASE_URL?.trim() || "https://api.x.ai/v1";
const grokModel = process.env.GROK_MODEL?.trim() || "grok-4.20-reasoning";
const liveSkipReason = !envResult.loaded
  ? `missing local env file at ${envResult.path}`
  : !xaiApiKey
    ? "XAI_API_KEY is missing from the local env file"
    : undefined;

const itLive = liveSkipReason ? it.skip : it;

function completedOutput(notification: AppServerNotification): string {
  if (notification.method !== "turn/completed") {
    throw new Error(`Expected a completed notification, received ${notification.method}`);
  }
  return notification.params.turn.output[0]?.text ?? "";
}

async function waitForNotification(
  notifications: AppServerNotification[],
  method: AppServerNotification["method"],
  runId: string,
): Promise<AppServerNotification> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const match = notifications.find(
      (notification) =>
        notification.method === method &&
        notification.params.runId === runId,
    );
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${method} for run ${runId}`);
}

describe("Grok live smoke", () => {
  itLive(
    "runs two real Grok-backed turns through the public app-server harness",
    { timeout: 45_000 },
    async () => {
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

      const marker = `smoke-${Date.now().toString(36)}`;
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
            text: `Reply with this token and no explanation: ${marker}`,
          },
        ],
      })) as { threadId: string; runId: string };
      const firstCompleted = await waitForNotification(
        notifications,
        "turn/completed",
        firstTurn.runId,
      );
      const firstOutput = completedOutput(firstCompleted);

      expect(firstOutput).toContain(marker);

      const secondTurn = (await server.request("turn/start", {
        threadId: "thread-live",
        input: [
          {
            type: "text",
            text: "What token did you just return? Reply with the token only.",
          },
        ],
      })) as { threadId: string; runId: string };
      const secondCompleted = await waitForNotification(
        notifications,
        "turn/completed",
        secondTurn.runId,
      );
      const secondOutput = completedOutput(secondCompleted);

      expect(secondOutput).toContain(marker);

      const replay = await server.request("thread/read", { threadId: "thread-live" });
      expect(replay).toMatchObject({
        threadId: "thread-live",
        lastUserMessage: "What token did you just return? Reply with the token only.",
      });
      expect((replay as { lastAssistantMessage?: string }).lastAssistantMessage).toContain(marker);
    },
  );
});
