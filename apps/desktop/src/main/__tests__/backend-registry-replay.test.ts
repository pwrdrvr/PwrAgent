import { describe, expect, it } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { ReplayClient } from "../testing/replay-client";

function createOverlayStoreMock() {
  return {
    getThreadOverlayState: async () => undefined,
    getThreadOverlayStates: async ({ threadIds }: { threadIds: string[] }) =>
      Object.fromEntries(threadIds.map((threadId) => [threadId, undefined])),
    setThreadExecutionMode: async ({
      backend,
      threadId,
      executionMode,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      executionMode: "default" | "full-access";
    }) => ({
      backend,
      threadId,
      executionMode,
      extraLinkedDirectories: [],
    }),
  } as unknown as InstanceType<typeof import("@pwragnt/agent-core").OverlayStore>;
}

function createPassiveClient() {
  return {
    close: async () => undefined,
    getInitializeResult: async () => ({ methods: ["thread/list", "thread/read"] }),
    listThreads: async () => [],
    listSkills: async () => [],
    onNotification: () => () => undefined,
    readThread: async () => ({
      entries: [],
      messages: [],
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    }),
    startThread: async () => ({ threadId: "noop-thread" }),
    startTurn: async () => ({ threadId: "noop-thread", runId: "noop-turn" }),
    interruptTurn: async () => ({ threadId: "noop-thread", runId: "noop-turn" }),
  };
}

describe("DesktopBackendRegistry replay integration", () => {
  it("routes replay notifications through registry events and resolves replay requests through submitServerRequest", async () => {
    const replayClient = ReplayClient.fromFixture({
      metadata: {
        backend: "codex",
        scenario: "registry-replay"
      },
      steps: [
        {
          id: "initialize-1",
          kind: "response",
          method: "initialize",
          result: {
            serverInfo: {
              name: "Replay Codex",
              version: "1.0.0"
            },
            methods: ["thread/read"]
          }
        },
        {
          id: "read-1",
          kind: "response",
          method: "thread/read",
          result: {
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          }
        },
        {
          id: "notif-1",
          kind: "notification",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              runId: "turn-1",
              turn: {
                id: "turn-1",
                status: "completed",
                output: [{ type: "text", text: "Done." }]
              }
            }
          }
        },
        {
          id: "req-1",
          kind: "request",
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
    });

    const registry = new DesktopBackendRegistry({
      codexClient: replayClient,
      codexFullAccessClient: createPassiveClient() as any,
      grokClient: createPassiveClient() as any,
      overlayStore: createOverlayStoreMock(),
    });
    const events: string[] = [];
    registry.onEvent((event) => {
      events.push(event.notification.method);
    });

    await expect(
      registry.readThread({
        backend: "codex",
        threadId: "thread-1"
      })
    ).resolves.toEqual(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
      })
    );

    await replayClient.advance({ stepId: "notif-1" });
    expect(events).toContain("turn/completed");

    await replayClient.advance({ stepId: "req-1" });
    expect(replayClient.getPendingRequest()).toMatchObject({
      params: {
        requestId: "approval-1"
      }
    });

    await registry.submitServerRequest({
      backend: "codex",
      threadId: "thread-1",
      runId: "turn-1",
      requestId: "approval-1",
      response: {
        decision: "approve"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(replayClient.getPendingRequest()).toBeUndefined();
    await registry.close();
  });
});
