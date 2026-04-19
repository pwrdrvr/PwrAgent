import { describe, expect, it } from "vitest";
import { ReplayClient } from "../testing/replay-client";

function buildFixture() {
  return {
    metadata: {
      backend: "codex" as const,
      scenario: "replay-client-test"
    },
    steps: [
      {
        id: "initialize-1",
        kind: "response" as const,
        method: "initialize" as const,
        result: {
          serverInfo: {
            name: "Replay Codex",
            version: "1.0.0"
          },
          methods: ["thread/list", "thread/read"]
        }
      },
      {
        id: "list-1",
        kind: "response" as const,
        method: "thread/list" as const,
        result: [
          {
            id: "thread-1",
            title: "Replay thread",
            titleSource: "explicit" as const,
            source: "codex" as const,
            linkedDirectories: [],
          }
        ]
      },
      {
        id: "notif-1",
        kind: "notification" as const,
        notification: {
          method: "turn/completed" as const,
          params: {
            threadId: "thread-1",
            runId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed" as const,
              output: [{ type: "text" as const, text: "Done." }]
            }
          }
        }
      },
      {
        id: "req-1",
        kind: "request" as const,
        request: {
          method: "turn/requestApproval",
          params: {
            threadId: "thread-1",
            runId: "turn-1",
            requestId: "approval-1"
          }
        }
      }
    ]
  };
}

function buildInterleavedFixture() {
  return {
    metadata: {
      backend: "codex" as const,
      scenario: "replay-client-interleaved-test"
    },
    steps: [
      {
        id: "initialize-1",
        kind: "response" as const,
        method: "initialize" as const,
        result: {
          serverInfo: {
            name: "Replay Codex",
            version: "1.0.0"
          },
          methods: ["thread/list"]
        }
      },
      {
        id: "notif-1",
        kind: "notification" as const,
        notification: {
          method: "turn/completed" as const,
          params: {
            threadId: "thread-1",
            runId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed" as const,
              output: [{ type: "text" as const, text: "Done." }]
            }
          }
        }
      },
      {
        id: "list-1",
        kind: "response" as const,
        method: "thread/list" as const,
        result: [
          {
            id: "thread-1",
            title: "Replay thread",
            titleSource: "explicit" as const,
            source: "codex" as const,
            linkedDirectories: [],
          }
        ]
      }
    ]
  };
}

describe("ReplayClient", () => {
  it("consumes response steps and advances live replay deterministically", async () => {
    const client = ReplayClient.fromFixture(buildFixture());
    const notifications: string[] = [];

    client.onNotification((notification) => {
      notifications.push(notification.method);
    });

    await expect(client.getInitializeResult()).resolves.toEqual({
      serverInfo: {
        name: "Replay Codex",
        version: "1.0.0"
      },
      methods: ["thread/list", "thread/read"]
    });

    await expect(client.listThreads()).resolves.toEqual([
      expect.objectContaining({
        id: "thread-1",
        title: "Replay thread"
      })
    ]);

    await client.advance({ stepId: "notif-1" });
    expect(notifications).toEqual(["turn/completed"]);
  });

  it("blocks later live steps until a pending request is resolved", async () => {
    const client = ReplayClient.fromFixture(buildFixture());

    await client.getInitializeResult();
    await client.listThreads();
    await client.advance({ stepId: "notif-1" });
    await client.advance({ stepId: "req-1" });

    expect(client.getPendingRequest()).toMatchObject({
      method: "turn/requestApproval",
      params: {
        requestId: "approval-1"
      }
    });

    await expect(client.advance()).rejects.toThrow(
      "Replay is waiting for request approval-1"
    );

    await client.respondToPendingRequest("approval-1");
    expect(client.getPendingRequest()).toBeUndefined();
  });

  it("requires interleaved live steps to be advanced before later responses", async () => {
    const client = ReplayClient.fromFixture(buildInterleavedFixture());
    const notifications: string[] = [];

    client.onNotification((notification) => {
      notifications.push(notification.method);
    });

    await expect(client.getInitializeResult()).resolves.toMatchObject({
      methods: ["thread/list"]
    });

    await expect(client.listThreads()).rejects.toThrow(
      "Replay fixture expected live step notif-1 before response thread/list"
    );

    await client.advance({ stepId: "notif-1" });
    expect(notifications).toEqual(["turn/completed"]);

    await expect(client.listThreads()).resolves.toEqual([
      expect.objectContaining({
        id: "thread-1"
      })
    ]);
  });
});
