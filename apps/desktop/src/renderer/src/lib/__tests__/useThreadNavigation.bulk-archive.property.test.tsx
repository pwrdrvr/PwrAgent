import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { AgentEvent, BackendSummary, NavigationRow } from "@pwragent/shared";
import { Sidebar } from "../../features/navigation/Sidebar";
import type { DesktopApi } from "../desktop-api";
import { useThreadNavigation } from "../useThreadNavigation";

const backends: BackendSummary[] = [{
  kind: "codex", label: "Codex", available: true, methods: [], executionModes: [],
  capabilities: { listThreads: true, createThread: true, resumeThread: true, archiveThread: true,
    restoreThread: true, renameThread: true, readThread: true, startTurn: true, interruptTurn: true,
    steerTurn: true, transcriptPagination: true, toolUse: false, approvalRequests: false, multiDirectoryThreads: true },
}];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => vi.spyOn(document, "hasFocus").mockReturnValue(true));
afterEach(() => vi.restoreAllMocks());

async function archiveFromSidebar(size: number, completionGroups: number[][], options?: {
  failed?: number[];
  remote?: number[];
}) {
  const archived = new Set<string>();
  const listeners = new Set<(event: AgentEvent) => void>();
  const emit = (event: AgentEvent) => { for (const listener of listeners) listener(event); };
  const refreshTasks = new Set<() => void>();
  const scheduleNavigationRefresh = (callback: () => void) => {
    refreshTasks.add(callback);
    return () => { refreshTasks.delete(callback); };
  };
  const removedPins = new Set<string>();
  const owner = { scope: "remote" as const, instanceId: "archive-owner" };
  const gates = Array.from({ length: size }, deferred);
  const rows: NavigationRow[] = Array.from({ length: size + 1 }, (_, index) => ({
    id: `thread-${index}`, source: "codex", title: `Thread ${index}`, titleSource: "explicit",
    ref: { backend: "codex", threadId: `thread-${index}` }, rowRevision: "r", linkedDirectories: [],
    inbox: { inInbox: true }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false,
    queueCount: 0, queueState: "unknown",
    ...(options?.remote?.includes(index) ? {
      ref: { backend: "codex", threadId: `thread-${index}`, ownerInstanceId: owner.instanceId },
      federation: { ref: { backend: "codex", threadId: `thread-${index}`, target: owner },
        instanceLabel: "Archive owner", peerStatus: "connected", capabilities: ["thread_navigation", "turn_control"] },
    } : {}),
  }));
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async ({ query, federationTarget }) => {
    // The viewer keeps a remote mount's cached snapshot until its pin is
    // removed, even after the owner archives the thread.
    const visible = rows.filter((row) => federationTarget?.scope === "remote"
      ? row.ref.ownerInstanceId === federationTarget.instanceId && !archived.has(row.id)
      : row.federation ? !removedPins.has(row.id) : !archived.has(row.id));
    const entries = query.kind === "lens" && query.roots !== "pinned" ? visible
      : query.kind === "exact" ? visible.filter((row) => query.identities.some((ref) => ref.threadId === row.id)) : [];
    return { protocol: 2, queryKey: JSON.stringify(query), generation: "g", ownerEpoch: "owner", countsRevision: "r",
      coverage: { state: "complete" }, counts: { total: 1500 - archived.size, active: 0, unread: 1500 - archived.size, review: 0 },
      entries: entries.map((row, index) => ({ row, placement: { kind: "root" }, orderKey: String(index).padStart(4, "0") })),
      directories: [], complete: true };
  });
  const archive = vi.fn<NonNullable<DesktopApi["archiveThread"]>>(async ({ threadId }) => {
    const index = Number(threadId.slice("thread-".length));
    await gates[index]!.promise;
    if (options?.failed?.includes(index)) throw new Error(`Archive failed: ${threadId}`);
    archived.add(threadId);
    emit({ backend: "codex", ...(options?.remote?.includes(index) ? { federationTarget: owner } : {}),
      notification: { method: "thread/archived", params: { threadId } } });
    return { backend: "codex", threadId, archivedAt: 1, cleanup: [] };
  });
  const api: DesktopApi = {
    archiveThread: archive, getNavigationQueryPage: read, releaseNavigationQuery: async () => undefined,
    removeRemoteThreadPin: vi.fn(async ({ ref }) => {
      removedPins.add(ref.threadId);
      emit({ backend: "codex", notification: { method: "navigation/remoteThreadPins/changed",
        params: { instanceId: owner.instanceId, threadId: ref.threadId, pinned: false } } });
      return { removed: true };
    }),
    getNavigationSelectedDetail: async ({ ref }) => ({ protocol: 2, ref, revision: "r", readiness: "ready",
      identity: archived.has(ref.threadId) ? "archived" : "present", thread: rows.find((row) => row.id === ref.threadId) }),
    onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  let hook!: ReturnType<typeof renderHook<ReturnType<typeof useThreadNavigation>, void>>;
  await act(async () => { hook = renderHook(() => useThreadNavigation(api, { scheduleNavigationRefresh })); });
  await waitFor(() => {
    expect(hook.result.current.selectedThreadConfigurationReady).toBe(true);
    expect([...hook.result.current.pagedNavigation.resources.values()].every((resource) => !resource.loading)).toBe(true);
  });
  const navigation = hook.result.current;
  const onThreadsArchived = vi.fn();
  // Mount the real sidebar against the hook's admitted page. Keep that
  // presentation stable while driving IPC completions; hook state still
  // renders on every optimistic removal and accepted owner page.
  const sidebar = render(<Sidebar backends={backends} remoteBackends={new Map([[owner.instanceId, backends]])} browseMode={navigation.browseMode}
    directories={navigation.directories} threads={navigation.threads} inboxThreads={navigation.inboxThreads}
    pagedNavigation={navigation.pagedNavigation} loading={navigation.loading} selectedItemKey={navigation.selectedItemKey}
    onBrowseModeChange={navigation.setBrowseMode} onSelectThread={navigation.selectThread}
    onArchiveThread={navigation.archiveThread} onArchiveThreads={navigation.archiveThreads} onThreadsArchived={onThreadsArchived}
    onCreateThread={async () => undefined} onOpenLaunchpad={async () => undefined} />);
  try {
    const first = screen.getByRole("button", { name: "Thread 0" });
    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: `Thread ${size - 1}` }), { shiftKey: true });
    fireEvent.contextMenu(first);
    read.mockClear();
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: `Archive ${size} Threads` })); });
    expect(archive).toHaveBeenCalledTimes(size);
    expect(hook.result.current.archivedThreadKeys.size).toBe(size);
    expect(hook.result.current.threads.map((thread) => thread.id)).toEqual([`thread-${size}`]);
    expect(hook.result.current.selectedThreadKey).toBe(`codex:thread-${size}`);
    for (const group of completionGroups) {
      await act(async () => { for (const index of group) gates[index]!.resolve(); });
      // Deliver the same timer tasks production runs between staggered IPC
      // replies, without depending on wall time or fake timers.
      await act(async () => {
        while (refreshTasks.size > 0) {
          const tasks = [...refreshTasks];
          refreshTasks.clear();
          for (const task of tasks) task();
          await Promise.resolve();
        }
      });
    }
    await waitFor(() => expect(onThreadsArchived).toHaveBeenCalledOnce());
    for (let index = 0; index < size; index++) {
      const failed = options?.failed?.includes(index) === true;
      expect(hook.result.current.threads.some((thread) => thread.id === `thread-${index}`)).toBe(failed);
      expect(removedPins.has(`thread-${index}`)).toBe(!failed && options?.remote?.includes(index) === true);
    }
    const successes = onThreadsArchived.mock.calls[0]![0] as Array<{ threadId: string }>;
    expect(successes.map((thread) => thread.threadId)).toEqual(rows.slice(0, size)
      .filter((_, index) => !options?.failed?.includes(index)).map((row) => row.id));
    const loads = read.mock.calls.length;
    const lensLoads = read.mock.calls.filter(([request]) => request.query.kind === "lens" && request.query.roots !== "pinned").length;
    console.info("bulk archive navigation IPC", { size, groups: completionGroups.length, loads, lensLoads });
    return { loads, lensLoads, selectedThreadKey: hook.result.current.selectedThreadKey };
  } finally {
    sidebar.unmount();
    hook.unmount();
  }
}

