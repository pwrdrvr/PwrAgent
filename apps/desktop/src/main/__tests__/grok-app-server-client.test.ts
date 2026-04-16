import { describe, expect, it } from "vitest";
import { CodexAppServer, FakeProvider } from "@pwragnt/agent-core";
import { GrokAppServerClient } from "../grok-app-server/client";

describe("GrokAppServerClient", () => {
  it("lists threads, reads replay, and forwards turn notifications", async () => {
    const provider = new FakeProvider();
    const server = new CodexAppServer({
      provider,
      threadIdGenerator: () => "thread-1",
      runIdGenerator: () => "turn-1",
    });

    const client = new GrokAppServerClient({
      server,
      directoryResolver: async (projectKey) =>
        projectKey
          ? [
              {
                id: "/repo/workspace",
                label: "workspace",
                path: "/repo/workspace",
                kind: "local",
              },
            ]
          : [],
    });

    const notifications: string[] = [];
    const unsubscribe = client.onNotification((notification) => {
      notifications.push(notification.method);
    });

    const initialize = await client.getInitializeResult();
    expect(initialize.serverInfo?.name).toBe("@pwragnt/grok-app-server");
    expect(initialize.methods).toContain("thread/list");
    expect(initialize.methods).toContain("turn/start");

    const created = await client.startThread({
      cwd: "/repo/workspace",
      model: "grok-4.20-reasoning",
    });
    expect(created).toEqual({ threadId: "thread-1" });

    const threads = await client.listThreads();
    expect(threads).toEqual([
      {
        id: "thread-1",
        title: "Untitled thread",
        summary: undefined,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
        linkedDirectories: [
          {
            id: "/repo/workspace",
            label: "workspace",
            path: "/repo/workspace",
            kind: "local",
          },
        ],
        source: "grok",
      },
    ]);

    const startedTurn = await client.startTurn({
      threadId: "thread-1",
      input: [{ type: "text", text: "Ship Unit 3" }],
    });
    expect(startedTurn).toEqual({ threadId: "thread-1", runId: "turn-1" });

    provider.runs[0]?.deferred.resolve({
      assistantText: "Done.",
      providerResponseId: "resp_1",
    });
    await Promise.resolve();
    await Promise.resolve();

    const replay = await client.readThread({ threadId: "thread-1" });
    expect(replay).toEqual({
      lastUserMessage: "Ship Unit 3",
      lastAssistantMessage: "Done.",
    });
    expect(notifications).toContain("turn/completed");

    unsubscribe();
    await client.close();
  });
});
