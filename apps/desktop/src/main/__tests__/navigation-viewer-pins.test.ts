import { expect, it, vi } from "vitest";
import { buildFederatedThreadRef, type NavigationThreadSummary } from "@pwragent/shared";
import { appendViewerNavigationPins, loadViewerNavigationPins } from "../app-server/navigation-viewer-pins";
import { projectNavigationQuery } from "../app-server/navigation-query-projection";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import { RemoteThreadSummaryCache } from "../federation/remote-thread-summary-cache";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { openInMemoryStateDb } from "./sqlite-test-utils";

it("reconciles saved active pins with owner lifecycle for both Attention rows and directory counts without polling writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  const ref = buildFederatedThreadRef({ backend: "codex", threadId: "remote", instanceId: "peer" });
  const saved: NavigationThreadSummary = { id: "remote", source: "codex", title: "Remote", titleSource: "explicit",
    threadStatus: "active", updatedAt: 1, inbox: { inInbox: false },
    linkedDirectories: [{ id: "repo", kind: "local", label: "repo", path: "/owner/repo" }] };
  let owner: NavigationThreadSummary = { ...saved, threadStatus: "idle", updatedAt: 2, pinnedRank: "owner-rank",
    federation: { ref, instanceLabel: "Peer", peerStatus: "connected" } };
  let completeRefresh: (() => void) | undefined;
  const refreshed = vi.fn();
  const cache = new RemoteThreadSummaryCache({
    peers: () => [{ target: { scope: "remote", instanceId: "peer" }, label: "Peer", capabilities: ["thread_navigation"] }],
    fetchSnapshot: vi.fn(),
    fetchPinnedSnapshot: async () => {
      await new Promise<void>((resolve) => { completeRefresh = resolve; });
      return { backend: "all", fetchedAt: 2, unchanged: false, threads: [owner], directories: [], inboxThreadKeys: [],
        launchpadDefaults: { backend: "codex", executionMode: "default" } };
    },
    fetchArchivedThreads: async () => [],
    peerStatus: () => ({ status: "connected", label: "Peer" }),
    onPinnedSummariesRefreshed: refreshed,
  });
  const finishRefresh = async () => {
    expect(completeRefresh).toBeDefined();
    const calls = refreshed.mock.calls.length;
    completeRefresh!();
    completeRefresh = undefined;
    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledTimes(calls + 1));
  };
  const queries = new NavigationQueryStore();
  const loadIndex = async () => appendViewerNavigationPins({ threads: [], directories: [] },
    await loadViewerNavigationPins(store, cache));
  const read = (query: import("@pwragent/shared").NavigationQuery) => queries.readPage({ loadIndex,
    scopeKey: "viewer", request: { protocol: 2, consumer: "main-sidebar", inventory: "viewer", query } });
  const assertCounts = async (active: number) => {
    const attention = await read({ kind: "lens", lens: "attention" });
    expect(attention.counts.active).toBe(active);
    expect(attention.counts.activeRemote ?? 0).toBe(active);
    expect(attention.entries.filter(({ row }) => row.threadStatus === "active")).toHaveLength(active);
    const directories = await read({ kind: "directory-index" });
    expect(directories.directories).toHaveLength(1);
    expect(directories.directories?.[0]?.counts?.active).toBe(active);
    expect(directories.directories?.[0]?.counts?.activeRemote ?? 0).toBe(active);
  };
  try {
    await store.addRemoteThreadPin({ ref, instanceLabel: "Peer", summary: { ...saved, summary: "Private detail".repeat(100_000) } });
    await store.setRemoteThreadLocalPin({ ref, pinned: true });
    const localRank = (await store.readRemoteThreadPinNavigationRows())[0]!.pinnedRank;
    const fullPinRead = vi.spyOn(store, "listRemoteThreadPins");

    // A slow peer must not block navigation or turn yesterday's saved active flag into today's busy count.
    await assertCounts(0);
    expect(completeRefresh).toBeDefined();
    await finishRefresh();
    const { writes } = await measureSqliteWrites(async () => {
      await assertCounts(0);
      const rows = await loadViewerNavigationPins(store, cache);
      expect(rows[0]).toMatchObject({ threadStatus: "idle", updatedAt: 2, pinnedRank: localRank });
      expect(JSON.stringify(rows)).not.toContain("Private detail");
    });
    expectSqliteWriteBudget({ scenario: "navigation-viewer-pin-lifecycle-recovery", writes,
      note: "One changed owner summary commits once; repeated lens/directory reads add no commits. At 200 changed summaries/day and 4 KiB/page: ~0.8 MB/day per dirty page; idle polling adds 0 MB/day." });
    expect(writes.commits).toBe(1);
    expect(fullPinRead).not.toHaveBeenCalled();
    expect((await store.readRemoteThreadPinNavigationRows())[0]).toMatchObject({ threadStatus: "idle", updatedAt: 2 });

    // Owner invalidations refresh mounted pins even when no lens is currently asking for them.
    owner = { ...owner, threadStatus: "active" };
    cache.invalidate("peer");
    await finishRefresh();
    await assertCounts(1);
    owner = { ...owner, threadStatus: "idle" }; // Lifecycle changes can share an updatedAt value.
    cache.invalidate("peer");
    await assertCounts(1); // Keep the previous owner observation consistent during the pending refresh.
    await finishRefresh();
    await assertCounts(0);

    const { writes: repeatedWrites } = await measureSqliteWrites(async () => {
      for (let i = 0; i < 20; i++) await assertCounts(0);
    });
    expectSqliteWriteBudget({ scenario: "navigation-viewer-pin-unchanged-reads", writes: repeatedWrites,
      note: "Twenty Attention and directory query pairs retain the same owner lifecycle: zero commits, 0 MB/day added WAL." });
    expect(repeatedWrites.commits).toBe(0);
  } finally {
    cache.dispose();
    db.close();
    vi.unstubAllEnvs();
  }
});