it.each([50, 200])("bounds navigation IPC loads for %i sidebar archives, even when responses are staggered", async (size) => {
  const indices = Array.from({ length: size }, (_, index) => index);
  const together = await archiveFromSidebar(size, [indices]);
  const staggered = await archiveFromSidebar(size, indices.map((index) => [index]));
  expect(staggered.loads).toBeLessThanOrEqual(together.loads);
  expect(staggered.lensLoads).toBe(1);
});

it.each([2, 3])("refreshes once for the shrunk %i-thread counterexample", async (size) => {
  const groups = size === 2 ? [[0], [1]] : [[0, 1], [2]];
  expect((await archiveFromSidebar(size, groups)).lensLoads).toBe(1);
});

it("rolls back failed rows and selection while removing only successfully archived remote pins", async () => {
  const outcome = await archiveFromSidebar(4, [[3], [2], [1], [0]], { failed: [0, 2], remote: [1, 2] });
  expect(outcome.selectedThreadKey).toBe("codex:thread-0");
});

it("loads per bulk archive do not grow with the number of threads or completion groups", async () => {
  const baseline = await archiveFromSidebar(2, [[0, 1]]);
  await fc.assert(fc.asyncProperty(
    fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 2, maxLength: 12 }),
    async (completionOrder) => {
      const groups = [...new Set(completionOrder)].sort().map((rank) => completionOrder
        .flatMap((value, index) => value === rank ? [index] : []));
      const { loads, lensLoads } = await archiveFromSidebar(completionOrder.length, groups);
      expect(lensLoads).toBe(1);
      expect(loads).toBeLessThanOrEqual(baseline.loads);
    },
  ), { numRuns: 25 });
});
