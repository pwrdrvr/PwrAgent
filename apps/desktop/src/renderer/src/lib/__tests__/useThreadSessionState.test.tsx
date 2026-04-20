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

  it("does not reread an interacted thread when only updatedAt changed on reselect", async () => {
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
      result.current.setActiveRunId("run-1");
      result.current.setActiveRunId(undefined);
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
      expect(result.current.entries[0]?.id).toBe("thread-1-message-1");
    });

    expect(readThread).toHaveBeenCalledTimes(2);
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
      result.current.setActiveRunId("run-1");
      result.current.setActiveRunId(undefined);
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
              runId: "run-1",
              turn: {
                id: "run-1",
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
      result.current.setActiveRunId("turn-1");
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
    expect(result.current.activeRunId).toBe("turn-1");
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
      result.current.setActiveRunId("turn-1");
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
    expect(result.current.activeRunId).toBe("turn-1");

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              runId: "turn-1",
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
    expect(result.current.activeRunId).toBeUndefined();
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
              runId: "run-1",
              turn: {
                id: "run-1",
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
});
