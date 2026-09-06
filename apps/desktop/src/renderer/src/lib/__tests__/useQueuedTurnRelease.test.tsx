import { useMemo, useRef } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  AgentEvent,
  BackendSummary,
  ComposerThreadOwner,
  StartReviewRequest,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerDraftStore } from "../../features/composer/useComposerDraftStore";
import type { DesktopApi } from "../desktop-api";
import { useQueuedTurnRelease as useOwnerQueuedTurnRelease } from "../useQueuedTurnRelease";

const fixtureOwners = new WeakMap<ComposerDraftStore, Map<string, ComposerThreadOwner>>();

/** Test owner endpoints are seeded independently of the production hook's demands. */
function useQueuedTurnRelease(params: Parameters<typeof useOwnerQueuedTurnRelease>[0] & { threads: NavigationThreadSummary[] }) {
  const current = useRef(params);
  current.current = params;
  const owners = fixtureOwners.get(params.composerDraftStore) ?? new Map<string, ComposerThreadOwner>();
  for (const row of params.threads) owners.set(`thread:${row.source}:${row.id}`, {
    backend: row.source, threadId: row.id, target: row.federation?.ref.target ?? { scope: "local" },
  });
  fixtureOwners.set(params.composerDraftStore, owners);
  for (const [scope, owner] of owners) {
    const entries = params.composerDraftStore.getQueuedTurns(scope);
    if (entries.some((entry) => !entry.threadOwner)) params.composerDraftStore.setQueuedTurns(scope,
      entries.map((entry) => ({ ...entry, threadOwner: entry.threadOwner ?? owner })),
    );
  }
  const desktopApi = useMemo<DesktopApi>(() => ({
    getNavigationSelectedDetail: async (request) => {
      const row = current.current.threads.find((candidate) => candidate.source === request.ref.backend && candidate.id === request.ref.threadId);
      return { protocol: 2, ref: request.ref, revision: "detail", readiness: "ready", identity: row ? "present" : "deleted", thread: row };
    },
    getNavigationQueueProjection: async (request) => ({
      protocol: 2, ref: request.ref, revision: "fifo", readiness: "ready", complete: true, entries: [],
    }),
    listBackends: async () => ({ fetchedAt: 1, backends: current.current.backends }),
    ...params.desktopApi,
  }), [params.desktopApi]);
  useOwnerQueuedTurnRelease({ ...params, desktopApi });
}

type BranchDriftResult = Awaited<
  ReturnType<NonNullable<DesktopApi["checkThreadBranchDrift"]>>
>;

function createComposerDraftStore(): ComposerDraftStore {
  const queuedTurns = new Map<
    string,
    ReturnType<ComposerDraftStore["getQueuedTurns"]>
  >();
  const store: ComposerDraftStore = {
    getScopeOwner: (scope) => fixtureOwners.get(store)?.get(scope),
    hydrationStatus: "memory-only",
    getDraftScopeKeys: () => [],
    getQueuedScopeKeys: () => [...queuedTurns.keys()],
    delete: vi.fn(),
    get: vi.fn(),
    popDraft: vi.fn(),
    pushDraft: vi.fn(),
    deletePendingSteer: vi.fn(),
    deleteQueuedTurn: (scopeKey) => {
      queuedTurns.delete(scopeKey);
    },
    getPendingSteer: vi.fn(),
    getQueuedTurn: (scopeKey) => queuedTurns.get(scopeKey)?.[0],
    getQueuedTurns: (scopeKey) => queuedTurns.get(scopeKey) ?? [],
    getQueuedTurnVersion: () => 0,
    subscribeQueuedTurns: () => () => {},
    hasDraftContent: () => false,
    getDraftPresenceVersion: () => 0,
    subscribeDraftPresence: () => () => {},
    removeQueuedTurnAt: (scopeKey, index) => {
      const current = queuedTurns.get(scopeKey) ?? [];
      const next = [...current];
      const [removed] = next.splice(index, 1);
      if (next.length > 0) {
        queuedTurns.set(scopeKey, next);
      } else {
        queuedTurns.delete(scopeKey);
      }
      return removed;
    },
    removeQueuedTurnById: (scopeKey, id) => {
      const current = queuedTurns.get(scopeKey) ?? [];
      const index = current.findIndex((entry) => entry.id === id);
      if (index === -1) {
        return undefined;
      }
      const next = [...current];
      const [removed] = next.splice(index, 1);
      if (next.length > 0) {
        queuedTurns.set(scopeKey, next);
      } else {
        queuedTurns.delete(scopeKey);
      }
      return removed;
    },
    shiftQueuedTurn: (scopeKey) => {
      const current = queuedTurns.get(scopeKey) ?? [];
      const [first, ...rest] = current;
      if (rest.length > 0) {
        queuedTurns.set(scopeKey, rest);
      } else {
        queuedTurns.delete(scopeKey);
      }
      return first;
    },
    setPendingSteer: vi.fn(),
    setQueuedTurn: (scopeKey, snapshot) => {
      queuedTurns.set(scopeKey, [snapshot]);
    },
    setQueuedTurns: (scopeKey, snapshots) => {
      queuedTurns.set(scopeKey, snapshots);
    },
    set: vi.fn(),
  };
  return store;
}

