import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import {
  buildPullRequestStatusKey,
  shortenDerivedThreadTitle,
} from "@pwragent/shared";
import type {
  AgentEvent,
  AppServerThreadTitleSource,
  FederationRemoteTarget,
  NavigationLaunchpadDefaults,
  NavigationLaunchpadDraft,
  NavigationSnapshot,
  NavigationThreadSummary,
  PrSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginNativeDragInteraction,
  endNativeDragInteraction,
} from "../native-drag-interaction";
import { useThreadNavigation } from "../useThreadNavigation";

/**
 * Create / rename / archive failures leave the hook through
 * `onThreadActionError` instead of a returned string — they render as
 * durable toasts now, not as a static slot in the sidebar. The hook
 * republishes the slot on every change, including the clear that each new
 * attempt performs, so the LAST call for a kind is the current state.
 */
function latestThreadActionError(
  onThreadActionError: ReturnType<typeof vi.fn>,
  kind:
    | "add-directory"
    | "archive-thread"
    | "create-thread"
    | "discard-launchpad"
    | "rename-thread",
): string | undefined {
  const calls = onThreadActionError.mock.calls.filter(
    ([event]) => event?.kind === kind,
  );
  return calls.at(-1)?.[0]?.message;
}

/**
 * One ACP thread whose title provenance the caller chooses. The rename path
 * only reveals what it recorded when the row starts as something other than
 * the source under test, so these deliberately start at `fallback`.
 */
function acpTitleSnapshot(
  title: string,
  titleSource: AppServerThreadTitleSource,
  updatedAt: number,
): NavigationSnapshot {
  return {
    backend: "all",
    fetchedAt: updatedAt,
    unchanged: false,
    inboxThreadKeys: ["acp:kimi:thread-1"],
    threads: [
      {
        id: "thread-1",
        title,
        titleSource,
        source: "acp:kimi",
        linkedDirectories: [],
        inbox: { inInbox: true, reason: "new-thread" },
        updatedAt,
      },
    ],
    directories: [],
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
    },
  };
}

function acpFallbackTitleSnapshot(
  title: string,
  updatedAt: number,
): NavigationSnapshot {
  return acpTitleSnapshot(title, "fallback", updatedAt);
}

function acpDerivedTitleSnapshot(
  title: string,
  updatedAt: number,
): NavigationSnapshot {
  return acpTitleSnapshot(title, "derived", updatedAt);
}

