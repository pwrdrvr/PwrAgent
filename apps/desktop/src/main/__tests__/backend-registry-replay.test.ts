import { describe, expect, it } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { OverlayStoreLike } from "../state/overlay-store-sqlite";
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
    setThreadAgent: async ({
      backend,
      threadId,
      agent,
    }: {
      backend: "codex" | "grok";
      threadId: string;
      agent: import("@pwragent/shared").ThreadOverlayState["agent"] | null;
    }) => ({
      backend,
      threadId,
      executionMode: "default" as const,
      extraLinkedDirectories: [],
      agent: agent ?? undefined,
    }),
  } as unknown as OverlayStoreLike;
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
    startTurn: async () => ({ threadId: "noop-thread", turnId: "noop-turn" }),
    interruptTurn: async () => ({ threadId: "noop-thread", turnId: "noop-turn" }),
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
              turnId: "turn-1",
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
              turnId: "turn-1",
              requestId: "approval-1"
            }
          }
        }
      ]
    });

    const registry = new DesktopBackendRegistry({
      codexClient: replayClient,
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
      turnId: "turn-1",
      requestId: "approval-1",
      response: {
        decision: "approve"
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(replayClient.getPendingRequest()).toBeUndefined();
    await registry.close();
  });

  it("preserves request_user_input question payloads through registry events", async () => {
    const replayClient = ReplayClient.fromFixture({
      metadata: {
        backend: "codex",
        scenario: "registry-user-input-replay"
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
          id: "req-input-1",
          kind: "request",
          request: {
            method: "item/tool/requestUserInput",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "input-1",
              requestId: "input-request-1",
              questions: [
                {
                  id: "approach",
                  header: "Approach",
                  question: "Which implementation path should I take?",
                  isOther: false,
                  isSecret: false,
                  options: [
                    {
                      label: "Small patch (Recommended)",
                      description: "Keep this scoped."
                    },
                    {
                      label: "Large refactor",
                      description: "Touch adjacent flows."
                    }
                  ]
                }
              ]
            }
          }
        }
      ]
    });

    const registry = new DesktopBackendRegistry({
      codexClient: replayClient,
      grokClient: createPassiveClient() as any,
      overlayStore: createOverlayStoreMock(),
    });
    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    registry.onEvent((event) => {
      events.push({
        method: event.notification.method,
        params: event.notification.params as Record<string, unknown>,
      });
    });

    await registry.readThread({
      backend: "codex",
      threadId: "thread-1"
    });
    await replayClient.advance({ stepId: "req-input-1" });

    expect(events).toContainEqual(
      expect.objectContaining({
        method: "item/tool/requestUserInput",
        params: expect.objectContaining({
          requestId: "input-request-1",
          itemId: "input-1",
          questions: [
            expect.objectContaining({
              id: "approach",
              options: [
                expect.objectContaining({
                  label: "Small patch (Recommended)"
                }),
                expect.objectContaining({
                  label: "Large refactor"
                })
              ]
            })
          ]
        })
      })
    );

    await registry.submitServerRequest({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: "input-request-1",
      response: {
        answers: {
          approach: {
            answers: ["Small patch (Recommended)"]
          }
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(replayClient.getPendingRequest()).toBeUndefined();
    await registry.close();
  });

  it("preserves MCP elicitation payloads through registry events", async () => {
    const replayClient = ReplayClient.fromFixture({
      metadata: {
        backend: "codex",
        scenario: "registry-mcp-elicitation-replay"
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
          id: "req-mcp-1",
          kind: "request",
          request: {
            method: "mcpServer/elicitation/request",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              requestId: "mcp-request-1",
              serverName: "playwright",
              mode: "form",
              _meta: {
                tool_description: "List, create, close, or select a browser tab.",
                tool_params_display: [
                  {
                    label: "action",
                    value: "list"
                  }
                ]
              },
              message: "Allow the playwright MCP server to run tool \"browser_tabs\"?",
              requestedSchema: {
                type: "object",
                properties: {}
              }
            }
          }
        }
      ]
    });

    const registry = new DesktopBackendRegistry({
      codexClient: replayClient,
      grokClient: createPassiveClient() as any,
      overlayStore: createOverlayStoreMock(),
    });
    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    registry.onEvent((event) => {
      events.push({
        method: event.notification.method,
        params: event.notification.params as Record<string, unknown>,
      });
    });

    await registry.readThread({
      backend: "codex",
      threadId: "thread-1"
    });
    await replayClient.advance({ stepId: "req-mcp-1" });

    expect(events).toContainEqual(
      expect.objectContaining({
        method: "mcpServer/elicitation/request",
        params: expect.objectContaining({
          requestId: "mcp-request-1",
          serverName: "playwright",
          mode: "form",
          message: "Allow the playwright MCP server to run tool \"browser_tabs\"?",
          requestedSchema: {
            type: "object",
            properties: {}
          }
        })
      })
    );

    await registry.submitServerRequest({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: "mcp-request-1",
      response: {
        action: "accept",
        content: {},
        _meta: null
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(replayClient.getPendingRequest()).toBeUndefined();
    await registry.close();
  });
});