function backendSummary(): BackendSummary {
  return {
    kind: "codex",
    label: "Codex",
    available: true,
    methods: ["turn/start", "review/start"],
    capabilities: {
      listThreads: true,
      createThread: true,
      resumeThread: true,
      renameThread: false,
      readThread: true,
      startTurn: true,
      startReview: true,
      interruptTurn: true,
      steerTurn: false,
      transcriptPagination: true,
      toolUse: false,
      approvalRequests: true,
      multiDirectoryThreads: true,
    },
    executionModes: [
      {
        mode: "default",
        label: "Default Access",
        available: true,
        isDefault: true,
      },
    ],
  };
}

function thread(
  id: string,
  overrides: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    titleSource: "explicit",
    source: "codex",
    executionMode: "default",
    linkedDirectories: [],
    inbox: { inInbox: false },
    ...overrides,
  };
}

describe("useQueuedTurnRelease", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears a backend-owned queued message without dispatching it from React", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const startTurn = vi.fn();
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-ui-1",
      queueEntryId: "backend-queue-1",
      text: "Backend-owned reply",
      imageAttachments: [],
      fileAttachments: [],
      input: [{ type: "text", text: "Backend-owned reply" }],
    });

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi: {
          onAgentEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          startTurn,
        },
        selectedThread: thread("thread-b"),
        threads: [thread("thread-a"), thread("thread-b")],
      }),
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/turnQueue/updated",
            params: {
              threadId: "thread-a",
              queueEntryId: "backend-queue-1",
              origin: "manual",
              status: "started",
              turnId: "turn-next",
            },
          },
        });
      }
    });

    expect(startTurn).not.toHaveBeenCalled();
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a"),
    ).toBeUndefined();
  });

  it("keeps a backend-owned queued message when its start is blocked", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-ui-1",
      queueEntryId: "backend-queue-1",
      text: "Backend-owned reply",
      imageAttachments: [],
      fileAttachments: [],
      input: [{ type: "text", text: "Backend-owned reply" }],
    });

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi: {
          onAgentEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          startTurn: vi.fn(),
        },
        selectedThread: thread("thread-b"),
        threads: [thread("thread-a"), thread("thread-b")],
      }),
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/turnQueue/updated",
            params: {
              threadId: "thread-a",
              queueEntryId: "backend-queue-1",
              origin: "manual",
              status: "blocked",
              errorMessage: "Thread is not ready.",
            },
          },
        });
      }
    });

    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a"),
    ).toMatchObject({
      id: "queued-ui-1",
      queueEntryId: "backend-queue-1",
    });
  });

  it("releases the oldest queued message for a non-focused thread when its turn completes", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      turnId: "turn-next",
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startTurn,
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurns("thread:codex:thread-a", [
      {
        id: "queued-1",
        text: "First background reply",
        imageAttachments: [],
        fileAttachments: [],
        input: [{ type: "text", text: "First background reply" }],
      },
      {
        id: "queued-2",
        text: "Second background reply",
        imageAttachments: [],
        fileAttachments: [],
        input: [{ type: "text", text: "Second background reply" }],
      },
    ]);

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-b"),
        threads: [
          thread("thread-a", {
            model: "gpt-5.5",
            reasoningEffort: "high",
            serviceTier: "priority",
            fastMode: true,
          }),
          thread("thread-b"),
        ],
      })
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-a",
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
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          threadId: "thread-a",
          input: [{ type: "text", text: "First background reply" }],
        })
      );
    });
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")?.text
    ).toBe("Second background reply");
  });

  it("claims a queued message once when duplicate release subscribers see the same completion", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      turnId: "turn-next",
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startTurn,
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurns("thread:codex:thread-a", [
      {
        id: "queued-1",
        text: "First background reply",
        imageAttachments: [],
        fileAttachments: [],
        input: [{ type: "text", text: "First background reply" }],
      },
      {
        id: "queued-2",
        text: "Second background reply",
        imageAttachments: [],
        fileAttachments: [],
        input: [{ type: "text", text: "Second background reply" }],
      },
    ]);
    const hookParams = {
      backends: [backendSummary()],
      composerDraftStore,
      desktopApi,
      selectedThread: thread("thread-b"),
      threads: [thread("thread-a"), thread("thread-b")],
    };

    renderHook(() => useQueuedTurnRelease(hookParams));
    renderHook(() => useQueuedTurnRelease(hookParams));

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-a",
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
      expect(startTurn).toHaveBeenCalledTimes(1);
    });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-a",
        input: [{ type: "text", text: "First background reply" }],
      }),
    );
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")?.text,
    ).toBe("Second background reply");
  });

  it("releases a queued message for a non-focused thread when its status becomes idle", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      turnId: "turn-next",
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startTurn,
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-idle",
      text: "Idle status reply",
      imageAttachments: [],
      fileAttachments: [],
      input: [{ type: "text", text: "Idle status reply" }],
    });

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-b"),
        threads: [
          thread("thread-a", {
            model: "gpt-5.5",
            reasoningEffort: "high",
            serviceTier: "priority",
            fastMode: true,
          }),
          thread("thread-b"),
        ],
      })
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/status/changed",
            params: {
              threadId: "thread-a",
              status: { type: "idle" },
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          threadId: "thread-a",
          input: [{ type: "text", text: "Idle status reply" }],
        })
      );
    });
    expect(composerDraftStore.getQueuedTurn("thread:codex:thread-a")).toBeUndefined();
  });

  it("waits until a scheduled queued message is due before background release", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    const listeners = new Set<(event: AgentEvent) => void>();
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      turnId: "turn-next",
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startTurn,
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-scheduled",
      text: "Future background reply",
      imageAttachments: [],
      fileAttachments: [],
      scheduledSendAt: Date.now() + 15 * 60_000,
      input: [{ type: "text", text: "Future background reply" }],
    });

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-b"),
        threads: [thread("thread-a"), thread("thread-b")],
      })
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/status/changed",
            params: {
              threadId: "thread-a",
              status: { type: "idle" },
            },
          },
        });
      }
    });

    expect(startTurn).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-07-10T12:15:00Z"));
    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/status/changed",
            params: {
              threadId: "thread-a",
              status: { type: "idle" },
            },
          },
        });
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-a",
        input: [{ type: "text", text: "Future background reply" }],
      })
    );
  });

  it("releases the due scheduled background turn ahead of an earlier future scheduled turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    const listeners = new Set<(event: AgentEvent) => void>();
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      turnId: "turn-sooner",
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startTurn,
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurns("thread:codex:thread-a", [
      {
        id: "queued-later",
        text: "Later background reply",
        imageAttachments: [],
        fileAttachments: [],
        scheduledSendAt: Date.now() + 2 * 60 * 60_000,
        input: [{ type: "text", text: "Later background reply" }],
      },
      {
        id: "queued-sooner",
        text: "Sooner background reply",
        imageAttachments: [],
        fileAttachments: [],
        scheduledSendAt: Date.now() + 15 * 60_000,
        input: [{ type: "text", text: "Sooner background reply" }],
      },
    ]);

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-b"),
        threads: [thread("thread-a"), thread("thread-b")],
      })
    );

    vi.setSystemTime(new Date("2026-07-10T12:15:00Z"));
    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/status/changed",
            params: {
              threadId: "thread-a",
              status: { type: "idle" },
            },
          },
        });
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-a",
        input: [{ type: "text", text: "Sooner background reply" }],
      })
    );
    expect(
      composerDraftStore.getQueuedTurns("thread:codex:thread-a").map((entry) => entry.text)
    ).toEqual(["Later background reply"]);
  });

  it("releases a queued review with review/start for a non-focused thread", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const startTurn = vi.fn();
    const startReview = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      reviewThreadId: "thread-a",
      turnId: "review-turn",
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startReview,
      startTurn,
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-review",
      text: "/review main",
      imageAttachments: [],
      fileAttachments: [],
      reviewCommand: {
        cwd: "/repo/selected-worktree",
        displayText: "Review changes against main",
        target: {
          type: "baseBranch",
          branch: "main",
        },
      },
    });

    const backend = backendSummary();
    backend.capabilities.startReview = true;

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backend],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-b"),
        threads: [
          thread("thread-a", {
            model: "gpt-5.5",
            reasoningEffort: "high",
            serviceTier: "priority",
            fastMode: true,
          }),
          thread("thread-b"),
        ],
      })
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-a",
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
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-a",
        target: {
          type: "baseBranch",
          branch: "main",
        },
        delivery: "inline",
        cwd: "/repo/selected-worktree",
        model: "gpt-5.5",
        reasoningEffort: "high",
        serviceTier: "priority",
        fastMode: true,
      });
    });
    expect(startTurn).not.toHaveBeenCalled();
    expect(composerDraftStore.getQueuedTurn("thread:codex:thread-a")).toBeUndefined();
  });

  it("releases a queued review on its picked reviewer, not the thread's", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: "codex" as const,
      threadId: request.threadId,
      reviewThreadId: "thread-a",
      turnId: "review-turn",
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startReview,
      startTurn: vi.fn(),
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-review",
      text: "/review main",
      imageAttachments: [],
      fileAttachments: [],
      reviewCommand: {
        displayText: "Review changes against main",
        target: { type: "baseBranch", branch: "main" },
        reviewer: {
          backend: "acp:grok",
          model: "grok-4",
          reasoningEffort: "high",
        },
      },
    });

    const backend = backendSummary();
    backend.capabilities.startReview = true;

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backend],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-b"),
        threads: [
          thread("thread-a", {
            model: "gpt-5.5",
            reasoningEffort: "medium",
            serviceTier: "priority",
            fastMode: true,
          }),
          thread("thread-b"),
        ],
      })
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-a",
              turnId: "turn-1",
              turn: { id: "turn-1", status: "completed", output: [] },
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          reviewBackend: "acp:grok",
          model: "grok-4",
          reasoningEffort: "high",
        })
      );
    });
    // The thread's own settings belong to a different catalog and must not
    // ride along with an overridden reviewer.
    const request = startReview.mock.calls.at(-1)?.[0];
    expect(request).toBeDefined();
    expect(request).not.toHaveProperty("serviceTier");
    expect(request).not.toHaveProperty("fastMode");
  });

  it("keeps a queued review when review/start rejects", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const startReview = vi.fn(async () => {
      throw new Error("review unavailable");
    });
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startReview,
      startTurn: vi.fn(),
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-review",
      text: "/review main",
      imageAttachments: [],
      fileAttachments: [],
      reviewCommand: {
        displayText: "Review changes against main",
        target: {
          type: "baseBranch",
          branch: "main",
        },
      },
    });

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-b"),
        threads: [thread("thread-a"), thread("thread-b")],
      })
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-a",
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
      expect(startReview).toHaveBeenCalled();
    });
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")?.id
    ).toBe("queued-review");
  });

  it("does not remove the next background queued message when the started item changed while in flight", async () => {
    let resolveStartTurn: (() => void) | undefined;
    const listeners = new Set<(event: AgentEvent) => void>();
    const startTurn = vi.fn(
      () =>
        new Promise<{
          backend: "codex";
          threadId: string;
          turnId: string;
        }>((resolve) => {
          resolveStartTurn = () => {
            resolve({
              backend: "codex",
              threadId: "thread-a",
              turnId: "turn-next",
            });
          };
        })
    );
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startTurn,
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurns("thread:codex:thread-a", [
      {
        id: "queued-1",
        text: "First background reply",
        imageAttachments: [],
        fileAttachments: [],
        input: [{ type: "text", text: "First background reply" }],
      },
      {
        id: "queued-2",
        text: "Second background reply",
        imageAttachments: [],
        fileAttachments: [],
        input: [{ type: "text", text: "Second background reply" }],
      },
    ]);

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-b"),
        threads: [thread("thread-a"), thread("thread-b")],
      })
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-a",
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
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          input: [{ type: "text", text: "First background reply" }],
        })
      );
    });

    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")?.text
    ).toBe("Second background reply");

    await act(async () => {
      resolveStartTurn?.();
    });

    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")?.text
    ).toBe("Second background reply");
  });

  it("does not background-release a branch-tracked thread when the drift guard reports drift", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const startTurn = vi.fn();
    const checkThreadBranchDrift = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      expectedBranch: "feature/expected",
      observedBranch: "feature/actual",
      drifted: true,
      checkedAt: Date.now(),
    }));
    const desktopApi: DesktopApi = {
      checkThreadBranchDrift,
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startTurn,
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-branch",
      text: "Guarded background reply",
      imageAttachments: [],
      fileAttachments: [],
      input: [{ type: "text", text: "Guarded background reply" }],
    });

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-b"),
        threads: [
          thread("thread-a", { gitBranch: "feature/expected" }),
          thread("thread-b"),
        ],
      })
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-a",
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

    expect(startTurn).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(checkThreadBranchDrift).toHaveBeenCalledWith({
        backend: "codex",
        expectedBranch: "feature/expected",
        threadId: "thread-a",
      });
    });
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")?.text
    ).toBe("Guarded background reply");
  });

  it("releases a queued review for a non-focused thread when its turn completes", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const startTurn = vi.fn();
    const startReview = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      reviewThreadId: "thread-a",
      turnId: "turn-review",
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startReview,
      startTurn,
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-review",
      text: "/review main",
      imageAttachments: [],
      fileAttachments: [],
      reviewCommand: {
        cwd: "/repo/background-worktree",
        displayText: "Review changes against main",
        target: { type: "baseBranch", branch: "main" },
      },
    });

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-b"),
        threads: [thread("thread-a"), thread("thread-b")],
      })
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-a",
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
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-a",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
        cwd: "/repo/background-worktree",
      });
    });
    expect(startTurn).not.toHaveBeenCalled();
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")
    ).toBeUndefined();
  });

  it("releases a branch-tracked queued review after a clean drift check", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const startReview = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      reviewThreadId: "thread-a",
      turnId: "turn-review",
    }));
    const checkThreadBranchDrift = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      expectedBranch: "feature/review",
      observedBranch: "feature/review",
      drifted: false,
      checkedAt: Date.now(),
    }));
    const desktopApi: DesktopApi = {
      checkThreadBranchDrift,
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startReview,
      startTurn: vi.fn(),
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-review",
      text: "/review main",
      imageAttachments: [],
      fileAttachments: [],
      reviewCommand: {
        cwd: "/repo/polled-worktree",
        displayText: "Review changes against main",
        target: { type: "baseBranch", branch: "main" },
      },
    });

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-b"),
        threads: [
          thread("thread-a", { gitBranch: "feature/review" }),
          thread("thread-b"),
        ],
      })
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-a",
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
      expect(checkThreadBranchDrift).toHaveBeenCalledWith({
        backend: "codex",
        expectedBranch: "feature/review",
        threadId: "thread-a",
      });
      expect(startReview).toHaveBeenCalled();
    });
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")
    ).toBeUndefined();
  });

  it("keeps a branch-tracked queued review when the drift check blocks background release", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const startReview = vi.fn();
    const checkThreadBranchDrift = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      expectedBranch: "feature/review",
      observedBranch: "main",
      drifted: true,
      checkedAt: Date.now(),
    }));
    const desktopApi: DesktopApi = {
      checkThreadBranchDrift,
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startReview,
      startTurn: vi.fn(),
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-review",
      text: "/review main",
      imageAttachments: [],
      fileAttachments: [],
      reviewCommand: {
        cwd: "/repo/retained-worktree",
        displayText: "Review changes against main",
        target: { type: "baseBranch", branch: "main" },
      },
    });

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-b"),
        threads: [
          thread("thread-a", { gitBranch: "feature/review" }),
          thread("thread-b"),
        ],
      })
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-a",
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
      expect(checkThreadBranchDrift).toHaveBeenCalled();
    });
    expect(startReview).not.toHaveBeenCalled();
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")?.text
    ).toBe("/review main");
  });

  it("releases a queued review when non-HEAD branch drift was retained", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const startReview = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      reviewThreadId: "thread-a",
      turnId: "turn-review",
    }));
    const checkThreadBranchDrift = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      expectedBranch: "feature/review",
      observedBranch: "main",
      drifted: true,
      checkedAt: Date.now(),
    }));
    const desktopApi: DesktopApi = {
      checkThreadBranchDrift,
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startReview,
      startTurn: vi.fn(),
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-review",
      text: "/review main",
      imageAttachments: [],
      fileAttachments: [],
      reviewCommand: {
        cwd: "/repo/retained-worktree",
        displayText: "Review changes against main",
        target: { type: "baseBranch", branch: "main" },
      },
    });

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-b"),
        threads: [
          thread("thread-a", {
            gitBranch: "feature/review",
            retainedBranchDriftPairs: [
              {
                expectedBranch: "feature/review",
                observedBranch: "main",
                retainedAt: 1,
              },
            ],
          }),
          thread("thread-b"),
        ],
      })
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-a",
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
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-a",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
        cwd: "/repo/retained-worktree",
      });
    });
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")
    ).toBeUndefined();
  });

  it("keeps a queued review when a stale retained HEAD drift pair exists", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const startReview = vi.fn();
    const checkThreadBranchDrift = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      expectedBranch: "HEAD",
      observedBranch: "fix/review",
      drifted: true,
      checkedAt: Date.now(),
    }));
    const desktopApi: DesktopApi = {
      checkThreadBranchDrift,
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startReview,
      startTurn: vi.fn(),
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-review",
      text: "/review main",
      imageAttachments: [],
      fileAttachments: [],
      reviewCommand: {
        cwd: "/repo/polled-worktree",
        displayText: "Review changes against main",
        target: { type: "baseBranch", branch: "main" },
      },
    });

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-b"),
        threads: [
          thread("thread-a", {
            gitBranch: "HEAD",
            retainedBranchDriftPairs: [
              {
                expectedBranch: "HEAD",
                observedBranch: "fix/review",
                retainedAt: 1,
              },
            ],
          }),
          thread("thread-b"),
        ],
      })
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-a",
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
      expect(checkThreadBranchDrift).toHaveBeenCalledWith({
        backend: "codex",
        expectedBranch: "HEAD",
        threadId: "thread-a",
      });
    });
    expect(startReview).not.toHaveBeenCalled();
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")?.text
    ).toBe("/review main");
  });

  it("background-releases a branch-tracked thread when the drift guard passes", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      turnId: "turn-next",
    }));
    const checkThreadBranchDrift = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      expectedBranch: "fix/queued-review-release",
      observedBranch: "fix/queued-review-release",
      drifted: false,
      checkedAt: Date.now(),
    }));
    const desktopApi: DesktopApi = {
      checkThreadBranchDrift,
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startTurn,
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-branch",
      text: "Release background reply",
      imageAttachments: [],
      fileAttachments: [],
      input: [{ type: "text", text: "Release background reply" }],
    });

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-b"),
        threads: [
          thread("thread-a", { gitBranch: "feature/expected" }),
          thread("thread-b"),
        ],
      })
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-a",
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
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          threadId: "thread-a",
          input: [{ type: "text", text: "Release background reply" }],
        })
      );
    });
    expect(composerDraftStore.getQueuedTurn("thread:codex:thread-a")).toBeUndefined();
  });

  it("does not background-release when the guarded thread becomes focused", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    let resolveDrift: ((value: BranchDriftResult) => void) | undefined;
    const startTurn = vi.fn();
    const checkThreadBranchDrift = vi.fn(
      () =>
        new Promise<BranchDriftResult>((resolve) => {
          resolveDrift = resolve;
        })
    );
    const desktopApi: DesktopApi = {
      checkThreadBranchDrift,
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startTurn,
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-branch",
      text: "Release background reply",
      imageAttachments: [],
      fileAttachments: [],
      input: [{ type: "text", text: "Release background reply" }],
    });

    const { rerender } = renderHook(
      ({ selectedThread }: { selectedThread: NavigationThreadSummary }) =>
        useQueuedTurnRelease({
          backends: [backendSummary()],
          composerDraftStore,
          desktopApi,
          selectedThread,
          threads: [
            thread("thread-a", { gitBranch: "feature/expected" }),
            thread("thread-b"),
          ],
        }),
      { initialProps: { selectedThread: thread("thread-b") } },
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-a",
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
      expect(checkThreadBranchDrift).toHaveBeenCalled();
    });

    rerender({
      selectedThread: thread("thread-a", { gitBranch: "feature/expected" }),
    });
    await act(async () => {
      resolveDrift?.({
        backend: "codex",
        threadId: "thread-a",
        expectedBranch: "fix/queued-review-release",
        observedBranch: "fix/queued-review-release",
        drifted: false,
        checkedAt: Date.now(),
      });
    });

    expect(startTurn).not.toHaveBeenCalled();
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")?.id
    ).toBe("queued-branch");
  });

  it("does not background-release when the queued item changes during the drift guard", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    let resolveDrift: ((value: BranchDriftResult) => void) | undefined;
    const startTurn = vi.fn();
    const checkThreadBranchDrift = vi.fn(
      () =>
        new Promise<BranchDriftResult>((resolve) => {
          resolveDrift = resolve;
        })
    );
    const desktopApi: DesktopApi = {
      checkThreadBranchDrift,
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startTurn,
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-old",
      text: "Stale background reply",
      imageAttachments: [],
      fileAttachments: [],
      input: [{ type: "text", text: "Stale background reply" }],
    });

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-b"),
        threads: [
          thread("thread-a", { gitBranch: "feature/expected" }),
          thread("thread-b"),
        ],
      })
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-a",
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
      expect(checkThreadBranchDrift).toHaveBeenCalled();
    });

    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-new",
      text: "Current background reply",
      imageAttachments: [],
      fileAttachments: [],
      input: [{ type: "text", text: "Current background reply" }],
    });
    await act(async () => {
      resolveDrift?.({
        backend: "codex",
        threadId: "thread-a",
        expectedBranch: "fix/queued-review-release",
        observedBranch: "fix/queued-review-release",
        drifted: false,
        checkedAt: Date.now(),
      });
    });

    expect(startTurn).not.toHaveBeenCalled();
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")?.id
    ).toBe("queued-new");
  });

  it("leaves the focused thread queue for the mounted composer to release", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const startTurn = vi.fn();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      startTurn,
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-1",
      text: "Focused reply",
      imageAttachments: [],
      fileAttachments: [],
      input: [{ type: "text", text: "Focused reply" }],
    });

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-a"),
        threads: [thread("thread-a")],
      })
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-a",
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

    expect(startTurn).not.toHaveBeenCalled();
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")?.text
    ).toBe("Focused reply");
  });

  it("leaves the focused thread queue to the mounted composer during the idle probe", async () => {
    vi.useFakeTimers();
    const startReview = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      reviewThreadId: "thread-a",
      turnId: "turn-review",
    }));
    const readThread = vi.fn(async () => ({
      backend: "codex" as const,
      fetchedAt: Date.now(),
      threadId: "thread-a",
      threadStatus: "idle" as const,
      replay: {
        entries: [],
        messages: [],
        pagination: {
          hasPreviousPage: false,
          supportsPagination: true,
        },
      },
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
      startReview,
      startTurn: vi.fn(),
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-review",
      text: "/review main",
      imageAttachments: [],
      fileAttachments: [],
      reviewCommand: {
        cwd: "/repo/polled-worktree",
        displayText: "Review changes against main",
        target: { type: "baseBranch", branch: "main" },
      },
    });

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-a"),
        threads: [thread("thread-a")],
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(readThread).not.toHaveBeenCalled();
    expect(startReview).not.toHaveBeenCalled();
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")?.text
    ).toBe("/review main");
  });

  it("does not release from the idle probe when the thread becomes focused mid-check", async () => {
    vi.useFakeTimers();
    let resolveReadThread:
      | ((response: Awaited<ReturnType<NonNullable<DesktopApi["readThread"]>>>) => void)
      | undefined;
    const startReview = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      reviewThreadId: "thread-a",
      turnId: "turn-review",
    }));
    const readThread = vi.fn(
      () =>
        new Promise<
          Awaited<ReturnType<NonNullable<DesktopApi["readThread"]>>>
        >((resolve) => {
          resolveReadThread = resolve;
        })
    );
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
      startReview,
      startTurn: vi.fn(),
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-review",
      text: "/review main",
      imageAttachments: [],
      fileAttachments: [],
      reviewCommand: {
        cwd: "/repo/polled-worktree",
        displayText: "Review changes against main",
        target: { type: "baseBranch", branch: "main" },
      },
    });

    const { rerender } = renderHook(
      ({ selectedThread }: { selectedThread: NavigationThreadSummary }) =>
        useQueuedTurnRelease({
          backends: [backendSummary()],
          composerDraftStore,
          desktopApi,
          selectedThread,
          threads: [thread("thread-a"), thread("thread-b")],
        }),
      { initialProps: { selectedThread: thread("thread-b") } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(readThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-a",
      limit: 1,
    });

    rerender({ selectedThread: thread("thread-a") });

    await act(async () => {
      resolveReadThread?.({
        backend: "codex",
        fetchedAt: Date.now(),
        threadId: "thread-a",
        threadStatus: "idle",
        replay: {
          entries: [],
          messages: [],
          pagination: {
            hasPreviousPage: false,
            supportsPagination: true,
          },
        },
      });
    });

    expect(startReview).not.toHaveBeenCalled();
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")?.id
    ).toBe("queued-review");
  });

  it("periodically releases a non-focused queued review after verifying the thread is idle", async () => {
    vi.useFakeTimers();
    const startReview = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      reviewThreadId: "thread-a",
      turnId: "turn-review",
    }));
    const readThread = vi.fn(async () => ({
      backend: "codex" as const,
      fetchedAt: Date.now(),
      threadId: "thread-a",
      threadStatus: "idle" as const,
      replay: {
        entries: [],
        messages: [],
        pagination: {
          hasPreviousPage: false,
          supportsPagination: true,
        },
      },
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
      startReview,
      startTurn: vi.fn(),
    };
    const composerDraftStore = createComposerDraftStore();
    composerDraftStore.setQueuedTurn("thread:codex:thread-a", {
      id: "queued-review",
      text: "/review main",
      imageAttachments: [],
      fileAttachments: [],
      reviewCommand: {
        cwd: "/repo/polled-worktree",
        displayText: "Review changes against main",
        target: { type: "baseBranch", branch: "main" },
      },
    });

    renderHook(() =>
      useQueuedTurnRelease({
        backends: [backendSummary()],
        composerDraftStore,
        desktopApi,
        selectedThread: thread("thread-b"),
        threads: [thread("thread-a"), thread("thread-b")],
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(readThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-a",
      limit: 1,
    });
    expect(startReview).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-a",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
      cwd: "/repo/polled-worktree",
    });
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")
    ).toBeUndefined();
  });
});

