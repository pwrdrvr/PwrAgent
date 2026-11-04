import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { BackendSummary, NavigationRow } from "@pwragent/shared";
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

async function archiveFromSidebar(size: number, completionGroups: number[][]) {
  const archived = new Set<string>();
  const gates = Array.from({ length: size }, deferred);
  const rows: NavigationRow[] = Array.from({ length: size + 1 }, (_, index) => ({
    id: `thread-${index}`, source: "codex", title: `Thread ${index}`, titleSource: "explicit",
    ref: { backend: "codex", threadId: `thread-${index}` }, rowRevision: "r", linkedDirectories: [],
    inbox: { inInbox: true }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false,
    queueCount: 0, queueState: "unknown",
  }));
  const read = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async ({ query }) => {
    const visible = rows.filter((row) => !archived.has(row.id));
    const entries = query.kind === "lens" && query.roots !== "pinned" ? visible
      : query.kind === "exact" ? visible.filter((row) => query.identities.some((ref) => ref.threadId === row.id)) : [];
    return { protocol: 2, queryKey: JSON.stringify(query), generation: "g", ownerEpoch: "owner", countsRevision: "r",
      coverage: { state: "complete" }, counts: { total: 1500 - archived.size, active: 0, unread: 1500 - archived.size, review: 0 },
      entries: entries.map((row, index) => ({ row, placement: { kind: "root" }, orderKey: String(index).padStart(4, "0") })),
      directories: [], complete: true };
  });
  const archive = vi.fn<NonNullable<DesktopApi["archiveThread"]>>(async ({ threadId }) => {
    await gates[Number(threadId.slice("thread-".length))]!.promise;
    archived.add(threadId);
    return { backend: "codex", threadId, archivedAt: 1, cleanup: [] };
  });
  const api: DesktopApi = {
    archiveThread: archive, getNavigationQueryPage: read, releaseNavigationQuery: async () => undefined,
    getNavigationSelectedDetail: async ({ ref }) => ({ protocol: 2, ref, revision: "r", readiness: "ready",
      identity: archived.has(ref.threadId) ? "archived" : "present", thread: rows.find((row) => row.id === ref.threadId) }),
    onAgentEvent: () => () => undefined,
  };
  const hook = renderHook(() => useThreadNavigation(api));
  await waitFor(() => expect(hook.result.current.selectedThreadConfigurationReady).toBe(true));
  const navigation = hook.result.current;
  const onThreadsArchived = vi.fn();
  // Mount the real sidebar against the hook's admitted page. Keep that
  // presentation stable while driving IPC completions; hook state still
  // renders on every optimistic removal and accepted owner page.
  const sidebar = render(<Sidebar backends={backends} browseMode={navigation.browseMode}
    directories={navigation.directories} threads={navigation.threads} inboxThreads={navigation.inboxThreads}
    pagedNavigation={navigation.pagedNavigation} loading={navigation.loading} selectedItemKey={navigation.selectedItemKey}
    onBrowseModeChange={navigation.setBrowseMode} onSelectThread={navigation.selectThread}
    onArchiveThread={navigation.archiveThread} onThreadsArchived={onThreadsArchived}
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
    }
    await waitFor(() => expect(onThreadsArchived).toHaveBeenCalledOnce());
    const loads = read.mock.calls.length;
    const lensLoads = read.mock.calls.filter(([request]) => request.query.kind === "lens" && request.query.roots !== "pinned").length;
    console.info("bulk archive navigation IPC", { size, groups: completionGroups.length, loads, lensLoads });
    return { loads, lensLoads };
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
  expect(staggered.lensLoads).toBeLessThanOrEqual(2);
});

it("loads per bulk archive do not grow with the number of threads or completion groups", async () => {
  const baseline = await archiveFromSidebar(2, [[0, 1]]);
  await fc.assert(fc.asyncProperty(
    fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 2, maxLength: 12 }),
    async (completionOrder) => {
      const groups = [...new Set(completionOrder)].sort().map((rank) => completionOrder
        .flatMap((value, index) => value === rank ? [index] : []));
      const { loads, lensLoads } = await archiveFromSidebar(completionOrder.length, groups);
      expect(lensLoads).toBeLessThanOrEqual(2);
      expect(loads).toBeLessThanOrEqual(baseline.loads);
    },
  ), { numRuns: 25 });
});
