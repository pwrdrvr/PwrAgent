import { describe, expect, it } from "vitest";
import { CodexAppServer } from "../app-server/codex-app-server.js";
import { AppServerSessionState } from "../app-server/session-state.js";
import { GrokRolloutStore } from "../persistence/grok-rollout-store.js";
import { FakeProvider, createTemporaryTestDirectory } from "../testing/test-harness.js";

describe("CodexAppServer persistence", () => {
  it("reloads threads and previous response ids across server recreation", async () => {
    const temp = await createTemporaryTestDirectory();

    try {
      const firstProvider = new FakeProvider();
      const firstServer = new CodexAppServer({
        provider: firstProvider,
        sessionState: new AppServerSessionState({
          store: new GrokRolloutStore(temp.path),
        }),
        threadIdGenerator: () => "thread-1",
        runIdGenerator: () => "turn-1",
      });

      await firstServer.request("thread/start", {
        cwd: "/repo/workspace",
        model: "grok-4.20-reasoning",
      });
      await firstServer.request("thread/name/set", {
        threadId: "thread-1",
        name: "OpenClaw parity",
      });
      await firstServer.request("turn/start", {
        threadId: "thread-1",
        input: [{ type: "text", text: "Ship it" }],
        collaborationMode: { mode: "default" },
      });

      firstProvider.runs[0]?.deferred.resolve({
        assistantText: "Done.",
        providerResponseId: "resp_1",
      });
      await Promise.resolve();
      await Promise.resolve();

      const secondProvider = new FakeProvider();
      const secondServer = new CodexAppServer({
        provider: secondProvider,
        sessionState: new AppServerSessionState({
          store: new GrokRolloutStore(temp.path),
        }),
        threadIdGenerator: () => "thread-2",
        runIdGenerator: () => "turn-2",
      });

      await expect(secondServer.request("thread/list", {})).resolves.toEqual({
        threads: [
          {
            threadId: "thread-1",
            title: "OpenClaw parity",
            summary: "Done.",
            projectKey: "/repo/workspace",
            model: "grok-4.20-reasoning",
            createdAt: expect.any(Number),
            updatedAt: expect.any(Number),
          },
        ],
      });
      await expect(
        secondServer.request("thread/read", { threadId: "thread-1" }),
      ).resolves.toEqual({
        threadId: "thread-1",
        thread: expect.objectContaining({
          threadId: "thread-1",
          threadName: "OpenClaw parity",
          cwd: "/repo/workspace",
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

      await secondServer.request("turn/start", {
        threadId: "thread-1",
        input: [{ type: "text", text: "Follow up" }],
        collaborationMode: { mode: "default" },
      });

      expect(secondProvider.runs[0]?.previousResponseId).toBe("resp_1");
    } finally {
      await temp.cleanup();
    }
  });
});
