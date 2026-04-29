import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { DesktopApi } from "../desktop-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThreadSessionState } from "../useThreadSessionState";

function buildThread(params: {
  id: string;
  updatedAt: number;
}): any {
  return {
    id: params.id,
    title: `Thread ${params.id}`,
    titleSource: "explicit" as const,
    summary: `Summary for ${params.id}`,
    source: "codex" as const,
    linkedDirectories: [],
    inbox: {
      inInbox: false,
    },
    updatedAt: params.updatedAt,
  };
}

describe("useThreadSessionState", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the optimistic user message ahead of the completed assistant reply", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: "codex" | "grok";
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          messages: [
            {
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    act(() => {
      result.current.addOptimisticUserMessage("Please fix transcript ordering.");
    });

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              output: [{ type: "text", text: "Transcript ordering is fixed." }],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(
        result.current.entries.map((entry) =>
          entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
        )
      ).toEqual([
        "assistant:Loaded thread-1",
        "user:Please fix transcript ordering.",
        "assistant:Transcript ordering is fixed.",
      ]);
    });

    expect(
      result.current.response?.replay.messages.map(
        (message) => `${message.role}:${message.text}`
      )
    ).toEqual([
      "assistant:Loaded thread-1",
      "user:Please fix transcript ordering.",
      "assistant:Transcript ordering is fixed.",
    ]);
  });

  it("materializes a new thread in user-then-assistant order on completion", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: "codex" | "grok";
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-empty", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.response?.replay.entries).toEqual([]);
    });

    act(() => {
      result.current.addOptimisticUserMessage("Start a new ordered thread.");
    });

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-empty",
            turnId: "turn-2",
            turn: {
              output: [{ type: "text", text: "The new thread is ordered." }],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(
        result.current.entries.map((entry) =>
          entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
        )
      ).toEqual([
        "user:Start a new ordered thread.",
        "assistant:The new thread is ordered.",
      ]);
    });
  });

  it("preserves multiple streamed assistant messages before the final answer", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: "codex" | "grok";
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.response?.replay.entries).toEqual([]);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-1",
            delta: "First commentary.",
            phase: "commentary",
          },
        },
      });
    });

    expect(result.current.pendingAssistantMessage?.text).toBe("First commentary.");
    expect(result.current.pendingAssistantMessage?.phase).toBe("commentary");

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-2",
            delta: "Second commentary.",
            phase: "commentary",
          },
        },
      });
    });

    expect(
      result.current.entries.map((entry) =>
        entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
      )
    ).toEqual(["assistant:First commentary."]);
    expect(result.current.pendingAssistantMessage?.text).toBe("Second commentary.");
    expect(result.current.pendingAssistantMessage?.phase).toBe("commentary");

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              durationMs: 524_447,
              output: [{ type: "text", text: "Final answer." }],
            },
          },
        },
      });
    });

    expect(
      result.current.entries.map((entry) =>
        entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
      )
    ).toEqual([
      "assistant:First commentary.",
      "assistant:Second commentary.",
      "assistant:Final answer.",
    ]);
    expect(
      result.current.entries
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.phase)
    ).toEqual(["commentary", "commentary", "final"]);
    expect(
      result.current.entries
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.turn)
    ).toEqual([
      { id: "turn-1", status: "completed", durationMs: 524_447 },
      { id: "turn-1", status: "completed", durationMs: 524_447 },
      { id: "turn-1", status: "completed", durationMs: 524_447 },
    ]);
    expect(result.current.pendingAssistantMessage).toBeUndefined();
  });

  it("keeps streamed assistant commentary below the optimistic user prompt", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: "codex" | "grok";
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: "history-1",
              role: "assistant" as const,
              text: "Earlier thread context.",
            },
          ],
          messages: [
            {
              id: "history-1",
              role: "assistant" as const,
              text: "Earlier thread context.",
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.response?.replay.entries).toHaveLength(1);
    });

    act(() => {
      result.current.addOptimisticUserMessage("Please keep the reply under this prompt.");
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-1",
            delta: "First commentary.",
            phase: "commentary",
          },
        },
      });
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-2",
            delta: "Second commentary.",
            phase: "commentary",
          },
        },
      });
    });

    expect(
      result.current.entries.map((entry) =>
        entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
      )
    ).toEqual([
      "assistant:Earlier thread context.",
      "user:Please keep the reply under this prompt.",
      "assistant:First commentary.",
    ]);
    expect(result.current.pendingAssistantMessage?.text).toBe("Second commentary.");
  });

  it("hydrates unphased streamed assistant text after completion", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    let readCount = 0;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: "codex" | "grok";
        threadId: string;
      }) => {
        readCount += 1;
        return {
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries:
              readCount > 1
                ? [
                    {
                      type: "message" as const,
                      id: "hydrated-final",
                      role: "assistant" as const,
                      phase: "final" as const,
                      text: "Hydrated final answer.",
                      turn: {
                        id: "turn-1",
                        status: "completed" as const,
                      },
                    },
                  ]
                : [],
            messages:
              readCount > 1
                ? [
                    {
                      id: "hydrated-final",
                      role: "assistant" as const,
                      text: "Hydrated final answer.",
                    },
                  ]
                : [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        };
      }
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.response?.replay.entries).toEqual([]);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-1",
            delta: "Hydrated final answer.",
          },
        },
      });
    });

    expect(result.current.pendingAssistantMessage?.phase).toBeUndefined();

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.entries).toEqual([
        expect.objectContaining({
          id: "hydrated-final",
          phase: "final",
          text: "Hydrated final answer.",
        }),
      ]);
    });
  });

  it("tracks thinking state for a nonselected thread until the turn completes", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: "codex" | "grok";
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-2", updatedAt: 1_500 }),
      })
    );

    await waitFor(() => {
      expect(result.current.response?.threadId).toBe("thread-2");
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              status: "inProgress",
            },
          },
        },
      });
    });

    expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBe(true);

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Finished background work." }],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBeUndefined();
    });
  });

  it("rereads an interacted thread when updatedAt changed on reselect", async () => {
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: "codex" | "grok";
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          messages: [
            {
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };

    const thread1 = buildThread({ id: "thread-1", updatedAt: 1_000 });
    const thread1Updated = buildThread({ id: "thread-1", updatedAt: 2_000 });
    const thread2 = buildThread({ id: "thread-2", updatedAt: 1_500 });

    const { result, rerender } = renderHook(
      ({ thread }) =>
        useThreadSessionState({
          desktopApi,
          thread,
        }),
      {
        initialProps: {
          thread: thread1,
        },
      }
    );

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    expect(readThread).toHaveBeenCalledTimes(1);
    expect(readThread).toHaveBeenNthCalledWith(1, {
      backend: "codex",
      threadId: "thread-1",
    });

    act(() => {
      result.current.setActiveTurnId("turn-1");
      result.current.setActiveTurnId(undefined);
    });

    rerender({ thread: thread2 });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });

    expect(readThread).toHaveBeenNthCalledWith(2, {
      backend: "codex",
      threadId: "thread-2",
    });

    rerender({ thread: thread1Updated });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(3);
    });

    expect(readThread).toHaveBeenNthCalledWith(3, {
      backend: "codex",
      threadId: "thread-1",
    });
  });

  it("rereads an interacted thread when the cached transcript is still empty", async () => {
    const readThread = vi
      .fn()
      .mockImplementationOnce(
        async ({
          backend,
          threadId,
        }: {
          backend?: "codex" | "grok";
          threadId: string;
        }) => ({
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        })
      )
      .mockImplementationOnce(
        async ({
          backend,
          threadId,
        }: {
          backend?: "codex" | "grok";
          threadId: string;
        }) => ({
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [
              {
                type: "message" as const,
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "hello from launchpad",
              },
              {
                type: "message" as const,
                id: `${threadId}-message-2`,
                role: "assistant" as const,
                text: "captured after refresh",
              },
            ],
            messages: [
              {
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "hello from launchpad",
              },
              {
                id: `${threadId}-message-2`,
                role: "assistant" as const,
                text: "captured after refresh",
              },
            ],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        })
      );

    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };

    const thread = buildThread({ id: "thread-1", updatedAt: 1_000 });
    const updatedThread = buildThread({ id: "thread-1", updatedAt: 2_000 });

    const { result, rerender } = renderHook(
      ({ currentThread }) =>
        useThreadSessionState({
          desktopApi,
          thread: currentThread,
        }),
      {
        initialProps: {
          currentThread: thread,
        },
      }
    );

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
    });
    expect(result.current.entries).toHaveLength(0);

    act(() => {
      result.current.setActiveTurnId("turn-1");
      result.current.setActiveTurnId(undefined);
    });

    rerender({ currentThread: updatedThread });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.entries).toHaveLength(2);
    });
  });

  it("rereads an empty transcript after turn completion even when updatedAt is unchanged", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const readThread = vi
      .fn()
      .mockImplementationOnce(
        async ({
          backend,
          threadId,
        }: {
          backend?: "codex" | "grok";
          threadId: string;
        }) => ({
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        })
      )
      .mockImplementationOnce(
        async ({
          backend,
          threadId,
        }: {
          backend?: "codex" | "grok";
          threadId: string;
        }) => ({
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [
              {
                type: "message" as const,
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "hello from launchpad",
              },
              {
                type: "message" as const,
                id: `${threadId}-message-2`,
                role: "assistant" as const,
                text: "captured after refresh",
              },
            ],
            messages: [
              {
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "hello from launchpad",
              },
              {
                id: `${threadId}-message-2`,
                role: "assistant" as const,
                text: "captured after refresh",
              },
            ],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        })
      );

    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread,
    };

    const thread = buildThread({ id: "thread-1", updatedAt: 2_000 });

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread,
      })
    );

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
    });
    expect(result.current.entries).toHaveLength(0);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "completed",
                output: [],
              },
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.entries).toHaveLength(2);
    });
  });

  it("surfaces a failed transcript read once per thread version", async () => {
    const readThread = vi.fn(async () => {
      throw new Error(
        "json-rpc error (-32603): failed to locate rollout for thread thread-1"
      );
    });

    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };

    const thread = buildThread({ id: "thread-1", updatedAt: 1_000 });
    const updatedThread = buildThread({ id: "thread-1", updatedAt: 2_000 });

    const { result, rerender } = renderHook(
      ({ currentThread }) =>
        useThreadSessionState({
          desktopApi,
          thread: currentThread,
        }),
      {
        initialProps: {
          currentThread: thread,
        },
      }
    );

    await waitFor(() => {
      expect(result.current.error).toBe(
        "json-rpc error (-32603): failed to locate rollout for thread thread-1"
      );
    });
    expect(readThread).toHaveBeenCalledTimes(1);

    rerender({ currentThread: thread });

    await act(async () => {
      await Promise.resolve();
    });
    expect(readThread).toHaveBeenCalledTimes(1);

    rerender({ currentThread: updatedThread });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps thinking visible during metadata notifications for an active turn", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setActiveTurnId("turn-1");
      result.current.setPendingStatusText("Thinking");
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              tokenUsage: {
                modelContextWindow: 258400,
              },
            },
          } as any,
        });
        listener({
          backend: "codex",
          notification: {
            method: "account/rateLimits/updated",
            params: {
              rateLimits: {
                limitId: "codex",
                planType: "pro",
              },
            },
          } as any,
        });
        listener({
          backend: "codex",
          notification: {
            method: "item/commandExecution/outputDelta",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "call-1",
              delta: "To github.com:pwrdrvr/PwrAgnt.git\n",
            },
          } as any,
        });
      }
    });

    expect(result.current.pendingStatusText).toBe("Thinking");
    expect(result.current.activeTurnId).toBe("turn-1");
  });

  it("derives the transcript thinking status from an active turn when status text is cleared", async () => {
    const desktopApi: DesktopApi = {
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setPendingStatusText("Thinking");
      result.current.setActiveTurnId("turn-1");
      result.current.setPendingStatusText(undefined);
    });

    expect(result.current.activeTurnId).toBe("turn-1");
    expect(result.current.pendingStatusText).toBe("Thinking");
    expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBe(true);
  });

  it("keeps thinking visible when an idle status arrives before turn completion", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setActiveTurnId("turn-1");
      result.current.setPendingStatusText("Thinking");
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/status/changed",
            params: {
              threadId: "thread-1",
              status: {
                type: "idle",
              },
            },
          },
        });
      }
    });

    expect(result.current.pendingStatusText).toBe("Thinking");
    expect(result.current.activeTurnId).toBe("turn-1");

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "completed",
                output: [],
              },
            },
          },
        });
      }
    });

    expect(result.current.pendingStatusText).toBeUndefined();
    expect(result.current.activeTurnId).toBeUndefined();
  });

  it("shows a transcript status when context compaction starts", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "item/started",
            params: {
              threadId: "thread-1",
              turnId: "compact-turn-1",
              item: {
                id: "compact-item-1",
                type: "contextCompaction",
              },
            },
          },
        } as any);
      }
    });

    expect(result.current.pendingStatusText).toBe("Compacting context");
    expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBe(true);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/compacted",
            params: {
              threadId: "thread-1",
              itemId: "compact-item-1",
            },
          },
        });
      }
    });

    expect(result.current.pendingStatusText).toBeUndefined();
    expect(result.current.contextWindow).toBeUndefined();
  });

  it("surfaces failed turn errors in the transcript state", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "in_progress",
              },
            },
          } as any,
        });
      }
    });

    expect(result.current.pendingStatusText).toBe("Thinking");
    expect(result.current.activeTurnId).toBe("turn-1");

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/failed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "failed",
                error: {
                  message: "Provider completed the turn without assistant text.",
                },
              },
            },
          } as any,
        });
      }
    });

    expect(result.current.activeTurnId).toBeUndefined();
    expect(result.current.pendingStatusText).toBeUndefined();
    expect(result.current.error).toBe("Provider completed the turn without assistant text.");
  });

  it("surfaces command execution approval requests from app-server events", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "call-1",
              requestId: "approval-1",
              reason: "Network access is required.",
              command: "npm view dive",
            },
          } as any,
        });
      }
    });

    expect(result.current.pendingStatusText).toBe("Waiting for approval");
    expect(result.current.pendingRequest).toMatchObject({
      method: "item/commandExecution/requestApproval",
      params: {
        requestId: "approval-1",
        command: "npm view dive",
      },
    });
  });

  it("does not surface permissions approvals as command approval requests", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "item/permissions/requestApproval",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "call-1",
              requestId: "approval-1",
              reason: "Additional permissions are required.",
              permissions: {
                type: "full-access",
              },
            },
          } as any,
        });
      }
    });

    expect(result.current.pendingStatusText).toBeUndefined();
    expect(result.current.pendingRequest).toBeUndefined();
  });

  it("surfaces request_user_input as pending user input instead of approval", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
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
                  question: "Which path should I take?",
                  isOther: false,
                  isSecret: false,
                  options: [
                    {
                      label: "Small patch (Recommended)",
                      description: "Keep this scoped.",
                    },
                    {
                      label: "Large refactor",
                      description: "Touch adjacent flows.",
                    },
                  ],
                },
              ],
            },
          } as any,
        });
      }
    });

    expect(result.current.pendingStatusText).toBe("Waiting for input");
    expect(result.current.pendingRequest).toBeUndefined();
    expect(result.current.pendingUserInput).toMatchObject({
      method: "item/tool/requestUserInput",
      requestId: "input-request-1",
      questions: [
        {
          id: "approach",
          options: [
            {
              key: "A",
              label: "Small patch (Recommended)",
              recommended: true,
            },
            {
              key: "B",
              label: "Large refactor",
              recommended: false,
            },
          ],
        },
      ],
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "serverRequest/resolved",
            params: {
              threadId: "thread-1",
              requestId: "input-request-1",
            },
          },
        });
      }
    });

    expect(result.current.pendingUserInput).toBeUndefined();
    expect(result.current.pendingStatusText).toBe("Thinking");
  });

  it("surfaces MCP elicitations as pending MCP interactions instead of approval", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "mcpServer/elicitation/request",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              requestId: "mcp-request-1",
              serverName: "playwright",
              mode: "form",
              _meta: {
                tool_description: "List, create, close, or select a browser tab.",
              },
              message: "Allow the playwright MCP server to run tool \"browser_tabs\"?",
              requestedSchema: {
                type: "object",
                properties: {},
              },
            },
          },
        });
      }
    });

    expect(result.current.pendingStatusText).toBe("Waiting for MCP approval");
    expect(result.current.pendingRequest).toBeUndefined();
    expect(result.current.pendingUserInput).toBeUndefined();
    expect(result.current.pendingMcpInteraction).toMatchObject({
      method: "mcpServer/elicitation/request",
      requestId: "mcp-request-1",
      serverName: "playwright",
      mode: "form",
      form: {
        empty: true,
        fields: [],
      },
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "serverRequest/resolved",
            params: {
              threadId: "thread-1",
              requestId: "mcp-request-1",
            },
          },
        });
      }
    });

    expect(result.current.pendingMcpInteraction).toBeUndefined();
    expect(result.current.pendingStatusText).toBe("Thinking");
  });

  it("clears pending MCP interactions when the turn is cancelled", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "mcpServer/elicitation/request",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              requestId: "mcp-request-cancelled",
              serverName: "playwright",
              mode: "form",
              _meta: null,
              message: "Allow the playwright MCP server to run tool \"browser_tabs\"?",
              requestedSchema: {
                type: "object",
                properties: {},
              },
            },
          },
        });
      }
    });

    expect(result.current.pendingMcpInteraction?.requestId).toBe(
      "mcp-request-cancelled"
    );

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/cancelled",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "cancelled",
              },
            },
          },
        });
      }
    });

    expect(result.current.pendingMcpInteraction).toBeUndefined();
    expect(result.current.pendingRequest).toBeUndefined();
    expect(result.current.pendingUserInput).toBeUndefined();
    expect(result.current.pendingStatusText).toBeUndefined();
  });

  it("updates and clears pending MCP interactions", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "mcpServer/elicitation/request",
            params: {
              threadId: "thread-1",
              turnId: null,
              requestId: "mcp-request-2",
              serverName: "github",
              mode: "form",
              _meta: null,
              message: "Provide a repository.",
              requestedSchema: {
                type: "object",
                required: ["repo"],
                properties: {
                  repo: {
                    type: "string",
                    title: "Repository",
                  },
                },
              },
            },
          },
        });
      }
    });

    act(() => {
      result.current.updatePendingMcpInteraction("mcp-request-2", (state) => ({
        ...state,
        form: state.form
          ? {
              ...state.form,
              fields: state.form.fields.map((field) =>
                field.key === "repo" && field.kind === "string"
                  ? { ...field, value: "pwrdrvr/PwrAgnt" }
                  : field
              ),
            }
          : state.form,
      }));
    });

    expect(result.current.pendingMcpInteraction?.form?.fields[0]).toMatchObject({
      key: "repo",
      value: "pwrdrvr/PwrAgnt",
    });

    act(() => {
      result.current.clearPendingRequest("mcp-request-2", "Thinking");
    });

    expect(result.current.pendingMcpInteraction).toBeUndefined();
    expect(result.current.pendingStatusText).toBe("Thinking");
  });

  it("rereads a partially hydrated transcript after turn completion when only the user message is present", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const readThread = vi
      .fn()
      .mockImplementationOnce(
        async ({
          backend,
          threadId,
        }: {
          backend?: "codex" | "grok";
          threadId: string;
        }) => ({
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [
              {
                type: "message" as const,
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "Let's test creating a new thread again",
              },
            ],
            messages: [
              {
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "Let's test creating a new thread again",
              },
            ],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        })
      )
      .mockImplementationOnce(
        async ({
          backend,
          threadId,
        }: {
          backend?: "codex" | "grok";
          threadId: string;
        }) => ({
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [
              {
                type: "message" as const,
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "Let's test creating a new thread again",
              },
              {
                type: "message" as const,
                id: `${threadId}-message-2`,
                role: "assistant" as const,
                text: "The new thread is live and the reply has been hydrated.",
              },
            ],
            messages: [
              {
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "Let's test creating a new thread again",
              },
              {
                id: `${threadId}-message-2`,
                role: "assistant" as const,
                text: "The new thread is live and the reply has been hydrated.",
              },
            ],
            lastAssistantMessage: "The new thread is live and the reply has been hydrated.",
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        })
      );

    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread,
    };

    const thread = buildThread({ id: "thread-1", updatedAt: 2_000 });

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread,
      })
    );

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "completed",
                output: [],
              },
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.entries).toHaveLength(2);
    });
    expect(result.current.entries[1]).toMatchObject({
      role: "assistant",
      text: "The new thread is live and the reply has been hydrated.",
    });
  });

  it("renders live review items without synthesizing an assistant completion message", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: "codex" | "grok";
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          messages: [
            {
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    act(() => {
      result.current.addOptimisticReviewEntry("Review changes against main");
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-review-1",
              item: {
                id: "turn-review-1-item-entered",
                type: "enteredReviewMode",
                review: "changes against 'main'",
              },
            },
          },
        });
        listener({
          backend: "codex",
          notification: {
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-review-1",
              item: {
                id: "turn-review-1-item",
                type: "exitedReviewMode",
                review: "No findings. Ready to merge.",
                data: {
                  reviewOutput: {
                    findings: [],
                    overall_correctness: "patch is correct",
                    overall_explanation: "No findings. Ready to merge.",
                    overall_confidence_score: 0.92,
                  },
                },
              },
            },
          },
        });
        listener({
          backend: "codex",
          notification: {
            method: "item/agentMessage/delta",
            params: {
              threadId: "thread-1",
              turnId: "turn-review-1",
              itemId: "turn-review-1-assistant",
              delta: "No findings. Ready to merge.",
            },
          },
        });
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-review-1",
              turn: {
                id: "turn-review-1",
                status: "completed",
                output: [{ type: "text", text: "No findings. Ready to merge." }],
              },
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(
        result.current.entries.map((entry) =>
          entry.type === "message" ? `${entry.role}:${entry.text}` : `${entry.type}:${entry.id}`
        )
      ).toEqual([
        "assistant:Loaded thread-1",
        "review:turn-review-1-item-entered",
        "review:turn-review-1-item",
      ]);
      expect(result.current.entries[1]).toMatchObject({
        type: "review",
        review: "Review changes against main",
        displayText: "Review changes against main",
      });
    });
    expect(result.current.response?.replay.messages).toHaveLength(1);
    expect(result.current.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        text: "Loaded thread-1",
      }),
    ]);
  });

  it("stores context window usage from token usage notifications", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: vi.fn(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(desktopApi.readThread).toHaveBeenCalled();
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            tokenUsage: {
              total: {
                totalTokens: 96_000,
              },
              modelContextWindow: 128_000,
            },
          },
        },
      });
    });

    expect(result.current.contextWindow).toEqual({
      cachedInputTokens: undefined,
      cumulativeTotalTokens: undefined,
      inputTokens: undefined,
      modelContextWindow: 128_000,
      outputTokens: undefined,
      phase: 6,
      reasoningOutputTokens: undefined,
      remainingPercent: 25,
      remainingTokens: 32_000,
      totalTokens: 96_000,
      usedPercent: 75,
    });
  });

  it("derives context window usage from captured input and output token breakdowns", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: vi.fn(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(desktopApi.readThread).toHaveBeenCalled();
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            tokenUsage: {
              total: {
                inputTokens: 1_200,
                outputTokens: 12,
              },
              modelContextWindow: 258_400,
            },
          },
        },
      });
    });

    expect(result.current.contextWindow).toEqual({
      cachedInputTokens: undefined,
      cumulativeTotalTokens: undefined,
      inputTokens: 1_200,
      modelContextWindow: 258_400,
      outputTokens: 12,
      phase: 0,
      reasoningOutputTokens: undefined,
      remainingPercent: ((258_400 - 1_212) / 258_400) * 100,
      remainingTokens: 258_400 - 1_212,
      totalTokens: 1_212,
      usedPercent: (1_212 / 258_400) * 100,
    });
  });

  it("prefers last token usage over cumulative session usage for context fill", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: vi.fn(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(desktopApi.readThread).toHaveBeenCalled();
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 20_663,
                cached_input_tokens: 20_352,
                output_tokens: 45,
                total_tokens: 20_708,
              },
              total_token_usage: {
                input_tokens: 41_267,
                cached_input_tokens: 23_808,
                output_tokens: 75,
                total_tokens: 41_342,
              },
              model_context_window: 258_400,
            },
          },
        },
      });
    });

    expect(result.current.contextWindow).toMatchObject({
      cachedInputTokens: 20_352,
      cumulativeTotalTokens: 41_342,
      inputTokens: 20_663,
      modelContextWindow: 258_400,
      outputTokens: 45,
      phase: 0,
      totalTokens: 20_708,
      usedPercent: (20_708 / 258_400) * 100,
    });
  });
});