describe("useThreadNavigation", () => {
  beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });

  afterEach(() => {
    endNativeDragInteraction();
    delete (window as unknown as {
      __pwragentNavigationPreferences?: unknown;
    }).__pwragentNavigationPreferences;
    delete (window as unknown as {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget;
    delete (window as unknown as {
      __pwragentFederationLabel?: unknown;
    }).__pwragentFederationLabel;
    vi.restoreAllMocks();
  });

  it("does not synchronously access browser storage during navigation startup", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    const snapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: 1,
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [],
      providerRefresh: { state: "checking" },
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const desktopApi: DesktopApi = {
      getNavigationSnapshot: vi.fn(async () => snapshot),
      onAgentEvent: () => () => undefined,
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  function createDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  } {
    let resolve: (value: T) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });

    return { promise, resolve, reject };
  }

  it("uses the renderer transport revision for subsequent refreshes", async () => {
    const snapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: 1,
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const getNavigationSnapshot = vi.fn(async () => snapshot);
    const getNavigationSnapshotTransport = vi
      .fn<NonNullable<DesktopApi["getNavigationSnapshotTransport"]>>()
      .mockResolvedValueOnce({
        kind: "full",
        revision: "revision-1",
        snapshot,
      })
      .mockResolvedValueOnce({
        kind: "unchanged",
        revision: "revision-1",
      });
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      getNavigationSnapshotTransport,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(getNavigationSnapshotTransport).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await result.current.refresh();
    });

    expect(getNavigationSnapshot).not.toHaveBeenCalled();
    expect(getNavigationSnapshotTransport).toHaveBeenNthCalledWith(1, {
      transport: { protocol: 1 },
    });
    expect(getNavigationSnapshotTransport).toHaveBeenNthCalledWith(2, {
      transport: {
        protocol: 1,
        baseRevision: "revision-1",
      },
    });
    expect(result.current.error).toBeUndefined();
  });

  it("renders a recent page before reconciling the full startup snapshot", async () => {
    const recentSnapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: 1,
      unchanged: false,
      inboxThreadKeys: ["codex:thread-recent"],
      threads: [
        {
          id: "thread-recent",
          title: "Recent thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: true, reason: "updated-since-seen" },
          pinnedRank: "1024",
          updatedAt: 3_000,
        },
      ],
      directories: [
        {
          key: "directory:/repo/alpha",
          kind: "directory",
          label: "alpha",
          path: "/repo/alpha",
          threadKeys: ["codex:thread-recent"],
          needsAttentionCount: 1,
          latestUpdatedAt: 3_000,
        },
      ],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const fullSnapshot: NavigationSnapshot = {
      ...recentSnapshot,
      fetchedAt: 2,
      inboxThreadKeys: ["codex:thread-new", "codex:thread-recent"],
      threads: [
        {
          id: "thread-new",
          title: "Newer thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: true, reason: "updated-since-seen" },
          updatedAt: 4_000,
        },
        recentSnapshot.threads[0]!,
      ],
      directories: [
        ...recentSnapshot.directories,
        {
          key: "directory:/repo/beta",
          kind: "directory",
          label: "beta",
          path: "/repo/beta",
          threadKeys: ["codex:thread-new"],
          needsAttentionCount: 1,
          latestUpdatedAt: 4_000,
        },
      ],
    };
    const recentResponse = createDeferred<
      Awaited<ReturnType<NonNullable<DesktopApi["getNavigationSnapshotTransport"]>>>
    >();
    const fullResponse = createDeferred<
      Awaited<ReturnType<NonNullable<DesktopApi["getNavigationSnapshotTransport"]>>>
    >();
    const getNavigationSnapshotTransport = vi
      .fn<NonNullable<DesktopApi["getNavigationSnapshotTransport"]>>()
      .mockReturnValueOnce(recentResponse.promise)
      .mockReturnValueOnce(fullResponse.promise);
    const desktopApi: DesktopApi = {
      getNavigationSnapshotTransport,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() =>
      useThreadNavigation(desktopApi, { progressiveInitialRefresh: true }),
    );

    await waitFor(() => {
      expect(getNavigationSnapshotTransport).toHaveBeenCalledTimes(1);
    });
    expect(getNavigationSnapshotTransport).toHaveBeenNthCalledWith(1, {
      refreshMode: "active-recent",
      transport: { protocol: 1 },
    });

    act(() => {
      recentResponse.resolve({
        kind: "full",
        revision: "recent-revision",
        snapshot: recentSnapshot,
      });
    });
    await waitFor(() => {
      expect(result.current.threads.map((thread) => thread.id)).toEqual([
        "thread-recent",
      ]);
      expect(result.current.selectedThread?.id).toBe("thread-recent");
    });
    await waitFor(() => {
      expect(getNavigationSnapshotTransport).toHaveBeenCalledTimes(2);
    });
    expect(getNavigationSnapshotTransport).toHaveBeenNthCalledWith(2, {
      refreshMode: "full",
      transport: { protocol: 1 },
    });

    act(() => {
      fullResponse.resolve({
        kind: "full",
        revision: "full-revision",
        snapshot: fullSnapshot,
      });
    });
    await waitFor(() => {
      expect(result.current.threads.map((thread) => thread.id)).toEqual([
        "thread-new",
        "thread-recent",
      ]);
    });

    expect(result.current.selectedThread?.id).toBe("thread-recent");
    expect(result.current.threads.find((thread) => thread.id === "thread-recent"))
      .toMatchObject({
        inbox: { inInbox: true, reason: "updated-since-seen" },
        pinnedRank: "1024",
      });
    expect(result.current.directories.map((directory) => directory.path)).toEqual([
      "/repo/alpha",
      "/repo/beta",
    ]);
    expect(result.current.inboxThreads.map((thread) => thread.id)).toEqual([
      "thread-new",
      "thread-recent",
    ]);
  });

  it("never displays startup rows without their initial fallback selection", async () => {
    const emptySnapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: 1,
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [],
      providerRefresh: { state: "ready" },
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const populatedSnapshot: NavigationSnapshot = {
      ...emptySnapshot,
      fetchedAt: 2,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First discovered thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: true },
          updatedAt: 1_000,
        },
      ],
    };
    const recentResponse = createDeferred<
      Awaited<ReturnType<NonNullable<DesktopApi["getNavigationSnapshotTransport"]>>>
    >();
    const fullResponse = createDeferred<
      Awaited<ReturnType<NonNullable<DesktopApi["getNavigationSnapshotTransport"]>>>
    >();
    const getNavigationSnapshotTransport = vi
      .fn<NonNullable<DesktopApi["getNavigationSnapshotTransport"]>>()
      .mockReturnValueOnce(recentResponse.promise)
      .mockReturnValueOnce(fullResponse.promise);
    const renderedStates: Array<{
      selectedThreadId?: string;
      threadCount: number;
    }> = [];
    const desktopApi: DesktopApi = {
      getNavigationSnapshotTransport,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => {
      const navigation = useThreadNavigation(desktopApi, {
        progressiveInitialRefresh: true,
      });
      renderedStates.push({
        selectedThreadId: navigation.selectedThread?.id,
        threadCount: navigation.threads.length,
      });
      return navigation;
    });

    act(() => {
      recentResponse.resolve({
        kind: "full",
        revision: "empty-revision",
        snapshot: emptySnapshot,
      });
    });
    await waitFor(() => {
      expect(getNavigationSnapshotTransport).toHaveBeenCalledTimes(2);
    });
    expect(result.current.selectedThread).toBeUndefined();

    act(() => {
      fullResponse.resolve({
        kind: "full",
        revision: "populated-revision",
        snapshot: populatedSnapshot,
      });
    });
    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });

    const visibleStates = renderedStates.filter((state) => state.threadCount > 0);
    expect(visibleStates.length).toBeGreaterThan(0);
    for (const state of visibleStates) {
      expect(state).toEqual({ selectedThreadId: "thread-1", threadCount: 1 });
    }
  });

  it("reconciles an automatic partial selection against the full startup rows", async () => {
    const partialSnapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: 1,
      unchanged: false,
      inboxThreadKeys: ["codex:partial-thread"],
      threads: [
        {
          id: "partial-thread",
          title: "Partial thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: true },
          updatedAt: 2_000,
        },
      ],
      directories: [],
      providerRefresh: { state: "ready" },
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const fullSnapshot: NavigationSnapshot = {
      ...partialSnapshot,
      fetchedAt: 2,
      inboxThreadKeys: ["codex:full-thread"],
      threads: [
        {
          id: "full-thread",
          title: "Full thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: true },
          updatedAt: 1_000,
        },
      ],
    };
    const recentResponse = createDeferred<
      Awaited<ReturnType<NonNullable<DesktopApi["getNavigationSnapshotTransport"]>>>
    >();
    const fullResponse = createDeferred<
      Awaited<ReturnType<NonNullable<DesktopApi["getNavigationSnapshotTransport"]>>>
    >();
    const getNavigationSnapshotTransport = vi
      .fn<NonNullable<DesktopApi["getNavigationSnapshotTransport"]>>()
      .mockReturnValueOnce(recentResponse.promise)
      .mockReturnValueOnce(fullResponse.promise);
    const desktopApi: DesktopApi = {
      getNavigationSnapshotTransport,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() =>
      useThreadNavigation(desktopApi, { progressiveInitialRefresh: true })
    );

    act(() => {
      recentResponse.resolve({
        kind: "full",
        revision: "partial-revision",
        snapshot: partialSnapshot,
      });
    });
    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("partial-thread");
    });

    act(() => {
      fullResponse.resolve({
        kind: "full",
        revision: "full-revision",
        snapshot: fullSnapshot,
      });
    });
    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("full-thread");
    });
  });

  it("defers navigation deltas during a drag and preserves the dropped pin rank", async () => {
    const buildSnapshot = (title: string): NavigationSnapshot => ({
      backend: "all",
      fetchedAt: 1,
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title,
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: true },
          updatedAt: 1,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    });
    const deferredDelta = createDeferred<
      Awaited<
        ReturnType<NonNullable<DesktopApi["getNavigationSnapshotTransport"]>>
      >
    >();
    const getNavigationSnapshot = vi.fn(async () => buildSnapshot("Initial"));
    const getNavigationSnapshotTransport = vi
      .fn<NonNullable<DesktopApi["getNavigationSnapshotTransport"]>>()
      .mockResolvedValueOnce({
        kind: "full",
        revision: "revision-1",
        snapshot: buildSnapshot("Initial"),
      })
      .mockReturnValueOnce(deferredDelta.promise);
    const reorderThreadPins = vi.fn<
      NonNullable<DesktopApi["reorderThreadPins"]>
    >(async () => ({
      pinnedRanks: { "codex:thread-1": "1024" },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      getNavigationSnapshotTransport,
      onAgentEvent: () => () => undefined,
      reorderThreadPins,
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads[0]?.title).toBe("Initial");
    });

    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refresh();
    });
    await waitFor(() => {
      expect(getNavigationSnapshotTransport).toHaveBeenCalledTimes(2);
    });

    beginNativeDragInteraction();
    await act(async () => {
      await result.current.reorderThreadPins(["codex:thread-1"]);
    });
    expect(result.current.threads[0]?.pinnedRank).toBe("1024");

    act(() => {
      deferredDelta.resolve({
        kind: "delta",
        baseRevision: "revision-1",
        revision: "revision-2",
        fetchedAt: 2,
        removedThreadKeys: [],
        upsertedThreads: buildSnapshot("Updated during drag").threads,
        removedDirectoryKeys: [],
        upsertedDirectories: [],
      });
    });
    await Promise.resolve();
    expect(result.current.threads[0]?.title).toBe("Initial");
    expect(result.current.threads[0]?.pinnedRank).toBe("1024");

    await act(async () => {
      endNativeDragInteraction();
      await refresh;
    });
    expect(result.current.threads[0]).toMatchObject({
      title: "Updated during drag",
      pinnedRank: "1024",
    });
    expect(getNavigationSnapshot).not.toHaveBeenCalled();
  });

  it("keeps separate transport revisions while lightweight refresh scopes alternate", async () => {
    let intervalHandler: (() => void) | undefined;
    let focusListener: (() => void) | undefined;
    const originalSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(
      (handler, timeout, ...args) => {
        if (timeout !== 5 * 60_000) {
          return originalSetInterval(handler, timeout, ...args);
        }
        intervalHandler =
          typeof handler === "function" ? () => handler() : undefined;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
    );
    const snapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: 1,
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const getNavigationSnapshot = vi.fn(async () => snapshot);
    const getNavigationSnapshotTransport = vi.fn<
      NonNullable<DesktopApi["getNavigationSnapshotTransport"]>
    >(async (request) => {
      const revision = request.refreshMode === "active-recent"
        ? "active-recent-revision"
        : "full-revision";
      return request.transport.baseRevision === revision
        ? { kind: "unchanged", revision }
        : { kind: "full", revision, snapshot };
    });
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      getNavigationSnapshotTransport,
      onWindowFocus: (callback) => {
        focusListener = callback;
        return () => {
          focusListener = undefined;
        };
      },
    };
    const { unmount } = renderHook(() =>
      useThreadNavigation(desktopApi, { lightweightNavigationRefresh: true }),
    );

    await waitFor(() => {
      expect(getNavigationSnapshotTransport).toHaveBeenCalledTimes(1);
    });
    act(() => {
      intervalHandler?.();
    });
    await waitFor(() => {
      expect(getNavigationSnapshotTransport).toHaveBeenCalledTimes(2);
    });
    act(() => {
      focusListener?.();
    });
    await waitFor(() => {
      expect(getNavigationSnapshotTransport).toHaveBeenCalledTimes(3);
    });
    act(() => {
      intervalHandler?.();
    });
    await waitFor(() => {
      expect(getNavigationSnapshotTransport).toHaveBeenCalledTimes(4);
    });

    expect(getNavigationSnapshotTransport).toHaveBeenNthCalledWith(3, {
      forceRefresh: true,
      refreshMode: "full",
      transport: {
        baseRevision: "full-revision",
        protocol: 1,
      },
    });
    expect(getNavigationSnapshotTransport).toHaveBeenNthCalledWith(4, {
      forceRefresh: true,
      refreshMode: "active-recent",
      transport: {
        baseRevision: "active-recent-revision",
        protocol: 1,
      },
    });
    expect(getNavigationSnapshot).not.toHaveBeenCalled();
    unmount();
  });

  it("does not let a late launchpad update replace a directory label with its internal key", async () => {
    const directoryKey = "directory:/Users/fixture-user/github/PwrAgnt";
    const defaults: NavigationLaunchpadDefaults = {
      backend: "codex",
      executionMode: "default",
    };
    const malformedLaunchpad: NavigationLaunchpadDraft = {
      directoryKey,
      directoryKind: "directory",
      directoryLabel: directoryKey,
      directoryPath: "/Users/fixture-user/github/PwrAgnt",
      backend: "codex",
      executionMode: "default",
      prompt: "Late composer update",
      workMode: "worktree",
      createdAt: 1,
      updatedAt: 2,
    };
    const getNavigationSnapshot = vi.fn(async (): Promise<NavigationSnapshot> => ({
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: directoryKey,
          kind: "directory",
          label: "PwrAgnt",
          path: "/Users/fixture-user/github/PwrAgnt",
          threadKeys: [],
          needsAttentionCount: 0,
        },
      ],
      launchpadDefaults: defaults,
    }));
    const updateDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: malformedLaunchpad,
      defaults,
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
      updateDirectoryLaunchpad,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.directories[0]?.label).toBe("PwrAgnt");
    });

    await act(async () => {
      await result.current.updateDirectoryLaunchpad(directoryKey, {
        prompt: "Late composer update",
      });
    });

    expect(result.current.directories[0]).toMatchObject({
      label: "PwrAgnt",
      launchpad: {
        directoryLabel: "PwrAgnt",
      },
    });
  });

  it("keeps runtime thread status current across refreshes and lifecycle events", async () => {
    let threadStatus: "active" | "idle" = "active";
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "Surviving HMR turn",
          titleSource: "explicit" as const,
          source: "codex" as const,
          threadStatus,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads[0]?.threadStatus).toBe("active");
    });

    threadStatus = "idle";
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.threads[0]?.threadStatus).toBe("idle");

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/status/changed",
          params: {
            threadId: "thread-1",
            status: { type: "active" },
          },
        },
      });
    });
    expect(result.current.threads[0]?.threadStatus).toBe("active");

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/status/changed",
          params: {
            threadId: "thread-1",
            status: { type: "idle" },
          },
        },
      });
    });
    expect(result.current.threads[0]?.threadStatus).toBe("idle");
  });

  it("does not let an in-flight remote snapshot overwrite a live status event", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "instance-m2-max",
    };
    (window as unknown as {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = federationTarget;
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const snapshot = (threadStatus: "active" | "idle"): NavigationSnapshot => ({
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["acp:kimi:session-1"],
      threads: [
        {
          id: "session-1",
          title: "Remote Kimi thread",
          titleSource: "explicit",
          source: "acp:kimi",
          threadStatus,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread",
          },
          federation: {
            ref: {
              backend: "acp:kimi",
              target: federationTarget,
              threadId: "session-1",
            },
            instanceLabel: "M2 Max",
            peerStatus: "connected",
            capabilities: ["thread_navigation"],
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
      federationTarget,
    });
    const staleRefresh = createDeferred<NavigationSnapshot>();
    const getNavigationSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot("idle"))
      .mockReturnValueOnce(staleRefresh.promise)
      .mockResolvedValueOnce(snapshot("idle"));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads[0]?.threadStatus).toBe("idle");
    });
    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refresh();
    });
    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
    });

    act(() => {
      agentEventHandler?.({
        backend: "acp:kimi",
        federationTarget,
        notification: {
          method: "thread/status/changed",
          params: {
            threadId: "session-1",
            status: { type: "active" },
          },
        },
      });
    });
    expect(result.current.threads[0]?.threadStatus).toBe("active");

    await act(async () => {
      staleRefresh.resolve(snapshot("idle"));
      await refresh;
    });
    expect(result.current.threads[0]?.threadStatus).toBe("active");

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.threads[0]?.threadStatus).toBe("idle");
  });

  it("keeps a thread unread when it is focused from the Attention lens", async () => {
    // The Attention lens is a work queue. Opening something to look at it
    // must not empty the queue — only a reply (which routes through
    // markThreadsSeen from the composer) does. Every other lens still marks
    // seen on focus, which the test below this one pins.
    const markThreadSeen = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      seenAt: Date.now(),
      seenUpdatedAt: 1_000,
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "updated-since-seen" as const,
            lastSeenUpdatedAt: 900,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });

    act(() => {
      result.current.setBrowseMode("attention");
    });
    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });

    // Nothing should ever arrive; give the effects a full flush to be sure
    // this is a real "never" and not a race the assertion outran.
    await act(async () => {
      await Promise.resolve();
    });
    expect(markThreadSeen).not.toHaveBeenCalled();
    expect(result.current.threads[0]?.inbox.inInbox).toBe(true);

    // Replying is the one thing that does clear it.
    await act(async () => {
      await result.current.markThreadsSeen([result.current.threads[0]!]);
    });
    expect(markThreadSeen).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      seenUpdatedAt: 1_000,
    });
    await waitFor(() => {
      expect(result.current.threads[0]?.inbox.inInbox).toBe(false);
    });
  });

  it("marks a still-selected thread seen once the operator leaves the Attention lens", async () => {
    // Deliberate, and the counterpart to the test above: the exemption is a
    // property of the lens, not of the thread. Carrying "never auto-clear"
    // out of the work queue and into ordinary browsing would leak a rule the
    // operator did not ask for into every other lens.
    const markThreadSeen = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      seenAt: Date.now(),
      seenUpdatedAt: 1_000,
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "updated-since-seen" as const,
            lastSeenUpdatedAt: 900,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });

    act(() => {
      result.current.setBrowseMode("attention");
    });
    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(markThreadSeen).not.toHaveBeenCalled();

    // Same thread still selected; only the lens changed.
    act(() => {
      result.current.setBrowseMode("inbox");
    });

    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        seenUpdatedAt: 1_000,
      });
    });
  });

  it("clears a directory attention count after the selected thread is marked seen", async () => {
    const markThreadSeen = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      seenAt: Date.now(),
      seenUpdatedAt: 1_000,
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgent",
              path: "/Users/fixture-user/pwrdrvr/PwrAgent",
              kind: "local" as const,
            },
          ],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [
        {
          key: "directory:/Users/fixture-user/pwrdrvr/PwrAgent",
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/fixture-user/pwrdrvr/PwrAgent",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 1,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });

    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });

    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        seenUpdatedAt: 1_000,
      });
    });

    await waitFor(() => {
      expect(result.current.inboxThreads).toHaveLength(1);
      expect(result.current.inboxThreads[0]?.inbox.inInbox).toBe(false);
      expect(result.current.directories[0]?.needsAttentionCount).toBe(0);
    });
  });

  it("marks each unread thread in a selected directory batch seen once", async () => {
    const markThreadSeen = vi.fn(async (
      request: Parameters<NonNullable<DesktopApi["markThreadSeen"]>>[0],
    ) => ({
      backend: request.backend ?? "codex",
      threadId: request.threadId,
      seenAt: Date.now(),
      seenUpdatedAt: request.seenUpdatedAt,
    }));
    const firstThread = {
      id: "thread-directory-first",
      title: "First unread thread",
      titleSource: "explicit" as const,
      source: "codex" as const,
      linkedDirectories: [],
      inbox: {
        inInbox: true,
        reason: "new-thread" as const,
      },
      updatedAt: 1_000,
    };
    const sharedThread = {
      ...firstThread,
      id: "thread-directory-shared",
      title: "Shared unread thread",
      updatedAt: 2_000,
    };
    const lastThread = {
      ...firstThread,
      id: "thread-directory-last",
      title: "Last unread thread",
      updatedAt: 3_000,
    };
    const alreadyReadThread = {
      ...firstThread,
      id: "thread-directory-read",
      title: "Already read thread",
      inbox: {
        inInbox: false,
      },
      updatedAt: 4_000,
    };
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [
        `codex:${firstThread.id}`,
        `codex:${sharedThread.id}`,
        `codex:${lastThread.id}`,
      ],
      threads: [firstThread, sharedThread, lastThread, alreadyReadThread],
      directories: [
        {
          key: "directory:/tmp/first",
          kind: "directory" as const,
          label: "First directory",
          path: "/tmp/first",
          threadKeys: [
            `codex:${firstThread.id}`,
            `codex:${sharedThread.id}`,
          ],
          needsAttentionCount: 2,
        },
        {
          key: "directory:/tmp/last",
          kind: "directory" as const,
          label: "Last directory",
          path: "/tmp/last",
          threadKeys: [
            `codex:${sharedThread.id}`,
            `codex:${lastThread.id}`,
            `codex:${alreadyReadThread.id}`,
          ],
          needsAttentionCount: 2,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads).toHaveLength(4);
    });

    await act(async () => {
      await result.current.markThreadsSeen([
        result.current.threads[0]!,
        result.current.threads[1]!,
        result.current.threads[1]!,
        result.current.threads[2]!,
        result.current.threads[3]!,
      ]);
    });

    expect(markThreadSeen).toHaveBeenCalledTimes(3);
    expect(markThreadSeen).toHaveBeenCalledWith({
      backend: "codex",
      threadId: firstThread.id,
      seenUpdatedAt: firstThread.updatedAt,
    });
    expect(markThreadSeen).toHaveBeenCalledWith({
      backend: "codex",
      threadId: sharedThread.id,
      seenUpdatedAt: sharedThread.updatedAt,
    });
    expect(markThreadSeen).toHaveBeenCalledWith({
      backend: "codex",
      threadId: lastThread.id,
      seenUpdatedAt: lastThread.updatedAt,
    });

    await waitFor(() => {
      expect(
        result.current.threads.map((thread) => thread.inbox.inInbox),
      ).toEqual([false, false, false, false]);
      expect(result.current.snapshot?.inboxThreadKeys).toEqual([]);
      expect(
        result.current.directories.map((directory) => directory.needsAttentionCount),
      ).toEqual([0, 0]);
    });
  });

  it("refreshes selected thread directory git status on demand", async () => {
    const refreshDirectoryGitStatuses = vi.fn(async () => ({ scheduledCount: 1 }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [
        {
          key: "directory:/repo/app",
          kind: "directory" as const,
          label: "app",
          path: "/repo/app",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
      refreshDirectoryGitStatuses,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads).toHaveLength(1);
    });

    expect(refreshDirectoryGitStatuses).not.toHaveBeenCalled();

    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });

    await waitFor(() => {
      expect(refreshDirectoryGitStatuses).toHaveBeenCalledWith({
        directoryKeys: ["directory:/repo/app"],
        force: true,
      });
    });
  });

  it("keeps a selected unread marker until another item is selected", async () => {
    const markThreadSeen = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-unread",
      seenAt: Date.now(),
      seenUpdatedAt: 2_000,
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-unread"],
      threads: [
        {
          id: "thread-unread",
          title: "Unread thread",
          titleSource: "explicit" as const,
          summary: "Unread thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "updated-since-seen" as const,
            lastSeenUpdatedAt: 1_000,
          },
          updatedAt: 2_000,
        },
        {
          id: "thread-read",
          title: "Read thread",
          titleSource: "explicit" as const,
          summary: "Read thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 1_500,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.inboxThreads.map((thread) => thread.id)).toEqual([
        "thread-unread",
        "thread-read",
      ]);
    });

    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });

    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-unread",
        seenUpdatedAt: 2_000,
      });
    });
    expect(result.current.inboxThreads.map((thread) => thread.id)).toEqual([
      "thread-unread",
      "thread-read",
    ]);
    expect(result.current.threads[0]?.inbox.inInbox).toBe(true);

    act(() => {
      result.current.selectThread(result.current.threads[1]!);
    });

    await waitFor(() => {
      expect(result.current.threads[0]?.inbox.inInbox).toBe(false);
    });
  });

  it("releases retained remote unread state without clearing a local collision", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    const markThreadSeen = vi.fn(
      async (
        request: Parameters<NonNullable<DesktopApi["markThreadSeen"]>>[0],
      ) => ({
        backend: request.backend ?? "codex",
        threadId: request.threadId,
        seenAt: Date.now(),
        seenUpdatedAt: request.seenUpdatedAt,
      }),
    );
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["remote:remote-instance:codex:shared-thread"],
      threads: [
        {
          id: "shared-thread",
          title: "Local collision",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: false },
          updatedAt: 1_500,
        },
        {
          id: "shared-thread",
          title: "Remote unread collision",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          federation: {
            instanceLabel: "Remote Mac",
            ref: {
              backend: "codex" as const,
              target: federationTarget,
              threadId: "shared-thread",
            },
          },
          inbox: {
            inInbox: true,
            reason: "updated-since-seen" as const,
            lastSeenUpdatedAt: 1_000,
          },
          updatedAt: 2_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen,
      onAgentEvent: () => () => undefined,
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads).toHaveLength(2);
    });
    act(() => {
      result.current.selectThread(
        result.current.threads.find((thread) => thread.federation)!,
      );
    });
    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        federationTarget,
        threadId: "shared-thread",
        seenUpdatedAt: 2_000,
      });
    });
    expect(result.current.threads.find((thread) => thread.federation)?.inbox.inInbox)
      .toBe(true);

    act(() => {
      result.current.selectThread(
        result.current.threads.find((thread) => !thread.federation)!,
      );
    });
    await waitFor(() => {
      expect(result.current.threads.find(
        (thread) => thread.federation,
      )?.inbox.inInbox).toBe(false);
    });
    expect(result.current.threads.find((thread) => !thread.federation)?.inbox.inInbox)
      .toBe(false);
    expect(result.current.snapshot?.inboxThreadKeys).toEqual([]);
  });

  it("marks a remote read thread unread until the user returns to it", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    const markThreadSeen = vi.fn(
      async (
        request: Parameters<NonNullable<DesktopApi["markThreadSeen"]>>[0],
      ) => ({
        backend: request.backend ?? "codex",
        threadId: request.threadId,
        seenAt: Date.now(),
        seenUpdatedAt: request.seenUpdatedAt,
      }),
    );
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [
        {
          id: "thread-read",
          title: "Read thread",
          titleSource: "explicit" as const,
          summary: "Read thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          federation: {
            instanceLabel: "Remote Mac",
            ref: {
              backend: "codex" as const,
              target: federationTarget,
              threadId: "thread-read",
            },
          },
          inbox: {
            inInbox: false,
            lastSeenUpdatedAt: 2_000,
          },
          updatedAt: 2_000,
        },
        {
          id: "thread-other",
          title: "Other thread",
          titleSource: "explicit" as const,
          summary: "Other thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: false,
            lastSeenUpdatedAt: 1_500,
          },
          updatedAt: 1_500,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen,
      onAgentEvent: () => () => undefined,
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads).toHaveLength(2);
    });

    await act(async () => {
      await result.current.markThreadUnread(result.current.threads[0]!);
    });

    expect(markThreadSeen).toHaveBeenCalledWith({
      backend: "codex",
      federationTarget,
      threadId: "thread-read",
      seenUpdatedAt: 1_999,
    });
    expect(result.current.threads[0]?.inbox).toMatchObject({
      inInbox: true,
      reason: "updated-since-seen",
      lastSeenUpdatedAt: 1_999,
    });
    expect(result.current.snapshot?.inboxThreadKeys).toEqual([
      "remote:remote-instance:codex:thread-read",
    ]);

    act(() => {
      result.current.selectThread(result.current.threads[1]!);
    });
    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-other",
        seenUpdatedAt: 1_500,
      });
    });
    expect(result.current.threads[0]?.inbox.inInbox).toBe(true);

    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });
    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        federationTarget,
        threadId: "thread-read",
        seenUpdatedAt: 2_000,
      });
    });
  });

  it("marks the selected thread seen again when a refresh advances it", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const markThreadSeen = vi.fn(
      async (
        request: Parameters<NonNullable<DesktopApi["markThreadSeen"]>>[0]
      ) => ({
        backend: request.backend,
        threadId: request.threadId,
        seenAt: Date.now(),
        seenUpdatedAt: request.seenUpdatedAt,
      })
    );
    let refreshed = false;
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: refreshed ? ["codex:thread-read"] : [],
      threads: [
        {
          id: "thread-read",
          title: "Read thread",
          titleSource: "explicit" as const,
          summary: "Read thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: refreshed
            ? {
                inInbox: true,
                reason: "updated-since-seen" as const,
                lastSeenUpdatedAt: 1_000,
              }
            : {
                inInbox: false,
                lastSeenUpdatedAt: 1_000,
              },
          updatedAt: refreshed ? 2_000 : 1_000,
        },
        {
          id: "thread-other",
          title: "Other thread",
          titleSource: "explicit" as const,
          summary: "Other thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 900,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-read");
    });

    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });

    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-read",
        seenUpdatedAt: 1_000,
      });
    });

    refreshed = true;
    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-other",
              turnId: "turn-other",
              turn: {
                id: "turn-other",
                status: "completed",
                output: [],
              },
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-read",
        seenUpdatedAt: 2_000,
      });
      expect(result.current.threads[0]?.inbox.inInbox).toBe(false);
    });
  });

  it("contains a failed remote seen write and retries it on reselection", async () => {
    const federationTarget: FederationRemoteTarget = {
      scope: "remote",
      instanceId: "remote-owner",
    };
    const markThreadSeen = vi
      .fn<NonNullable<DesktopApi["markThreadSeen"]>>()
      .mockRejectedValueOnce(new Error("Federation peer is not connected"))
      .mockResolvedValueOnce({
        backend: "codex",
        threadId: "remote-thread",
        seenAt: 2_000,
        seenUpdatedAt: 1_000,
      });
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:remote-thread"],
      threads: [{
        id: "remote-thread",
        title: "Remote thread",
        titleSource: "explicit" as const,
        summary: "Remote thread summary",
        source: "codex" as const,
        linkedDirectories: [],
        inbox: {
          inInbox: true,
          reason: "updated-since-seen" as const,
          lastSeenUpdatedAt: 900,
        },
        updatedAt: 1_000,
        federation: {
          ref: {
            backend: "codex" as const,
            target: federationTarget,
            threadId: "remote-thread",
          },
          instanceLabel: "Remote owner",
          peerStatus: "connected" as const,
        },
      }],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));
    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("remote-thread");
    });

    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });
    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledTimes(1);
    });
    expect(result.current.threads[0]?.inbox.inInbox).toBe(true);

    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });
    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledTimes(2);
    });
    expect(markThreadSeen).toHaveBeenLastCalledWith({
      backend: "codex",
      federationTarget,
      threadId: "remote-thread",
      seenUpdatedAt: 1_000,
    });
  });

  it("clears a selected-thread unread update when the seen write resolves after selecting away", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const delayedSeen = createDeferred<{
      backend: "codex";
      threadId: string;
      seenAt: number;
      seenUpdatedAt?: number;
    }>();
    const markThreadSeen = vi.fn(
      (
        request: Parameters<NonNullable<DesktopApi["markThreadSeen"]>>[0]
      ) => {
        const response = {
          backend: request.backend,
          threadId: request.threadId,
          seenAt: Date.now(),
          seenUpdatedAt: request.seenUpdatedAt,
        } as const;

        return request.seenUpdatedAt === 2_000
          ? delayedSeen.promise
          : Promise.resolve(response);
      }
    );
    let refreshed = false;
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: refreshed ? ["codex:thread-read"] : [],
      threads: [
        {
          id: "thread-read",
          title: "Read thread",
          titleSource: "explicit" as const,
          summary: "Read thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: refreshed
            ? {
                inInbox: true,
                reason: "updated-since-seen" as const,
                lastSeenUpdatedAt: 1_000,
              }
            : {
                inInbox: false,
                lastSeenUpdatedAt: 1_000,
              },
          updatedAt: refreshed ? 2_000 : 1_000,
        },
        {
          id: "thread-other",
          title: "Other thread",
          titleSource: "explicit" as const,
          summary: "Other thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 900,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi), {
      wrapper: StrictMode,
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-read");
    });

    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });

    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-read",
        seenUpdatedAt: 1_000,
      });
    });

    refreshed = true;
    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-other",
              turnId: "turn-other",
              turn: {
                id: "turn-other",
                status: "completed",
                output: [],
              },
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-read",
        seenUpdatedAt: 2_000,
      });
      expect(result.current.threads[0]?.inbox.inInbox).toBe(true);
    });

    act(() => {
      result.current.selectThread(result.current.threads[1]!);
    });

    await act(async () => {
      delayedSeen.resolve({
        backend: "codex",
        threadId: "thread-read",
        seenAt: Date.now(),
        seenUpdatedAt: 2_000,
      });
      await delayedSeen.promise;
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-other");
      expect(result.current.threads[0]?.inbox.inInbox).toBe(false);
    });
  });

  it("keeps selected refreshes unread while the window is backgrounded", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const markThreadSeen = vi.fn(
      async (
        request: Parameters<NonNullable<DesktopApi["markThreadSeen"]>>[0]
      ) => ({
        backend: request.backend,
        threadId: request.threadId,
        seenAt: Date.now(),
        seenUpdatedAt: request.seenUpdatedAt,
      })
    );
    let refreshed = false;
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: refreshed ? ["codex:thread-read"] : [],
      threads: [
        {
          id: "thread-read",
          title: "Read thread",
          titleSource: "explicit" as const,
          summary: "Read thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: refreshed
            ? {
                inInbox: true,
                reason: "updated-since-seen" as const,
                lastSeenUpdatedAt: 1_000,
              }
            : {
                inInbox: false,
                lastSeenUpdatedAt: 1_000,
              },
          updatedAt: refreshed ? 2_000 : 1_000,
        },
        {
          id: "thread-other",
          title: "Other thread",
          titleSource: "explicit" as const,
          summary: "Other thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 900,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-read");
    });

    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });

    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-read",
        seenUpdatedAt: 1_000,
      });
    });

    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    refreshed = true;
    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-other",
              turnId: "turn-other",
              turn: {
                id: "turn-other",
                status: "completed",
                output: [],
              },
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(result.current.threads[0]?.inbox.inInbox).toBe(true);
    });
    expect(markThreadSeen).not.toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-read",
      seenUpdatedAt: 2_000,
    });
  });

  it("keeps selected refreshes unread while the thread view is hidden", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const markThreadSeen = vi.fn(
      async (
        request: Parameters<NonNullable<DesktopApi["markThreadSeen"]>>[0]
      ) => ({
        backend: request.backend,
        threadId: request.threadId,
        seenAt: Date.now(),
        seenUpdatedAt: request.seenUpdatedAt,
      })
    );
    let refreshed = false;
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: refreshed ? ["codex:thread-read"] : [],
      threads: [
        {
          id: "thread-read",
          title: "Read thread",
          titleSource: "explicit" as const,
          summary: "Read thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: refreshed
            ? {
                inInbox: true,
                reason: "updated-since-seen" as const,
                lastSeenUpdatedAt: 1_000,
              }
            : {
                inInbox: false,
                lastSeenUpdatedAt: 1_000,
              },
          updatedAt: refreshed ? 2_000 : 1_000,
        },
        {
          id: "thread-other",
          title: "Other thread",
          titleSource: "explicit" as const,
          summary: "Other thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 900,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { rerender, result } = renderHook(
      ({ threadViewVisible }: { threadViewVisible: boolean }) =>
        useThreadNavigation(desktopApi, { threadViewVisible }),
      {
        initialProps: {
          threadViewVisible: true,
        },
      }
    );

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-read");
    });

    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });

    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-read",
        seenUpdatedAt: 1_000,
      });
    });

    rerender({ threadViewVisible: false });

    refreshed = true;
    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-other",
              turnId: "turn-other",
              turn: {
                id: "turn-other",
                status: "completed",
                output: [],
              },
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(result.current.threads[0]?.inbox.inInbox).toBe(true);
    });
    expect(markThreadSeen).not.toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-read",
      seenUpdatedAt: 2_000,
    });

    rerender({ threadViewVisible: true });

    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-read",
        seenUpdatedAt: 2_000,
      });
    });
  });

  it("orders recent threads by creation time without changing inbox order", async () => {
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [
        {
          id: "updated-newer",
          title: "Updated newer",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: false },
          createdAt: 1_000,
          updatedAt: 9_000,
        },
        {
          id: "created-newer",
          title: "Created newer",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: false },
          createdAt: 2_000,
          updatedAt: 2_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.inboxThreads.map((thread) => thread.id)).toEqual([
        "updated-newer",
        "created-newer",
      ]);
      expect(result.current.recentThreads.map((thread) => thread.id)).toEqual([
        "created-newer",
        "updated-newer",
      ]);
    });
  });

  it("coalesces transcript-affecting notifications into one navigation refresh", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen: vi.fn(async () => ({
        backend: "codex",
        threadId: "thread-1",
        seenAt: Date.now(),
      })),
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });

    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);

    const refreshNotifications: AgentEvent["notification"][] = [
      {
        method: "navigation/providerThreads/refreshed",
        params: {
          failedProviders: 0,
        },
      },
      {
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
      {
        method: "turn/failed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "failed",
            error: {
              message: "Turn failed",
            },
          },
        },
      },
      {
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
      {
        method: "thread/questionnaireActivity/updated",
        params: {
          threadId: "thread-1",
          requestId: "request-1",
        },
      },
    ];

    await act(async () => {
      for (const notification of refreshNotifications) {
        for (const listener of listeners) {
          listener({
            backend: "codex",
            notification,
          });
        }
      }
    });

    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  it("uses broad forced background polling by default", async () => {
    let intervalHandler: (() => void) | undefined;
    const originalSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation((handler, timeout, ...args) => {
      if (timeout !== 5 * 60_000) {
        return originalSetInterval(handler, timeout, ...args);
      }
      intervalHandler = typeof handler === "function" ? () => handler() : undefined;
      return 1 as unknown as ReturnType<typeof setInterval>;
    });

    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
    };

    const { result, unmount } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });

    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);
    expect(getNavigationSnapshot.mock.calls[0]).toEqual([]);
    expect(intervalHandler).toBeDefined();

    act(() => {
      intervalHandler?.();
    });

    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
      expect(getNavigationSnapshot).toHaveBeenLastCalledWith({
        forceRefresh: true,
      });
    });

    unmount();
  });

  it("uses a cheap active-recent refresh for opt-in foreground background polling", async () => {
    let intervalHandler: (() => void) | undefined;
    const originalSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation((handler, timeout, ...args) => {
      if (timeout !== 5 * 60_000) {
        return originalSetInterval(handler, timeout, ...args);
      }
      intervalHandler = typeof handler === "function" ? () => handler() : undefined;
      return 1 as unknown as ReturnType<typeof setInterval>;
    });

    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
    };

    const { result, unmount } = renderHook(() =>
      useThreadNavigation(desktopApi, { lightweightNavigationRefresh: true }),
    );

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });

    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);
    expect(getNavigationSnapshot.mock.calls[0]).toEqual([]);
    expect(intervalHandler).toBeDefined();

    act(() => {
      intervalHandler?.();
    });

    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
      expect(getNavigationSnapshot).toHaveBeenLastCalledWith({
        forceRefresh: true,
        refreshMode: "active-recent",
      });
    });

    unmount();
  });

  it("pauses opt-in foreground background polling while navigation is idle", async () => {
    let intervalHandler: (() => void) | undefined;
    const originalSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation((handler, timeout, ...args) => {
      if (timeout !== 5 * 60_000) {
        return originalSetInterval(handler, timeout, ...args);
      }
      intervalHandler = typeof handler === "function" ? () => handler() : undefined;
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    const dateNowSpy = vi.spyOn(Date, "now");
    dateNowSpy.mockReturnValue(1_000_000);

    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
    };

    const { result, unmount } = renderHook(() =>
      useThreadNavigation(desktopApi, { lightweightNavigationRefresh: true }),
    );

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });

    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);
    expect(intervalHandler).toBeDefined();

    dateNowSpy.mockReturnValue(1_000_000 + 31 * 60_000);
    act(() => {
      intervalHandler?.();
    });

    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);

    dateNowSpy.mockReturnValue(1_000_000 + 31 * 60_000 + 1_000);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    });

    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
      expect(getNavigationSnapshot).toHaveBeenLastCalledWith({
        forceRefresh: true,
        refreshMode: "active-recent",
      });
    });

    unmount();
  });

  it("uses the ordinary scheduled refresh on focus by default", async () => {
    let focusListener: (() => void) | undefined;
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onWindowFocus: (callback) => {
        focusListener = callback;
        return () => {
          focusListener = undefined;
        };
      },
    };

    const { result, unmount } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });

    act(() => {
      focusListener?.();
    });

    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
      expect(getNavigationSnapshot.mock.calls.at(-1)).toEqual([]);
    });

    unmount();
  });

  it("throttles full focus refreshes to one per minute after completion", async () => {
    let focusListener: (() => void) | undefined;
    let delayedFocusHandler: (() => void) | undefined;
    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((handler, timeout, ...args) => {
        if (typeof timeout === "number" && timeout > 10_000) {
          delayedFocusHandler =
            typeof handler === "function" ? () => handler(...args) : undefined;
          return 42 as unknown as ReturnType<typeof setTimeout>;
        }
        return originalSetTimeout(handler, timeout, ...args);
      });
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    const dateNowSpy = vi.spyOn(Date, "now");
    dateNowSpy.mockReturnValue(1_000_000);

    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onWindowFocus: (callback) => {
        focusListener = callback;
        return () => {
          focusListener = undefined;
        };
      },
    };

    const { result, unmount } = renderHook(() =>
      useThreadNavigation(desktopApi, { lightweightNavigationRefresh: true }),
    );

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });

    act(() => {
      focusListener?.();
    });

    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
      expect(getNavigationSnapshot).toHaveBeenLastCalledWith({
        forceRefresh: true,
        refreshMode: "full",
      });
    });

    dateNowSpy.mockReturnValue(1_030_000);
    act(() => {
      focusListener?.();
      focusListener?.();
    });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);

    dateNowSpy.mockReturnValue(1_060_000);
    act(() => {
      delayedFocusHandler?.();
    });

    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(3);
      expect(getNavigationSnapshot).toHaveBeenLastCalledWith({
        forceRefresh: true,
        refreshMode: "full",
      });
    });

    unmount();
  });

  it("applies streamed directory git status updates without refreshing the snapshot", async () => {
    const listeners = new Set<(event: any) => void>();
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [
        {
          key: "directory:/repo/app",
          kind: "directory" as const,
          label: "app",
          path: "/repo/app",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 1,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.directories[0]?.key).toBe("directory:/repo/app");
    });
    expect(result.current.directories[0]?.gitStatus).toBeUndefined();

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "navigation/directoryGitStatus/updated",
            params: {
              directoryKey: "directory:/repo/app",
              gitStatus: {
                currentBranch: "main",
                upstreamBranch: "origin/main",
                ahead: 0,
                behind: 0,
                syncState: "in-sync",
              },
              fetchedAt: Date.now(),
            },
          },
        });
      }
    });

    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);
    expect(result.current.directories[0]?.gitStatus).toMatchObject({
      currentBranch: "main",
      syncState: "in-sync",
    });
  });

  it("applies streamed thread working-state updates without refreshing the snapshot", async () => {
    const listeners = new Set<(event: any) => void>();
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [
            {
              id: "directory:/repo/wt",
              kind: "worktree" as const,
              label: "wt",
              path: "/repo",
              worktreePath: "/repo/wt",
            },
          ],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads[0]?.id).toBe("thread-1");
    });
    expect(result.current.threads[0]?.gitWorkingState).toBeUndefined();

    const gitWorkingState = {
      dirtyFiles: 3,
      dirtyAdditions: 12,
      dirtyDeletions: 4,
      untrackedFiles: 1,
      unpushedCommits: 2,
    };
    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "navigation/threadGitWorkingState/updated",
            params: {
              worktreePath: "/repo/wt",
              gitWorkingState,
              fetchedAt: 1000,
            },
          },
        });
      }
    });

    // Patched in place — no extra snapshot fetch.
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);
    expect(result.current.threads[0]?.gitWorkingState).toMatchObject({
      dirtyFiles: 3,
      unpushedCommits: 2,
    });
    expect(result.current.threads[0]?.gitWorkingStateFetchedAt).toBe(1000);

    // An amend/rebase can replace commit metadata without changing any aggregate
    // counts. The fetched-at token must still advance so detail panels reload.
    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "navigation/threadGitWorkingState/updated",
            params: {
              worktreePath: "/repo/wt",
              gitWorkingState,
              fetchedAt: 2000,
            },
          },
        });
      }
    });
    expect(result.current.threads[0]?.gitWorkingStateFetchedAt).toBe(2000);

    // A clean probe (null) clears the chips.
    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "navigation/threadGitWorkingState/updated",
            params: {
              worktreePath: "/repo/wt",
              gitWorkingState: null,
              fetchedAt: Date.now(),
            },
          },
        });
      }
    });

    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);
    expect(result.current.threads[0]?.gitWorkingState).toBeUndefined();
  });

  it("does not move selection to another thread when refresh temporarily drops the selected thread", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    let includeSelectedThread = true;
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 1_000,
        },
        ...(includeSelectedThread
          ? [
              {
                id: "thread-2",
                title: "Clicked thread",
                titleSource: "explicit" as const,
                summary: "Clicked thread summary",
                source: "codex" as const,
                linkedDirectories: [],
                inbox: {
                  inInbox: false,
                },
                updatedAt: 2_000,
              },
            ]
          : []),
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });

    act(() => {
      result.current.selectThread(result.current.threads[1]!);
    });

    expect(result.current.selectedThread?.id).toBe("thread-2");

    includeSelectedThread = false;

    await act(async () => {
      for (const listener of listeners) {
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
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
    });

    expect(result.current.selectedItemKey).toBe("codex:thread-2");
    expect(result.current.selectedThread?.id).not.toBe("thread-1");
  });

  it("keeps an archived thread hidden when the post-archive refresh is stale", async () => {
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-archived"],
      threads: [
        {
          id: "thread-archived",
          title: "Archived thread",
          titleSource: "explicit" as const,
          summary: "This thread is archived before the backend list catches up",
          source: "codex" as const,
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgent",
              path: "/Users/fixture-user/github/PwrAgent",
              kind: "local" as const,
            },
          ],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 2_000,
        },
        {
          id: "thread-remaining",
          title: "Remaining thread",
          titleSource: "explicit" as const,
          summary: "This thread stays in navigation",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [
        {
          key: "directory:/Users/fixture-user/github/PwrAgent",
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/fixture-user/github/PwrAgent",
          threadKeys: ["codex:thread-archived"],
          needsAttentionCount: 1,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const archiveThread = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-archived",
      archivedAt: 3_000,
      cleanup: [],
    }));

    const desktopApi: DesktopApi = {
      archiveThread,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads.map((thread) => thread.id)).toEqual([
        "thread-archived",
        "thread-remaining",
      ]);
    });

    await act(async () => {
      await result.current.archiveThread(result.current.threads[0]!);
    });

    expect(archiveThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-archived",
    });
    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
    });
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      "thread-remaining",
    ]);
    expect(result.current.inboxThreads.map((thread) => thread.id)).toEqual([
      "thread-remaining",
    ]);
    expect(result.current.directories[0]?.threadKeys).toEqual([]);
    expect(result.current.directories[0]?.needsAttentionCount).toBe(0);
  });

  it("archives a remote thread through its owning federation target", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: 1_000,
      unchanged: false,
      inboxThreadKeys: ["codex:thread-remote"],
      threads: [
        {
          id: "thread-remote",
          title: "Remote thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: true },
          federation: {
            instanceLabel: "Remote Mac",
            ref: {
              backend: "codex" as const,
              target: federationTarget,
              threadId: "thread-remote",
            },
          },
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const archiveThread = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-remote",
      archivedAt: 2_000,
      cleanup: [],
    }));
    const removeRemoteThreadPin = vi.fn(async () => ({ removed: true }));
    const desktopApi: DesktopApi = {
      archiveThread,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
      removeRemoteThreadPin,
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads[0]?.id).toBe("thread-remote");
    });
    await act(async () => {
      await result.current.archiveThread(result.current.threads[0]!);
    });

    expect(archiveThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-remote",
      federationTarget,
    });
    expect(removeRemoteThreadPin).toHaveBeenCalledWith({
      ref: {
        backend: "codex",
        target: federationTarget,
        threadId: "thread-remote",
      },
    });
  });

  it("keeps a colliding local row visible while suppressing a remote archive", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    const remoteKey = "remote:remote-instance:codex:shared-thread";
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:shared-thread", remoteKey],
      threads: [
        {
          id: "shared-thread",
          title: "Local collision",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: true },
        },
        {
          id: "shared-thread",
          title: "Remote collision",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: true },
          federation: {
            instanceLabel: "Remote Mac",
            ref: {
              backend: "codex" as const,
              target: federationTarget,
              threadId: "shared-thread",
            },
          },
        },
      ],
      directories: [{
        key: "directory:/repo",
        kind: "directory" as const,
        label: "Repo",
        path: "/repo",
        threadKeys: ["codex:shared-thread", remoteKey],
        needsAttentionCount: 2,
      }],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const archiveThread = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "shared-thread",
      archivedAt: 2_000,
      cleanup: [],
    }));
    const desktopApi: DesktopApi = {
      archiveThread,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
      removeRemoteThreadPin: vi.fn(async () => ({ removed: true })),
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads).toHaveLength(2);
    });
    const remoteThread = result.current.threads.find(
      (thread) => thread.federation,
    )!;
    await act(async () => {
      await result.current.archiveThread(remoteThread);
    });

    expect(result.current.threads.map((thread) => thread.title)).toEqual([
      "Local collision",
    ]);
    expect(result.current.snapshot?.inboxThreadKeys).toEqual([
      "codex:shared-thread",
    ]);
    expect(result.current.directories[0]?.threadKeys).toEqual([
      "codex:shared-thread",
    ]);
  });

  it("pins a main-window remote row through the viewer-owned local pin API", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    const remoteRef = {
      backend: "codex" as const,
      target: federationTarget,
      threadId: "thread-remote",
    };
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: 1_000,
      unchanged: false,
      inboxThreadKeys: [],
      threads: [
        {
          id: "thread-remote",
          title: "Local collision",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: false },
        },
        {
          id: "thread-remote",
          title: "Remote thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: false },
          federation: {
            instanceLabel: "Remote Mac",
            ref: remoteRef,
          },
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const setThreadPin = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-remote",
      pinnedRank: "1024",
    }));
    const setRemoteThreadLocalPin = vi.fn(async () => ({
      ref: remoteRef,
      pinnedRank: "1024",
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      setThreadPin,
      setRemoteThreadLocalPin,
      onAgentEvent: () => () => undefined,
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads).toHaveLength(2);
    });
    const remoteThread = result.current.threads.find(
      (thread) => thread.federation,
    )!;
    await act(async () => {
      await result.current.setThreadPin(remoteThread, true);
    });

    // Main window, remote row: the rank is VIEWER-owned — the owner-routing
    // setThreadPin API must not be touched.
    expect(setRemoteThreadLocalPin).toHaveBeenCalledWith({
      ref: remoteRef,
      pinnedRank: expect.any(String),
    });
    expect(setThreadPin).not.toHaveBeenCalled();
    expect(result.current.threads.find((thread) => !thread.federation)?.pinnedRank)
      .toBeUndefined();
    expect(result.current.threads.find((thread) => thread.federation)?.pinnedRank)
      .toBe("1024");
  });

  it("pins through the owner in a remote-viewer window", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    (window as typeof window & {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = federationTarget;
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: 1_000,
      unchanged: false,
      inboxThreadKeys: [],
      threads: [
        {
          id: "thread-remote",
          title: "Remote thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: false },
          federation: {
            instanceLabel: "Remote Mac",
            ref: {
              backend: "codex" as const,
              target: federationTarget,
              threadId: "thread-remote",
            },
          },
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const setThreadPin = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-remote",
      pinnedRank: "1024",
    }));
    const setRemoteThreadLocalPin = vi.fn(async () => ({
      ref: {
        backend: "codex" as const,
        target: federationTarget,
        threadId: "thread-remote",
      },
      pinnedRank: "1024",
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      setThreadPin,
      setRemoteThreadLocalPin,
      onAgentEvent: () => () => undefined,
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads[0]?.id).toBe("thread-remote");
    });
    await act(async () => {
      await result.current.setThreadPin(result.current.threads[0]!, true);
    });

    // Remote-viewer window: operating the OWNER's pinned section is
    // intended, so the owner-routing API carries the federation target.
    expect(setThreadPin).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-remote",
      federationTarget,
      pinnedRank: expect.any(String),
    });
    expect(setRemoteThreadLocalPin).not.toHaveBeenCalled();
  });

  it("adds reactions through the owner in a remote-viewer window", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    (window as typeof window & {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = federationTarget;
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: 1_000,
      unchanged: false,
      inboxThreadKeys: [],
      threads: [
        {
          id: "thread-remote",
          title: "Remote thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          reactions: ["✋"],
          inbox: { inInbox: false },
          federation: {
            instanceLabel: "Remote Mac",
            ref: {
              backend: "codex" as const,
              target: federationTarget,
              threadId: "thread-remote",
            },
          },
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const setThreadReaction = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-remote",
      reactions: ["✋", "👀"],
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      setThreadReaction,
      onAgentEvent: () => () => undefined,
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads[0]?.reactions).toEqual(["✋"]);
    });
    await act(async () => {
      await result.current.setThreadReaction(
        result.current.threads[0]!,
        "👀",
        true,
      );
    });

    expect(setThreadReaction).toHaveBeenCalledWith({
      backend: "codex",
      federationTarget,
      threadId: "thread-remote",
      emoji: "👀",
      present: true,
    });
    expect(result.current.threads[0]?.reactions).toEqual(["✋", "👀"]);
  });

  it("marks a remote snapshot unavailable and refreshes it after reconnect", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    (window as unknown as {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = federationTarget;
    const listeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    let title = "Before disconnect";
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      federationTarget,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-remote"],
      threads: [
        {
          id: "thread-remote",
          title,
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: true },
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.title).toBe("Before disconnect");
    });
    expect(result.current.federationTarget).toEqual(federationTarget);

    act(() => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          federationTarget,
          notification: {
            method: "federation/peerStatus/changed",
            params: {
              instanceId: "remote-instance",
              status: "disconnected",
              unavailableReason: "Federation gateway connection closed.",
            },
          },
        });
      }
    });

    expect(result.current.error).toBe("Federation gateway connection closed.");
    expect(result.current.selectedThread?.title).toBe("Before disconnect");

    title = "After reconnect";
    act(() => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          federationTarget,
          notification: {
            method: "federation/peerStatus/changed",
            params: {
              instanceId: "remote-instance",
              status: "connected",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
      expect(result.current.selectedThread?.title).toBe("After reconnect");
      expect(result.current.error).toBeUndefined();
    });
    expect(getNavigationSnapshot).toHaveBeenLastCalledWith({
      federationTarget,
      forceRefresh: true,
      refreshMode: "full",
    });
  });

  it("reconciles a status-only remote thread change after reconnect", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    (window as unknown as {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = federationTarget;
    const listeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    let peerStatus: "connected" | "disconnected" = "connected";
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      federationTarget,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-remote"],
      threads: [
        {
          id: "thread-remote",
          title: "Unchanged remote title",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: true },
          federation: {
            ref: {
              backend: "codex" as const,
              target: federationTarget,
              threadId: "thread-remote",
            },
            instanceLabel: "Remote fixture",
            peerStatus,
          },
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.federation?.peerStatus).toBe(
        "connected",
      );
    });

    act(() => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          federationTarget,
          notification: {
            method: "federation/peerStatus/changed",
            params: {
              instanceId: "remote-instance",
              status: "disconnected",
              unavailableReason: "Federation gateway connection closed.",
            },
          },
        });
      }
    });

    expect(result.current.selectedThread?.federation?.peerStatus).toBe(
      "disconnected",
    );
    await act(async () => {
      await result.current.refresh();
    });
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);

    peerStatus = "connected";
    act(() => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          federationTarget,
          notification: {
            method: "federation/peerStatus/changed",
            params: {
              instanceId: "remote-instance",
              status: "connected",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
      expect(result.current.selectedThread?.federation?.peerStatus).toBe(
        "connected",
      );
      expect(result.current.error).toBeUndefined();
    });
  });

  it("re-enables a locally mounted remote thread after reconnect", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    const listeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    let peerStatus: "connected" | "disconnected" = "connected";
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-local", "codex:thread-remote"],
      threads: [
        {
          id: "thread-local",
          title: "Local thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: true },
        },
        {
          id: "thread-remote",
          title: "Mounted remote thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: true },
          federation: {
            ref: {
              backend: "codex" as const,
              target: federationTarget,
              threadId: "thread-remote",
            },
            instanceLabel: "Remote fixture",
            peerStatus,
          },
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads[1]?.federation?.peerStatus).toBe(
        "connected",
      );
    });

    act(() => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          federationTarget,
          notification: {
            method: "federation/peerStatus/changed",
            params: {
              instanceId: "remote-instance",
              status: "disconnected",
              unavailableReason: "Federation gateway connection closed.",
            },
          },
        });
      }
    });

    expect(result.current.threads[0]?.federation).toBeUndefined();
    expect(result.current.threads[1]?.federation?.peerStatus).toBe(
      "disconnected",
    );
    // A mounted peer going away must not turn the otherwise-local main
    // window into a global navigation error surface.
    expect(result.current.error).toBeUndefined();

    peerStatus = "connected";
    act(() => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          federationTarget,
          notification: {
            method: "federation/peerStatus/changed",
            params: {
              instanceId: "remote-instance",
              status: "connected",
            },
          },
        });
      }
    });

    expect(result.current.threads[1]?.federation?.peerStatus).toBe(
      "connected",
    );
    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
      expect(result.current.threads[1]?.federation?.peerStatus).toBe(
        "connected",
      );
    });
    expect(getNavigationSnapshot).toHaveBeenLastCalledWith({
      forceRefresh: true,
      refreshMode: "full",
    });
  });

  it("retries a failed remote snapshot until its route recovers", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    (window as unknown as {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = federationTarget;
    const snapshot = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-remote"],
      threads: [
        {
          id: "thread-remote",
          title: "Recovered remotely",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: true },
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    };
    const getNavigationSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error("Unexpected server response: 502"))
      .mockResolvedValue(snapshot);
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.error).toBe("Unexpected server response: 502");
    });
    await waitFor(() => {
      expect(result.current.selectedThread?.title).toBe("Recovered remotely");
      expect(result.current.error).toBeUndefined();
    }, { timeout: 2_500 });
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
    expect(getNavigationSnapshot).toHaveBeenLastCalledWith({
      federationTarget,
      forceRefresh: true,
      refreshMode: "full",
    });
  });

  it("surfaces archive worktree cleanup failures returned by the desktop bridge", async () => {
    let archived = false;
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: archived
        ? []
        : [
            {
              id: "thread-archived",
              title: "Archive me",
              titleSource: "explicit" as const,
              summary: "This thread has a worktree",
              source: "codex" as const,
              linkedDirectories: [
                {
                  id: "directory:/repo/app",
                  label: "app",
                  path: "/repo/app",
                  kind: "worktree" as const,
                  worktreePath: "/repo/.worktrees/archive-me",
                },
              ],
              inbox: {
                inInbox: false,
              },
              updatedAt: 1_000,
            },
          ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const archiveThread = vi.fn(async () => {
      archived = true;
      return {
        backend: "codex" as const,
        threadId: "thread-archived",
        archivedAt: 3_000,
        cleanup: [
          {
            worktreePath: "/repo/.worktrees/archive-me",
            removedWorktree: false,
            deletedBranch: false,
            error: "Worktree is not registered with Git",
          },
        ],
      };
    });

    const desktopApi: DesktopApi = {
      archiveThread,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const onThreadActionError = vi.fn();
    const { result } = renderHook(() =>
      useThreadNavigation(desktopApi, { onThreadActionError }),
    );

    await waitFor(() => {
      expect(result.current.threads.map((thread) => thread.id)).toEqual([
        "thread-archived",
      ]);
    });

    await act(async () => {
      await result.current.archiveThread(result.current.threads[0]!);
    });

    expect(latestThreadActionError(onThreadActionError, "archive-thread")).toBeUndefined();
    expect(result.current.archiveThreadNotice).toMatchObject({
      title: "Worktree cleanup skipped",
      message: "Thread archived. The worktree cleanup did not complete.",
      detail:
        "/repo/.worktrees/archive-me: Worktree is not registered with Git",
    });
  });

  it("surfaces archive cleanup metadata lookup skips without requiring a worktree path", async () => {
    let archived = false;
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: archived
        ? []
        : [
            {
              id: "thread-archived",
              title: "Archive me",
              titleSource: "explicit" as const,
              summary: "Archive remains available without cleanup metadata",
              source: "codex" as const,
              linkedDirectories: [],
              inbox: {
                inInbox: false,
              },
              updatedAt: 1_000,
            },
          ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const archiveThread = vi.fn(async () => {
      archived = true;
      return {
        backend: "codex" as const,
        threadId: "thread-archived",
        archivedAt: 3_000,
        cleanup: [
          {
            removedWorktree: false,
            deletedBranch: false,
            skippedReason:
              "Unable to load thread metadata for archive cleanup: thread list unavailable",
          },
        ],
      };
    });

    const desktopApi: DesktopApi = {
      archiveThread,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const onThreadActionError = vi.fn();
    const { result } = renderHook(() =>
      useThreadNavigation(desktopApi, { onThreadActionError }),
    );

    await waitFor(() => {
      expect(result.current.threads.map((thread) => thread.id)).toEqual([
        "thread-archived",
      ]);
    });

    await act(async () => {
      await result.current.archiveThread(result.current.threads[0]!);
    });

    expect(latestThreadActionError(onThreadActionError, "archive-thread")).toBeUndefined();
    expect(result.current.archiveThreadNotice).toMatchObject({
      title: "Worktree cleanup skipped",
      message: "Thread archived. The worktree cleanup did not complete.",
      detail:
        "Unable to load thread metadata for archive cleanup: thread list unavailable",
    });
  });

  it("surfaces shared worktree archive cleanup skips as informational notices", async () => {
    let archived = false;
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: archived
        ? []
        : [
            {
              id: "thread-archived",
              title: "Archive me",
              titleSource: "explicit" as const,
              source: "codex" as const,
              linkedDirectories: [],
              inbox: { inInbox: false },
              updatedAt: 1_000,
            },
          ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const archiveThread = vi.fn(async () => {
      archived = true;
      return {
        backend: "codex" as const,
        threadId: "thread-archived",
        archivedAt: 3_000,
        cleanup: [
          {
            worktreePath: "/repo/.worktrees/shared",
            removedWorktree: false,
            deletedBranch: false,
            skippedReason: "Worktree is still used by another active thread: thread-parent.",
          },
        ],
      };
    });

    const desktopApi: DesktopApi = {
      archiveThread,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const onThreadActionError = vi.fn();
    const { result } = renderHook(() =>
      useThreadNavigation(desktopApi, { onThreadActionError }),
    );

    await waitFor(() => {
      expect(result.current.threads.map((thread) => thread.id)).toEqual([
        "thread-archived",
      ]);
    });

    await act(async () => {
      await result.current.archiveThread(result.current.threads[0]!);
    });

    expect(latestThreadActionError(onThreadActionError, "archive-thread")).toBeUndefined();
    expect(result.current.archiveThreadNotice).toMatchObject({
      title: "Worktree kept",
      message:
        "Thread archived. The worktree was kept because another active thread is still using it.",
      detail:
        "/repo/.worktrees/shared: Worktree is still used by another active thread: thread-parent.",
    });

    act(() => {
      result.current.dismissArchiveThreadNotice();
    });
    expect(result.current.archiveThreadNotice).toBeUndefined();
  });

  it("archives sub-threads before the parent when archiving a group", async () => {
    const archivedThreadIds = new Set<string>();
    const parentThread = {
      id: "thread-parent",
      title: "Parent thread",
      titleSource: "explicit" as const,
      source: "codex" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
      updatedAt: 1_000,
    };
    const childThread = {
      id: "thread-child",
      title: "Child thread",
      titleSource: "explicit" as const,
      parentThreadId: "thread-parent",
      source: "codex" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
      updatedAt: 2_000,
    };
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [parentThread, childThread].filter(
        (thread) => !archivedThreadIds.has(thread.id),
      ),
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const archiveThread = vi.fn(async (request: { threadId: string }) => {
      archivedThreadIds.add(request.threadId);
      return {
        backend: "codex" as const,
        threadId: request.threadId,
        archivedAt: 3_000,
        cleanup: [],
      };
    });

    const desktopApi: DesktopApi = {
      archiveThread,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads.map((thread) => thread.id)).toEqual([
        "thread-parent",
        "thread-child",
      ]);
    });

    await act(async () => {
      await result.current.archiveThread(result.current.threads[0]!, {
        includeSubthreads: true,
      });
    });

    expect(archiveThread.mock.calls.map(([request]) => request.threadId)).toEqual([
      "thread-child",
      "thread-parent",
    ]);
    await waitFor(() => {
      expect(result.current.threads).toEqual([]);
    });
  });

  it("forks a child below its source and re-parents it to the group root", async () => {
    const worktree = {
      id: "wt",
      label: "Repo",
      path: "/repo",
      worktreePath: "/wt/repo",
      kind: "worktree" as const,
    };
    const rootThread = {
      id: "thread-root",
      title: "Root thread",
      titleSource: "explicit" as const,
      source: "codex" as const,
      linkedDirectories: [worktree],
      inbox: { inInbox: false },
      updatedAt: 1_000,
      createdAt: 1_000,
      subthreadOrder: ["thread-a", "thread-b"],
    };
    const childA = {
      id: "thread-a",
      title: "Child A",
      titleSource: "explicit" as const,
      parentThreadId: "thread-root",
      source: "codex" as const,
      linkedDirectories: [worktree],
      inbox: { inInbox: false },
      updatedAt: 2_000,
      createdAt: 2_000,
    };
    const childB = { ...childA, id: "thread-b", title: "Child B", createdAt: 3_000 };

    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [rootThread, childA, childB],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const forkThread = vi.fn(
      async (request: { parentThreadId?: string; sourceThreadId: string }) => ({
        backend: "codex" as const,
        sourceThreadId: request.sourceThreadId,
        threadId: "thread-fork",
        executionMode: "default" as const,
        workMode: "local" as const,
      }),
    );
    const updateSubthreadOrder = vi.fn(
      async (request: {
        backend?: string;
        parentThreadId: string;
        threadIds: string[];
      }) => ({
        backend: "codex" as const,
        parentThreadId: request.parentThreadId,
        threadIds: request.threadIds,
      }),
    );

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      forkThread,
      updateSubthreadOrder,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads.map((thread) => thread.id)).toEqual([
        "thread-root",
        "thread-a",
        "thread-b",
      ]);
    });

    const sourceChild = result.current.threads.find((thread) => thread.id === "thread-a")!;
    await act(async () => {
      await result.current.forkThread(sourceChild, "same-worktree");
    });

    // Forks the clicked child's content but links the new thread to the root,
    // so it renders one level deep rather than as an unrenderable grandchild.
    expect(forkThread).toHaveBeenCalledTimes(1);
    expect(forkThread.mock.calls[0]![0]).toMatchObject({
      parentThreadId: "thread-root",
      sourceThreadId: "thread-a",
    });

    // The new thread lands directly below its source child in the root's tray.
    expect(updateSubthreadOrder).toHaveBeenCalledTimes(1);
    expect(updateSubthreadOrder.mock.calls[0]![0]).toMatchObject({
      parentThreadId: "thread-root",
      threadIds: ["thread-a", "thread-fork", "thread-b"],
    });
  });

  it("records remote-root ownership for locally created children and forks", async () => {
    const rootTarget = {
      scope: "remote" as const,
      instanceId: "root-owner",
    };
    const worktree = {
      id: "wt",
      label: "Repo",
      path: "/repo",
      worktreePath: "/wt/repo",
      kind: "worktree" as const,
    };
    const remoteRoot: NavigationThreadSummary = {
      id: "thread-root",
      title: "Remote root",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [worktree],
      inbox: { inInbox: false },
      subthreadOrder: ["thread-local-child"],
      federation: {
        capabilities: ["thread_navigation", "thread_grouping"],
        ref: {
          backend: "codex",
          target: rootTarget,
          threadId: "thread-root",
        },
        instanceLabel: "Root Mac",
      },
    };
    const localChild: NavigationThreadSummary = {
      ...remoteRoot,
      id: "thread-local-child",
      title: "Local child",
      parentThreadId: "thread-root",
      parentThreadBackend: "codex",
      parentThreadInstanceId: "root-owner",
      federation: undefined,
    };
    const directoryKey =
      "subthread:codex:thread-local-child:same-worktree";
    const launchpad = {
      directoryKey,
      directoryKind: "directory" as const,
      directoryLabel: "Repo",
      directoryPath: "/wt/repo",
      workMode: "local" as const,
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      createdAt: 1,
      updatedAt: 1,
    };
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad,
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const updateDirectoryLaunchpad = vi.fn(async (request) => ({
      launchpad: { ...launchpad, ...request.patch, updatedAt: 2 },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const forkThread = vi.fn(async () => ({
      backend: "codex" as const,
      sourceThreadId: "thread-local-child",
      threadId: "thread-fork",
      executionMode: "default" as const,
      workMode: "local" as const,
    }));
    const updateSubthreadOrder = vi.fn(async (request) => ({
      backend: "codex" as const,
      parentThreadId: request.parentThreadId,
      threadIds: request.threadIds,
    }));
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      forkThread,
      getNavigationSnapshot: vi.fn(async () => ({
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: false,
        inboxThreadKeys: [],
        threads: [remoteRoot, localChild],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      })),
      onAgentEvent: () => () => undefined,
      updateDirectoryLaunchpad,
      updateSubthreadOrder,
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));
    await waitFor(() => expect(result.current.threads).toHaveLength(2));

    await act(async () => {
      await result.current.createSubthread(localChild, "same-worktree");
    });
    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({
        federationTarget: undefined,
        parentThreadId: "thread-root",
        parentThreadInstanceId: "root-owner",
      }),
    );
    expect(updateDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          federationTarget: undefined,
          parentThreadId: "thread-root",
          parentThreadInstanceId: "root-owner",
        }),
      }),
    );

    await act(async () => {
      await result.current.forkThread(localChild, "same-worktree");
    });
    expect(forkThread).toHaveBeenCalledWith(
      expect.objectContaining({
        federationTarget: undefined,
        parentThreadId: "thread-root",
        parentThreadInstanceId: "root-owner",
      }),
    );
    expect(updateSubthreadOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        federationTarget: rootTarget,
        parentThreadId: "thread-root",
      }),
    );
  });

  it("does not route grouping mutations to a legacy remote peer", async () => {
    const target = {
      scope: "remote" as const,
      instanceId: "legacy-owner",
    };
    const remoteParent: NavigationThreadSummary = {
      id: "thread-root",
      title: "Legacy remote root",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
      subthreadOrder: ["thread-a", "thread-b"],
      subthreadsCollapsed: false,
      federation: {
        capabilities: ["thread_navigation"],
        instanceLabel: "Legacy Mac",
        ref: {
          backend: "codex",
          target,
          threadId: "thread-root",
        },
      },
    };
    const updateSubthreadOrder = vi.fn();
    const setSubthreadsCollapsed = vi.fn();
    const desktopApi = {
      getNavigationSnapshot: vi.fn(async () => ({
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: false,
        inboxThreadKeys: [],
        threads: [remoteParent],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      })),
      onAgentEvent: () => () => undefined,
      updateSubthreadOrder,
      setSubthreadsCollapsed,
    } as unknown as DesktopApi;
    const { result } = renderHook(() => useThreadNavigation(desktopApi));
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    await act(async () => {
      await result.current.updateSubthreadOrder(remoteParent, [
        "thread-b",
        "thread-a",
      ]);
      await result.current.setSubthreadsCollapsed(remoteParent, true);
    });

    expect(updateSubthreadOrder).not.toHaveBeenCalled();
    expect(setSubthreadsCollapsed).not.toHaveBeenCalled();
    expect(result.current.threads[0]).toMatchObject({
      subthreadOrder: ["thread-a", "thread-b"],
      subthreadsCollapsed: false,
    });
  });

  it("pins unlinked siblings together immediately above their pinned parent", async () => {
    const pinnedBefore = {
      id: "thread-before",
      title: "Pinned before",
      titleSource: "explicit" as const,
      source: "codex" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
      pinnedRank: "1024",
    };
    const parent = {
      ...pinnedBefore,
      id: "thread-parent",
      title: "Pinned parent",
      pinnedRank: "2048",
      subthreadOrder: ["thread-child-a", "thread-child-b"],
      federation: {
        ref: {
          backend: "codex" as const,
          target: { scope: "remote" as const, instanceId: "parent-owner" },
          threadId: "thread-parent",
        },
        instanceLabel: "Parent Mac",
      },
    };
    const childA = {
      ...pinnedBefore,
      id: "thread-child-a",
      title: "Child A",
      pinnedRank: undefined,
      parentThreadId: "thread-parent",
      parentThreadBackend: "codex" as const,
      parentThreadInstanceId: "parent-owner",
    };
    const childB = { ...childA, id: "thread-child-b", title: "Child B" };
    const snapshot = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [pinnedBefore, parent, childA, childB],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    };
    const setThreadParent = vi.fn(async (request: { threadId: string }) => ({
      backend: "codex" as const,
      threadId: request.threadId,
    }));
    const reorderThreadPins = vi.fn(async () => ({
      pinnedRanks: {
        "codex:thread-before": "1024",
        "codex:thread-child-a": "2048",
        "codex:thread-child-b": "3072",
        "codex:thread-parent": "4096",
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot: vi.fn(async () => snapshot),
      onAgentEvent: () => () => undefined,
      reorderThreadPins,
      setThreadParent,
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));
    await waitFor(() => expect(result.current.threads).toHaveLength(4));

    await act(async () => {
      await result.current.unlinkThreads([childB, childA]);
    });

    expect(setThreadParent.mock.calls.map(([request]) => request)).toEqual([
      { backend: "codex", federationTarget: undefined, threadId: "thread-child-b" },
      { backend: "codex", federationTarget: undefined, threadId: "thread-child-a" },
    ]);
    expect(reorderThreadPins).toHaveBeenCalledWith({
      federationTarget: undefined,
      threadKeys: [
        "codex:thread-before",
        "codex:thread-child-a",
        "codex:thread-child-b",
        "remote:parent-owner:codex:thread-parent",
      ],
    });
  });

  it("routes remote-child unlinking to its owner", async () => {
    const remoteTarget = {
      scope: "remote" as const,
      instanceId: "child-owner",
    };
    const parent = {
      id: "thread-parent",
      title: "Local parent",
      titleSource: "explicit" as const,
      source: "codex" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
      pinnedRank: "1024",
    };
    const child: NavigationThreadSummary = {
      ...parent,
      id: "thread-child",
      title: "Remote child",
      pinnedRank: undefined,
      parentThreadId: "thread-parent",
      parentThreadBackend: "codex",
      federation: {
        ref: {
          backend: "codex",
          target: remoteTarget,
          threadId: "thread-child",
        },
        instanceLabel: "Child Mac",
        derivedFromMountedParent: true,
      },
    };
    const snapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [parent, child],
      directories: [],
      launchpadDefaults: { backend: "codex", executionMode: "default" },
    };
    const setThreadParent = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-child",
    }));
    const addRemoteThreadPin = vi.fn(async () => ({
      pin: {
        ref: child.federation!.ref,
        instanceLabel: "Child Mac",
        pinnedVia: "explicit" as const,
        addedAt: Date.now(),
      },
    }));
    const reorderThreadPins = vi.fn(async () => ({ pinnedRanks: {} }));
    const desktopApi: DesktopApi = {
      addRemoteThreadPin,
      getNavigationSnapshot: vi.fn(async () => snapshot),
      onAgentEvent: () => () => undefined,
      reorderThreadPins,
      setThreadParent,
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));
    await waitFor(() => expect(result.current.threads).toHaveLength(2));

    await act(async () => {
      await result.current.unlinkThreads([child]);
    });

    expect(setThreadParent).toHaveBeenCalledWith({
      backend: "codex",
      federationTarget: remoteTarget,
      threadId: "thread-child",
    });
    expect(addRemoteThreadPin).toHaveBeenCalledWith({
      ref: child.federation?.ref,
      instanceLabel: "Child Mac",
      summary: child,
    });
    expect(addRemoteThreadPin.mock.invocationCallOrder[0]).toBeLessThan(
      setThreadParent.mock.invocationCallOrder[0]!,
    );
    expect(reorderThreadPins).toHaveBeenCalledWith({
      federationTarget: undefined,
      threadKeys: [
        "remote:child-owner:codex:thread-child",
        "codex:thread-parent",
      ],
    });
  });

  it("restores focus to the selected thread when archive fails", async () => {
    const navigationSnapshot = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [
        {
          id: "thread-archived",
          title: "Archive target",
          titleSource: "explicit" as const,
          summary: "This thread should regain focus when archive fails",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 2_000,
        },
        {
          id: "thread-fallback",
          title: "Fallback thread",
          titleSource: "explicit" as const,
          summary: "This thread is selected optimistically during archive",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    };
    const getNavigationSnapshot = vi.fn(async () => navigationSnapshot);
    const archiveThread = vi.fn(async () => {
      throw new Error("Archive failed");
    });

    const desktopApi: DesktopApi = {
      archiveThread,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const onThreadActionError = vi.fn();
    const { result } = renderHook(() =>
      useThreadNavigation(desktopApi, { onThreadActionError }),
    );

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-archived");
    });

    await act(async () => {
      await result.current.archiveThread(result.current.threads[0]!);
    });

    expect(latestThreadActionError(onThreadActionError, "archive-thread")).toBe("Archive failed");
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      "thread-archived",
      "thread-fallback",
    ]);
    expect(result.current.selectedThread?.id).toBe("thread-archived");
  });

  it("renames a thread and refreshes navigation with the explicit title", async () => {
    (window as unknown as {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = {
      scope: "remote",
      instanceId: "remote-instance",
    };
    let threadTitle = "First thread";
    const renameThread = vi.fn(async ({ name }: { name: string }) => {
      threadTitle = name;
      return {
        backend: "codex" as const,
        threadId: "thread-1",
        renamedAt: Date.now(),
      };
    });
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: threadTitle,
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen: vi.fn(async () => ({
        backend: "codex",
        threadId: "thread-1",
        seenAt: Date.now(),
      })),
      renameThread,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.title).toBe("First thread");
    });

    await act(async () => {
      await result.current.renameThread(result.current.threads[0]!, "  Renamed thread  ");
    });

    expect(renameThread).toHaveBeenCalledWith({
      backend: "codex",
      federationTarget: {
        scope: "remote",
        instanceId: "remote-instance",
      },
      threadId: "thread-1",
      name: "Renamed thread",
    });
    await waitFor(() => {
      expect(result.current.selectedThread?.title).toBe("Renamed thread");
      expect(result.current.selectedThread?.titleSource).toBe("explicit");
    });
  });

  it("retires a name observation after a snapshot acknowledges it", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const snapshot = (title: string, updatedAt: number): NavigationSnapshot => ({
      backend: "all",
      fetchedAt: updatedAt,
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title,
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: true, reason: "new-thread" },
          updatedAt,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    });
    const getNavigationSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot("Initial title", 1_000))
      .mockResolvedValueOnce(snapshot("Generated title", 2_000))
      .mockResolvedValueOnce(snapshot("Newer remote title", 3_000));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads[0]?.title).toBe("Initial title");
    });
    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/name/updated",
          params: {
            threadId: "thread-1",
            threadName: "Generated title",
          },
        },
      });
    });
    expect(result.current.threads[0]?.title).toBe("Generated title");

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.threads[0]?.title).toBe("Generated title");

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.threads[0]?.title).toBe("Newer remote title");
  });

  it.each([
    // The agent named its own session. Stamping `explicit` here is what made
    // the placeholder-title paths skip a generated title.
    ["a stated provenance", "derived", "derived"],
    // A Codex or federated rename can carry none, and the default has to stay
    // what this assumed before the field existed.
    ["no provenance", undefined, "explicit"],
    // Federation forwards a peer's params verbatim, so this recorder reads
    // another instance's JSON and a peer on a different build can send
    // anything. An unrecognized value must not reach the row: no snapshot row
    // could ever report it back, and the observation retires by comparing the
    // two — it would re-pin this title on every refresh for the life of the
    // hook, which is the failure this provenance exists to remove.
    ["an unrecognized provenance", "generated", "explicit"],
  ])("records %s on a rename notification", async (_label, stated, expected) => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const getNavigationSnapshot = vi
      .fn()
      .mockResolvedValue(acpFallbackTitleSnapshot("ACP session", 1_000));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads[0]?.title).toBe("ACP session");
    });
    act(() => {
      agentEventHandler?.({
        backend: "acp:kimi",
        notification: {
          method: "thread/name/updated",
          params: {
            threadId: "thread-1",
            threadName: "Investigate the flaky handshake test",
            ...(stated !== undefined ? { titleSource: stated } : {}),
          },
        },
      } as never);
    });

    expect(result.current.threads[0]?.title).toBe(
      "Investigate the flaky handshake test",
    );
    expect(result.current.threads[0]?.titleSource).toBe(expected);
  });

  it("retires a derived name observation after a snapshot acknowledges it", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const getNavigationSnapshot = vi
      .fn()
      .mockResolvedValueOnce(acpFallbackTitleSnapshot("ACP session", 1_000))
      .mockResolvedValueOnce(
        acpDerivedTitleSnapshot("Investigate the flaky handshake test", 2_000),
      )
      .mockResolvedValueOnce(
        acpDerivedTitleSnapshot("Newer remote title", 3_000),
      );
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads[0]?.title).toBe("ACP session");
    });
    act(() => {
      agentEventHandler?.({
        backend: "acp:kimi",
        notification: {
          method: "thread/name/updated",
          params: {
            threadId: "thread-1",
            threadName: "Investigate the flaky handshake test",
            titleSource: "derived",
          },
        },
      });
    });

    // The snapshot catches up and agrees, which is what retires the pending
    // observation. Comparing it against a hardcoded `explicit` never matches a
    // derived row, so the observation would be re-applied on every refresh and
    // pin the title forever.
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.threads[0]?.title).toBe(
      "Investigate the flaky handshake test",
    );

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.threads[0]?.title).toBe("Newer remote title");
  });

  it("patches thread activity immediately when a rewind notification arrives", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const navigationSnapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: 1_000,
      unchanged: false,
      inboxThreadKeys: ["acp:grok:grok-thread"],
      threads: [{
        id: "grok-thread",
        title: "Breakfast poem",
        titleSource: "explicit",
        source: "acp:grok",
        linkedDirectories: [],
        inbox: { inInbox: true, reason: "new-thread" },
        threadStatus: "active",
        updatedAt: 1_000,
      }],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const desktopApi: DesktopApi = {
      getNavigationSnapshot: vi.fn(async () => navigationSnapshot),
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));
    await waitFor(() => {
      expect(result.current.threads).toHaveLength(1);
    });

    act(() => {
      agentEventHandler?.({
        backend: "acp:grok",
        notification: {
          method: "thread/rewound",
          params: {
            threadId: "grok-thread",
            targetPromptIndex: 0,
            updatedAt: 2_000,
          },
        },
      });
    });

    expect(result.current.threads[0]).toMatchObject({
      id: "grok-thread",
      threadStatus: "idle",
      updatedAt: 2_000,
    });
  });

  it("isolates observed names for same-id threads owned by different peers", async () => {
    const firstTarget = {
      scope: "remote" as const,
      instanceId: "first-owner",
    };
    const secondTarget = {
      scope: "remote" as const,
      instanceId: "second-owner",
    };
    (window as unknown as {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = firstTarget;
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const navigationSnapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: 1_000,
      unchanged: false,
      inboxThreadKeys: [],
      threads: [
        {
          id: "shared-session-id",
          title: "First owner title",
          titleSource: "explicit",
          source: "acp:kimi",
          linkedDirectories: [],
          inbox: { inInbox: false },
          federation: {
            ref: {
              backend: "acp:kimi",
              target: firstTarget,
              threadId: "shared-session-id",
            },
            instanceLabel: "First Owner",
          },
          updatedAt: 1_000,
        },
        {
          id: "shared-session-id",
          title: "Second owner title",
          titleSource: "explicit",
          source: "acp:kimi",
          linkedDirectories: [],
          inbox: { inInbox: false },
          federation: {
            ref: {
              backend: "acp:kimi",
              target: secondTarget,
              threadId: "shared-session-id",
            },
            instanceLabel: "Second Owner",
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const getNavigationSnapshot = vi.fn(async () => navigationSnapshot);
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));
    const titlesByOwner = (): Record<string, string> => Object.fromEntries(
      result.current.threads.map((thread) => [
        thread.federation?.ref.target.scope === "remote"
          ? thread.federation.ref.target.instanceId
          : "local",
        thread.title,
      ]),
    );

    await waitFor(() => {
      expect(result.current.threads).toHaveLength(2);
    });
    act(() => {
      agentEventHandler?.({
        backend: "acp:kimi",
        federationTarget: firstTarget,
        notification: {
          method: "thread/name/updated",
          params: {
            threadId: "shared-session-id",
            threadName: "Renamed first owner",
          },
        },
      });
    });
    expect(titlesByOwner()).toEqual({
      "first-owner": "Renamed first owner",
      "second-owner": "Second owner title",
    });

    await act(async () => {
      await result.current.refresh();
    });
    expect(titlesByOwner()).toEqual({
      "first-owner": "Renamed first owner",
      "second-owner": "Second owner title",
    });
  });

  it("keeps an eager generated name that arrives while a scheduled thread materializes", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "scheduled-thread-owner",
    };
    (window as unknown as {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = federationTarget;
    const directoryKey = "directory:/Users/fixture-user/github/PwrSuiteLab";
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const initialSnapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: 1_000,
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: directoryKey,
          kind: "directory",
          label: "PwrSuiteLab",
          path: "/Users/fixture-user/github/PwrSuiteLab",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey,
            directoryKind: "directory",
            directoryLabel: "PwrSuiteLab",
            directoryPath: "/Users/fixture-user/github/PwrSuiteLab",
            backend: "codex",
            executionMode: "full-access",
            prompt: "Update all Tart VMs to macOS 26.6.1",
            workMode: "local",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      ],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
      federationTarget,
    };
    const scheduledFor = Date.now() + 60 * 60 * 1_000;
    const staleHydratedSnapshot: NavigationSnapshot = {
      ...initialSnapshot,
      fetchedAt: 2_000,
      inboxThreadKeys: ["codex:thread-scheduled"],
      threads: [
        {
          id: "thread-scheduled",
          title: "Untitled thread",
          titleSource: "fallback",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: true, reason: "new-thread" },
          federation: {
            ref: {
              backend: "codex",
              target: federationTarget,
              threadId: "thread-scheduled",
            },
            instanceLabel: "Scheduled Thread Owner",
          },
          scheduledStart: {
            actionId: "scheduled-action:1",
            scheduledFor,
            state: "scheduled",
          },
          updatedAt: 2_000,
        },
      ],
      directories: [
        {
          ...initialSnapshot.directories[0]!,
          threadKeys: ["codex:thread-scheduled"],
          launchpad: undefined,
        },
      ],
    };
    const getNavigationSnapshot = vi
      .fn()
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValue(staleHydratedSnapshot);
    const materializeDirectoryLaunchpad: NonNullable<
      DesktopApi["materializeDirectoryLaunchpad"]
    > = vi.fn(async () => {
      agentEventHandler?.({
        backend: "codex",
        federationTarget,
        notification: {
          method: "thread/name/updated",
          params: {
            threadId: "thread-scheduled",
            threadName: "Update Tart VMs to macOS 26.6.1",
          },
        },
      });
      return {
        backend: "codex" as const,
        threadId: "thread-scheduled",
        executionMode: "full-access" as const,
        workMode: "local" as const,
        scheduledAction: {
          id: "scheduled-action:1",
          backend: "codex" as const,
          threadId: "thread-scheduled",
          kind: "turn" as const,
          origin: "desktop" as const,
          status: "scheduled" as const,
          scheduledFor,
          displayText: "Update all Tart VMs to macOS 26.6.1",
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      };
    });
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      materializeDirectoryLaunchpad,
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedLaunchpad?.directoryKey).toBe(directoryKey);
    });

    await act(async () => {
      await result.current.materializeDirectoryLaunchpad(
        directoryKey,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        scheduledFor,
      );
    });

    expect(result.current.selectedThread).toMatchObject({
      id: "thread-scheduled",
      title: "Update Tart VMs to macOS 26.6.1",
      titleSource: "explicit",
      scheduledStart: {
        scheduledFor,
        state: "scheduled",
      },
    });
  });

  it("clears the viewer-persisted launchpad after remote materialization", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    (window as unknown as {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = federationTarget;
    const directoryKey = "directory:/remote/PwrAgent";
    const launchpad: NavigationLaunchpadDraft = {
      directoryKey,
      directoryKind: "directory",
      directoryLabel: "PwrAgent",
      directoryPath: "/remote/PwrAgent",
      backend: "codex",
      executionMode: "default",
      prompt: "Submitted remotely",
      workMode: "local",
      createdAt: 1,
      updatedAt: 2,
    };
    const defaults = {
      backend: "codex" as const,
      executionMode: "default" as const,
    };
    const initialSnapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: directoryKey,
          kind: "directory",
          label: "PwrAgent",
          path: "/remote/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad,
        },
      ],
      launchpadDefaults: defaults,
    };
    const getNavigationSnapshot = vi
      .fn()
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValue({
        ...initialSnapshot,
        inboxThreadKeys: ["codex:remote-thread-new"],
        threads: [
          {
            id: "remote-thread-new",
            title: "Submitted remotely",
            titleSource: "derived" as const,
            source: "codex" as const,
            linkedDirectories: [],
            inbox: { inInbox: true, reason: "new-thread" as const },
            updatedAt: 3,
          },
        ],
        directories: [
          {
            ...initialSnapshot.directories[0]!,
            threadKeys: ["codex:remote-thread-new"],
            launchpad: undefined,
          },
        ],
      });
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "remote-thread-new",
      executionMode: "default" as const,
      workMode: "local" as const,
    }));
    const resetDirectoryLaunchpad = vi.fn(async () => ({
      directoryKey,
      defaults,
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      materializeDirectoryLaunchpad,
      resetDirectoryLaunchpad,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedLaunchpad?.prompt).toBe("Submitted remotely");
    });

    await act(async () => {
      await result.current.materializeDirectoryLaunchpad(directoryKey);
    });

    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({ federationTarget }),
    );
    expect(resetDirectoryLaunchpad).toHaveBeenCalledWith({ directoryKey });
    expect(result.current.selectedLaunchpad).toBeUndefined();
  });

  it("creates a mounted remote thread from a peer-populated launchpad", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    const workspace = {
      key: "workspace:new-thread",
      kind: "workspace" as const,
      label: "Workspaces",
      threadKeys: [],
      needsAttentionCount: 0,
    };
    const project = {
      key: "directory:/remote/PwrAgent",
      kind: "directory" as const,
      label: "PwrAgent",
      path: "/remote/PwrAgent",
      threadKeys: [],
      needsAttentionCount: 0,
    };
    const defaults = {
      backend: "codex" as const,
      executionMode: "default" as const,
    };
    const remoteSnapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: 2,
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [workspace, project],
      launchpadDefaults: defaults,
      federationTarget,
    };
    const localSnapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: 1,
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [],
      launchpadDefaults: defaults,
    };
    const getNavigationSnapshot: NonNullable<DesktopApi["getNavigationSnapshot"]> = vi.fn(
      async (request) => request?.federationTarget ? remoteSnapshot : localSnapshot,
    );
    const ensureDirectoryLaunchpad: NonNullable<
      DesktopApi["ensureDirectoryLaunchpad"]
    > = vi.fn(async (request) => ({
      launchpad: {
        directoryKey: request.directoryKey,
        directoryKind: request.directoryKind,
        directoryLabel: request.directoryLabel,
        directoryPath: request.directoryPath,
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "Start a remote thread",
        workMode: "local" as const,
        federationTarget: request.federationTarget,
        createdAt: 1,
        updatedAt: 2,
      },
      defaults,
    }));
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "remote-thread-new",
      executionMode: "default" as const,
      workMode: "local" as const,
    }));
    const resetDirectoryLaunchpad = vi.fn(async () => ({
      directoryKey: project.key,
      defaults,
    }));
    const addRemoteThreadPin = vi.fn(async (request: Parameters<
      NonNullable<DesktopApi["addRemoteThreadPin"]>
    >[0]) => ({
      pin: {
        ref: request.ref,
        instanceLabel: request.instanceLabel ?? federationTarget.instanceId,
        pinnedVia: "explicit" as const,
        addedAt: 1,
      },
    }));
    const desktopApi: DesktopApi = {
      addRemoteThreadPin,
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      materializeDirectoryLaunchpad,
      onAgentEvent: () => () => undefined,
      resetDirectoryLaunchpad,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.openFederatedWorkspaceLaunchpad(federationTarget);
    });

    expect(getNavigationSnapshot).toHaveBeenCalledWith({ federationTarget });
    expect(result.current.selectedLaunchpad).toMatchObject({
      directoryKey: workspace.key,
      federationTarget,
    });
    expect(result.current.launchpadDirectories).toEqual(expect.arrayContaining([
      expect.objectContaining(project),
    ]));

    await act(async () => {
      await result.current.openFederatedDirectoryLaunchpad(federationTarget, project);
    });
    expect(result.current.selectedLaunchpad).toMatchObject({
      directoryKey: project.key,
      federationTarget,
    });

    await act(async () => {
      await result.current.materializeDirectoryLaunchpad(project.key);
    });

    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({
        directoryKey: project.key,
        federationTarget,
      }),
    );
    expect(addRemoteThreadPin).toHaveBeenCalledWith(expect.objectContaining({
      ref: {
        backend: "codex",
        target: federationTarget,
        threadId: "remote-thread-new",
      },
    }));
    expect(result.current.selectedThread).toMatchObject({
      id: "remote-thread-new",
      federation: {
        ref: {
          target: federationTarget,
        },
      },
    });
  });

  it("keeps the newest remote launchpad request selected", async () => {
    const firstTarget = { scope: "remote" as const, instanceId: "first-owner" };
    const secondTarget = { scope: "remote" as const, instanceId: "second-owner" };
    const defaults = {
      backend: "codex" as const,
      executionMode: "default" as const,
    };
    const firstEnsure = createDeferred<{
      defaults: NavigationLaunchpadDefaults;
      launchpad: NavigationLaunchpadDraft;
    }>();
    const secondEnsure = createDeferred<{
      defaults: NavigationLaunchpadDefaults;
      launchpad: NavigationLaunchpadDraft;
    }>();
    const makeSnapshot = (target: FederationRemoteTarget): NavigationSnapshot => ({
      backend: "all",
      fetchedAt: 1,
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [{
        key: "workspace:new-thread",
        kind: "workspace",
        label: "Workspaces",
        threadKeys: [],
        needsAttentionCount: 0,
      }],
      launchpadDefaults: defaults,
      federationTarget: target,
    });
    const launchpadResponse = (target: FederationRemoteTarget) => ({
      launchpad: {
        directoryKey: "workspace:new-thread",
        directoryKind: "workspace" as const,
        directoryLabel: "Workspaces",
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: target.instanceId,
        workMode: "local" as const,
        federationTarget: target,
        createdAt: 1,
        updatedAt: 1,
      },
      defaults,
    });
    const getNavigationSnapshot: NonNullable<DesktopApi["getNavigationSnapshot"]> = vi.fn(
      async (request) => {
        const target = request?.federationTarget;
        if (!target || target.scope !== "remote") {
          return {
            backend: "all" as const,
            fetchedAt: 1,
            unchanged: false,
            inboxThreadKeys: [],
            threads: [],
            directories: [],
            launchpadDefaults: defaults,
          };
        }
        return makeSnapshot(target);
      },
    );
    const ensureDirectoryLaunchpad: NonNullable<
      DesktopApi["ensureDirectoryLaunchpad"]
    > = vi.fn((request) => request.federationTarget?.scope === "remote"
      && request.federationTarget.instanceId === firstTarget.instanceId
      ? firstEnsure.promise
      : secondEnsure.promise);
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      void result.current.openFederatedWorkspaceLaunchpad(firstTarget);
    });
    await waitFor(() => expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({ federationTarget: firstTarget }),
    ));

    act(() => {
      void result.current.openFederatedWorkspaceLaunchpad(secondTarget);
    });
    await waitFor(() => expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({ federationTarget: secondTarget }),
    ));

    await act(async () => {
      secondEnsure.resolve(launchpadResponse(secondTarget));
      await secondEnsure.promise;
    });
    expect(result.current.selectedLaunchpad).toMatchObject({
      federationTarget: secondTarget,
      prompt: secondTarget.instanceId,
    });

    await act(async () => {
      firstEnsure.resolve(launchpadResponse(firstTarget));
      await firstEnsure.promise;
    });
    expect(result.current.selectedLaunchpad).toMatchObject({
      federationTarget: secondTarget,
      prompt: secondTarget.instanceId,
    });
  });

  it("scopes a remote optimistic thread before its owner snapshot arrives", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    (window as unknown as {
      __pwragentFederationTarget?: unknown;
      __pwragentFederationLabel?: unknown;
    }).__pwragentFederationTarget = federationTarget;
    (window as unknown as {
      __pwragentFederationLabel?: unknown;
    }).__pwragentFederationLabel = "Harold-MBP-M2-Max";
    const directoryKey = "directory:/remote/PwrAgent";
    const launchpad: NavigationLaunchpadDraft = {
      directoryKey,
      directoryKind: "directory",
      directoryLabel: "PwrAgent",
      directoryPath: "/remote/PwrAgent",
      backend: "codex",
      executionMode: "default",
      prompt: "Start remotely",
      workMode: "local",
      createdAt: 1,
      updatedAt: 2,
    };
    const snapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [{
        key: directoryKey,
        kind: "directory",
        label: "PwrAgent",
        path: "/remote/PwrAgent",
        threadKeys: [],
        needsAttentionCount: 0,
        launchpad,
      }],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const desktopApi: DesktopApi = {
      getNavigationSnapshot: vi.fn(async () => snapshot),
      materializeDirectoryLaunchpad: vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "remote-thread-new",
        turnId: "remote-turn-new",
        executionMode: "default" as const,
        workMode: "local" as const,
      })),
      resetDirectoryLaunchpad: vi.fn(async () => ({
        directoryKey,
        defaults: snapshot.launchpadDefaults,
      })),
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));
    await waitFor(() => {
      expect(result.current.selectedLaunchpad?.prompt).toBe("Start remotely");
    });

    await act(async () => {
      await result.current.materializeDirectoryLaunchpad(directoryKey);
    });

    expect(result.current.threads[0]?.federation).toEqual({
      ref: {
        backend: "codex",
        target: federationTarget,
        threadId: "remote-thread-new",
      },
      instanceLabel: "Harold-MBP-M2-Max",
    });
  });

  it("shows a newly materialized detached worktree thread as HEAD before the backend snapshot catches up", async () => {
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: "directory:/Users/fixture-user/github/PwrAgent",
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/fixture-user/github/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          // A saved collapsed preference is latent when the directory
          // has no pinned threads, so it must not auto-pin by itself.
          directoryThreadsCollapsed: true,
          launchpad: {
            directoryKey: "directory:/Users/fixture-user/github/PwrAgent",
            directoryKind: "directory" as const,
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/fixture-user/github/PwrAgent",
            backend: "codex" as const,
            executionMode: "default" as const,
            agent: {
              name: "PwrAgent Agent",
              instructions: "Manage PwrAgent threads.",
            },
            prompt: "",
            workMode: "worktree" as const,
            branchName: "main",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const creation = createDeferred<Awaited<ReturnType<NonNullable<DesktopApi["materializeDirectoryLaunchpad"]>>>>();
    const materializeDirectoryLaunchpad = vi.fn(() => creation.promise);
    const setThreadPin: NonNullable<DesktopApi["setThreadPin"]> = vi.fn(
      async (request) => ({
        backend: request.backend ?? "codex",
        threadId: request.threadId,
        pinnedRank: request.pinnedRank ?? undefined,
      }),
    );

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      materializeDirectoryLaunchpad,
      onAgentEvent: () => () => undefined,
      setThreadPin,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.directories[0]?.launchpad?.directoryKey).toBe(
        "directory:/Users/fixture-user/github/PwrAgent"
      );
    });

    const onMaterialized = vi.fn((thread: NavigationThreadSummary) => {
      expect(thread.id).toBe("thread-new");
      expect(result.current.selectedThread).toBeUndefined();
    });
    let pending: Promise<void>;
    act(() => {
      pending = result.current.materializeDirectoryLaunchpad(
        "directory:/Users/fixture-user/github/PwrAgent",
        undefined, undefined, undefined, undefined, undefined, undefined,
        onMaterialized,
      );
    });
    expect(result.current.pendingLaunchpadCreations).toHaveLength(1);
    act(() => result.current.selectPendingLaunchpad(result.current.pendingLaunchpadCreations[0]!.selectionKey));
    expect(result.current.selectedLaunchpad?.directoryLabel).toBe("PwrAgent");
    await act(async () => {
      creation.resolve({
        backend: "codex", threadId: "thread-new", executionMode: "default", workMode: "worktree",
      });
      await pending;
    });
    expect(onMaterialized).toHaveBeenCalledTimes(1);
    expect(result.current.pendingLaunchpadCreations).toEqual([]);

    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "directory:/Users/fixture-user/github/PwrAgent",
      launchpad: expect.objectContaining({
        directoryKey: "directory:/Users/fixture-user/github/PwrAgent",
        agent: {
          name: "PwrAgent Agent",
          instructions: "Manage PwrAgent threads.",
        },
      }),
      input: undefined,
      collaborationMode: undefined,
      reviewTarget: undefined,
    });
    expect(result.current.selectedThread?.id).toBe("thread-new");
    expect(result.current.selectedThread?.title).toBe("PwrAgent Agent");
    expect(result.current.selectedThread?.agent).toMatchObject({
      name: "PwrAgent Agent",
      instructionLineCount: 1,
      instructionsTooLong: false,
    });
    expect(result.current.selectedThread?.gitBranch).toBe("HEAD");
    expect(result.current.selectedThread?.observedGitBranch).toBe("HEAD");
    expect(result.current.directories[0]?.threadKeys).toEqual(["codex:thread-new"]);
    expect(result.current.directories[0]?.needsAttentionCount).toBe(1);
    expect(setThreadPin).not.toHaveBeenCalled();
  });

  it("projects a centrally auto-pinned materialized thread without another pin write", async () => {
    const directoryKey = "directory:/Users/fixture-user/github/PwrAgent";
    const existingPinnedThread = {
      id: "thread-pinned",
      title: "Pinned thread",
      titleSource: "explicit" as const,
      source: "codex" as const,
      linkedDirectories: [],
      inbox: { inInbox: true },
      executionMode: "default" as const,
      updatedAt: 1,
      pinnedRank: "1024",
    };
    const getNavigationSnapshot = vi.fn(async (): Promise<NavigationSnapshot> => ({
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-pinned"],
      threads: [existingPinnedThread],
      directories: [
        {
          key: directoryKey,
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/fixture-user/github/PwrAgent",
          threadKeys: ["codex:thread-pinned"],
          needsAttentionCount: 0,
          directoryThreadsCollapsed: true,
          launchpad: {
            directoryKey,
            directoryKind: "directory",
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/fixture-user/github/PwrAgent",
            backend: "codex",
            executionMode: "default",
            prompt: "",
            workMode: "worktree",
            branchName: "main",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    }));
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-new",
      executionMode: "default" as const,
      workMode: "worktree" as const,
      pinnedRank: "2048",
    }));
    const setThreadPin: NonNullable<DesktopApi["setThreadPin"]> = vi.fn(
      async (request) => ({
        backend: request.backend ?? "codex",
        threadId: request.threadId,
        pinnedRank: request.pinnedRank ?? undefined,
      }),
    );
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      materializeDirectoryLaunchpad,
      onAgentEvent: () => () => undefined,
      setThreadPin,
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.directories[0]?.directoryThreadsCollapsed).toBe(true);
    });

    await act(async () => {
      await result.current.materializeDirectoryLaunchpad(directoryKey);
    });

    expect(setThreadPin).not.toHaveBeenCalled();
    expect(result.current.selectedThread).toMatchObject({
      id: "thread-new",
      pinnedRank: "2048",
    });
  });

  it("carries the started review turn from launchpad materialization", async () => {
    const directoryKey = "directory:/Users/fixture-user/github/PwrAgent";
    const getNavigationSnapshot = vi.fn(async (): Promise<NavigationSnapshot> => ({
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: directoryKey,
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/fixture-user/github/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey,
            directoryKind: "directory",
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/fixture-user/github/PwrAgent",
            backend: "codex",
            executionMode: "default",
            prompt: "/review main",
            workMode: "worktree",
            branchName: "main",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    }));
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-review",
      executionMode: "default" as const,
      workMode: "worktree" as const,
      turnId: "turn-review",
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      materializeDirectoryLaunchpad,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.directories[0]?.launchpad?.prompt).toBe("/review main");
    });

    await act(async () => {
      await result.current.materializeDirectoryLaunchpad(
        directoryKey,
        undefined,
        undefined,
        { type: "baseBranch", branch: "main" }
      );
    });

    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey,
      launchpad: expect.objectContaining({
        prompt: "/review main",
      }),
      input: undefined,
      collaborationMode: undefined,
      reviewTarget: { type: "baseBranch", branch: "main" },
    });
    expect(result.current.selectedThread).toMatchObject({
      id: "thread-review",
      optimisticActiveTurn: {
        id: "turn-review",
        statusText: "Reviewing",
        reviewDisplayText: "Review changes against main",
      },
    });
    expect(result.current.selectedThread?.optimisticUserMessage).toBeUndefined();
  });

  it("keeps launchpad review turn metadata when hydration races materialization", async () => {
    const directoryKey = "directory:/Users/fixture-user/github/PwrAgent";
    const initialSnapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: 1_000,
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: directoryKey,
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/fixture-user/github/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey,
            directoryKind: "directory",
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/fixture-user/github/PwrAgent",
            backend: "codex",
            executionMode: "default",
            prompt: "/review main",
            workMode: "worktree",
            branchName: "main",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const hydratedSnapshot: NavigationSnapshot = {
      ...initialSnapshot,
      fetchedAt: 1_100,
      inboxThreadKeys: ["codex:thread-review"],
      threads: [
        {
          id: "thread-review",
          title: "Untitled thread",
          titleSource: "fallback",
          source: "codex",
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread",
          },
          updatedAt: 1_050,
        },
      ],
    };
    const getNavigationSnapshot = vi
      .fn()
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(hydratedSnapshot)
      .mockResolvedValue(hydratedSnapshot);
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-review",
      executionMode: "default" as const,
      workMode: "worktree" as const,
      turnId: "turn-review",
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      materializeDirectoryLaunchpad,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.directories[0]?.launchpad?.prompt).toBe("/review main");
    });

    await act(async () => {
      await result.current.materializeDirectoryLaunchpad(
        directoryKey,
        undefined,
        undefined,
        { type: "baseBranch", branch: "main" }
      );
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.selectedThread).toMatchObject({
      id: "thread-review",
      title: "/review main",
      optimisticActiveTurn: {
        id: "turn-review",
        statusText: "Reviewing",
      },
    });
  });

  it("rejects materialize failures after recording the launchpad error", async () => {
    const directoryKey = "directory:/Users/fixture-user/github/PwrAgent";
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: directoryKey,
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/fixture-user/github/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey,
            directoryKind: "directory" as const,
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/fixture-user/github/PwrAgent",
            backend: "acp:gemini" as const,
            executionMode: "default" as const,
            prompt: "Investigate Gemini",
            workMode: "worktree" as const,
            branchName: "main",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
      launchpadDefaults: {
        backend: "acp:gemini" as const,
        executionMode: "default" as const,
      },
    }));
    const materializeDirectoryLaunchpad = vi.fn(async () => {
      throw new Error("spawn gemini ENOENT");
    });

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      materializeDirectoryLaunchpad,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedLaunchpad?.directoryKey).toBe(directoryKey);
    });

    await act(async () => {
      await expect(
        result.current.materializeDirectoryLaunchpad(directoryKey)
      ).rejects.toThrow("spawn gemini ENOENT");
    });

    expect(result.current.launchpadError).toBe("spawn gemini ENOENT");
    expect(result.current.selectedLaunchpad?.directoryKey).toBe(directoryKey);
    expect(result.current.selectedThread).toBeUndefined();
  });

  it("keeps the materialized thread selected when the post-create refresh fails", async () => {
    const directoryKey = "directory:/Users/fixture-user/github/PwrAgent";
    const initialSnapshot = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: directoryKey,
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/fixture-user/github/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey,
            directoryKind: "directory" as const,
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/fixture-user/github/PwrAgent",
            backend: "acp:gemini" as const,
            executionMode: "default" as const,
            prompt: "Investigate Gemini",
            workMode: "worktree" as const,
            branchName: "main",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
      launchpadDefaults: {
        backend: "acp:gemini" as const,
        executionMode: "default" as const,
      },
    };
    let snapshotCalls = 0;
    const getNavigationSnapshot = vi.fn(async () => {
      snapshotCalls += 1;
      if (snapshotCalls > 1) {
        throw new Error("refresh failed");
      }
      return initialSnapshot;
    });
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "acp:gemini" as const,
      threadId: "thread-new",
      executionMode: "default" as const,
      workMode: "worktree" as const,
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      materializeDirectoryLaunchpad,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedLaunchpad?.directoryKey).toBe(directoryKey);
    });

    await act(async () => {
      await result.current.materializeDirectoryLaunchpad(directoryKey);
    });

    expect(result.current.launchpadError).toBeUndefined();
    expect(result.current.error).toBe("refresh failed");
    expect(result.current.selectedThread?.id).toBe("thread-new");
    expect(result.current.selectedThread?.source).toBe("acp:gemini");
    expect(result.current.selectedLaunchpad).toBeUndefined();
  });

  it("keeps a launchpad prompt-derived title when the hydrated thread only has a fallback id title", async () => {
    const directoryKey = "directory:/Users/fixture-user/github/PwrAgent";
    const threadId = "019df3a2-75b2-73d1-a273-5f94ac425966";
    const prompt =
      "What went wrong with Discord? Investigate the adapter path and explain the failure";
    const initialSnapshot = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: directoryKey,
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/fixture-user/github/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey,
            directoryKind: "directory" as const,
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/fixture-user/github/PwrAgent",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt,
            workMode: "worktree" as const,
            branchName: "main",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    };
    const getNavigationSnapshot = vi
      .fn()
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce({
        ...initialSnapshot,
        inboxThreadKeys: [`codex:${threadId}`],
        threads: [
          {
            id: threadId,
            title: threadId,
            titleSource: "fallback" as const,
            summary: undefined,
            source: "codex" as const,
            linkedDirectories: [
              {
                id: directoryKey,
                label: "PwrAgent",
                path: "/Users/fixture-user/github/PwrAgent",
                kind: "worktree" as const,
              },
            ],
            gitBranch: "HEAD",
            observedGitBranch: "HEAD",
            inbox: {
              inInbox: true,
              reason: "new-thread" as const,
            },
            updatedAt: 2,
          },
        ],
        directories: [
          {
            ...initialSnapshot.directories[0]!,
            threadKeys: [`codex:${threadId}`],
            needsAttentionCount: 1,
            launchpad: undefined,
          },
        ],
      });
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId,
      executionMode: "default" as const,
      workMode: "worktree" as const,
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      materializeDirectoryLaunchpad,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.directories[0]?.launchpad?.prompt).toBe(prompt);
    });

    await act(async () => {
      await result.current.materializeDirectoryLaunchpad(directoryKey);
    });

    expect(result.current.selectedThread?.id).toBe(threadId);
    expect(result.current.selectedThread?.title).toBe(shortenDerivedThreadTitle(prompt));
    expect(result.current.selectedThread?.titleSource).toBe("derived");
    expect(result.current.selectedThread?.title).not.toBe(threadId);
  });

  it("keeps launchpad input on an environment setup failure thread", async () => {
    const directoryKey = "directory:/Users/fixture-user/github/PwrAgent";
    const threadId = "thread-env-failure";
    const input = [{ type: "text" as const, text: "Fix the failed setup" }];
    const initialSnapshot = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: directoryKey,
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/fixture-user/github/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey,
            directoryKind: "directory" as const,
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/fixture-user/github/PwrAgent",
            backend: "codex" as const,
            executionMode: "full-access" as const,
            prompt: "Fix the failed setup",
            workMode: "worktree" as const,
            branchName: "main",
            model: "gpt-5.5",
            reasoningEffort: "high",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    };
    const getNavigationSnapshot = vi
      .fn()
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce({
        ...initialSnapshot,
        inboxThreadKeys: [`codex:${threadId}`],
        threads: [
          {
            id: threadId,
            title: "Untitled thread",
            titleSource: "fallback" as const,
            source: "codex" as const,
            linkedDirectories: [],
            inbox: { inInbox: true, reason: "new-thread" as const },
            updatedAt: 2,
            codexEnvironmentRuntime: {
              environmentId: "environment",
              environmentName: "PwrAgent",
              executionTarget: "local" as const,
              setupStatus: "failed" as const,
            },
          },
        ],
        directories: [
          {
            ...initialSnapshot.directories[0]!,
            threadKeys: [`codex:${threadId}`],
            launchpad: undefined,
          },
        ],
      });
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId,
      executionMode: "full-access" as const,
      workMode: "worktree" as const,
      codexEnvironmentStartupFailure: {
        message: "setup failed",
        phase: "setup" as const,
        worktreeCleanupAvailable: true,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      materializeDirectoryLaunchpad,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.directories[0]?.launchpad?.prompt).toBe(
        "Fix the failed setup"
      );
    });

    await act(async () => {
      await result.current.materializeDirectoryLaunchpad(directoryKey, input);
    });

    expect(result.current.selectedThread?.id).toBe(threadId);
    expect(result.current.selectedThread?.optimisticUserMessage?.text).toBe(
      "Fix the failed setup"
    );
  });

  it("selects a materialized thread without optimistic input when the first turn fails", async () => {
    const directoryKey = "directory:/Users/fixture-user/github/PwrAgent";
    const threadId = "thread-turn-failed";
    const input = [{ type: "text" as const, text: "Fix the model setting" }];
    const initialSnapshot = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: directoryKey,
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/fixture-user/github/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey,
            directoryKind: "directory" as const,
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/fixture-user/github/PwrAgent",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: "Fix the model setting",
            workMode: "local" as const,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    };
    const getNavigationSnapshot = vi.fn().mockResolvedValue(initialSnapshot);
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId,
      executionMode: "default" as const,
      workMode: "local" as const,
      turnStartFailure: {
        message: "invalid model",
        phase: "turn" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      materializeDirectoryLaunchpad,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.directories[0]?.launchpad?.prompt).toBe(
        "Fix the model setting"
      );
    });

    await act(async () => {
      await result.current.materializeDirectoryLaunchpad(directoryKey, input);
    });

    expect(result.current.selectedThread?.id).toBe(threadId);
    expect(result.current.selectedThread?.optimisticUserMessage).toBeUndefined();
    expect(result.current.launchpadError).toBe("invalid model");
  });

  it("does not let a materialized thread refresh override a newer user thread selection", async () => {
    const directoryKey = "directory:/Users/fixture-user/github/PwrAgent";
    const refreshedSnapshot = createDeferred<Awaited<ReturnType<NonNullable<DesktopApi["getNavigationSnapshot"]>>>>();
    const initialSnapshot = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [
        {
          id: "thread-existing",
          title: "Existing thread",
          titleSource: "explicit" as const,
          summary: "Existing thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [
        {
          key: directoryKey,
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/fixture-user/github/PwrAgent",
          threadKeys: ["codex:thread-existing"],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey,
            directoryKind: "directory" as const,
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/fixture-user/github/PwrAgent",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: "Start the focus regression thread",
            workMode: "worktree" as const,
            branchName: "main",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    };
    const getNavigationSnapshot = vi
      .fn()
      .mockResolvedValueOnce(initialSnapshot)
      .mockImplementationOnce(async () => await refreshedSnapshot.promise);
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-new",
      executionMode: "default" as const,
      workMode: "worktree" as const,
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      materializeDirectoryLaunchpad,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-existing");
    });

    let materializePromise: Promise<void> | undefined;
    act(() => {
      materializePromise = result.current.materializeDirectoryLaunchpad(directoryKey);
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-new");
    });

    act(() => {
      result.current.selectThread(
        result.current.threads.find((thread) => thread.id === "thread-existing")!,
      );
    });
    expect(result.current.selectedThread?.id).toBe("thread-existing");

    await act(async () => {
      refreshedSnapshot.resolve({
        ...initialSnapshot,
        threads: [
          {
            id: "thread-new",
            title: "Fresh focus thread",
            titleSource: "derived" as const,
            summary: undefined,
            source: "codex" as const,
            linkedDirectories: [],
            inbox: {
              inInbox: true,
              reason: "new-thread" as const,
            },
            updatedAt: 2_000,
          },
          ...initialSnapshot.threads,
        ],
        directories: [
          {
            ...initialSnapshot.directories[0]!,
            launchpad: undefined,
            threadKeys: ["codex:thread-new", "codex:thread-existing"],
            needsAttentionCount: 1,
          },
        ],
      });
      await materializePromise;
    });

    expect(result.current.selectedThread?.id).toBe("thread-existing");
  });

  it("does not let a pending materialized thread override a newer user thread selection", async () => {
    const directoryKey = "directory:/Users/fixture-user/github/PwrAgent";
    const launchpad: NavigationLaunchpadDraft = {
      directoryKey,
      directoryKind: "directory",
      directoryLabel: "PwrAgent",
      directoryPath: "/Users/fixture-user/github/PwrAgent",
      backend: "codex",
      executionMode: "default",
      prompt: "Start the pending focus thread",
      workMode: "worktree",
      branchName: "main",
      createdAt: 1,
      updatedAt: 1,
    };
    const defaults: NavigationLaunchpadDefaults = {
      backend: "codex",
      executionMode: "default",
    };
    const materializeResponse = createDeferred<{
      backend: "codex";
      threadId: string;
      executionMode: "default";
      workMode: "worktree";
    }>();
    const initialSnapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [
        {
          id: "thread-existing",
          title: "Existing thread",
          titleSource: "explicit",
          summary: "Existing thread summary",
          source: "codex",
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 1_000,
        },
        {
          id: "thread-stay-put",
          title: "Stay put thread",
          titleSource: "explicit",
          summary: "Thread selected while the launchpad is starting",
          source: "codex",
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 900,
        },
      ],
      directories: [
        {
          key: directoryKey,
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/fixture-user/github/PwrAgent",
          threadKeys: ["codex:thread-existing", "codex:thread-stay-put"],
          needsAttentionCount: 0,
        },
      ],
      launchpadDefaults: defaults,
    };
    const getNavigationSnapshot = vi.fn(async () => initialSnapshot);
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad,
      defaults,
    }));
    const materializeDirectoryLaunchpad = vi.fn(
      async () => await materializeResponse.promise
    );

    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      materializeDirectoryLaunchpad,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-existing");
    });

    await act(async () => {
      await result.current.openDirectoryLaunchpad(result.current.directories[0]!);
    });

    expect(result.current.selectedLaunchpad?.directoryKey).toBe(directoryKey);

    let materializePromise: Promise<void> | undefined;
    act(() => {
      materializePromise = result.current.materializeDirectoryLaunchpad(directoryKey);
    });

    await waitFor(() => {
      expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith({
        directoryKey,
        launchpad: expect.objectContaining({
          directoryKey,
        }),
        input: undefined,
        collaborationMode: undefined,
        reviewTarget: undefined,
      });
    });

    act(() => {
      result.current.selectThread(
        result.current.threads.find((thread) => thread.id === "thread-stay-put")!,
      );
    });
    expect(result.current.selectedThread?.id).toBe("thread-stay-put");

    await act(async () => {
      materializeResponse.resolve({
        backend: "codex",
        threadId: "thread-new",
        executionMode: "default",
        workMode: "worktree",
      });
      await materializePromise;
    });

    expect(result.current.threads.map((thread) => thread.id)).toContain("thread-new");
    expect(result.current.selectedThread?.id).toBe("thread-stay-put");
  });

  it("does not let an older launchpad completion replace a newer optimistic selection", async () => {
    const firstDirectoryKey = "directory:/Users/fixture-user/github/PwrAgent";
    const secondDirectoryKey = "directory:/Users/fixture-user/github/OtherApp";
    const defaults: NavigationLaunchpadDefaults = {
      backend: "codex",
      executionMode: "default",
    };
    const firstMaterialize = createDeferred<{
      backend: "codex";
      threadId: string;
      executionMode: "default";
      workMode: "worktree";
    }>();
    const secondMaterialize = createDeferred<{
      backend: "codex";
      threadId: string;
      executionMode: "default";
      workMode: "worktree";
    }>();
    const launchpadsByDirectory = new Map<string, NavigationLaunchpadDraft>(
      [firstDirectoryKey, secondDirectoryKey].map((directoryKey) => [
        directoryKey,
        {
          directoryKey,
          directoryKind: "directory",
          directoryLabel: directoryKey === firstDirectoryKey ? "PwrAgent" : "OtherApp",
          directoryPath:
            directoryKey === firstDirectoryKey
              ? "/Users/fixture-user/github/PwrAgent"
              : "/Users/fixture-user/github/OtherApp",
          backend: "codex",
          executionMode: "default",
          prompt:
            directoryKey === firstDirectoryKey
              ? "Start the older pending launchpad"
              : "Start the newer optimistic launchpad",
          workMode: "worktree",
          branchName: "main",
          createdAt: 1,
          updatedAt: 1,
        },
      ])
    );
    const initialSnapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: firstDirectoryKey,
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/fixture-user/github/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
        },
        {
          key: secondDirectoryKey,
          kind: "directory",
          label: "OtherApp",
          path: "/Users/fixture-user/github/OtherApp",
          threadKeys: [],
          needsAttentionCount: 0,
        },
      ],
      launchpadDefaults: defaults,
    };
    const getNavigationSnapshot = vi.fn(async () => initialSnapshot);
    const ensureDirectoryLaunchpad = vi.fn(
      async ({ directoryKey }: { directoryKey: string }) => ({
        launchpad: launchpadsByDirectory.get(directoryKey)!,
        defaults,
      })
    );
    const materializeDirectoryLaunchpad = vi.fn(
      async ({ directoryKey }: { directoryKey: string }) =>
        await (directoryKey === firstDirectoryKey
          ? firstMaterialize.promise
          : secondMaterialize.promise)
    );

    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      materializeDirectoryLaunchpad,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.directories).toHaveLength(2);
    });

    await act(async () => {
      await result.current.openDirectoryLaunchpad(
        result.current.directories.find(
          (directory) => directory.key === firstDirectoryKey,
        )!,
      );
    });

    let firstMaterializePromise: Promise<void> | undefined;
    act(() => {
      firstMaterializePromise =
        result.current.materializeDirectoryLaunchpad(firstDirectoryKey);
    });

    await waitFor(() => {
      expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith({
        directoryKey: firstDirectoryKey,
        launchpad: expect.objectContaining({
          directoryKey: firstDirectoryKey,
        }),
        input: undefined,
        collaborationMode: undefined,
        reviewTarget: undefined,
      });
    });

    await act(async () => {
      await result.current.openDirectoryLaunchpad(
        result.current.directories.find(
          (directory) => directory.key === secondDirectoryKey,
        )!,
      );
    });

    let secondMaterializePromise: Promise<void> | undefined;
    act(() => {
      secondMaterializePromise =
        result.current.materializeDirectoryLaunchpad(secondDirectoryKey);
    });

    await act(async () => {
      secondMaterialize.resolve({
        backend: "codex",
        threadId: "thread-newer",
        executionMode: "default",
        workMode: "worktree",
      });
      await secondMaterializePromise;
    });

    expect(result.current.selectedThread?.id).toBe("thread-newer");

    await act(async () => {
      firstMaterialize.resolve({
        backend: "codex",
        threadId: "thread-older",
        executionMode: "default",
        workMode: "worktree",
      });
      await firstMaterializePromise;
    });

    expect(result.current.selectedThread?.id).toBe("thread-newer");
    expect(result.current.threads.map((thread) => thread.id)).toContain(
      "thread-newer"
    );
  });

  it("does not keep a directory launchpad selected when a thread in that directory is selected", async () => {
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [
        {
          id: "thread-1",
          title: "Existing thread",
          titleSource: "explicit" as const,
          summary: "Thread summary",
          source: "codex" as const,
          linkedDirectories: [
            {
              id: "launchpad:directory:/Users/fixture-user/github/PwrAgent",
              label: "PwrAgent",
              path: "/Users/fixture-user/github/PwrAgent",
              kind: "local" as const,
            },
          ],
          inbox: {
            inInbox: false,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [
        {
          key: "directory:/Users/fixture-user/github/PwrAgent",
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/fixture-user/github/PwrAgent",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey: "directory:/Users/fixture-user/github/PwrAgent",
            directoryKind: "directory" as const,
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/fixture-user/github/PwrAgent",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: "",
            workMode: "worktree" as const,
            branchName: "main",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const launchpad: NavigationLaunchpadDraft = {
      directoryKey: "directory:/Users/fixture-user/github/PwrAgent",
      directoryKind: "directory" as const,
      directoryLabel: "PwrAgent",
      directoryPath: "/Users/fixture-user/github/PwrAgent",
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      workMode: "worktree" as const,
      branchName: "main",
      createdAt: 1,
      updatedAt: 1,
    };
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      ensureDirectoryLaunchpad: vi.fn(async () => ({
        launchpad,
        defaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      })),
      markThreadSeen: vi.fn(async () => ({
        backend: "codex",
        threadId: "thread-1",
        seenAt: Date.now(),
      })),
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });
    expect(result.current.selectedLaunchpad).toBeUndefined();

    await act(async () => {
      await result.current.openDirectoryLaunchpad(result.current.directories[0]!);
    });

    expect(result.current.selectedLaunchpad?.directoryKey).toBe(
      "directory:/Users/fixture-user/github/PwrAgent"
    );

    await act(async () => {
      result.current.selectThread(result.current.threads[0]!);
    });

    await waitFor(() => {
      expect(desktopApi.markThreadSeen).toHaveBeenCalledWith({
        backend: "codex",
        seenUpdatedAt: 1_000,
        threadId: "thread-1",
      });
    });
    expect(result.current.selectedThread?.id).toBe("thread-1");
    expect(result.current.selectedLaunchpad).toBeUndefined();
  });

  it("keeps newer launchpad edits when an older update response resolves later", async () => {
    const defaults = {
      backend: "codex" as const,
      executionMode: "default" as const,
    };
    const launchpad: NavigationLaunchpadDraft = {
      directoryKey: "directory:/Users/fixture-user/github/PwrAgent",
      directoryKind: "directory" as const,
      directoryLabel: "PwrAgent",
      directoryPath: "/Users/fixture-user/github/PwrAgent",
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      workMode: "local" as const,
      branchName: "main",
      createdAt: 1,
      updatedAt: 1,
    };
    const olderUpdate = createDeferred<{
      defaults: typeof defaults;
      launchpad: typeof launchpad;
    }>();
    const newerUpdate = createDeferred<{
      defaults: typeof defaults;
      launchpad: typeof launchpad;
    }>();
    const updateDirectoryLaunchpad = vi
      .fn()
      .mockReturnValueOnce(olderUpdate.promise)
      .mockReturnValueOnce(newerUpdate.promise);
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: "directory:/Users/fixture-user/github/PwrAgent",
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/fixture-user/github/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad,
        },
      ],
      launchpadDefaults: defaults,
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
      updateDirectoryLaunchpad,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedLaunchpad?.directoryKey).toBe(
        "directory:/Users/fixture-user/github/PwrAgent"
      );
    });

    let firstUpdate: Promise<void> | undefined;
    let secondUpdate: Promise<void> | undefined;
    act(() => {
      firstUpdate = result.current.updateDirectoryLaunchpad(
        "directory:/Users/fixture-user/github/PwrAgent",
        { prompt: "older prompt" },
      );
      secondUpdate = result.current.updateDirectoryLaunchpad(
        "directory:/Users/fixture-user/github/PwrAgent",
        { prompt: "newer prompt" },
      );
    });

    await waitFor(() => {
      expect(result.current.selectedLaunchpad?.prompt).toBe("newer prompt");
    });

    await act(async () => {
      newerUpdate.resolve({
        defaults,
        launchpad: {
          ...launchpad,
          prompt: "newer prompt",
          updatedAt: 3,
        },
      });
      await secondUpdate!;
    });
    expect(result.current.selectedLaunchpad?.prompt).toBe("newer prompt");

    await act(async () => {
      olderUpdate.resolve({
        defaults,
        launchpad: {
          ...launchpad,
          prompt: "older prompt",
          updatedAt: 2,
        },
      });
      await firstUpdate!;
    });

    expect(result.current.selectedLaunchpad?.prompt).toBe("newer prompt");
  });

  it("atomically restores remembered reasoning when a launchpad model changes", async () => {
    const defaults: NavigationLaunchpadDefaults = {
      backend: "codex",
      executionMode: "default",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    };
    const launchpad: NavigationLaunchpadDraft = {
      directoryKey: "directory:/Users/fixture-user/github/PwrAgent",
      directoryKind: "directory",
      directoryLabel: "PwrAgent",
      directoryPath: "/Users/fixture-user/github/PwrAgent",
      backend: "codex",
      executionMode: "default",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      providerSettings: {
        codex: {
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          reasoningEffortsByModel: {
            "gpt-5.6-sol": "high",
            "gpt-5.6-terra": "medium",
          },
        },
      },
      prompt: "",
      workMode: "local",
      branchName: "main",
      createdAt: 1,
      updatedAt: 1,
    };
    const terraUpdate = createDeferred<{
      defaults: NavigationLaunchpadDefaults;
      launchpad: NavigationLaunchpadDraft;
    }>();
    const solUpdate = createDeferred<{
      defaults: NavigationLaunchpadDefaults;
      launchpad: NavigationLaunchpadDraft;
    }>();
    const updateDirectoryLaunchpad = vi
      .fn()
      .mockReturnValueOnce(terraUpdate.promise)
      .mockReturnValueOnce(solUpdate.promise);
    const terraResponse = {
      defaults: {
        ...defaults,
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
      },
      launchpad: {
        ...launchpad,
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
        providerSettings: {
          codex: {
            ...launchpad.providerSettings?.codex,
            model: "gpt-5.6-terra",
            reasoningEffort: "medium",
          },
        },
        updatedAt: 2,
      },
    } satisfies {
      defaults: NavigationLaunchpadDefaults;
      launchpad: NavigationLaunchpadDraft;
    };
    const solResponse = {
      defaults,
      launchpad: {
        ...launchpad,
        updatedAt: 3,
      },
    } satisfies {
      defaults: NavigationLaunchpadDefaults;
      launchpad: NavigationLaunchpadDraft;
    };
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: launchpad.directoryKey,
          kind: "directory" as const,
          label: launchpad.directoryLabel,
          path: launchpad.directoryPath,
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad,
        },
      ],
      launchpadDefaults: defaults,
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
      updateDirectoryLaunchpad,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedLaunchpad?.reasoningEffort).toBe("high");
    });

    let firstUpdate: Promise<void> | undefined;
    act(() => {
      firstUpdate = result.current.updateDirectoryLaunchpad(
        launchpad.directoryKey,
        { model: "gpt-5.6-terra" },
        { stickySettingsChanged: true },
      );
    });

    expect(result.current.selectedLaunchpad).toMatchObject({
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });

    await act(async () => {
      terraUpdate.resolve(terraResponse);
      await firstUpdate;
    });

    let secondUpdate: Promise<void> | undefined;
    act(() => {
      secondUpdate = result.current.updateDirectoryLaunchpad(
        launchpad.directoryKey,
        { model: "gpt-5.6-sol" },
        { stickySettingsChanged: true },
      );
    });

    expect(result.current.selectedLaunchpad).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });

    await act(async () => {
      solUpdate.resolve(solResponse);
      await secondUpdate;
    });
  });

  it("keeps launchpad environment controls stable after prompt-only update responses", async () => {
    const defaults = {
      backend: "codex" as const,
      executionMode: "default" as const,
    };
    const launchpad: NavigationLaunchpadDraft = {
      directoryKey: "directory:/Users/fixture-user/github/PwrAgent",
      directoryKind: "directory" as const,
      directoryLabel: "PwrAgent",
      directoryPath: "/Users/fixture-user/github/PwrAgent",
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      workMode: "local" as const,
      branchName: "main",
      codexEnvironmentId: "environment",
      codexEnvironmentExecutionTarget: "local" as const,
      codexEnvironmentOptions: [
        {
          id: "environment",
          name: "PwrAgnt",
          sourcePath: "/Users/fixture-user/github/PwrAgent/.codex/environments/environment.toml",
          setupScript: "pnpm install",
          actions: [
            {
              id: "dev",
              name: "Dev",
              command: "pnpm dev",
            },
          ],
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    };
    const promptUpdate = createDeferred<{
      defaults: typeof defaults;
      launchpad: typeof launchpad;
    }>();
    const updateDirectoryLaunchpad = vi.fn().mockReturnValueOnce(promptUpdate.promise);
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: launchpad.directoryKey,
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/fixture-user/github/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad,
        },
      ],
      launchpadDefaults: defaults,
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
      updateDirectoryLaunchpad,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedLaunchpad?.codexEnvironmentId).toBe("environment");
    });

    let update: Promise<void> | undefined;
    act(() => {
      update = result.current.updateDirectoryLaunchpad(launchpad.directoryKey, {
        prompt: "typing",
      });
    });

    await act(async () => {
      promptUpdate.resolve({
        defaults,
        launchpad: {
          ...launchpad,
          prompt: "typing",
          codexEnvironmentId: undefined,
          codexEnvironmentExecutionTarget: undefined,
          codexEnvironmentOptions: [],
          updatedAt: 2,
        },
      });
      await update!;
    });

    expect(result.current.selectedLaunchpad).toMatchObject({
      prompt: "typing",
      codexEnvironmentId: "environment",
      codexEnvironmentExecutionTarget: "local",
      codexEnvironmentOptions: [
        expect.objectContaining({
          id: "environment",
          name: "PwrAgnt",
        }),
      ],
    });
  });

  it("keeps owner environment metadata after remote viewer environment updates", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "owner-instance",
    };
    (window as unknown as {
      __pwragentFederationTarget?: typeof federationTarget;
    }).__pwragentFederationTarget = federationTarget;
    const defaults = {
      backend: "codex" as const,
      executionMode: "default" as const,
    };
    const launchpad: NavigationLaunchpadDraft = {
      directoryKey: "directory:/owner-only/PwrAgent",
      directoryKind: "directory",
      directoryLabel: "PwrAgent",
      directoryPath: "/owner-only/PwrAgent",
      backend: "codex",
      executionMode: "default",
      prompt: "",
      workMode: "local",
      codexEnvironmentOptions: [
        {
          id: "environment",
          name: "PwrAgent",
          sourcePath: "/owner-only/PwrAgent/.codex/environments/environment.toml",
          setupScript: "pnpm install",
          actions: [],
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    };
    const updateDirectoryLaunchpad = vi.fn(async () => ({
      defaults,
      launchpad: {
        ...launchpad,
        codexEnvironmentId: undefined,
        codexEnvironmentExecutionTarget: undefined,
        codexEnvironmentOptions: [],
        updatedAt: 2,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot: vi.fn(async () => ({
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: false,
        federationTarget,
        inboxThreadKeys: [],
        threads: [],
        directories: [
          {
            key: launchpad.directoryKey,
            kind: "directory" as const,
            label: launchpad.directoryLabel,
            path: launchpad.directoryPath,
            threadKeys: [],
            needsAttentionCount: 0,
            launchpad,
          },
        ],
        launchpadDefaults: defaults,
      })),
      onAgentEvent: () => () => undefined,
      updateDirectoryLaunchpad,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedLaunchpad?.directoryKey).toBe(
        launchpad.directoryKey,
      );
    });

    await act(async () => {
      await result.current.updateDirectoryLaunchpad(launchpad.directoryKey, {
        codexEnvironmentId: "environment",
        codexEnvironmentExecutionTarget: "local",
      });
    });

    expect(result.current.selectedLaunchpad).toMatchObject({
      codexEnvironmentId: "environment",
      codexEnvironmentExecutionTarget: "local",
      codexEnvironmentOptions: [
        expect.objectContaining({
          id: "environment",
          name: "PwrAgent",
        }),
      ],
    });
  });

  it("keeps launchpad updates stable across remote viewer rerenders", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "owner-instance",
    };
    (window as unknown as {
      __pwragentFederationTarget?: typeof federationTarget;
    }).__pwragentFederationTarget = federationTarget;
    const desktopApi: DesktopApi = {
      getNavigationSnapshot: vi.fn(async () => ({
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: false,
        federationTarget,
        inboxThreadKeys: [],
        threads: [],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      })),
      onAgentEvent: () => () => undefined,
    };

    const { result, rerender } = renderHook(() =>
      useThreadNavigation(desktopApi)
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    const initialUpdateDirectoryLaunchpad =
      result.current.updateDirectoryLaunchpad;

    rerender();

    expect(result.current.updateDirectoryLaunchpad).toBe(
      initialUpdateDirectoryLaunchpad,
    );
  });

  it("keeps server-confirmed settingsTouchedAt after sticky launchpad updates", async () => {
    const defaults: NavigationLaunchpadDefaults = {
      backend: "codex" as const,
      executionMode: "default" as const,
    };
    const launchpad: NavigationLaunchpadDraft = {
      directoryKey: "directory:/Users/fixture-user/github/PwrAgent",
      directoryKind: "directory",
      directoryLabel: "PwrAgent",
      directoryPath: "/Users/fixture-user/github/PwrAgent",
      backend: "codex",
      executionMode: "default",
      prompt: "",
      workMode: "local",
      branchName: "main",
      createdAt: 1,
      updatedAt: 1,
    };
    const stickyUpdate = createDeferred<{
      defaults: typeof defaults;
      launchpad: NavigationLaunchpadDraft;
    }>();
    const updateDirectoryLaunchpad = vi.fn().mockReturnValueOnce(stickyUpdate.promise);
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: launchpad.directoryKey,
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/fixture-user/github/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad,
        },
      ],
      launchpadDefaults: defaults,
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
      updateDirectoryLaunchpad,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedLaunchpad?.workMode).toBe("local");
    });

    let update: Promise<void> | undefined;
    act(() => {
      update = result.current.updateDirectoryLaunchpad(
        launchpad.directoryKey,
        {
          workMode: "worktree",
        },
        { stickySettingsChanged: true },
      );
    });

    await act(async () => {
      stickyUpdate.resolve({
        defaults: {
          ...defaults,
          workMode: "worktree",
        },
        launchpad: {
          ...launchpad,
          workMode: "worktree",
          settingsTouchedAt: 123_456,
          updatedAt: 2,
        },
      });
      await update!;
    });

    expect(result.current.selectedLaunchpad).toMatchObject({
      workMode: "worktree",
      settingsTouchedAt: 123_456,
    });
    expect(updateDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: launchpad.directoryKey,
      patch: {
        workMode: "worktree",
      },
      stickySettingsChanged: true,
    });
  });

  it("opens masthead new-thread drafts inside the Workspaces directory", async () => {
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey: "workspace:/Users/test/.pwragent/projects",
        directoryKind: "workspace" as const,
        directoryLabel: "Workspaces",
        directoryPath: "/Users/test/.pwragent/projects",
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        workMode: "local" as const,
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: "workspace:/Users/test/.pwragent/projects",
          kind: "workspace" as const,
          label: "Workspaces",
          path: "/Users/test/.pwragent/projects",
          threadKeys: [],
          needsAttentionCount: 0,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.directories[0]?.label).toBe("Workspaces");
    });

    await act(async () => {
      await result.current.createThread();
    });

    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "workspace:/Users/test/.pwragent/projects",
      directoryKind: "workspace",
      directoryLabel: "Workspaces",
      directoryPath: "/Users/test/.pwragent/projects",
      preferredBackend: undefined,
    });
    expect(result.current.selectedItemKey).toBe(
      "launchpad:workspace:/Users/test/.pwragent/projects"
    );
    expect(result.current.selectedDirectory?.label).toBe("Workspaces");
    expect(result.current.selectedLaunchpad?.directoryKind).toBe("workspace");
    expect(result.current.directories.map((directory) => directory.label)).toEqual([
      "Workspaces",
    ]);
    expect(result.current.directories.some((directory) => directory.kind === "unlinked")).toBe(
      false
    );
  });

  it("publishes a create failure to the notice stack and clears it on retry", async () => {
    // Regression: `Desktop backend registry is closed` pinned itself in the
    // sidebar masthead with no dismiss, no timeout, and a permanent layout
    // cost. It is a durable toast now, and the retry that clears the hook's
    // slot has to take the toast down with it.
    let attempt = 0;
    const ensureDirectoryLaunchpad = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("Desktop backend registry is closed");
      }
      return {
        launchpad: {
          directoryKey: "workspace:/Users/test/.pwragent/projects",
          directoryKind: "workspace" as const,
          directoryLabel: "Workspaces",
          directoryPath: "/Users/test/.pwragent/projects",
          backend: "codex" as const,
          executionMode: "default" as const,
          prompt: "",
          workMode: "local" as const,
          createdAt: 1,
          updatedAt: 2,
        },
        defaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      };
    });
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: "workspace:/Users/test/.pwragent/projects",
          kind: "workspace" as const,
          label: "Workspaces",
          path: "/Users/test/.pwragent/projects",
          threadKeys: [],
          needsAttentionCount: 0,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const onThreadActionError = vi.fn();
    const { result } = renderHook(() =>
      useThreadNavigation(desktopApi, { onThreadActionError }),
    );

    await waitFor(() => {
      expect(result.current.directories[0]?.label).toBe("Workspaces");
    });

    await act(async () => {
      await result.current.createThread();
    });

    await waitFor(() => {
      expect(latestThreadActionError(onThreadActionError, "create-thread")).toBe(
        "Desktop backend registry is closed",
      );
    });

    await act(async () => {
      await result.current.createThread();
    });

    await waitFor(() => {
      expect(
        latestThreadActionError(onThreadActionError, "create-thread"),
      ).toBeUndefined();
    });
  });

  it("opens masthead new-thread drafts while the initial navigation snapshot is loading", async () => {
    const initialSnapshot = createDeferred<NavigationSnapshot>();
    const emptySnapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const launchpad: NavigationLaunchpadDraft = {
      directoryKey: "workspace:new-thread",
      directoryKind: "workspace",
      directoryLabel: "Workspaces",
      backend: "codex",
      executionMode: "default",
      prompt: "",
      workMode: "local",
      createdAt: 1,
      updatedAt: 2,
    };
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad,
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const getNavigationSnapshot = vi
      .fn()
      .mockReturnValueOnce(initialSnapshot.promise)
      .mockResolvedValue(emptySnapshot);
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    let create!: Promise<void>;
    act(() => {
      create = result.current.createThread();
    });

    await waitFor(() => {
      expect(ensureDirectoryLaunchpad).toHaveBeenCalled();
    });

    await act(async () => {
      initialSnapshot.resolve(emptySnapshot);
      await create;
    });

    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "workspace:new-thread",
      directoryKind: "workspace",
      directoryLabel: "Workspaces",
      directoryPath: undefined,
      preferredBackend: undefined,
    });
    await waitFor(() => {
      expect(result.current.selectedLaunchpad?.directoryKey).toBe(
        "workspace:new-thread"
      );
      expect(result.current.selectedDirectory?.kind).toBe("workspace");
    });
  });

  it("rebases a loading fallback launchpad without duplicating it or losing viewer input", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "owner-mini",
    };
    (window as unknown as {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = federationTarget;
    const initialSnapshot = createDeferred<NavigationSnapshot>();
    const workspaceKey = "workspace:/Users/test/.pwragent/profiles/default/projects";
    const canonicalSnapshot: NavigationSnapshot = {
      backend: "all",
      federationTarget,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [{
        key: workspaceKey,
        kind: "workspace",
        label: "Workspaces",
        path: "/Users/test/.pwragent/profiles/default/projects",
        threadKeys: ["codex:scratch-thread"],
        needsAttentionCount: 1,
        pinnedRank: "6144",
        launchpad: {
          directoryKey: workspaceKey,
          directoryKind: "workspace",
          directoryLabel: "Workspaces",
          directoryPath: "/Users/test/.pwragent/profiles/default/projects",
          backend: "codex",
          executionMode: "default",
          model: "owner-model",
          prompt: "Owner snapshot draft",
          workMode: "local",
          createdAt: 1,
          updatedAt: 1,
        },
      }],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const fallbackLaunchpad: NavigationLaunchpadDraft = {
      directoryKey: "workspace:new-thread",
      directoryKind: "workspace",
      directoryLabel: "Workspaces",
      backend: "codex",
      executionMode: "default",
      model: "viewer-model",
      prompt: "Viewer unsent draft",
      workMode: "local",
      createdAt: 1,
      updatedAt: 2,
    };
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: fallbackLaunchpad,
      defaults: canonicalSnapshot.launchpadDefaults,
    }));
    const getNavigationSnapshot = vi
      .fn()
      .mockReturnValueOnce(initialSnapshot.promise)
      .mockResolvedValue(canonicalSnapshot);
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    let create!: Promise<void>;
    act(() => {
      create = result.current.createThread(undefined, "default", {
        forceWorkspace: true,
      });
    });

    await waitFor(() => {
      expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith({
        federationTarget,
        directoryKey: "workspace:new-thread",
        directoryKind: "workspace",
        directoryLabel: "Workspaces",
        directoryPath: undefined,
        preferredBackend: undefined,
      });
    });

    await act(async () => {
      initialSnapshot.resolve(canonicalSnapshot);
      await create;
    });

    await waitFor(() => {
      expect(result.current.directories).toHaveLength(1);
      expect(result.current.directories[0]).toMatchObject({
        key: workspaceKey,
        path: "/Users/test/.pwragent/profiles/default/projects",
        threadKeys: ["codex:scratch-thread"],
        needsAttentionCount: 1,
        pinnedRank: "6144",
        launchpad: {
          directoryKey: workspaceKey,
          directoryPath: "/Users/test/.pwragent/profiles/default/projects",
          model: "viewer-model",
          prompt: "Viewer unsent draft",
        },
      });
      expect(result.current.selectedItemKey).toBe(`launchpad:${workspaceKey}`);
      expect(result.current.selectedDirectory?.key).toBe(workspaceKey);
    });
  });

  it("creates a new thread in the selected thread's project directory", async () => {
    const directoryKey = "directory:/Users/test/PwrAgent";
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey,
        directoryKind: "directory" as const,
        directoryLabel: "PwrAgent",
        directoryPath: "/Users/test/PwrAgent",
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        workMode: "local" as const,
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "Project thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [
            {
              id: "linked-dir-1",
              label: "PwrAgent",
              path: "/Users/test/PwrAgent",
              kind: "local" as const,
            },
          ],
          inbox: {
            inInbox: false,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [
        {
          key: directoryKey,
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/test/PwrAgent",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
        },
        {
          key: "workspace:/Users/test/.pwragent/projects",
          kind: "workspace" as const,
          label: "Workspaces",
          path: "/Users/test/.pwragent/projects",
          threadKeys: [],
          needsAttentionCount: 0,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads).toHaveLength(1);
    });

    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });

    await act(async () => {
      await result.current.createThread();
    });

    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey,
      directoryKind: "directory",
      directoryLabel: "PwrAgent",
      directoryPath: "/Users/test/PwrAgent",
      preferredBackend: undefined,
    });
    expect(result.current.selectedItemKey).toBe(`launchpad:${directoryKey}`);
    expect(result.current.selectedDirectory?.key).toBe(directoryKey);
    expect(result.current.selectedLaunchpad?.directoryKey).toBe(directoryKey);
  });

  it("does not let a same-key viewer launchpad replace remote branch authority", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "owner-one",
    };
    (window as unknown as {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = federationTarget;
    const directoryKey = "directory:/shared/PwrAgent";
    const ownerGitStatus = {
      currentBranch: "owner/main",
      branches: ["owner/main", "owner/release"],
      branchDetails: [
        { name: "owner/main", lastCommitAt: 200 },
        { name: "owner/release", lastCommitAt: 100 },
      ],
      baseBranches: ["owner/main", "owner/release", "origin/release"],
      baseBranchDetails: [
        { name: "origin/release", lastCommitAt: 90 },
      ],
      syncState: "in-sync" as const,
    };
    const snapshot: NavigationSnapshot = {
      backend: "all",
      federationTarget,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:remote-thread"],
      threads: [{
        id: "remote-thread",
        title: "Remote work",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
        projectKey: "/shared/PwrAgent",
        inbox: { inInbox: true },
        updatedAt: 1,
      }],
      directories: [{
        key: directoryKey,
        kind: "directory",
        label: "Owner PwrAgent",
        path: "/shared/PwrAgent",
        threadKeys: ["codex:remote-thread"],
        needsAttentionCount: 0,
        gitStatus: ownerGitStatus,
      }],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey,
        directoryKind: "directory" as const,
        directoryLabel: "Viewer PwrAgent",
        directoryPath: "/shared/PwrAgent",
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "viewer-persisted draft",
        workMode: "local" as const,
        branchName: "viewer/local-only",
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: snapshot.launchpadDefaults,
      gitStatus: ownerGitStatus,
    }));
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot: vi.fn(async () => snapshot),
      onAgentEvent: () => () => undefined,
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("remote-thread");
    });
    await act(async () => {
      await result.current.createThread();
    });

    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith({
      federationTarget,
      directoryKey,
      directoryKind: "directory",
      directoryLabel: "Owner PwrAgent",
      directoryPath: "/shared/PwrAgent",
      gitStatus: ownerGitStatus,
      currentBranch: "owner/main",
      preferredBackend: undefined,
    });
    expect(result.current.selectedDirectory?.label).toBe("Owner PwrAgent");
    expect(result.current.selectedDirectory?.gitStatus).toEqual(ownerGitStatus);
    expect(result.current.selectedLaunchpad).toMatchObject({
      prompt: "viewer-persisted draft",
      directoryLabel: "Owner PwrAgent",
      branchName: "owner/main",
    });

    ensureDirectoryLaunchpad.mockResolvedValueOnce({
      launchpad: {
        directoryKey,
        directoryKind: "directory" as const,
        directoryLabel: "Viewer PwrAgent",
        directoryPath: "/shared/PwrAgent",
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "remote base draft",
        workMode: "local" as const,
        branchName: "origin/release",
        createdAt: 1,
        updatedAt: 3,
      },
      defaults: snapshot.launchpadDefaults,
      gitStatus: ownerGitStatus,
    });
    await act(async () => {
      await result.current.openDirectoryLaunchpad(result.current.directories[0]!);
    });
    expect(result.current.selectedLaunchpad).toMatchObject({
      prompt: "remote base draft",
      branchName: "origin/release",
    });
  });

  it("forces a directory-less workspace draft even when a directory is in context", async () => {
    const directoryKey = "directory:/Users/test/PwrAgent";
    const workspaceKey = "workspace:/Users/test/.pwragent/projects";
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey: workspaceKey,
        directoryKind: "workspace" as const,
        directoryLabel: "Workspaces",
        directoryPath: "/Users/test/.pwragent/projects",
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        workMode: "local" as const,
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "Project thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [
            {
              id: "linked-dir-1",
              label: "PwrAgent",
              path: "/Users/test/PwrAgent",
              kind: "local" as const,
            },
          ],
          inbox: {
            inInbox: false,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [
        {
          key: directoryKey,
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/test/PwrAgent",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
        },
        {
          key: workspaceKey,
          kind: "workspace" as const,
          label: "Workspaces",
          path: "/Users/test/.pwragent/projects",
          threadKeys: [],
          needsAttentionCount: 0,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads).toHaveLength(1);
    });

    // Select a thread bound to a real directory — the default createThread()
    // path would target that directory, and the flyout label reflects it.
    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });
    expect(result.current.newThreadDirectoryLabel).toBe("PwrAgent");

    await act(async () => {
      await result.current.createThread(undefined, "default", {
        forceWorkspace: true,
      });
    });

    // forceWorkspace must bypass the selected directory and land on workspace.
    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: workspaceKey,
      directoryKind: "workspace",
      directoryLabel: "Workspaces",
      directoryPath: "/Users/test/.pwragent/projects",
      preferredBackend: undefined,
    });
    expect(result.current.selectedLaunchpad?.directoryKind).toBe("workspace");
  });

  it("openWorkspaceLaunchpad synthesizes a workspace target when the snapshot has none", async () => {
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey: "workspace:new-thread",
        directoryKind: "workspace" as const,
        directoryLabel: "Workspaces",
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        workMode: "local" as const,
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalled();
    });

    await act(async () => {
      await result.current.openWorkspaceLaunchpad();
    });

    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "workspace:new-thread",
      directoryKind: "workspace",
      directoryLabel: "Workspaces",
      directoryPath: undefined,
      currentBranch: undefined,
      preferredBackend: undefined,
    });
    expect(result.current.selectedItemKey).toBe("launchpad:workspace:new-thread");
  });

  it("reuses the selected directory launchpad context for new threads", async () => {
    const directoryKey = "directory:/Users/test/PwrAgent";
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey,
        directoryKind: "directory" as const,
        directoryLabel: "PwrAgent",
        directoryPath: "/Users/test/PwrAgent",
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        workMode: "local" as const,
        createdAt: 3,
        updatedAt: 4,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: directoryKey,
          kind: "directory" as const,
          label: "PwrAgent",
          path: "/Users/test/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey,
            directoryKind: "directory" as const,
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/test/PwrAgent",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: "Existing draft",
            workMode: "local" as const,
            createdAt: 1,
            updatedAt: 2,
          },
        },
        {
          key: "workspace:/Users/test/.pwragent/projects",
          kind: "workspace" as const,
          label: "Workspaces",
          path: "/Users/test/.pwragent/projects",
          threadKeys: [],
          needsAttentionCount: 0,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.directories).toHaveLength(2);
    });

    await act(async () => {
      await result.current.openDirectoryLaunchpad(result.current.directories[0]!);
      await result.current.createThread();
    });

    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey,
      directoryKind: "directory",
      directoryLabel: "PwrAgent",
      directoryPath: "/Users/test/PwrAgent",
      preferredBackend: undefined,
    });
    expect(result.current.selectedItemKey).toBe(`launchpad:${directoryKey}`);
  });

  it("falls back to the workspace launchpad when the selected thread has no concrete project directory", async () => {
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey: "workspace:/Users/test/.pwragent/projects",
        directoryKind: "workspace" as const,
        directoryLabel: "Workspaces",
        directoryPath: "/Users/test/.pwragent/projects",
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        workMode: "local" as const,
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "Unlinked thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: false,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [
        {
          key: "workspace:/Users/test/.pwragent/projects",
          kind: "workspace" as const,
          label: "Workspaces",
          path: "/Users/test/.pwragent/projects",
          threadKeys: [],
          needsAttentionCount: 0,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads).toHaveLength(1);
    });

    act(() => {
      result.current.selectThread(result.current.threads[0]!);
    });

    await act(async () => {
      await result.current.createThread();
    });

    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "workspace:/Users/test/.pwragent/projects",
      directoryKind: "workspace",
      directoryLabel: "Workspaces",
      directoryPath: "/Users/test/.pwragent/projects",
      preferredBackend: undefined,
    });
    expect(result.current.selectedLaunchpad?.directoryKey).toBe(
      "workspace:/Users/test/.pwragent/projects"
    );
  });

  it("removes server-backed launchpads when a refreshed snapshot omits them", async () => {
    const directoryKey = "directory:/Users/test/PwrAgent";
    const snapshotWithLaunchpad: NavigationSnapshot = {
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: directoryKey,
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/test/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey,
            directoryKind: "directory",
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/test/PwrAgent",
            backend: "codex",
            executionMode: "default",
            prompt: "Build the feature",
            workMode: "worktree",
            createdAt: 1,
            updatedAt: 2,
          },
        },
      ],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const snapshotWithoutLaunchpad: NavigationSnapshot = {
      ...snapshotWithLaunchpad,
      fetchedAt: snapshotWithLaunchpad.fetchedAt + 1,
      directories: [
        {
          key: directoryKey,
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/test/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
        },
      ],
    };
    const getNavigationSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshotWithLaunchpad)
      .mockResolvedValueOnce(snapshotWithoutLaunchpad);
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.directories[0]?.launchpad?.prompt).toBe(
        "Build the feature"
      );
    });

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.directories[0]?.launchpad).toBeUndefined();
      expect(result.current.selectedLaunchpad).toBeUndefined();
    });
  });

  it("does not fabricate a git workspace relationship for directory-less Workspace threads", async () => {
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      executionMode: "default" as const,
      workMode: "local" as const,
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: "workspace:/Users/test/.pwragent/projects",
          kind: "workspace" as const,
          label: "Workspaces",
          path: "/Users/test/.pwragent/projects",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey: "workspace:/Users/test/.pwragent/projects",
            directoryKind: "workspace" as const,
            directoryLabel: "Workspaces",
            directoryPath: "/Users/test/.pwragent/projects",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: "Create an Agent",
            workMode: "local" as const,
            createdAt: 1,
            updatedAt: 2,
          },
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      materializeDirectoryLaunchpad,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedLaunchpad?.directoryKind).toBe("workspace");
    });

    await act(async () => {
      await result.current.materializeDirectoryLaunchpad(
        "workspace:/Users/test/.pwragent/projects",
      );
    });

    expect(result.current.selectedThread).toMatchObject({
      id: "thread-1",
      linkedDirectories: [],
    });
  });

  it("forks a parent thread through the desktop bridge and selects the optimistic fork", async () => {
    const parentThread = {
      id: "thread-parent",
      title: "Implement grouped threads",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      model: "gpt-5.5",
      serviceTier: "fast",
      fastMode: true,
      gitBranch: "feature/parent",
      observedGitBranch: "feature/parent",
      codexEnvironmentRuntime: {
        environmentId: "pwragent",
        environmentName: "PwrAgent",
        executionTarget: "local" as const,
        cwd: "/repo/app/.worktrees/parent/app",
        shellEnvironment: {
          PATH: "/Users/fixture-user/.nvm/versions/node/v24.14.1/bin:/usr/bin",
        },
      },
      messagingBindings: [
        {
          bindingId: "binding-parent",
          platform: "telegram" as const,
          conversationTitle: "Parent DM",
        },
      ],
      prs: [
        {
          provider: "github.com",
          number: 123,
          org: "pwrdrvr",
          repo: "PwrAgent",
          state: "passing" as const,
          url: "https://github.com/pwrdrvr/PwrAgent/pull/123",
        },
      ],
      reactions: ["👀"],
      linkedDirectories: [
        {
          id: "/repo/app",
          label: "app",
          path: "/repo/app",
          worktreePath: "/repo/app/.worktrees/parent/app",
          kind: "worktree" as const,
        },
      ],
      inbox: {
        inInbox: true,
        reason: "new-thread" as const,
      },
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const forkThread = vi.fn(async () => ({
      backend: "codex" as const,
      sourceThreadId: "thread-parent",
      threadId: "thread-fork",
      executionMode: "default" as const,
      workMode: "worktree" as const,
      linkedDirectory: {
        id: "/repo/app",
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/thread-fork/app",
        kind: "worktree" as const,
      },
      codexEnvironmentRuntime: {
        environmentId: "pwragent",
        environmentName: "PwrAgent",
        executionTarget: "local" as const,
        cwd: "/repo/app/.worktrees/thread-fork/app",
        shellEnvironment: {
          PATH: "/Users/fixture-user/.nvm/versions/node/v24.14.1/bin:/usr/bin",
        },
      },
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-parent"],
      threads: [parentThread],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      forkThread,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-parent");
    });

    await act(async () => {
      await result.current.forkThread(parentThread, "new-worktree");
    });

    expect(forkThread).toHaveBeenCalledWith({
      backend: "codex",
      federationTarget: undefined,
      sourceThreadId: "thread-parent",
      parentThreadId: "thread-parent",
      parentThreadBackend: "codex",
      executionMode: "default",
      directoryKind: "directory",
      directoryLabel: "app",
      directoryPath: "/repo/app/.worktrees/parent/app",
      branchName: "feature/parent",
      workMode: "worktree",
      model: "gpt-5.5",
      reasoningEffort: undefined,
      serviceTier: "fast",
      fastMode: true,
    });
    expect(result.current.selectedThread).toMatchObject({
      id: "thread-fork",
      parentThreadId: "thread-parent",
      parentThreadBackend: "codex",
      gitBranch: "HEAD",
      observedGitBranch: "HEAD",
      linkedDirectories: [
        {
          kind: "worktree",
          worktreePath: "/repo/app/.worktrees/thread-fork/app",
        },
      ],
      codexEnvironmentRuntime: {
        environmentId: "pwragent",
        environmentName: "PwrAgent",
        cwd: "/repo/app/.worktrees/thread-fork/app",
      },
    });
    expect(result.current.selectedThread?.messagingBindings).toBeUndefined();
    expect(result.current.selectedThread?.prs).toBeUndefined();
    expect(result.current.selectedThread?.reactions).toBeUndefined();
  });

  it("surfaces pending environment setup while forking into a new worktree", async () => {
    const parentThread = {
      id: "thread-parent",
      title: "Parent thread",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      codexEnvironmentRuntime: {
        environmentId: "pwragent",
        environmentName: "PwrAgent",
        executionTarget: "local" as const,
        cwd: "/repo/app",
        setupCommand: "pnpm install",
      },
      linkedDirectories: [
        {
          id: "/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local" as const,
        },
      ],
      inbox: {
        inInbox: true,
        reason: "new-thread" as const,
      },
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const forkDeferred = createDeferred<{
      backend: "codex";
      sourceThreadId: string;
      threadId: string;
      executionMode: "default";
      workMode: "worktree";
    }>();
    const forkThread = vi.fn(() => forkDeferred.promise);
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-parent"],
      threads: [parentThread],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      forkThread,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-parent");
    });

    let forkPromise: Promise<void> | undefined;
    await act(async () => {
      forkPromise = result.current.forkThread(parentThread, "new-worktree");
    });

    expect(result.current.creatingThread?.pendingForkEnvironmentSetup).toMatchObject({
      backend: "codex",
      command: "pnpm install",
      directoryKey: "fork:codex:thread-parent:new-worktree",
      directoryLabel: "app",
      environmentId: "pwragent",
      environmentName: "PwrAgent",
    });
    expect(forkThread).toHaveBeenCalledWith(
      expect.objectContaining({
        codexEnvironmentSetupProgressKey: "fork:codex:thread-parent:new-worktree",
        workMode: "worktree",
      }),
    );

    await act(async () => {
      forkDeferred.resolve({
        backend: "codex",
        sourceThreadId: "thread-parent",
        threadId: "thread-fork",
        executionMode: "default",
        workMode: "worktree",
      });
      await forkPromise;
    });

    expect(result.current.creatingThread).toBeUndefined();
  });

  it("forks detached worktree parents from the parent worktree path", async () => {
    const parentThread = {
      id: "thread-parent",
      title: "Detached parent",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      observedGitBranch: "HEAD",
      linkedDirectories: [
        {
          id: "/repo/app/.worktrees/parent/app",
          label: "app",
          path: "/repo/app",
          worktreePath: "/repo/app/.worktrees/parent/app",
          kind: "worktree" as const,
        },
      ],
      inbox: {
        inInbox: true,
        reason: "new-thread" as const,
      },
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const forkThread = vi.fn(async () => ({
      backend: "codex" as const,
      sourceThreadId: "thread-parent",
      threadId: "thread-fork",
      executionMode: "default" as const,
      workMode: "worktree" as const,
      linkedDirectory: {
        id: "/repo/app/.worktrees/thread-fork/app",
        label: "app",
        path: "/repo/app",
        worktreePath: "/repo/app/.worktrees/thread-fork/app",
        kind: "worktree" as const,
      },
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-parent"],
      threads: [parentThread],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      forkThread,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-parent");
    });

    await act(async () => {
      await result.current.forkThread(parentThread, "new-worktree");
    });

    expect(forkThread).toHaveBeenCalledWith(
      expect.not.objectContaining({
        branchName: expect.any(String),
      }),
    );
    expect(forkThread).toHaveBeenCalledWith(
      expect.objectContaining({
        directoryPath: "/repo/app/.worktrees/parent/app",
        workMode: "worktree",
      }),
    );
  });

  it("opens local sub-thread launchpads against the parent's local checkout", async () => {
    const parentThread = {
      id: "thread-parent",
      title: "Local parent",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [
        {
          id: "/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local" as const,
        },
      ],
      inbox: {
        inInbox: true,
        reason: "new-thread" as const,
      },
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey: "subthread:codex:thread-parent:local",
        directoryKind: "directory" as const,
        directoryLabel: "app",
        directoryPath: "/repo/app",
        workMode: "local" as const,
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        createdAt: 1,
        updatedAt: 1,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const updateDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey: "subthread:codex:thread-parent:local",
        directoryKind: "directory" as const,
        directoryLabel: "app",
        directoryPath: "/repo/app",
        workMode: "local" as const,
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-parent"],
      threads: [parentThread],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
      updateDirectoryLaunchpad,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-parent");
    });

    await act(async () => {
      await result.current.createSubthread(parentThread, "local");
    });

    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "subthread:codex:thread-parent:local",
      directoryKind: "directory",
      directoryLabel: "app",
      directoryPath: "/repo/app",
      gitStatusSourcePath: "/repo/app",
      parentThreadId: "thread-parent",
      parentThreadBackend: "codex",
      parentThreadTitle: "Local parent",
      preferredBackend: "codex",
    });
    expect(updateDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "subthread:codex:thread-parent:local",
      patch: {
        backend: "codex",
        executionMode: "default",
        workMode: "local",
        directoryLabel: "app",
        directoryPath: "/repo/app",
        parentThreadId: "thread-parent",
        parentThreadBackend: "codex",
        parentThreadTitle: "Local parent",
      },
    });
    expect(result.current.selectedLaunchpad?.directoryKey).toBe(
      "subthread:codex:thread-parent:local",
    );
    expect(result.current.selectedLaunchpad).toMatchObject({
      parentThreadId: "thread-parent",
      parentThreadBackend: "codex",
      parentThreadTitle: "Local parent",
    });
  });

  it("deletes the persisted overlay row when a sub-thread launchpad is cancelled", async () => {
    const parentThread = {
      id: "thread-parent",
      title: "Local parent",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [
        {
          id: "/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local" as const,
        },
      ],
      inbox: {
        inInbox: true,
        reason: "new-thread" as const,
      },
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const launchpad = {
      directoryKey: "subthread:codex:thread-parent:local",
      directoryKind: "directory" as const,
      directoryLabel: "app",
      directoryPath: "/repo/app",
      workMode: "local" as const,
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      createdAt: 1,
      updatedAt: 1,
    };
    const defaults = {
      backend: "codex" as const,
      executionMode: "default" as const,
    };
    const ensureDirectoryLaunchpad = vi.fn(async () => ({ launchpad, defaults }));
    const updateDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: { ...launchpad, updatedAt: 2 },
      defaults,
    }));
    const resetDirectoryLaunchpad = vi.fn(async () => ({
      directoryKey: "subthread:codex:thread-parent:local",
      defaults,
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-parent"],
      threads: [parentThread],
      directories: [],
      launchpadDefaults: defaults,
    }));
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      updateDirectoryLaunchpad,
      resetDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-parent");
    });

    await act(async () => {
      await result.current.createSubthread(parentThread, "local");
    });
    expect(result.current.selectedLaunchpad?.directoryKey).toBe(
      "subthread:codex:thread-parent:local",
    );

    let restoredSourceThread = false;
    await act(async () => {
      restoredSourceThread = result.current.discardLaunchpad(
        "subthread:codex:thread-parent:local",
      );
    });

    // A sub-thread launchpad has no registeredAt, so cancel drops the whole
    // overlay row instead of leaving a phantom directory behind.
    expect(resetDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "subthread:codex:thread-parent:local",
    });
    expect(restoredSourceThread).toBe(true);
    expect(result.current.selectedLaunchpad).toBeUndefined();
  });

  it("returns to the source thread when a sub-thread launchpad is cancelled after a refresh", async () => {
    const parentThread = {
      id: "thread-parent",
      title: "Local parent",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [
        {
          id: "/repo/app",
          label: "app",
          path: "/repo/app",
          kind: "local" as const,
        },
      ],
      inbox: {
        inInbox: true,
        reason: "new-thread" as const,
      },
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const launchpad = {
      directoryKey: "subthread:codex:thread-parent:local",
      directoryKind: "directory" as const,
      directoryLabel: "app",
      directoryPath: "/repo/app",
      workMode: "local" as const,
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      createdAt: 1,
      updatedAt: 1,
    };
    const defaults = {
      backend: "codex" as const,
      executionMode: "default" as const,
    };
    const ensureDirectoryLaunchpad = vi.fn(async () => ({ launchpad, defaults }));
    const updateDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: { ...launchpad, updatedAt: 2 },
      defaults,
    }));
    const resetDirectoryLaunchpad = vi.fn(async () => ({
      directoryKey: "subthread:codex:thread-parent:local",
      defaults,
    }));
    // The main-process snapshot deliberately omits sub-thread launchpads, so a
    // refresh while the composer is open wipes the row from state.response —
    // it survives only in localLaunchpads.
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-parent"],
      threads: [parentThread],
      directories: [],
      launchpadDefaults: defaults,
    }));
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      updateDirectoryLaunchpad,
      resetDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-parent");
    });

    await act(async () => {
      await result.current.createSubthread(parentThread, "local");
    });

    // Authoritative refresh lands while the sub-thread composer is still open.
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.selectedLaunchpad?.directoryKey).toBe(
      "subthread:codex:thread-parent:local",
    );

    let restoredSourceThread = false;
    await act(async () => {
      restoredSourceThread = result.current.discardLaunchpad(
        "subthread:codex:thread-parent:local",
      );
    });

    // Cancel must still resolve the launchpad (from localLaunchpads via the
    // merged memo) so it deletes the overlay row AND returns the user to the
    // card they composed from, rather than clearing selection entirely.
    expect(resetDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "subthread:codex:thread-parent:local",
    });
    expect(restoredSourceThread).toBe(true);
    expect(result.current.selectedItemKey).toBe("codex:thread-parent");
  });

  it("keeps a registered directory but clears its message when its launchpad is cancelled", async () => {
    const registeredLaunchpad = {
      directoryKey: "directory:/repo/app",
      directoryKind: "directory" as const,
      directoryLabel: "app",
      directoryPath: "/repo/app",
      workMode: "local" as const,
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "leftover draft",
      registeredAt: 1_500,
      settingsTouchedAt: 1_600,
      createdAt: 1,
      updatedAt: 2,
    };
    const defaults = {
      backend: "codex" as const,
      executionMode: "default" as const,
    };
    const updateDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: { ...registeredLaunchpad, prompt: "", updatedAt: 3 },
      defaults,
    }));
    const resetDirectoryLaunchpad = vi.fn(async () => ({
      directoryKey: "directory:/repo/app",
      defaults,
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: "directory:/repo/app",
          kind: "directory" as const,
          label: "app",
          path: "/repo/app",
          threadKeys: [],
          needsAttentionCount: 0,
          latestUpdatedAt: 2,
          launchpad: registeredLaunchpad,
        },
      ],
      launchpadDefaults: defaults,
    }));
    const desktopApi: DesktopApi = {
      updateDirectoryLaunchpad,
      resetDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(
        result.current.directories.some(
          (directory) => directory.key === "directory:/repo/app",
        ),
      ).toBe(true);
    });

    let restoredSourceThread = true;
    await act(async () => {
      restoredSourceThread = result.current.discardLaunchpad(
        "directory:/repo/app",
      );
    });

    // Registered directory: keep the row, wipe only the composed message.
    expect(updateDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "directory:/repo/app",
      patch: { prompt: "", imageAttachments: [], editorDocument: undefined },
    });
    expect(resetDirectoryLaunchpad).not.toHaveBeenCalled();
    expect(restoredSourceThread).toBe(false);
    expect(
      result.current.directories.some(
        (directory) => directory.key === "directory:/repo/app",
      ),
    ).toBe(true);
  });

  it("publishes a masthead add-directory rejection to the notice stack", async () => {
    // "Add project directory" lives in the sidebar / title-bar menu, and
    // `pickDirectoryError`'s only inline surface is the launchpad composer's
    // project picker — not mounted behind that menu. Picking a folder that is
    // not a git repository would otherwise fail silently.
    const pickDirectoryFromDisk = vi.fn(async () => ({
      canceled: false as const,
      path: "/Users/test/not-a-repo",
    }));
    const registerDirectoryFromDisk = vi.fn(async () => ({
      ok: false as const,
      reason: "not-a-git-repo" as const,
      message: "/Users/test/not-a-repo is not a git repository.",
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      pickDirectoryFromDisk,
      registerDirectoryFromDisk,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const onThreadActionError = vi.fn();
    const { result } = renderHook(() =>
      useThreadNavigation(desktopApi, { onThreadActionError }),
    );

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    await act(async () => {
      await result.current.addProjectDirectory();
    });

    expect(latestThreadActionError(onThreadActionError, "add-directory")).toBe(
      "/Users/test/not-a-repo is not a git repository.",
    );

    // A later cancel clears the slot, so the notice comes down on its own.
    pickDirectoryFromDisk.mockResolvedValueOnce({
      canceled: true,
    } as unknown as Awaited<ReturnType<typeof pickDirectoryFromDisk>>);
    await act(async () => {
      await result.current.addProjectDirectory();
    });

    expect(
      latestThreadActionError(onThreadActionError, "add-directory"),
    ).toBeUndefined();
  });

  it("publishes a launchpad discard failure to the notice stack", async () => {
    // `discardLaunchpad` drops the selection before it persists the discard,
    // so the launchpad composer that renders `launchpadError` is already
    // unmounted when the persistence call rejects. Routing it there would
    // show the operator nothing while the cancelled draft rehydrates on the
    // next open.
    const registeredLaunchpad = {
      directoryKey: "directory:/repo/app",
      directoryKind: "directory" as const,
      directoryLabel: "app",
      directoryPath: "/repo/app",
      workMode: "local" as const,
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "leftover draft",
      registeredAt: 1_500,
      settingsTouchedAt: 1_600,
      createdAt: 1,
      updatedAt: 2,
    };
    const defaults = {
      backend: "codex" as const,
      executionMode: "default" as const,
    };
    const updateDirectoryLaunchpad = vi.fn(async () => {
      throw new Error("Launchpad overlay is read-only");
    });
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: "directory:/repo/app",
          kind: "directory" as const,
          label: "app",
          path: "/repo/app",
          threadKeys: [],
          needsAttentionCount: 0,
          latestUpdatedAt: 2,
          launchpad: registeredLaunchpad,
        },
      ],
      launchpadDefaults: defaults,
    }));
    const desktopApi: DesktopApi = {
      updateDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const onThreadActionError = vi.fn();
    const { result } = renderHook(() =>
      useThreadNavigation(desktopApi, { onThreadActionError }),
    );

    await waitFor(() => {
      expect(
        result.current.directories.some(
          (directory) => directory.key === "directory:/repo/app",
        ),
      ).toBe(true);
    });

    await act(async () => {
      result.current.discardLaunchpad("directory:/repo/app");
    });

    await waitFor(() => {
      expect(
        latestThreadActionError(onThreadActionError, "discard-launchpad"),
      ).toBe("Launchpad overlay is read-only");
    });
    // The launchpad's own inline surface stays empty — one surface per error.
    expect(result.current.launchpadError).toBeUndefined();
  });

  it("removes an empty registered directory and deletes its overlay row", async () => {
    const registeredLaunchpad = {
      directoryKey: "directory:/repo/app",
      directoryKind: "directory" as const,
      directoryLabel: "app",
      directoryPath: "/repo/app",
      workMode: "local" as const,
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      registeredAt: 1_500,
      createdAt: 1,
      updatedAt: 2,
    };
    const defaults = {
      backend: "codex" as const,
      executionMode: "default" as const,
    };
    const resetDirectoryLaunchpad = vi.fn(async () => ({
      directoryKey: "directory:/repo/app",
      defaults,
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [
        {
          key: "directory:/repo/app",
          kind: "directory" as const,
          label: "app",
          path: "/repo/app",
          threadKeys: [],
          needsAttentionCount: 0,
          latestUpdatedAt: 2,
          launchpad: registeredLaunchpad,
        },
      ],
      launchpadDefaults: defaults,
    }));
    const desktopApi: DesktopApi = {
      resetDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(
        result.current.directories.some(
          (directory) => directory.key === "directory:/repo/app",
        ),
      ).toBe(true);
    });

    await act(async () => {
      await result.current.removeDirectory("directory:/repo/app");
    });

    // The empty row is pruned immediately and its overlay row is deleted so it
    // can't reappear on the next snapshot.
    expect(resetDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "directory:/repo/app",
    });
    expect(
      result.current.directories.some(
        (directory) => directory.key === "directory:/repo/app",
      ),
    ).toBe(false);
  });

  it("refuses to remove a directory that still has threads", async () => {
    const thread = {
      id: "thread-1",
      title: "Live work",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [
        { id: "/repo/app", label: "app", path: "/repo/app", kind: "local" as const },
      ],
      inbox: { inInbox: false },
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const defaults = {
      backend: "codex" as const,
      executionMode: "default" as const,
    };
    const resetDirectoryLaunchpad = vi.fn(async () => ({
      directoryKey: "directory:/repo/app",
      defaults,
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [thread],
      directories: [
        {
          key: "directory:/repo/app",
          kind: "directory" as const,
          label: "app",
          path: "/repo/app",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          latestUpdatedAt: 2,
        },
      ],
      launchpadDefaults: defaults,
    }));
    const desktopApi: DesktopApi = {
      resetDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(
        result.current.directories.some(
          (directory) => directory.key === "directory:/repo/app",
        ),
      ).toBe(true);
    });

    await act(async () => {
      await result.current.removeDirectory("directory:/repo/app");
    });

    // Deleting the overlay row would strip the directory's registration and
    // sticky settings while its threads kept the row on screen.
    expect(resetDirectoryLaunchpad).not.toHaveBeenCalled();
    expect(
      result.current.directories.some(
        (directory) => directory.key === "directory:/repo/app",
      ),
    ).toBe(true);
  });

  it("opens new-worktree sub-thread launchpads with stable worktree mode", async () => {
    const parentThread = {
      id: "thread-parent",
      title: "Worktree parent",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [
        {
          id: "/repo/app",
          label: "app",
          path: "/repo/app",
          worktreePath: "/repo/app/.worktrees/parent/app",
          kind: "worktree" as const,
        },
      ],
      gitBranch: "feature/parent",
      inbox: {
        inInbox: true,
        reason: "new-thread" as const,
      },
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey: "subthread:codex:thread-parent:new-worktree",
        directoryKind: "directory" as const,
        directoryLabel: "app",
        directoryPath: "/repo/app",
        workMode: "local" as const,
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        branchName: "main",
        createdAt: 1,
        updatedAt: 1,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const updateDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey: "subthread:codex:thread-parent:new-worktree",
        directoryKind: "directory" as const,
        directoryLabel: "app",
        directoryPath: "/repo/app",
        workMode: "worktree" as const,
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        branchName: "main",
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-parent"],
      threads: [parentThread],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
      updateDirectoryLaunchpad,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-parent");
    });

    await act(async () => {
      await result.current.createSubthread(parentThread, "new-worktree");
    });

    expect(updateDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "subthread:codex:thread-parent:new-worktree",
      patch: expect.objectContaining({
        workMode: "worktree",
        directoryPath: "/repo/app",
        branchName: "feature/parent",
        parentThreadId: "thread-parent",
      }),
    });
    expect(result.current.selectedLaunchpad).toMatchObject({
      directoryKey: "subthread:codex:thread-parent:new-worktree",
      workMode: "worktree",
      parentThreadId: "thread-parent",
      parentThreadTitle: "Worktree parent",
    });
  });

  it("inherits repo git status for new-worktree sub-thread branch pickers", async () => {
    const repoPath = "/repo/app";
    const parentWorktreePath = "/repo/app/.worktrees/parent/app";
    const parentThread = {
      id: "thread-parent",
      title: "Worktree parent",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [
        {
          id: parentWorktreePath,
          label: "app",
          path: repoPath,
          worktreePath: parentWorktreePath,
          kind: "worktree" as const,
        },
      ],
      gitBranch: "feature/parent",
      observedGitBranch: "feature/parent",
      inbox: {
        inInbox: true,
        reason: "new-thread" as const,
      },
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey: "subthread:codex:thread-parent:new-worktree",
        directoryKind: "directory" as const,
        directoryLabel: "app",
        directoryPath: parentWorktreePath,
        workMode: "local" as const,
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        createdAt: 1,
        updatedAt: 1,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const updateDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey: "subthread:codex:thread-parent:new-worktree",
        directoryKind: "directory" as const,
        directoryLabel: "app",
        directoryPath: parentWorktreePath,
        workMode: "worktree" as const,
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        branchName: "feature/parent",
        parentThreadId: "thread-parent",
        parentThreadTitle: "Worktree parent",
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const gitStatus = {
      currentBranch: "feature/parent",
      defaultBranch: "develop",
      branches: ["feature/parent", "develop", "release"],
      baseBranches: [
        "feature/parent",
        "develop",
        "origin/develop",
        "release",
      ],
      syncState: "untracked" as const,
    };
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-parent"],
      threads: [parentThread],
      directories: [
        {
          key: `directory:${repoPath}`,
          kind: "directory" as const,
          label: "app",
          path: repoPath,
          threadKeys: ["codex:thread-parent"],
          needsAttentionCount: 0,
          gitStatus,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
      updateDirectoryLaunchpad,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-parent");
    });

    await act(async () => {
      await result.current.createSubthread(parentThread, "new-worktree");
    });

    expect(result.current.selectedDirectory?.key).toBe(
      "subthread:codex:thread-parent:new-worktree",
    );
    expect(result.current.selectedDirectory?.gitStatus).toMatchObject({
      currentBranch: "feature/parent",
      defaultBranch: "develop",
      baseBranches: expect.arrayContaining(["develop", "origin/develop"]),
    });
    expect(result.current.selectedDirectory?.threadKeys).toEqual([]);
  });

  it("uses the live repository to materialize a new-worktree sub-thread from a missing parent worktree", async () => {
    const repoPath = "/repo/app";
    const parentWorktreePath = "/repo/app/.worktrees/missing-parent/app";
    const directoryKey = "subthread:codex:thread-parent:new-worktree";
    const parentThread = {
      id: "thread-parent",
      title: "Worktree parent",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [
        {
          id: parentWorktreePath,
          label: "app",
          path: repoPath,
          worktreePath: parentWorktreePath,
          kind: "worktree" as const,
        },
      ],
      gitBranch: "deleted-remote-branch",
      observedGitBranch: "deleted-remote-branch",
      inbox: {
        inInbox: true,
        reason: "new-thread" as const,
      },
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const gitStatus = {
      currentBranch: "main",
      defaultBranch: "main",
      branches: ["main", "release"],
      baseBranches: ["main", "origin/main", "release", "origin/release"],
      syncState: "in-sync" as const,
    };
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey,
        directoryKind: "directory" as const,
        directoryLabel: "app",
        directoryPath: parentWorktreePath,
        workMode: "local" as const,
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        createdAt: 1,
        updatedAt: 1,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
      gitStatus,
    }));
    const updateDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey,
        directoryKind: "directory" as const,
        directoryLabel: "app",
        directoryPath: repoPath,
        workMode: "worktree" as const,
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        branchName: "deleted-remote-branch",
        parentThreadId: "thread-parent",
        parentThreadTitle: "Worktree parent",
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot: async () => ({
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: false,
        inboxThreadKeys: ["codex:thread-parent"],
        threads: [parentThread],
        directories: [
          {
            key: `directory:${repoPath}`,
            kind: "directory" as const,
            label: "app",
            path: repoPath,
            threadKeys: ["codex:thread-parent"],
            needsAttentionCount: 0,
          },
        ],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      }),
      onAgentEvent: () => () => undefined,
      updateDirectoryLaunchpad,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));
    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-parent");
    });

    await act(async () => {
      await result.current.createSubthread(parentThread, "new-worktree");
    });

    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({
        directoryKey,
        directoryPath: repoPath,
        gitStatusSourcePath: repoPath,
      }),
    );
    expect(updateDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey,
      patch: expect.objectContaining({
        directoryPath: repoPath,
        workMode: "worktree",
      }),
    });
    expect(result.current.selectedLaunchpad?.directoryPath).toBe(repoPath);
    expect(result.current.selectedDirectory?.gitStatus).toEqual(gitStatus);
  });

  it("keeps launchpad git status streamed before the sub-thread directory exists", async () => {
    const repoPath = "/repo/app";
    const parentWorktreePath = "/repo/app/.worktrees/parent/app";
    const directoryKey = "subthread:codex:thread-parent:new-worktree";
    type AgentEvent = Parameters<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >[0];
    const listeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const parentThread = {
      id: "thread-parent",
      title: "Worktree parent",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [
        {
          id: parentWorktreePath,
          label: "app",
          path: repoPath,
          worktreePath: parentWorktreePath,
          kind: "worktree" as const,
        },
      ],
      gitBranch: "feature/parent",
      observedGitBranch: "feature/parent",
      inbox: {
        inInbox: true,
        reason: "new-thread" as const,
      },
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const gitStatus = {
      currentBranch: "feature/parent",
      defaultBranch: "develop",
      baseBranches: [
        "feature/parent",
        "develop",
        "origin/develop",
        "release",
      ],
      syncState: "untracked" as const,
    };
    const ensureDirectoryLaunchpad = vi.fn(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "navigation/directoryGitStatus/updated",
            params: {
              directoryKey,
              gitStatus,
              fetchedAt: Date.now(),
            },
          },
        } as unknown as AgentEvent);
      }
      return {
        launchpad: {
          directoryKey,
          directoryKind: "directory" as const,
          directoryLabel: "app",
          directoryPath: parentWorktreePath,
          workMode: "local" as const,
          backend: "codex" as const,
          executionMode: "default" as const,
          prompt: "",
          createdAt: 1,
          updatedAt: 1,
        },
        defaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      };
    });
    const updateDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey,
        directoryKind: "directory" as const,
        directoryLabel: "app",
        directoryPath: parentWorktreePath,
        workMode: "worktree" as const,
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        branchName: "feature/parent",
        parentThreadId: "thread-parent",
        parentThreadTitle: "Worktree parent",
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-parent"],
      threads: [parentThread],
      directories: [
        {
          key: `directory:${repoPath}`,
          kind: "directory" as const,
          label: "app",
          path: repoPath,
          threadKeys: ["codex:thread-parent"],
          needsAttentionCount: 0,
        },
      ],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
      updateDirectoryLaunchpad,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-parent");
    });

    await act(async () => {
      await result.current.createSubthread(parentThread, "new-worktree");
    });

    expect(result.current.selectedDirectory?.key).toBe(directoryKey);
    expect(result.current.selectedDirectory?.gitStatus).toMatchObject({
      currentBranch: "feature/parent",
      defaultBranch: "develop",
      baseBranches: expect.arrayContaining(["develop", "origin/develop"]),
    });
  });

  it("opens same-worktree sub-thread launchpads on the parent worktree branch", async () => {
    const parentThread = {
      id: "thread-parent",
      title: "Worktree parent",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [
        {
          id: "/repo/app",
          label: "app",
          path: "/repo/app",
          worktreePath: "/repo/app/.worktrees/parent/app",
          kind: "worktree" as const,
        },
      ],
      gitBranch: "feature/parent",
      observedGitBranch: "feature/parent",
      inbox: {
        inInbox: true,
        reason: "new-thread" as const,
      },
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey: "subthread:codex:thread-parent:same-worktree",
        directoryKind: "directory" as const,
        directoryLabel: "app",
        directoryPath: "/repo/app/.worktrees/parent/app",
        workMode: "local" as const,
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        createdAt: 1,
        updatedAt: 1,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const updateDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey: "subthread:codex:thread-parent:same-worktree",
        directoryKind: "directory" as const,
        directoryLabel: "app",
        directoryPath: "/repo/app/.worktrees/parent/app",
        workMode: "local" as const,
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        branchName: "feature/parent",
        parentThreadId: "thread-parent",
        parentThreadTitle: "Worktree parent",
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-parent"],
      threads: [parentThread],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      ensureDirectoryLaunchpad,
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
      updateDirectoryLaunchpad,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-parent");
    });

    await act(async () => {
      await result.current.createSubthread(parentThread, "same-worktree");
    });

    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith({
      federationTarget: undefined,
      directoryKey: "subthread:codex:thread-parent:same-worktree",
      directoryKind: "directory",
      directoryLabel: "app",
      directoryPath: "/repo/app/.worktrees/parent/app",
      gitStatusSourcePath: "/repo/app",
      currentBranch: "feature/parent",
      parentThreadId: "thread-parent",
      parentThreadBackend: "codex",
      parentThreadTitle: "Worktree parent",
      preferredBackend: "codex",
    });
    expect(updateDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "subthread:codex:thread-parent:same-worktree",
      patch: expect.objectContaining({
        workMode: "local",
        directoryPath: "/repo/app/.worktrees/parent/app",
        branchName: "feature/parent",
        parentThreadId: "thread-parent",
        parentThreadBackend: "codex",
      }),
    });
    expect(result.current.selectedLaunchpad).toMatchObject({
      directoryKey: "subthread:codex:thread-parent:same-worktree",
      workMode: "local",
      branchName: "feature/parent",
      parentThreadId: "thread-parent",
      parentThreadBackend: "codex",
      parentThreadTitle: "Worktree parent",
    });
  });

  it("refreshes the selected thread when only the observed branch changes", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    let navigationCallCount = 0;
    const getNavigationSnapshot = vi.fn(async () => {
      navigationCallCount += 1;
      return {
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: false,
        inboxThreadKeys: [],
        threads: [
          {
            id: "thread-1",
            title: "Detached branch naming",
            titleSource: "explicit" as const,
            summary: "Test branch chip refresh",
            source: "codex" as const,
            gitBranch: navigationCallCount === 1 ? undefined : "fix/branch-pill",
            observedGitBranch:
              navigationCallCount === 1 ? undefined : "fix/branch-pill",
            linkedDirectories: [],
            inbox: {
              inInbox: false,
            },
            updatedAt: 1_000,
          },
        ],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      };
    });

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });
    expect(result.current.selectedThread?.gitBranch).toBeUndefined();

    await act(async () => {
      for (const listener of listeners) {
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
      expect(result.current.selectedThread?.gitBranch).toBe("fix/branch-pill");
      expect(result.current.selectedThread?.observedGitBranch).toBe(
        "fix/branch-pill"
      );
    });
  });

  it("refreshes the selected thread when only reactions change", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    let navigationCallCount = 0;
    const getNavigationSnapshot = vi.fn(async () => {
      navigationCallCount += 1;
      return {
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: false,
        inboxThreadKeys: [],
        threads: [
          {
            id: "019e0755-ac96-7be2-a94d-78a6912eccb6",
            title: "Emoji sync regression",
            titleSource: "explicit" as const,
            summary: "The thread whose reactions were disappearing.",
            source: "codex" as const,
            linkedDirectories: [],
            inbox: {
              inInbox: false,
            },
            reactions: navigationCallCount === 1 ? [] : ["👀", "🚀"],
            updatedAt: 1_000,
          },
        ],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      };
    });

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe(
        "019e0755-ac96-7be2-a94d-78a6912eccb6"
      );
    });
    expect(result.current.selectedThread?.reactions).toEqual([]);

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "019e0755-ac96-7be2-a94d-78a6912eccb6",
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
      expect(result.current.selectedThread?.reactions).toEqual(["👀", "🚀"]);
    });
  });

  it("refreshes the selected thread when review sub-agents change", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    let navigationCallCount = 0;
    const getNavigationSnapshot = vi.fn(async () => {
      navigationCallCount += 1;
      return {
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: false,
        inboxThreadKeys: [],
        threads: [
          {
            id: "thread-review",
            title: "Review thread",
            titleSource: "explicit" as const,
            summary: "A thread that started a review.",
            source: "codex" as const,
            linkedDirectories: [],
            inbox: {
              inInbox: false,
            },
            subAgents:
              navigationCallCount === 1
                ? []
                : [
                    {
                      monitorId: "review:turn-review-1",
                      task: "Review changes against main",
                      status: "running" as const,
                      createdAt: 1_000,
                      updatedAt: 1_000,
                      monitorThreadId: "thread-review",
                      monitorTurnId: "turn-review-1",
                    },
                  ],
            updatedAt: 1_000,
          },
        ],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      };
    });

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-review");
    });
    expect(result.current.selectedThread?.subAgents).toEqual([]);

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/subAgents/updated",
            params: {
              threadId: "thread-review",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.subAgents).toEqual([
        expect.objectContaining({
          monitorId: "review:turn-review-1",
          task: "Review changes against main",
          status: "running",
        }),
      ]);
    });
  });

  it("applies live Token Miser sub-agents without waiting for navigation refresh", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [
        {
          id: "thread-miser",
          title: "Token Miser thread",
          titleSource: "explicit" as const,
          summary: "A running thread with gated output.",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: false },
          subAgents: [],
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));
    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-miser");
    });

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/subAgents/updated",
            params: {
              threadId: "thread-miser",
              subAgents: [
                {
                  agentName: "Token Miser",
                  createdAt: 2_000,
                  monitorId: "system:token-miser:gate-live",
                  status: "success",
                  task: "Gate Bash output",
                  updatedAt: 2_000,
                },
              ],
            },
          },
        });
      }
    });

    expect(result.current.selectedThread?.subAgents).toEqual([
      expect.objectContaining({
        monitorId: "system:token-miser:gate-live",
      }),
    ]);
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);
  });

  it("restores backend state and surfaces errors when rename fails", async () => {
    const renameThread = vi.fn(async () => {
      throw new Error("rename failed");
    });
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          summary: "First thread summary",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const,
          },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      markThreadSeen: vi.fn(async () => ({
        backend: "codex",
        threadId: "thread-1",
        seenAt: Date.now(),
      })),
      renameThread,
      onAgentEvent: () => () => undefined,
    };

    const onThreadActionError = vi.fn();
    const { result } = renderHook(() =>
      useThreadNavigation(desktopApi, { onThreadActionError }),
    );

    await waitFor(() => {
      expect(result.current.selectedThread?.title).toBe("First thread");
    });

    await act(async () => {
      await result.current.renameThread(result.current.threads[0]!, "Broken rename");
    });

    await waitFor(() => {
      expect(latestThreadActionError(onThreadActionError, "rename-thread")).toBe("rename failed");
      expect(result.current.selectedThread?.title).toBe("First thread");
    });
  });

  it("patches the snapshot for thread/executionMode/updated without refetching", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          executionMode: "default" as const,
          inbox: { inInbox: true, reason: "new-thread" as const },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.executionMode).toBe("default");
    });
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/executionMode/updated",
            params: {
              threadId: "thread-1",
              executionMode: "full-access",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.executionMode).toBe("full-access");
    });
    // Push-driven patch is immediate; an additional snapshot refresh
    // follows so the persisted permissionTransitionLog (which the
    // registry just appended an `applied` entry to) reaches the
    // renderer for transcript rendering.
    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  it("applies pull request update notification payloads before unchanged refreshes", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const initialPr: PrSummary = {
      provider: "github.com",
      number: 123,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "passing",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/123",
    };
    const updatedPr: PrSummary = {
      ...initialPr,
      title: "Preserve PR title updates",
    };
    const getNavigationSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: false,
        inboxThreadKeys: ["codex:thread-1"],
        threads: [
          {
            id: "thread-1",
            title: "First thread",
            titleSource: "explicit" as const,
            source: "codex" as const,
            linkedDirectories: [],
            prs: [initialPr],
            inbox: { inInbox: true, reason: "new-thread" as const },
            updatedAt: 1_000,
          },
        ],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      })
      .mockResolvedValue({
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: true,
        inboxThreadKeys: ["codex:thread-1"],
        threads: [],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      });

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.prs?.[0]?.title).toBeUndefined();
    });

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/pullRequests/updated",
            params: {
              threadId: "thread-1",
              prs: [updatedPr],
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.prs).toEqual([updatedPr]);
    });
  });

  it("fans out pull request status updates to every visible matching PR key", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const initialPr: PrSummary = {
      provider: "github.com",
      number: 255,
      org: "ExampleOrg",
      repo: "ExampleApp",
      state: "passing",
      checkState: "passing",
      lifecycleState: "open",
      reviewState: "draft",
      mergeState: "mergeable",
      url: "https://github.com/ExampleOrg/ExampleApp/pull/255",
    };
    const updatedPr: PrSummary = {
      ...initialPr,
      lifecycleState: "merged",
      reviewState: "ready_for_review",
      mergeState: "unknown",
    };
    const unrelatedPr: PrSummary = {
      ...initialPr,
      number: 256,
      url: "https://github.com/ExampleOrg/ExampleApp/pull/256",
    };
    const getNavigationSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: false,
        inboxThreadKeys: ["codex:thread-1", "grok:thread-2"],
        threads: [
          {
            id: "thread-1",
            title: "First thread",
            titleSource: "explicit" as const,
            source: "codex" as const,
            linkedDirectories: [],
            prs: [initialPr],
            inbox: { inInbox: true, reason: "new-thread" as const },
            updatedAt: 1_000,
          },
          {
            id: "thread-2",
            title: "Second thread",
            titleSource: "explicit" as const,
            source: "acp:grok" as const,
            linkedDirectories: [],
            prs: [{ ...initialPr }],
            inbox: { inInbox: true, reason: "new-thread" as const },
            updatedAt: 2_000,
          },
          {
            id: "thread-3",
            title: "Unrelated thread",
            titleSource: "explicit" as const,
            source: "codex" as const,
            linkedDirectories: [],
            prs: [unrelatedPr],
            inbox: { inInbox: true, reason: "new-thread" as const },
            updatedAt: 3_000,
          },
        ],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      })
      .mockResolvedValue({
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: true,
        inboxThreadKeys: ["codex:thread-1", "grok:thread-2"],
        threads: [],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      });

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads).toHaveLength(3);
    });

    Object.defineProperty(unrelatedPr, "provider", {
      configurable: true,
      get: () => {
        throw new Error("unrelated PR should not be scanned during status fanout");
      },
    });

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "pullRequest/status/updated",
            params: {
              prKey: buildPullRequestStatusKey(updatedPr),
              pr: updatedPr,
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(result.current.threads.find((thread) => thread.id === "thread-1")?.prs)
        .toEqual([updatedPr]);
      expect(result.current.threads.find((thread) => thread.id === "thread-2")?.prs)
        .toEqual([updatedPr]);
      expect(result.current.threads.find((thread) => thread.id === "thread-3")?.prs?.[0])
        .toBe(unrelatedPr);
    });
    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  it("patches the snapshot for thread/executionMode/queued and queueCleared", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    let navigationSnapshot: NavigationSnapshot = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "Queued thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          executionMode: "default" as const,
          inbox: { inInbox: true, reason: "new-thread" as const },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    };
    const getNavigationSnapshot = vi.fn(async () => navigationSnapshot);

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.executionMode).toBe("default");
    });

    navigationSnapshot = {
      ...navigationSnapshot,
      threads: [
        {
          ...navigationSnapshot.threads[0]!,
          queuedExecutionMode: "full-access" as const,
          queuedExecutionModeAt: 5_000,
          permissionTransitionLog: [
            {
              id: "permission-transition-1",
              fromExecutionMode: "default" as const,
              toExecutionMode: "full-access" as const,
              status: "queued" as const,
              occurredAt: 5_000,
              queueId: "queue-1",
            },
          ],
        },
      ],
    };

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/executionMode/queued",
            params: {
              threadId: "thread-1",
              queuedExecutionMode: "full-access",
              queuedAt: 5_000,
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.queuedExecutionMode).toBe(
        "full-access",
      );
      expect(result.current.selectedThread?.queuedExecutionModeAt).toBe(5_000);
      // Applied mode is unchanged while queued.
      expect(result.current.selectedThread?.executionMode).toBe("default");
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.permissionTransitionLog).toEqual([
        {
          id: "permission-transition-1",
          fromExecutionMode: "default",
          toExecutionMode: "full-access",
          status: "queued",
          occurredAt: 5_000,
          queueId: "queue-1",
        },
      ]);
    });

    navigationSnapshot = {
      ...navigationSnapshot,
      threads: [
        {
          ...navigationSnapshot.threads[0]!,
          queuedExecutionMode: undefined,
          queuedExecutionModeAt: undefined,
        },
      ],
    };

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/executionMode/queueCleared",
            params: {
              threadId: "thread-1",
              reason: "cancelled",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.queuedExecutionMode).toBeUndefined();
      expect(
        result.current.selectedThread?.queuedExecutionModeAt,
      ).toBeUndefined();
    });
  });

  it("patches the snapshot for thread/modelSettings/updated without refetching", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          model: "gpt-5",
          reasoningEffort: "low",
          fastMode: false,
          inbox: { inInbox: true, reason: "new-thread" as const },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.model).toBe("gpt-5");
    });
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/modelSettings/updated",
            params: {
              threadId: "thread-1",
              model: "gpt-5.5",
              reasoningEffort: "high",
              fastMode: true,
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.model).toBe("gpt-5.5");
      expect(result.current.selectedThread?.reasoningEffort).toBe("high");
      expect(result.current.selectedThread?.fastMode).toBe(true);
    });

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/modelSettings/updated",
            params: {
              threadId: "thread-1",
              fastMode: false,
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.model).toBe("gpt-5.5");
      expect(result.current.selectedThread?.reasoningEffort).toBe("high");
      expect(result.current.selectedThread?.fastMode).toBe(false);
    });
    // Push-driven patch — no full snapshot re-fetch.
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);
  });

  it("persists and patches the per-thread PR auto-dispatch preference", async () => {
    const listeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [{
        id: "thread-1",
        title: "First thread",
        titleSource: "explicit" as const,
        source: "codex" as const,
        linkedDirectories: [],
        prAutoDispatchEnabled: false,
        inbox: { inInbox: true, reason: "new-thread" as const },
        updatedAt: 1_000,
      }],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const setThreadPrAutoDispatch = vi.fn(
      async (
        request: Parameters<
          NonNullable<DesktopApi["setThreadPrAutoDispatch"]>
        >[0],
      ) => request,
    );
    const cancelThreadPrAutoDispatch = vi.fn(
      async (
        request: Parameters<
          NonNullable<DesktopApi["cancelThreadPrAutoDispatch"]>
        >[0],
      ) => ({ ...request, cancelled: true }),
    );
    const sendThreadPrAutoDispatchNow = vi.fn(
      async (
        request: Parameters<
          NonNullable<DesktopApi["sendThreadPrAutoDispatchNow"]>
        >[0],
      ) => ({ ...request, accepted: true }),
    );
    const desktopApi: DesktopApi = {
      cancelThreadPrAutoDispatch,
      getNavigationSnapshot,
      sendThreadPrAutoDispatchNow,
      setThreadPrAutoDispatch,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.prAutoDispatchEnabled).toBe(false);
    });
    await act(async () => {
      await result.current.setThreadPrAutoDispatch(
        result.current.selectedThread!,
        true,
      );
    });
    expect(setThreadPrAutoDispatch).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      enabled: true,
    });
    expect(result.current.selectedThread?.prAutoDispatchEnabled).toBe(true);

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/prAutoDispatch/updated",
            params: { threadId: "thread-1", enabled: false },
          },
        });
      }
    });
    await waitFor(() => {
      expect(result.current.selectedThread?.prAutoDispatchEnabled).toBe(false);
    });

    const pending = {
      fingerprint: "fingerprint-1",
      prKey: "github.com/pwrdrvr/PwrAgent#1105",
      prNumber: 1105,
      prUrl: "https://github.com/pwrdrvr/PwrAgent/pull/1105",
      headSha: "a".repeat(40),
      eventKinds: ["ci-failure" as const],
      createdAt: 1_000,
      scheduledAt: 31_000,
    };
    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/prAutoDispatch/pendingUpdated",
            params: { threadId: "thread-1", pending },
          },
        });
      }
    });
    expect(result.current.selectedThread?.prAutoDispatchPending).toEqual(pending);
    await act(async () => {
      await result.current.sendThreadPrAutoDispatchNow(
        result.current.selectedThread!,
        pending.fingerprint,
      );
      await result.current.cancelThreadPrAutoDispatch(
        result.current.selectedThread!,
        pending.fingerprint,
      );
    });
    expect(sendThreadPrAutoDispatchNow).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      fingerprint: "fingerprint-1",
    });
    expect(cancelThreadPrAutoDispatch).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      fingerprint: "fingerprint-1",
    });

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/prAutoDispatch/pendingUpdated",
            params: { threadId: "thread-1", pending: null },
          },
        });
      }
    });
    expect(result.current.selectedThread?.prAutoDispatchPending).toBeUndefined();
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);
  });

  it("applies PR auto-dispatch events to the matching mounted remote thread", async () => {
    const firstOwner = {
      scope: "remote" as const,
      instanceId: "first-owner",
    };
    const secondOwner = {
      scope: "remote" as const,
      instanceId: "second-owner",
    };
    const listeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const pending = (fingerprint: string) => ({
      fingerprint,
      prKey: "github.com/pwrdrvr/PwrAgent#1105",
      prNumber: 1105,
      prUrl: "https://github.com/pwrdrvr/PwrAgent/pull/1105",
      headSha: "a".repeat(40),
      eventKinds: ["ci-failure" as const],
      createdAt: 1_000,
      scheduledAt: 31_000,
    });
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [
        {
          id: "shared-thread-id",
          title: "Local thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          prAutoDispatchEnabled: true,
          prAutoDispatchPending: pending("local-pending"),
          inbox: { inInbox: false },
        },
        {
          id: "shared-thread-id",
          title: "First remote thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          prAutoDispatchEnabled: true,
          prAutoDispatchPending: pending("first-owner-pending"),
          inbox: { inInbox: false },
          federation: {
            instanceLabel: "First owner",
            ref: {
              backend: "codex" as const,
              target: firstOwner,
              threadId: "shared-thread-id",
            },
          },
        },
        {
          id: "shared-thread-id",
          title: "Second remote thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          prAutoDispatchEnabled: true,
          prAutoDispatchPending: pending("second-owner-pending"),
          inbox: { inInbox: false },
          federation: {
            instanceLabel: "Second owner",
            ref: {
              backend: "codex" as const,
              target: secondOwner,
              threadId: "shared-thread-id",
            },
          },
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads).toHaveLength(3);
    });

    act(() => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          federationTarget: firstOwner,
          notification: {
            method: "thread/prAutoDispatch/updated",
            params: { threadId: "shared-thread-id", enabled: false },
          },
        });
        listener({
          backend: "codex",
          federationTarget: firstOwner,
          notification: {
            method: "thread/prAutoDispatch/pendingUpdated",
            params: { threadId: "shared-thread-id", pending: null },
          },
        });
      }
    });

    const localThread = result.current.threads.find(
      (thread) => !thread.federation,
    );
    const firstRemoteThread = result.current.threads.find(
      (thread) =>
        thread.federation?.ref.target.scope === "remote"
        && thread.federation.ref.target.instanceId === "first-owner",
    );
    const secondRemoteThread = result.current.threads.find(
      (thread) =>
        thread.federation?.ref.target.scope === "remote"
        && thread.federation.ref.target.instanceId === "second-owner",
    );
    expect(firstRemoteThread?.prAutoDispatchEnabled).toBe(false);
    expect(firstRemoteThread?.prAutoDispatchPending).toBeUndefined();
    expect(localThread?.prAutoDispatchEnabled).toBe(true);
    expect(localThread?.prAutoDispatchPending?.fingerprint).toBe("local-pending");
    expect(secondRemoteThread?.prAutoDispatchEnabled).toBe(true);
    expect(secondRemoteThread?.prAutoDispatchPending?.fingerprint).toBe(
      "second-owner-pending",
    );
  });

  it("reconciles a primary workspace repository resolved after an earlier refresh", async () => {
    const snapshotState: { primaryGitRepository?: string } = {};
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [{
        id: "thread-1",
        title: "First thread",
        titleSource: "explicit" as const,
        source: "codex" as const,
        linkedDirectories: [],
        ...(snapshotState.primaryGitRepository
          ? { primaryGitRepository: snapshotState.primaryGitRepository }
          : {}),
        inbox: { inInbox: true, reason: "new-thread" as const },
        // Remote resolution can change without the app-server thread record.
        updatedAt: 1_000,
      }],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });
    expect(result.current.selectedThread?.primaryGitRepository).toBeUndefined();

    snapshotState.primaryGitRepository = "github.com/pwrdrvr/pwragent";
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.selectedThread?.primaryGitRepository).toBe(
      "github.com/pwrdrvr/pwragent",
    );
  });

  it("preserves the current thread model when patching non-model settings", async () => {
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          fastMode: false,
          inbox: { inInbox: true, reason: "new-thread" as const },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const setThreadModelSettings = vi.fn(
      async (
        request: Parameters<
          NonNullable<DesktopApi["setThreadModelSettings"]>
        >[0],
      ) => request,
    );

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
      setThreadModelSettings,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.model).toBe("gpt-5.6-sol");
    });

    await act(async () => {
      await result.current.setThreadModelSettings(result.current.selectedThread!, {
        reasoningEffort: "ultra",
      });
    });

    expect(setThreadModelSettings).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    });
  });

  it("patches the snapshot for thread/codexEnvironment/updated without refetching", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: true, reason: "new-thread" as const },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });
    expect(result.current.selectedThread?.codexEnvironmentRuntime).toBeUndefined();
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/codexEnvironment/updated",
            params: {
              threadId: "thread-1",
              codexEnvironmentRuntime: {
                environmentId: "environment",
                environmentName: "Fixture Env",
                executionTarget: "local",
                cwd: "/repo/app",
                setupCommand: "pnpm install",
                actions: [
                  {
                    id: "dev",
                    name: "Dev",
                    command: "pnpm dev",
                  },
                ],
              },
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(
        result.current.selectedThread?.codexEnvironmentRuntime?.environmentId,
      ).toBe("environment");
      expect(
        result.current.selectedThread?.codexEnvironmentRuntime?.environmentName,
      ).toBe("Fixture Env");
    });
    // Push-driven patch — no full snapshot re-fetch.
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);
  });

  it("refreshes the snapshot when thread directory metadata is repaired", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    let navigationSnapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-1"],
      threads: [
        {
          id: "thread-1",
          title: "First thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [
            {
              id: "/Users/example/.codex/worktrees/wt1/ProjectA",
              label: "ProjectA",
              path: "/Users/example/.codex/worktrees/wt1/ProjectA",
              kind: "local",
            },
          ],
          inbox: { inInbox: true, reason: "new-thread" },
          updatedAt: 1_000,
        },
      ],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const getNavigationSnapshot = vi.fn(async () => navigationSnapshot);
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);

    navigationSnapshot = {
      ...navigationSnapshot,
      directories: [
        {
          key: "directory:/Users/example/ProjectA",
          kind: "directory",
          label: "ProjectA",
          path: "/Users/example/ProjectA",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
        },
      ],
    };

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "navigation/threadDirectories/updated",
            params: {
              reason: "selected-thread",
              threadIds: ["thread-1"],
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
      expect(result.current.directories[0]?.label).toBe("ProjectA");
    });
  });

  it("removes a revoked messaging binding from the thread row after onMessagingBindingsChanged fires", async () => {
    const bindingsListeners = new Set<(event: { at: number }) => void>();
    let navigationCallCount = 0;
    const getNavigationSnapshot = vi.fn(async () => {
      navigationCallCount += 1;
      const messagingBindings =
        navigationCallCount === 1
          ? [
              {
                bindingId: "binding:telegram:topic:-1003841603622:5642:codex:thread-1",
                platform: "telegram" as const,
                conversationKind: "topic" as const,
                conversationTitle: "Knock Knock Rock",
                parentTitle: "PwrDrvr",
              },
              {
                bindingId: "binding:discord:channel:1480554271907905731:1501244021886943405:codex:thread-1",
                platform: "discord" as const,
                conversationKind: "channel" as const,
                conversationTitle: "knock-knock-rock",
                parentTitle: "PwrDrvr",
              },
            ]
          : [
              {
                bindingId: "binding:discord:channel:1480554271907905731:1501244021886943405:codex:thread-1",
                platform: "discord" as const,
                conversationKind: "channel" as const,
                conversationTitle: "knock-knock-rock",
                parentTitle: "PwrDrvr",
              },
            ];
      return {
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: false,
        inboxThreadKeys: [],
        threads: [
          {
            id: "thread-1",
            title: "Knock Knock Rock",
            titleSource: "explicit" as const,
            summary: "A thread that's bound to two messaging platforms.",
            source: "codex" as const,
            linkedDirectories: [],
            inbox: {
              inInbox: false,
            },
            // The reconciler bug we're regression-testing: this updatedAt
            // does NOT change between fetches, because the messaging
            // store mutates only the binding row, not the thread row.
            // Without `messagingBindings` in `threadSummariesEqual`, the
            // reconciler decides "nothing changed" and reuses the
            // previous thread reference (with stale bindings).
            updatedAt: 1_000,
            messagingBindings,
          },
        ],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      };
    });

    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
      onMessagingBindingsChanged: (callback: (event: { at: number }) => void) => {
        bindingsListeners.add(callback);
        return () => {
          bindingsListeners.delete(callback);
        };
      },
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });
    expect(result.current.selectedThread?.messagingBindings).toHaveLength(2);

    // Simulate the bus event the runtime fans out after a UI-originated
    // unbind: backend revokes the binding, fires onMessagingBindingsChanged,
    // and the renderer refetches. The next snapshot has only one binding.
    await act(async () => {
      for (const listener of bindingsListeners) {
        listener({ at: Date.now() });
      }
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.messagingBindings).toHaveLength(1);
    });
    expect(
      result.current.selectedThread?.messagingBindings?.[0]?.platform,
    ).toBe("discord");
  });

  it("reconciles a Token Miser override when the backend thread timestamp is unchanged", async () => {
    let navigationCallCount = 0;
    const getNavigationSnapshot = vi.fn(async () => {
      navigationCallCount += 1;
      return {
        backend: "all" as const,
        fetchedAt: 1_000 + navigationCallCount,
        unchanged: false,
        inboxThreadKeys: [],
        threads: [
          {
            id: "thread-1",
            title: "Control thread",
            titleSource: "explicit" as const,
            source: "codex" as const,
            linkedDirectories: [],
            inbox: { inInbox: false },
            updatedAt: 1_000,
            ...(navigationCallCount > 1
              ? { tokenMiserEnabled: false }
              : {}),
          },
        ],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      };
    });
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.selectedThread?.id).toBe("thread-1");
    });
    expect(result.current.selectedThread?.tokenMiserEnabled).toBeUndefined();

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.selectedThread?.tokenMiserEnabled).toBe(false);
  });

  it("reconciles queued turns when the backend thread timestamp is unchanged", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    let navigationCallCount = 0;
    const getNavigationSnapshot = vi.fn(async () => {
      navigationCallCount += 1;
      return {
        backend: "all" as const,
        fetchedAt: 1_000 + navigationCallCount,
        unchanged: false,
        inboxThreadKeys: [],
        threads: [
          {
            id: "thread-1",
            title: "Queued thread",
            titleSource: "explicit" as const,
            source: "codex" as const,
            linkedDirectories: [],
            inbox: { inInbox: false },
            updatedAt: 1_000,
            queuedTurns: navigationCallCount === 1
              ? undefined
              : [
                  {
                    queueEntryId: "queue-1",
                    origin: "manual" as const,
                    displayText: "Queued reply",
                    createdAt: 1_000,
                    position: 0,
                  },
                ],
          },
        ],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      };
    });
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => expect(result.current.selectedThread?.id).toBe("thread-1"));
    expect(result.current.selectedThread?.queuedTurns).toBeUndefined();

    await act(async () => {
      for (const listener of listeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/turnQueue/updated",
            params: {
              threadId: "thread-1",
              queueEntryId: "queue-1",
              queueEntryCreatedAt: 1_000,
              origin: "manual",
              status: "queued",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(result.current.selectedThread?.queuedTurns?.[0]?.queueEntryId).toBe(
        "queue-1",
      );
    });
  });

  it("keeps the public refresh callback stable across navigation renders", async () => {
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    const initialRefresh = result.current.refresh;

    act(() => {
      result.current.setBrowseMode("directories");
    });

    expect(result.current.refresh).toBe(initialRefresh);
  });

  it("initializes browse mode from bridged navigation preferences", async () => {
    Object.defineProperty(window, "__pwragentNavigationPreferences", {
      configurable: true,
      value: { browseMode: "recents" },
    });
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    expect(result.current.browseMode).toBe("recents");
  });

  it("persists browse mode changes through the desktop bridge", async () => {
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const setNavigationBrowseMode = vi.fn(async (request) => request);
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
      setNavigationBrowseMode,
    };

    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    act(() => {
      result.current.setBrowseMode("directories");
    });

    expect(result.current.browseMode).toBe("directories");
    expect(setNavigationBrowseMode).toHaveBeenCalledWith({
      browseMode: "directories",
    });
  });

  it("persists and optimistically applies the Directory threads disclosure", async () => {
    const directory = {
      key: "directory:/Users/me/repos/PwrAgent",
      kind: "directory" as const,
      label: "PwrAgent",
      path: "/Users/me/repos/PwrAgent",
      threadKeys: [],
      needsAttentionCount: 0,
    };
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [directory],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const setDirectoryThreadsCollapsed: NonNullable<
      DesktopApi["setDirectoryThreadsCollapsed"]
    > = vi.fn(async (request) => ({
      directoryKey: request.directoryKey,
      collapsed: request.collapsed,
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: () => () => undefined,
      setDirectoryThreadsCollapsed,
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.setDirectoryThreadsCollapsed(directory, true);
    });

    expect(setDirectoryThreadsCollapsed).toHaveBeenCalledWith({
      directoryKey: directory.key,
      collapsed: true,
    });
    expect(result.current.directories[0]?.directoryThreadsCollapsed).toBe(true);
  });

  it("keeps a remote viewer's Directory threads disclosure independent of the owner", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    (window as unknown as {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = federationTarget;
    const directory = {
      key: "directory:/Users/remote/repos/PwrAgent",
      kind: "directory" as const,
      label: "PwrAgent",
      path: "/Users/remote/repos/PwrAgent",
      threadKeys: [],
      needsAttentionCount: 0,
      directoryThreadsCollapsed: false,
    };
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      federationTarget,
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [directory],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const setDirectoryThreadsCollapsed: NonNullable<
      DesktopApi["setDirectoryThreadsCollapsed"]
    > = vi.fn(async (request) => ({
      directoryKey: request.directoryKey,
      collapsed: request.collapsed,
    }));
    const desktopApi: DesktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (handler) => {
        agentEventHandler = handler;
        return () => undefined;
      },
      setDirectoryThreadsCollapsed,
    };
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.setDirectoryThreadsCollapsed(directory, true);
    });

    expect(setDirectoryThreadsCollapsed).toHaveBeenCalledWith({
      directoryKey: directory.key,
      collapsed: true,
      federationTarget,
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        federationTarget,
        notification: {
          method: "directory/threadsCollapsed/updated",
          params: {
            directoryKey: directory.key,
            collapsed: false,
          },
        },
      });
    });
    expect(result.current.directories[0]?.directoryThreadsCollapsed).toBe(true);

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.directories[0]?.directoryThreadsCollapsed).toBe(true);
  });

  it("applies a peer's PR events to its pinned rows without touching local threads", async () => {
    // A pinned remote row is the only place a peer's PR chip is shown,
    // and the main window has no federation target, so these events do
    // not match its window target. They still have to land — scoped to
    // the peer that sent them.
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    const buildPr = (overrides: Record<string, unknown>) => ({
      number: 1270,
      provider: "github" as const,
      org: "pwrdrvr",
      repo: "PwrAgent",
      title: "canonical PR status",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/1270",
      state: "open" as const,
      lifecycleState: "open" as const,
      ...overrides,
    });
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    // Both threads deliberately share an id: only the federation origin
    // distinguishes them.
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
      threads: [
        {
          id: "shared-thread-id",
          title: "Local thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: true },
          prs: [buildPr({ number: 999, url: "https://github.com/pwrdrvr/PwrAgent/pull/999" })],
        },
        {
          id: "shared-thread-id",
          title: "Pinned remote thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: true },
          federation: {
            instanceLabel: "Remote Mac",
            ref: {
              backend: "codex" as const,
              target: federationTarget,
              threadId: "shared-thread-id",
            },
          },
          prs: [buildPr({})],
        },
      ],
    }));
    const desktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (
        callback: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0],
      ) => {
        agentEventHandler = callback;
        return () => {
          agentEventHandler = undefined;
        };
      },
    } as unknown as DesktopApi;

    const { result } = renderHook(() => useThreadNavigation(desktopApi));
    await waitFor(() => {
      expect(result.current.threads).toHaveLength(2);
    });

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        federationTarget,
        notification: {
          method: "pullRequest/status/updated",
          params: {
            prKey: "github/pwrdrvr/pwragent#1270",
            pr: buildPr({ state: "merged", lifecycleState: "merged" }),
          },
        },
      } as never);
    });

    await waitFor(() => {
      expect(result.current.threads[1]?.prs?.[0]?.lifecycleState).toBe("merged");
    });
    // The local thread carries a different PR and is untouched.
    expect(result.current.threads[0]?.prs?.[0]?.number).toBe(999);

    // A peer's attachment-list event must not rewrite the local thread
    // that shares its id.
    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        federationTarget,
        notification: {
          method: "thread/pullRequests/updated",
          params: {
            threadId: "shared-thread-id",
            prs: [buildPr({ number: 4242 })],
          },
        },
      } as never);
    });

    await waitFor(() => {
      expect(result.current.threads[1]?.prs?.[0]?.number).toBe(4242);
    });
    expect(result.current.threads[0]?.prs?.[0]?.number).toBe(999);
  });

  it("applies a peer's reaction event only to its pinned row", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
      threads: [
        {
          id: "shared-thread-id",
          title: "Local thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: true },
          reactions: ["🏠"],
        },
        {
          id: "shared-thread-id",
          title: "Pinned remote thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: true },
          reactions: ["✋"],
          federation: {
            instanceLabel: "Remote Mac",
            ref: {
              backend: "codex" as const,
              target: federationTarget,
              threadId: "shared-thread-id",
            },
          },
        },
      ],
    }));
    const desktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (
        callback: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0],
      ) => {
        agentEventHandler = callback;
        return () => {
          agentEventHandler = undefined;
        };
      },
    } as unknown as DesktopApi;
    const { result } = renderHook(() => useThreadNavigation(desktopApi));
    await waitFor(() => {
      expect(result.current.threads).toHaveLength(2);
    });

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        federationTarget,
        notification: {
          method: "thread/reactions/updated",
          params: {
            threadId: "shared-thread-id",
            reactions: ["✋", "👀"],
          },
        },
      } as never);
    });

    expect(result.current.threads[0]?.reactions).toEqual(["🏠"]);
    expect(result.current.threads[1]?.reactions).toEqual(["✋", "👀"]);
  });

  it("refreshes pinned remote summaries when a peer turn completes", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    let updatedAt = 1_000;
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
      threads: [
        {
          id: "remote-thread",
          title: "Pinned remote thread",
          titleSource: "explicit" as const,
          source: "codex" as const,
          linkedDirectories: [],
          inbox: { inInbox: false },
          updatedAt,
          federation: {
            instanceLabel: "Remote Mac",
            ref: {
              backend: "codex" as const,
              target: federationTarget,
              threadId: "remote-thread",
            },
          },
        },
      ],
    }));
    const desktopApi = {
      getNavigationSnapshot,
      onAgentEvent: (
        callback: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0],
      ) => {
        agentEventHandler = callback;
        return () => {
          agentEventHandler = undefined;
        };
      },
    } as unknown as DesktopApi;
    const { result } = renderHook(() => useThreadNavigation(desktopApi));

    await waitFor(() => {
      expect(result.current.threads[0]?.updatedAt).toBe(1_000);
    });

    updatedAt = 2_000;
    act(() => {
      agentEventHandler?.({
        backend: "codex",
        federationTarget,
        notification: {
          method: "turn/completed",
          params: {
            threadId: "remote-thread",
            turnId: "remote-turn",
            turn: {
              id: "remote-turn",
              status: "completed",
              output: [{ type: "text", text: "Remote final answer." }],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
      expect(result.current.threads[0]?.updatedAt).toBe(2_000);
    });
  });

  it("applies remote relationship events only to mounted rows from that peer", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const localParent: NavigationThreadSummary = {
      id: "shared-parent",
      title: "Local parent",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
      subthreadOrder: ["local-child"],
      subthreadsCollapsed: false,
    };
    const remoteParent: NavigationThreadSummary = {
      ...localParent,
      title: "Remote parent",
      federation: {
        capabilities: ["thread_navigation", "thread_grouping"],
        instanceLabel: "Remote Mac",
        ref: {
          backend: "codex",
          target: federationTarget,
          threadId: localParent.id,
        },
      },
    };
    const localChild: NavigationThreadSummary = {
      ...localParent,
      id: "shared-child",
      title: "Local child",
      subthreadOrder: undefined,
      subthreadsCollapsed: undefined,
    };
    const remoteChild: NavigationThreadSummary = {
      ...localChild,
      title: "Remote child",
      federation: {
        capabilities: ["thread_navigation", "thread_grouping"],
        instanceLabel: "Remote Mac",
        ref: {
          backend: "codex",
          target: federationTarget,
          threadId: localChild.id,
        },
      },
    };
    const desktopApi = {
      getNavigationSnapshot: vi.fn(async () => ({
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: false,
        inboxThreadKeys: [],
        threads: [localParent, remoteParent, localChild, remoteChild],
        directories: [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      })),
      onAgentEvent: (
        callback: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0],
      ) => {
        agentEventHandler = callback;
        return () => {
          agentEventHandler = undefined;
        };
      },
    } as unknown as DesktopApi;
    const { result } = renderHook(() => useThreadNavigation(desktopApi));
    await waitFor(() => expect(result.current.threads).toHaveLength(4));

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        federationTarget,
        notification: {
          method: "thread/subthreadOrder/updated",
          params: {
            parentThreadId: "shared-parent",
            threadIds: ["remote-child"],
          },
        },
      } as never);
      agentEventHandler?.({
        backend: "codex",
        federationTarget,
        notification: {
          method: "thread/subthreadsCollapsed/updated",
          params: {
            parentThreadId: "shared-parent",
            collapsed: true,
          },
        },
      } as never);
      agentEventHandler?.({
        backend: "codex",
        federationTarget,
        notification: {
          method: "thread/parent/set",
          params: {
            threadId: "shared-child",
            parentThreadId: "shared-parent",
            parentThreadBackend: "codex",
          },
        },
      } as never);
    });

    const localRows = result.current.threads.filter((thread) => !thread.federation);
    const remoteRows = result.current.threads.filter((thread) => thread.federation);
    expect(localRows.find((thread) => thread.id === "shared-parent")).toMatchObject({
      subthreadOrder: ["local-child"],
      subthreadsCollapsed: false,
    });
    expect(localRows.find((thread) => thread.id === "shared-child"))
      .not.toHaveProperty("parentThreadId");
    expect(remoteRows.find((thread) => thread.id === "shared-parent")).toMatchObject({
      subthreadOrder: ["remote-child"],
      subthreadsCollapsed: true,
    });
    expect(remoteRows.find((thread) => thread.id === "shared-child"))
      .toMatchObject({
        parentThreadId: "shared-parent",
        parentThreadBackend: "codex",
      });
  });

  describe("pickAndRegisterDirectory (issue #223)", () => {
    const launchpadDefaults = {
      backend: "codex" as const,
      executionMode: "default" as const,
    };

    function buildSnapshot(
      directories: NavigationSnapshot["directories"] = [],
    ): NavigationSnapshot {
      return {
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: false,
        inboxThreadKeys: [],
        threads: [],
        directories,
        launchpadDefaults,
      };
    }

    function buildPickedLaunchpad(
      patch: Partial<NavigationLaunchpadDraft> = {},
    ): NavigationLaunchpadDraft {
      return {
        directoryKey: "directory:/Users/me/repos/PwrAgent",
        directoryKind: "directory" as const,
        directoryLabel: "PwrAgent",
        directoryPath: "/Users/me/repos/PwrAgent",
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        workMode: "local" as const,
        createdAt: 1,
        updatedAt: 1,
        ...patch,
      };
    }

    function buildBaseDesktopApi(
      overrides: Partial<DesktopApi> = {},
    ): DesktopApi {
      return {
        getNavigationSnapshot: vi.fn(async () => buildSnapshot()),
        onAgentEvent: () => () => undefined,
        ...overrides,
      };
    }

    it("keeps newly registered directories sorted by label", async () => {
      const pickDirectoryFromDisk = vi.fn(async () => ({
        canceled: false as const,
        path: "/Users/me/repos/kube-manifests",
      }));
      const registerDirectoryFromDisk = vi.fn(async () => ({
        ok: true as const,
        directoryPath: "/Users/me/repos/kube-manifests",
        directoryKey: "directory:/Users/me/repos/kube-manifests",
        directoryLabel: "kube-manifests",
        currentBranch: "main",
        launchpad: {
          directoryKey: "directory:/Users/me/repos/kube-manifests",
          directoryKind: "directory" as const,
          directoryLabel: "kube-manifests",
          directoryPath: "/Users/me/repos/kube-manifests",
          backend: "codex" as const,
          executionMode: "default" as const,
          prompt: "",
          workMode: "local" as const,
          createdAt: 1,
          updatedAt: 1,
        },
        defaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      }));
      const getNavigationSnapshot = vi.fn(async () => ({
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: false,
        inboxThreadKeys: [],
        threads: [],
        directories: [
          {
            key: "directory:/Users/me/repos/web-app",
            kind: "directory" as const,
            label: "web-app",
            path: "/Users/me/repos/web-app",
            threadKeys: [],
            needsAttentionCount: 0,
          },
          {
            key: "directory:/Users/me/repos/infra",
            kind: "directory" as const,
            label: "infra",
            path: "/Users/me/repos/infra",
            threadKeys: [],
            needsAttentionCount: 0,
          },
        ],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      }));

      const desktopApi = buildBaseDesktopApi({
        getNavigationSnapshot,
        pickDirectoryFromDisk,
        registerDirectoryFromDisk,
      });

      const { result } = renderHook(() => useThreadNavigation(desktopApi));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.pickAndRegisterDirectory();
      });

      expect(result.current.directories.map((directory) => directory.label)).toEqual([
        "infra",
        "kube-manifests",
        "web-app",
      ]);
      expect(result.current.selectedItemKey).toBe(
        "launchpad:directory:/Users/me/repos/kube-manifests",
      );
    });

    it("seeds the launchpad and focuses it on a successful pick", async () => {
      const pickDirectoryFromDisk = vi.fn(async () => ({
        canceled: false as const,
        path: "/Users/me/repos/PwrAgent",
      }));
      const registerDirectoryFromDisk = vi.fn(async () => ({
        ok: true as const,
        directoryPath: "/Users/me/repos/PwrAgent",
        directoryKey: "directory:/Users/me/repos/PwrAgent",
        directoryLabel: "PwrAgent",
        currentBranch: "main",
        launchpad: {
          directoryKey: "directory:/Users/me/repos/PwrAgent",
          directoryKind: "directory" as const,
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/me/repos/PwrAgent",
          backend: "codex" as const,
          executionMode: "default" as const,
          prompt: "",
          workMode: "local" as const,
          createdAt: 1,
          updatedAt: 1,
        },
        defaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      }));

      const desktopApi = buildBaseDesktopApi({
        pickDirectoryFromDisk,
        registerDirectoryFromDisk,
      });

      const { result } = renderHook(() => useThreadNavigation(desktopApi));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.pickAndRegisterDirectory();
      });

      expect(pickDirectoryFromDisk).toHaveBeenCalledOnce();
      expect(registerDirectoryFromDisk).toHaveBeenCalledExactlyOnceWith({
        path: "/Users/me/repos/PwrAgent",
        preferredBackend: undefined,
      });
      expect(result.current.pickDirectoryError).toBeUndefined();
      expect(result.current.pickingDirectory).toBe(false);
      expect(result.current.selectedItemKey).toBe(
        "launchpad:directory:/Users/me/repos/PwrAgent",
      );
    });

    it("force-refreshes git status for a newly picked directory", async () => {
      const launchpad = buildPickedLaunchpad();
      const pickDirectoryFromDisk = vi.fn(async () => ({
        canceled: false as const,
        path: "/Users/me/repos/PwrAgent",
      }));
      const registerDirectoryFromDisk = vi.fn(async () => ({
        ok: true as const,
        directoryPath: "/Users/me/repos/PwrAgent",
        directoryKey: launchpad.directoryKey,
        directoryLabel: "PwrAgent",
        currentBranch: "main",
        launchpad,
        defaults: launchpadDefaults,
      }));
      const getNavigationSnapshot = vi
        .fn()
        .mockResolvedValueOnce(buildSnapshot())
        .mockResolvedValueOnce(
          buildSnapshot([
            {
              key: launchpad.directoryKey,
              kind: "directory" as const,
              label: "PwrAgent",
              path: "/Users/me/repos/PwrAgent",
              threadKeys: [],
              needsAttentionCount: 0,
              launchpad,
            },
          ]),
        );
      const refreshDirectoryGitStatuses = vi.fn(async () => ({
        scheduledCount: 1,
      }));
      const desktopApi = buildBaseDesktopApi({
        getNavigationSnapshot,
        pickDirectoryFromDisk,
        registerDirectoryFromDisk,
        refreshDirectoryGitStatuses,
      });

      const { result } = renderHook(() => useThreadNavigation(desktopApi));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.pickAndRegisterDirectory();
      });

      expect(refreshDirectoryGitStatuses).toHaveBeenCalledExactlyOnceWith({
        directoryKeys: [launchpad.directoryKey],
        force: true,
      });
    });

    it("does not overwrite launchpad edits when the picker refresh is stale", async () => {
      const launchpad = buildPickedLaunchpad();
      const refreshSnapshot = createDeferred<NavigationSnapshot>();
      const pickDirectoryFromDisk = vi.fn(async () => ({
        canceled: false as const,
        path: "/Users/me/repos/PwrAgent",
      }));
      const registerDirectoryFromDisk = vi.fn(async () => ({
        ok: true as const,
        directoryPath: "/Users/me/repos/PwrAgent",
        directoryKey: launchpad.directoryKey,
        directoryLabel: "PwrAgent",
        currentBranch: "main",
        launchpad,
        defaults: launchpadDefaults,
      }));
      const getNavigationSnapshot = vi
        .fn()
        .mockResolvedValueOnce(buildSnapshot())
        .mockReturnValueOnce(refreshSnapshot.promise);
      const updateDirectoryLaunchpad = vi.fn(async () => ({
        launchpad: buildPickedLaunchpad({
          prompt: "Edited before refresh completes",
          updatedAt: 2,
        }),
        defaults: launchpadDefaults,
      }));
      const desktopApi = buildBaseDesktopApi({
        getNavigationSnapshot,
        pickDirectoryFromDisk,
        registerDirectoryFromDisk,
        refreshDirectoryGitStatuses: vi.fn(async () => ({ scheduledCount: 1 })),
        updateDirectoryLaunchpad,
      });

      const { result } = renderHook(() => useThreadNavigation(desktopApi));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let pick!: Promise<void>;
      act(() => {
        pick = result.current.pickAndRegisterDirectory();
      });

      await waitFor(() => {
        expect(result.current.selectedLaunchpad?.directoryKey).toBe(
          launchpad.directoryKey,
        );
      });

      await act(async () => {
        await result.current.updateDirectoryLaunchpad(launchpad.directoryKey, {
          prompt: "Edited before refresh completes",
        });
      });

      await waitFor(() => {
        expect(result.current.selectedLaunchpad?.prompt).toBe(
          "Edited before refresh completes",
        );
      });

      await act(async () => {
        refreshSnapshot.resolve(buildSnapshot());
        await pick;
      });

      expect(result.current.selectedLaunchpad?.prompt).toBe(
        "Edited before refresh completes",
      );
    });

    it("is silent when the user cancels the OS dialog", async () => {
      const pickDirectoryFromDisk = vi.fn(async () => ({
        canceled: true as const,
      }));
      const registerDirectoryFromDisk = vi.fn();
      const desktopApi = buildBaseDesktopApi({
        pickDirectoryFromDisk,
        registerDirectoryFromDisk,
      });

      const { result } = renderHook(() => useThreadNavigation(desktopApi));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.pickAndRegisterDirectory();
      });

      expect(registerDirectoryFromDisk).not.toHaveBeenCalled();
      expect(result.current.pickDirectoryError).toBeUndefined();
    });

    it("surfaces an inline error when the chosen path is not a git repo", async () => {
      const pickDirectoryFromDisk = vi.fn(async () => ({
        canceled: false as const,
        path: "/tmp/not-a-repo",
      }));
      const registerDirectoryFromDisk = vi.fn(async () => ({
        ok: false as const,
        reason: "not-a-git-repo" as const,
        message: "/tmp/not-a-repo is not inside a git repository.",
      }));
      const desktopApi = buildBaseDesktopApi({
        pickDirectoryFromDisk,
        registerDirectoryFromDisk,
      });

      const { result } = renderHook(() => useThreadNavigation(desktopApi));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.pickAndRegisterDirectory();
      });

      expect(result.current.pickDirectoryError).toContain("not inside a git");
      expect(result.current.selectedItemKey).toBeUndefined();

      // clearPickDirectoryError resets the inline error state.
      act(() => {
        result.current.clearPickDirectoryError();
      });
      expect(result.current.pickDirectoryError).toBeUndefined();
    });

    it("pickDirectoryForReference registers the pick without navigating and returns it", async () => {
      const launchpad = buildPickedLaunchpad();
      const pickDirectoryFromDisk = vi.fn(async () => ({
        canceled: false as const,
        path: "/Users/me/repos/PwrAgent",
      }));
      const registerDirectoryFromDisk = vi.fn(async () => ({
        ok: true as const,
        directoryPath: "/Users/me/repos/PwrAgent",
        directoryKey: launchpad.directoryKey,
        directoryLabel: "PwrAgent",
        currentBranch: "main",
        launchpad,
        defaults: launchpadDefaults,
      }));
      const desktopApi = buildBaseDesktopApi({
        pickDirectoryFromDisk,
        registerDirectoryFromDisk,
      });

      const { result } = renderHook(() => useThreadNavigation(desktopApi));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let picked: { label: string; path: string } | undefined;
      await act(async () => {
        picked = await result.current.pickDirectoryForReference();
      });

      expect(picked).toEqual({
        label: "PwrAgent",
        path: "/Users/me/repos/PwrAgent",
      });
      expect(registerDirectoryFromDisk).toHaveBeenCalledExactlyOnceWith({
        path: "/Users/me/repos/PwrAgent",
      });
      // The tracked set learns the directory, but nothing navigates.
      expect(
        result.current.directories.map((directory) => directory.label),
      ).toContain("PwrAgent");
      expect(result.current.selectedItemKey).toBeUndefined();
      expect(result.current.pickDirectoryError).toBeUndefined();
      expect(result.current.pickingDirectory).toBe(false);
    });

    it("addProjectDirectory tracks an empty repo and reveals the Directories lens", async () => {
      const launchpad = buildPickedLaunchpad({ registeredAt: 1_500 });
      const getNavigationSnapshot = vi.fn(async () => buildSnapshot());
      const desktopApi = buildBaseDesktopApi({
        getNavigationSnapshot,
        pickDirectoryFromDisk: vi.fn(async () => ({
          canceled: false as const,
          path: "/Users/me/repos/PwrAgent",
        })),
        registerDirectoryFromDisk: vi.fn(async () => ({
          ok: true as const,
          directoryPath: "/Users/me/repos/PwrAgent",
          directoryKey: launchpad.directoryKey,
          directoryLabel: "PwrAgent",
          currentBranch: "main",
          launchpad,
          defaults: launchpadDefaults,
        })),
      });

      const { result } = renderHook(() => useThreadNavigation(desktopApi));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.addProjectDirectory();
      });

      expect(result.current.browseMode).toBe("directories");
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
      expect(result.current.selectedItemKey).toBeUndefined();
      expect(result.current.directories).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: launchpad.directoryKey,
            label: "PwrAgent",
            threadKeys: [],
            launchpad: expect.objectContaining({
              registeredAt: launchpad.registeredAt,
            }),
          }),
        ]),
      );
    });

    it("pickDirectoryForReference surfaces validation failures and resolves undefined", async () => {
      const pickDirectoryFromDisk = vi.fn(async () => ({
        canceled: false as const,
        path: "/tmp/not-a-repo",
      }));
      const registerDirectoryFromDisk = vi.fn(async () => ({
        ok: false as const,
        reason: "not-a-git-repo" as const,
        message: "/tmp/not-a-repo is not inside a git repository.",
      }));
      const desktopApi = buildBaseDesktopApi({
        pickDirectoryFromDisk,
        registerDirectoryFromDisk,
      });

      const { result } = renderHook(() => useThreadNavigation(desktopApi));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let picked: { label: string; path: string } | undefined;
      await act(async () => {
        picked = await result.current.pickDirectoryForReference();
      });

      expect(picked).toBeUndefined();
      expect(result.current.pickDirectoryError).toContain("not inside a git");
      expect(result.current.selectedItemKey).toBeUndefined();
    });
  });
});