it("adds viewer-owned remote memberships without modifying the owner's index or colliding local identities", () => {
  const local: NavigationThreadSummary = { id: "same", source: "codex", title: "Local", titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false } };
  const remote: NavigationThreadSummary = { ...local, title: "Remote", pinnedRank: "viewer-rank",
    linkedDirectories: [{ id: "directory:/repo", kind: "local", label: "repo", path: "/repo" }],
    federation: { ref: buildFederatedThreadRef({ backend: "codex", threadId: "same", instanceId: "peer" }), instanceLabel: "Peer" } };
  const owner = { threads: [local], directories: [] };
  const viewer = appendViewerNavigationPins(owner, [remote]);
  expect(owner).toEqual({ threads: [local], directories: [] });
  const projected = projectNavigationQuery({ index: viewer, request: { protocol: 2, consumer: "main-sidebar",
    query: { kind: "directory-index" } } });
  expect(projected.counts.total).toBe(2);
  expect(projected.directories).toHaveLength(1);
  expect(projected.directories[0]).toMatchObject({ key: "unconfigured-directory:repo", counts: { total: 1 }, pinnedRootCount: 1 });
  expect(viewer.threads.map((thread) => thread.title)).toEqual(["Local", "Remote"]);
});


it("groups a remote parent with its local child across checkout paths and resolves the selected home", () => {
  const child: NavigationThreadSummary = { id: "child-m4", source: "codex", title: "Finish 2001", titleSource: "explicit",
    linkedDirectories: [{ id: "worktree", kind: "worktree", label: "PwrAgnt", path: "/m4/.codex/worktrees/task/PwrAgnt" }],
    parentThreadId: "parent-m5", parentThreadBackend: "codex", parentThreadInstanceId: "m5", inbox: { inInbox: true } };
  const parent: NavigationThreadSummary = { id: "parent-m5", source: "codex", title: "Parent", titleSource: "explicit", pinnedRank: "1024",
    projectKey: "/m5/.codex/worktrees/parent/PwrAgnt", linkedDirectories: [
      { id: "secondary", kind: "local", label: "Lab", path: "/m5/Lab" },
      { id: "parent-project", kind: "worktree", label: "PwrAgnt", path: "/m5/.codex/worktrees/parent/PwrAgnt" },
    ], inbox: { inInbox: false },
    federation: { ref: buildFederatedThreadRef({ backend: "codex", threadId: "parent-m5", instanceId: "m5" }), instanceLabel: "M5" } };
  const directory = { key: "directory:/m4/github/PwrAgnt", kind: "directory" as const, label: "PwrAgnt", path: "/m4/github/PwrAgnt",
    threadKeys: ["codex:child-m4"], needsAttentionCount: 1 };
  const viewer = appendViewerNavigationPins({ threads: [child], directories: [directory] }, [parent]);
  expect(viewer.directories).toHaveLength(1);
  expect(directory.threadKeys).toEqual(["codex:child-m4"]);
  const project = (query: import("@pwragent/shared").NavigationQuery) => projectNavigationQuery({ index: viewer,
    request: { protocol: 2, consumer: "main-sidebar", inventory: "viewer", query } });
  const roots = project({ kind: "directory", directoryKey: directory.key });
  expect(roots.entries.map((entry) => entry.row.id)).toEqual(["parent-m5"]);
  expect(roots.entries[0]?.row.viewerChildCount).toBe(1);
  const children = project({ kind: "children", parent: { backend: "codex", threadId: "parent-m5", ownerInstanceId: "m5" } });
  expect(children.entries.map((entry) => entry.row.id)).toEqual(["child-m4"]);
  const exact = project({ kind: "exact", identities: [{ backend: "codex", threadId: "child-m4" }], includeAncestry: true });
  expect(exact.entries.map((entry) => entry.row.id)).toEqual(["parent-m5", "child-m4"]);
  expect(exact.selectionDirectory?.key).toBe(directory.key);
});
