import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  AgentEvent,
  BackendSummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerDraftStore } from "../../features/composer/useComposerDraftStore";
import type { DesktopApi } from "../desktop-api";
import { useQueuedTurnRelease } from "../useQueuedTurnRelease";

type BranchDriftResult = Awaited<
  ReturnType<NonNullable<DesktopApi["checkThreadBranchDrift"]>>
>;

function createComposerDraftStore(): ComposerDraftStore {
  const queuedTurns = new Map<
    string,
    ReturnType<ComposerDraftStore["getQueuedTurns"]>
  >();
  return {
    delete: vi.fn(),
    get: vi.fn(),
    deletePendingSteer: vi.fn(),
    deleteQueuedTurn: (scopeKey) => {
      queuedTurns.delete(scopeKey);
    },
    getPendingSteer: vi.fn(),
    getQueuedTurn: (scopeKey) => queuedTurns.get(scopeKey)?.[0],
    getQueuedTurns: (scopeKey) => queuedTurns.get(scopeKey) ?? [],
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
        input: [{ type: "text", text: "First background reply" }],
      },
      {
        id: "queued-2",
        text: "Second background reply",
        imageAttachments: [],
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
        input: [{ type: "text", text: "First background reply" }],
      },
      {
        id: "queued-2",
        text: "Second background reply",
        imageAttachments: [],
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
      input: [{ type: "text", text: "Idle status reply" }],
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
      reviewCommand: {
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
        target: {
          type: "baseBranch",
          branch: "main",
        },
        delivery: "inline",
      });
    });
    expect(startTurn).not.toHaveBeenCalled();
    expect(composerDraftStore.getQueuedTurn("thread:codex:thread-a")).toBeUndefined();
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
        input: [{ type: "text", text: "First background reply" }],
      },
      {
        id: "queued-2",
        text: "Second background reply",
        imageAttachments: [],
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
      reviewCommand: {
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
      reviewCommand: {
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
      reviewCommand: {
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
      reviewCommand: {
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
      reviewCommand: {
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
      reviewCommand: {
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
      reviewCommand: {
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
      reviewCommand: {
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
    });
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")
    ).toBeUndefined();
  });
});