describe("main selected detail authority", () => {
  it("keeps an off-page peer selection and hydrates configuration independently of row refresh", async () => {
    const snapshot = acpTitleSnapshot("Loaded row", "explicit", 1);
    const thread = { ...snapshot.threads[0]!, id: "off-page", model: "owner-model" };
    const target = { scope: "remote" as const, instanceId: "peer" };
    let resolveDetail!: (value: Awaited<ReturnType<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>>) => void;
    const pending = new Promise<Awaited<ReturnType<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>>>((resolve) => { resolveDetail = resolve; });
    const readDetail = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>(async (request) => {
      if (request.ref.threadId === "off-page") return pending;
      return { protocol: 2, ref: request.ref, revision: "loaded", readiness: "ready", identity: "present", thread: snapshot.threads[0] };
    });
    const api = {
      getNavigationSnapshot: vi.fn(async () => snapshot), getNavigationSelectedDetail: readDetail,
    } as unknown as DesktopApi;
    const hook = renderHook(() => useThreadNavigation(api));
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    await act(() => hook.result.current.showThread({ backend: "acp:kimi", threadId: "off-page", federationTarget: target }));
    expect(hook.result.current.selectedThreadKey).toBe("remote:peer:acp:kimi:off-page");
    expect(hook.result.current.selectedThreadConfigurationReady).toBe(false);
    expect(readDetail).toHaveBeenLastCalledWith(expect.objectContaining({
      ref: { backend: "acp:kimi", threadId: "off-page", ownerInstanceId: "peer" }, federationTarget: target,
    }));
    await act(async () => resolveDetail({
      protocol: 2, ref: { backend: "acp:kimi", threadId: "off-page", ownerInstanceId: "peer" },
      revision: "exact", readiness: "ready", identity: "present", thread,
    }));
    expect(hook.result.current.selectedThreadConfigurationReady).toBe(true);
    expect(hook.result.current.selectedThread?.model).toBe("owner-model");
    await act(() => hook.result.current.refresh());
    expect(hook.result.current.threads.some((row) => row.id === "off-page")).toBe(false);
    expect(hook.result.current.selectedThread?.id).toBe("off-page");
    expect(hook.result.current.selectedThreadKey).toBe("remote:peer:acp:kimi:off-page");
  });
});
