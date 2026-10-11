import { describe, expect, it, vi } from "vitest";
import type { AppServerBackendKind } from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { OverlayStoreLike } from "../state/overlay-store-sqlite";
import { ReplayClient } from "../testing/replay-client";
import { ThreadCorrespondenceStore } from "../app-server/thread-correspondence-store";

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
      backend: AppServerBackendKind;
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
      backend: AppServerBackendKind;
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

describe("DesktopBackendRegistry replay integration", () => {
  it("returns each delivery only with its source turn when reading newest and older transcript pages", async () => {
    const source = { backend: "codex" as const, threadId: "sender" };
    const correspondenceStore = new ThreadCorrespondenceStore();
    const pages = ["newer", "older"].map((id) => {
      const startedAt = id === "older" ? 1_000 : 3_000;
      const turn = { id, startedAt, completedAt: startedAt + 500 };
      const entries = [
        { type: "message" as const, id: `${id}-user`, role: "user" as const, text: `${id} prompt`, turn },
        { type: "message" as const, id: `${id}-response`, role: "assistant" as const, text: `${id} response`, turn },
      ];
      correspondenceStore.record({
        id: `${id}-delivery`, source,
        destination: { backend: "codex", threadId: "recipient" },
        input: [{ type: "text", text: `${id} guidance` }],
        createdAt: turn.startedAt + 100, state: "started",
      });
      return {
        entries, messages: entries.map(({ turn: _turn, ...message }) => message),
        pagination: { supportsPagination: true, hasPreviousPage: id === "newer", previousCursor: id === "newer" ? "older-page" : undefined },
      };
    });
    const replayClient = ReplayClient.fromFixture({
      metadata: { backend: "codex", scenario: "correspondence-pagination" },
      steps: [
        { id: "initialize", kind: "response", method: "initialize", result: { methods: ["thread/read"] } },
        ...pages.map((result, index) => ({ id: `read-${index}`, kind: "response" as const, method: "thread/read", result })),
      ],
    });
    const overlayStore = {
      ...createOverlayStoreMock(),
      readThreadMessageOrigins: async () => ({}),
      readThreadPricing: async () => ({ summaries: [], lines: [] }),
      readThreadToolAccounting: async () => undefined,
    } as unknown as OverlayStoreLike;
    const registry = new DesktopBackendRegistry({ codexClient: replayClient, correspondenceStore, overlayStore, threadTitleGenerationService: null });
    try {
      for (const id of ["newer", "older"]) {
        const result = await registry.readThread({
          ...source, viewOnly: true, ...(id === "older" ? { before: "older-page" } : {}),
          display: { resource: "transcript" },
        });
        expect(result.replay.entries.map((entry) => entry.id)).toEqual([
          `${id}-user`, `${id}-response`, `${id}-delivery`,
        ]);
      }
    } finally {
      await registry.close();
    }
  });

  it("pages normalized history and persists one completed analysis batch", async () => {
    const replayClient = ReplayClient.fromFixture({
      metadata: {
        backend: "codex",
        scenario: "tool-output-history-analysis",
      },
      steps: [
        {
          id: "initialize-analysis",
          kind: "response",
          method: "initialize",
          result: {
            serverInfo: { name: "Replay Codex", version: "1.0.0" },
            methods: ["thread/read"],
          },
        },
        {
          id: "read-analysis-latest",
          kind: "response",
          method: "thread/read",
          result: {
            entries: [],
            messages: [],
            pagination: {
              hasPreviousPage: true,
              previousCursor: "older-page",
              supportsPagination: true,
            },
          },
        },
        {
          id: "read-analysis-oldest",
          kind: "response",
          method: "thread/read",
          result: {
            entries: [],
            messages: [],
            pagination: {
              hasPreviousPage: false,
              supportsPagination: true,
            },
          },
        },
      ],
    });
    const persistThreadToolHistoryAnalysis = vi.fn(async () => undefined);
    const readThreadToolAccounting = vi.fn(async () => ({
      alerts: [],
      invocations: [],
      summaries: [],
    }));
    const overlayStore = {
      ...createOverlayStoreMock(),
      persistThreadToolHistoryAnalysis,
      readThreadToolAccounting,
    } as unknown as OverlayStoreLike;
    const registry = new DesktopBackendRegistry({
      codexClient: replayClient,
      overlayStore,
    });

    const response = await registry.analyzeThreadToolHistory({
      backend: "codex",
      threadId: "fork-thread",
    });

    expect(response.coverage).toMatchObject({
      completeness: "complete",
      pageCount: 2,
    });
    expect(persistThreadToolHistoryAnalysis).toHaveBeenCalledOnce();
    expect(persistThreadToolHistoryAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "fork-thread" }),
    );
    expect(readThreadToolAccounting).toHaveBeenCalledWith({
      backend: "codex",
      includeAllInvocations: true,
      threadId: "fork-thread",
    });
    await registry.close();
  });

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
    await new Promise((resolve) => setTimeout(resolve, 0));

    const inputEvent = events.find(
      (event) => event.params.requestId === "input-request-1",
    );
    expect(inputEvent?.method).toBe("item/tool/requestUserInput");
    expect(inputEvent?.params).toMatchObject({
      requestId: "input-request-1",
      itemId: "input-1",
    });
    const [question] =
      (inputEvent?.params.questions as Array<{
        id?: string;
        options?: Array<{ label?: string }>;
      }> | undefined) ?? [];
    expect(question?.id).toBe("approach");
    expect(question?.options?.map((option) => option.label)).toEqual([
      "Small patch (Recommended)",
      "Large refactor"
    ]);

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
    await new Promise((resolve) => setTimeout(resolve, 0));

    const mcpEvent = events.find(
      (event) => event.params.requestId === "mcp-request-1",
    );
    expect(mcpEvent?.method).toBe("mcpServer/elicitation/request");
    expect(mcpEvent?.params).toMatchObject({
      requestId: "mcp-request-1",
      serverName: "playwright",
      mode: "form",
      message: "Allow the playwright MCP server to run tool \"browser_tabs\"?",
      requestedSchema: {
        type: "object",
        properties: {}
      }
    });

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
