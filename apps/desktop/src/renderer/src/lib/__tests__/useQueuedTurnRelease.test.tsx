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
    methods: ["turn/start"],
    capabilities: {
      listThreads: true,
      createThread: true,
      resumeThread: true,
      renameThread: false,
      readThread: true,
      startTurn: true,
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

    composerDraftStore.removeQueuedTurnAt("thread:codex:thread-a", 0);
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

  it("does not background-release a branch-tracked thread that needs the drift guard", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const startTurn = vi.fn();
    const checkThreadBranchDrift = vi.fn();
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
    expect(checkThreadBranchDrift).not.toHaveBeenCalled();
    expect(
      composerDraftStore.getQueuedTurn("thread:codex:thread-a")?.text
    ).toBe("Guarded background reply");
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
});