describe("queue release without navigation rows", () => {
  afterEach(() => { vi.useRealTimers(); });
  const owner: ComposerThreadOwner = { backend: "codex", threadId: "same", target: { scope: "remote", instanceId: "owner" } };
  const scope = "thread:codex:same";
  function seededStore(owned = true) {
    const store = createComposerDraftStore();
    store.setQueuedTurns(scope, [{ id: "local-queued", text: "off-page reply", imageAttachments: [], fileAttachments: [],
      ...(owned ? { threadOwner: owner } : {}),
    }]);
    return store;
  }
  function ownerApi(patch: Partial<DesktopApi> = {}): DesktopApi {
    return {
      getNavigationSelectedDetail: vi.fn(async (request) => ({
        protocol: 2, ref: request.ref, revision: "detail", readiness: "ready", identity: "present", thread: thread("same"),
      })),
      getNavigationQueueProjection: vi.fn(async (request) => ({
        protocol: 2, ref: request.ref, revision: "fifo", readiness: "ready", complete: true, entries: [],
      })),
      listBackends: vi.fn(async () => ({ fetchedAt: 1, backends: [backendSummary()] })),
      readThread: vi.fn(async () => ({ backend: "codex", threadId: "same", threadStatus: "idle", replay: { entries: [] } })),
      startTurn: vi.fn(async () => ({ backend: "codex", threadId: "same", turnId: "accepted" })),
      ...patch,
    };
  }

  it("releases an off-page owner queue while another owner's same-ID thread is selected", async () => {
    vi.useFakeTimers();
    const store = seededStore();
    const api = ownerApi();
    const onUserRepliedToThread = vi.fn();
    renderHook(() => useOwnerQueuedTurnRelease({
      backends: [backendSummary()], composerDraftStore: store, desktopApi: api,
      selectedThread: thread("same"), onUserRepliedToThread,
    }));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({ federationTarget: owner.target, threadId: "same" }));
    expect(api.listBackends).toHaveBeenCalledWith({ includeUnavailable: true, federationTarget: owner.target });
    expect(onUserRepliedToThread).toHaveBeenCalledTimes(1);
    expect(store.getQueuedTurns(scope)).toHaveLength(0);
  });

  it("does not infer an unowned legacy entry's owner from a mounted scope registration", async () => {
    vi.useFakeTimers();
    const store = seededStore(false);
    fixtureOwners.set(store, new Map([[scope, owner]]));
    const api = ownerApi();
    renderHook(() => useOwnerQueuedTurnRelease({ backends: [backendSummary()], composerDraftStore: store, desktopApi: api }));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(api.getNavigationSelectedDetail).not.toHaveBeenCalled();
    expect(api.startTurn).not.toHaveBeenCalled();
    expect(store.getQueuedTurns(scope)).toHaveLength(1);
  });

  it("does not leapfrog an owner FIFO that has not reached the renderer mirror yet", async () => {
    vi.useFakeTimers();
    const store = seededStore();
    const api = ownerApi({ getNavigationQueueProjection: vi.fn(async (request) => ({
      protocol: 2, ref: request.ref, revision: "fifo", readiness: "ready", complete: true,
      entries: [{ queueEntryId: "owner-head", createdAt: 1, displayText: "accepted earlier", origin: "manual", position: 0 }],
    })) });
    renderHook(() => useOwnerQueuedTurnRelease({ backends: [backendSummary()], composerDraftStore: store, desktopApi: api }));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(api.startTurn).not.toHaveBeenCalled();
    expect(store.getQueuedTurns(scope)).toHaveLength(1);
  });

  it("does not dispatch after the consumer closes during its exact configuration read", async () => {
    vi.useFakeTimers();
    let resolve!: (value: Awaited<ReturnType<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>>) => void;
    const pending = new Promise<Awaited<ReturnType<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>>>((done) => { resolve = done; });
    const api = ownerApi({ getNavigationSelectedDetail: vi.fn(() => pending) });
    const store = seededStore();
    const hook = renderHook(() => useOwnerQueuedTurnRelease({ backends: [backendSummary()], composerDraftStore: store, desktopApi: api }));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    hook.unmount();
    await act(async () => resolve({ protocol: 2, ref: { backend: "codex", threadId: "same", ownerInstanceId: "owner" },
      revision: "detail", readiness: "ready", identity: "present", thread: thread("same"),
    }));
    expect(api.getNavigationQueueProjection).not.toHaveBeenCalled();
    expect(api.startTurn).not.toHaveBeenCalled();
    expect(store.getQueuedTurns(scope)).toHaveLength(1);
  });
  it("admits at most eight physical release probes across a background sweep", async () => {
    vi.useFakeTimers();
    const store = createComposerDraftStore();
    const pending: Array<() => void> = [];
    for (let index = 0; index < 20; index += 1) {
      const owned = { ...owner, threadId: `thread-${index}` };
      store.setQueuedTurns(`thread:codex:${owned.threadId}`, [{
        id: `queued-${index}`, text: "reply", imageAttachments: [], fileAttachments: [], threadOwner: owned,
      }]);
    }
    const read = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>((request) => new Promise((resolve) => {
      pending.push(() => resolve({ protocol: 2, ref: request.ref, revision: "detail", readiness: "ready", identity: "present", thread: thread(request.ref.threadId) }));
    }));
    const api = ownerApi({ getNavigationSelectedDetail: read });
    const hook = renderHook(() => useOwnerQueuedTurnRelease({ backends: [backendSummary()], composerDraftStore: store, desktopApi: api }));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(read).toHaveBeenCalledTimes(8);
    hook.unmount();
    await act(async () => { for (const resolve of pending) resolve(); });
    expect(read).toHaveBeenCalledTimes(8);
    expect(api.startTurn).not.toHaveBeenCalled();
  });

  it("only removes an accepted FIFO mirror for a terminal event from its owner", async () => {
    const store = seededStore();
    store.setQueuedTurns(scope, store.getQueuedTurns(scope).map((entry) => ({ ...entry, queueEntryId: "same-queue-id" })));
    let emit!: (event: AgentEvent) => void;
    const api = ownerApi({ onAgentEvent: (listener) => { emit = listener; return () => {}; } });
    renderHook(() => useOwnerQueuedTurnRelease({ backends: [backendSummary()], composerDraftStore: store, desktopApi: api }));
    const notification = { method: "thread/turnQueue/updated", params: { threadId: "same", queueEntryId: "same-queue-id", status: "started" } } as AgentEvent["notification"];
    act(() => emit({ backend: "codex", federationTarget: { scope: "remote", instanceId: "foreign" }, notification }));
    expect(store.getQueuedTurns(scope)).toHaveLength(1);
    act(() => emit({ backend: "codex", federationTarget: owner.target, notification }));
    expect(store.getQueuedTurns(scope)).toHaveLength(0);
  });

});
