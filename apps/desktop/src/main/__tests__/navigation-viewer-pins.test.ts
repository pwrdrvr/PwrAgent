import { expect, it, vi } from "vitest";
import {
  buildFederatedThreadRef,
  buildThreadIdentityKey,
  federatedThreadIdentityKey,
  findPeerCounterpartDirectory,
  type NavigationDirectorySummary,
  type NavigationThreadSummary,
  type ProjectForgeAutomation,
} from "@pwragent/shared";
import { appendViewerNavigationPins, loadViewerNavigationPins } from "../app-server/navigation-viewer-pins";
import { projectNavigationQuery } from "@pwragent/owner-core/navigation-query-projection";
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


// Peer A owns a thread in ~/src/app (fixture-org/app). Peer B has an
// unrelated checkout also named `app`. The viewer has neither.
it("carries the owner's repository into a remote-only placeholder so a same-named peer checkout does not match", () => {
  const ownerThread: NavigationThreadSummary = { id: "remote", source: "codex", title: "Remote", titleSource: "explicit",
    linkedDirectories: [{ id: "/peer-a/src/app", kind: "local", label: "app", path: "/peer-a/src/app" }],
    inbox: { inInbox: false } };
  const ownerDirectory: NavigationDirectorySummary = { key: "directory:/peer-a/src/app", kind: "directory", label: "app",
    path: "/peer-a/src/app", threadKeys: ["codex:remote"], needsAttentionCount: 0,
    gitStatus: { originRepository: "github.com/fixture-org/app",
      remoteRepositories: ["github.com/fixture-org/app", "github.com/fixture-upstream/app"] } };
  const served = projectNavigationQuery({ index: { threads: [ownerThread], directories: [ownerDirectory] },
    request: { protocol: 2, consumer: "main-sidebar", query: { kind: "exact", identities: [{ backend: "codex", threadId: "remote" }] } } });
  const linked = served.entries[0]!.row.linkedDirectories;
  expect(linked).toEqual([{ id: "/peer-a/src/app", kind: "local", label: "app", path: "/peer-a/src/app",
    repositoryKey: "github.com/fixture-org/app",
    repositoryKeys: ["github.com/fixture-org/app", "github.com/fixture-upstream/app"] }]);

  // The viewer mounts what the owner served.
  const remote: NavigationThreadSummary = { ...ownerThread, linkedDirectories: linked,
    federation: { ref: buildFederatedThreadRef({ backend: "codex", threadId: "remote", instanceId: "peer-a" }), instanceLabel: "Peer A" } };
  const viewer = appendViewerNavigationPins({ threads: [], directories: [] }, [remote]);
  const rows = projectNavigationQuery({ index: viewer, request: { protocol: 2, consumer: "main-sidebar",
    inventory: "viewer", query: { kind: "directory-index" } } }).directories;
  // The grouping key is still the name, so existing rows neither split nor merge.
  expect(rows).toEqual([expect.objectContaining({ key: "unconfigured-directory:app", label: "app",
    localAvailability: "unconfigured", repositoryKey: "github.com/fixture-org/app",
    repositoryKeys: ["github.com/fixture-org/app", "github.com/fixture-upstream/app"] })]);

  const peerCheckout = (instanceId: string, label: string, repositoryKey: string) => ({
    key: `directory:/${instanceId}/${label}`, kind: "directory" as const, label, path: `/${instanceId}/${label}`, repositoryKey });
  expect(findPeerCounterpartDirectory(rows[0]!, [peerCheckout("peer-b", "app", "github.com/fixture-other/app")]))
    .toBeUndefined();
  expect(findPeerCounterpartDirectory(rows[0]!, [peerCheckout("peer-c", "application", "github.com/fixture-org/app")]))
    .toMatchObject({ path: "/peer-c/application" });
});

it("stamps only the owner's own threads, never a mounted peer thread's paths", () => {
  // Same path on both machines (same user name), different repositories.
  const peerThread: NavigationThreadSummary = { id: "peer", source: "codex", title: "Peer", titleSource: "explicit",
    linkedDirectories: [{ id: "/Users/me/app", kind: "local", label: "app", path: "/Users/me/app" }], inbox: { inInbox: false },
    federation: { ref: buildFederatedThreadRef({ backend: "codex", threadId: "peer", instanceId: "peer-b" }), instanceLabel: "Peer B" } };
  const localDirectory: NavigationDirectorySummary = { key: "directory:/Users/me/app", kind: "directory", label: "app",
    path: "/Users/me/app", threadKeys: [], needsAttentionCount: 0, gitStatus: { originRepository: "github.com/fixture-org/app" } };
  const served = projectNavigationQuery({ index: { threads: [peerThread], directories: [localDirectory] },
    request: { protocol: 2, consumer: "main-sidebar", inventory: "viewer",
      query: { kind: "exact", identities: [{ backend: "codex", threadId: "peer", ownerInstanceId: "peer-b" }] } } });
  expect(served.entries[0]!.row.linkedDirectories).toEqual(peerThread.linkedDirectories);
});

it("keeps one placeholder for two same-named repositories and lets it stand for both", () => {
  const remote = (id: string, instanceId: string, repositoryKey?: string): NavigationThreadSummary => ({
    id, source: "codex", title: id, titleSource: "explicit", inbox: { inInbox: false },
    linkedDirectories: [{ id: `/${instanceId}/app`, kind: "local", label: "app", path: `/${instanceId}/app`,
      ...(repositoryKey ? { repositoryKey } : {}) }],
    federation: { ref: buildFederatedThreadRef({ backend: "codex", threadId: id, instanceId }), instanceLabel: instanceId } });
  const viewer = appendViewerNavigationPins({ threads: [], directories: [] }, [
    remote("older-owner", "peer-z"),
    remote("org", "peer-a", "github.com/fixture-org/app"),
    remote("other", "peer-b", "github.com/fixture-other/app"),
  ]);
  expect(viewer.directories).toHaveLength(1);
  expect(viewer.directories[0]).toMatchObject({ key: "unconfigured-directory:app", repositoryKey: "github.com/fixture-org/app",
    repositoryKeys: ["github.com/fixture-other/app"] });
  expect(viewer.directories[0]!.threadKeys).toHaveLength(3);
});

it("never adds a thread's home repository to a placeholder it joined by a secondary link's name", () => {
  const ref = (id: string) => buildFederatedThreadRef({ backend: "codex", threadId: id, instanceId: "peer-a" });
  const app: NavigationThreadSummary = { id: "app", source: "codex", title: "App", titleSource: "explicit",
    inbox: { inInbox: false }, federation: { ref: ref("app"), instanceLabel: "Peer A" },
    linkedDirectories: [{ id: "/peer-a/app", kind: "local", label: "app", path: "/peer-a/app",
      repositoryKey: "github.com/fixture-org/app" }] };
  const other: NavigationThreadSummary = { id: "other", source: "codex", title: "Other", titleSource: "explicit",
    inbox: { inInbox: false }, federation: { ref: ref("other"), instanceLabel: "Peer A" },
    linkedDirectories: [
      { id: "/peer-a/PwrAgnt", kind: "local", label: "PwrAgnt", path: "/peer-a/PwrAgnt",
        repositoryKey: "github.com/fixture-org/pwragent" },
      { id: "/peer-a/app", kind: "local", label: "app", path: "/peer-a/app", repositoryKey: "github.com/fixture-org/app" },
    ] };
  const viewer = appendViewerNavigationPins({ threads: [], directories: [] }, [app, other]);
  const placeholder = viewer.directories.find((directory) => directory.key === "unconfigured-directory:app");
  expect(placeholder).toMatchObject({ repositoryKey: "github.com/fixture-org/app" });
  expect(placeholder?.repositoryKeys).toBeUndefined();
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


// A thread started in a PwrAgnt worktree, with two secondary folders linked
// later. Without a projectKey the viewer once ranked every plain `local`
// link ahead of the `worktree` link, so the thread jumped from PwrAgnt to
// Workspaces after Cmd+K mounted it. The owner keeps linked order there.
it("files a remote thread under its first linked project, not a later plain folder", () => {
  const remote: NavigationThreadSummary = { id: "remote", source: "claude", title: "Remote", titleSource: "explicit",
    linkedDirectories: [
      { id: "/m2/pwrdrvr/PwrAgnt", kind: "worktree", label: "PwrAgnt", path: "/m2/pwrdrvr/PwrAgnt",
        worktreePath: "/m2/.pwragent/worktrees/mvrhqobw/PwrAgnt" },
      { id: "/m2/.pwragent/profiles/default/projects", kind: "local", label: "projects",
        path: "/m2/.pwragent/profiles/default/projects" },
      { id: "/m2/pwrdrvr/PwrSnap", kind: "local", label: "PwrSnap", path: "/m2/pwrdrvr/PwrSnap" },
    ], inbox: { inInbox: false },
    federation: { ref: buildFederatedThreadRef({ backend: "claude", threadId: "remote", instanceId: "m2" }), instanceLabel: "M2" } };
  const directory = (key: string, kind: "directory" | "workspace", label: string, path: string) => ({
    key, kind, label, path, threadKeys: [], needsAttentionCount: 0 });
  const viewer = appendViewerNavigationPins({ threads: [], directories: [
    directory("workspace:/m5/.pwragent/profiles/default/projects", "workspace", "Workspaces",
      "/m5/.pwragent/profiles/default/projects"),
    directory("directory:/m5/pwrdrvr/PwrSnap", "directory", "PwrSnap", "/m5/pwrdrvr/PwrSnap"),
    directory("directory:/m5/pwrdrvr/PwrAgnt", "directory", "PwrAgnt", "/m5/pwrdrvr/PwrAgnt"),
  ] }, [remote]);
  expect(viewer.directories.filter((entry) => entry.threadKeys.length).map((entry) => entry.key))
    .toEqual(["directory:/m5/pwrdrvr/PwrAgnt"]);
  const exact = projectNavigationQuery({ index: viewer, request: { protocol: 2, consumer: "main-sidebar",
    inventory: "viewer", query: { kind: "exact", identities: [{ backend: "claude", threadId: "remote",
      ownerInstanceId: "m2" }], includeAncestry: true } } });
  expect(exact.selectionDirectory?.key).toBe("directory:/m5/pwrdrvr/PwrAgnt");
});

it("never files a remote thread under Workspaces by a secondary `projects` link's name", () => {
  const remote: NavigationThreadSummary = { id: "remote", source: "claude", title: "Remote", titleSource: "explicit",
    linkedDirectories: [
      { id: "/m2/pwrdrvr/PwrAgnt", kind: "worktree", label: "PwrAgnt", path: "/m2/pwrdrvr/PwrAgnt",
        worktreePath: "/m2/.pwragent/worktrees/mvrhqobw/PwrAgnt" },
      { id: "/m2/.pwragent/profiles/default/projects", kind: "local", label: "projects",
        path: "/m2/.pwragent/profiles/default/projects" },
    ], inbox: { inInbox: false },
    federation: { ref: buildFederatedThreadRef({ backend: "claude", threadId: "remote", instanceId: "m2" }), instanceLabel: "M2" } };
  // This viewer has no PwrAgnt checkout, only its own Workspaces row.
  const viewer = appendViewerNavigationPins({ threads: [], directories: [
    { key: "workspace:/m5/.pwragent/profiles/default/projects", kind: "workspace", label: "Workspaces",
      path: "/m5/.pwragent/profiles/default/projects", threadKeys: [], needsAttentionCount: 0 },
  ] }, [remote]);
  expect(viewer.directories.filter((entry) => entry.threadKeys.length).map((entry) => entry.key))
    .toEqual(["unconfigured-directory:pwragnt"]);
});

it("still files a remote thread under its checkout before a tool-managed worktree folder", () => {
  const remote: NavigationThreadSummary = { id: "remote", source: "codex", title: "Remote", titleSource: "explicit",
    linkedDirectories: [
      { id: "scratch", kind: "local", label: "Lab", path: "/peer/.codex/worktrees/a1b2/Lab" },
      { id: "repo", kind: "local", label: "PwrAgnt", path: "/peer/github/PwrAgnt" },
    ], inbox: { inInbox: false },
    federation: { ref: buildFederatedThreadRef({ backend: "codex", threadId: "remote", instanceId: "peer" }), instanceLabel: "Peer" } };
  const viewer = appendViewerNavigationPins({ threads: [], directories: [
    { key: "directory:/viewer/Lab", kind: "directory", label: "Lab", path: "/viewer/Lab", threadKeys: [], needsAttentionCount: 0 },
    { key: "directory:/viewer/PwrAgnt", kind: "directory", label: "PwrAgnt", path: "/viewer/PwrAgnt", threadKeys: [],
      needsAttentionCount: 0 },
  ] }, [remote]);
  expect(viewer.directories.filter((entry) => entry.threadKeys.length).map((entry) => entry.key))
    .toEqual(["directory:/viewer/PwrAgnt"]);
});

it.each(["complete", "checking"] as const)("keeps remote parentage global and directory counts scoped with %s coverage", (state) => {
  const parent: NavigationThreadSummary = { id: "parent", source: "codex", title: "Parent", titleSource: "explicit",
    linkedDirectories: [{ id: "repo", kind: "local", label: "repo", path: "/viewer/repo" }], inbox: { inInbox: false } };
  const remote = (id: string, owner: string): NavigationThreadSummary => ({ ...parent, id,
    federation: { ref: buildFederatedThreadRef({ backend: "codex", threadId: id, instanceId: owner }), instanceLabel: owner } });
  const child = { ...remote("child", "peer"), parentThreadId: "parent", parentThreadBackend: "codex" as const,
    parentThreadInstanceId: "viewer",
    projectKey: "/peer/.pwragent/projects/2026-09-13-35e549",
    linkedDirectories: [{ id: "scratch", kind: "local" as const, label: "2026-09-13-35e549",
      path: "/peer/.pwragent/projects/2026-09-13-35e549" }] };
  const otherParent = remote("parent", "other");
  const otherChild = { ...remote("other-child", "peer"), parentThreadId: "parent", parentThreadBackend: "codex" as const,
    parentThreadInstanceId: "other" };
  const directory = { key: "repo", kind: "directory" as const, label: "repo", path: "/viewer/repo",
    threadKeys: ["codex:parent"], needsAttentionCount: 0 };
  const viewer = appendViewerNavigationPins({ threads: [parent], directories: [directory] }, [child, otherParent, otherChild]);
  const index = { ...viewer, localInstanceId: "viewer", coverage: { state } };
  const project = (query: import("@pwragent/shared").NavigationQuery) => projectNavigationQuery({ index,
    request: { protocol: 2, consumer: "main-sidebar", inventory: "viewer", query } });
  const roots = project({ kind: "directory", directoryKey: "repo" });
  expect(roots.entries.map(({ row }) => [row.ref.ownerInstanceId, row.id])).toEqual([[undefined, "parent"], ["other", "parent"]]);
  const children = project({ kind: "children", parent: { backend: "codex", threadId: "parent" } });
  expect(children.entries.map(({ row }) => row.id)).toEqual(["child"]);
  expect(children.entries[0]?.placement).toEqual({ kind: "child", parent: { backend: "codex", threadId: "parent" } });
  // The mounted inventory owns project membership. This child's scratch
  // workspace is outside repo even though its parent relationship is valid.
  const childKey = federatedThreadIdentityKey(child.federation!.ref);
  const childHome = viewer.directories.find((entry) => entry.threadKeys.includes(childKey));
  expect(childHome).toBeDefined();
  expect(childHome?.key).not.toBe(directory.key);
  const scopedChildren = project({ kind: "children", directoryKey: directory.key,
    parent: { backend: "codex", threadId: "parent" } });
  const repoMembers = new Set(viewer.directories.find((entry) => entry.key === directory.key)!.threadKeys);
  expect(scopedChildren.entries.map(({ row }) => row.id)).toEqual(children.entries.filter(({ row }) =>
    repoMembers.has(row.federation ? federatedThreadIdentityKey(row.federation.ref) : buildThreadIdentityKey(row.source, row.id)))
    .map(({ row }) => row.id));
  expect(scopedChildren.entries).toEqual([]);
  expect(roots.entries.find(({ row }) => !row.ref.ownerInstanceId)?.row.ordinaryChildCount).toBe(scopedChildren.entries.length);
  const selectedHome = project({ kind: "exact", identities: [{ backend: "codex", threadId: "child", ownerInstanceId: "peer" }],
    includeAncestry: true, ancestryScope: "directory" });
  expect(selectedHome.entries.map(({ row }) => row.id)).toEqual(["child"]);
  expect(selectedHome.selectionDirectory?.key).toBe(childHome?.key);
  expect(project({ kind: "children", parent: { backend: "codex", threadId: "parent", ownerInstanceId: "other" } })
    .entries.map(({ row }) => row.id)).toEqual(["other-child"]);
  const exact = project({ kind: "exact", identities: [{ backend: "codex", threadId: "child", ownerInstanceId: "peer" }], includeAncestry: true });
  expect(exact.entries.map(({ row }) => row.id)).toEqual(["parent", "child"]);
  expect(child.parentThreadInstanceId).toBe("viewer");
  expect(exact.selectionDirectory?.key).toBe("repo");
});

it("hydrates a summaryless link mount once from exact owner evidence without overwriting a later snapshot", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  const ref = buildFederatedThreadRef({ backend: "codex", threadId: "child", instanceId: "peer" });
  const summary: NavigationThreadSummary = { id: "child", source: "codex", title: "Child", titleSource: "explicit",
    parentThreadId: "parent", parentThreadBackend: "codex", parentThreadInstanceId: "viewer",
    linkedDirectories: [{ id: "repo", kind: "local", label: "repo", path: "/peer/repo" }], inbox: { inInbox: false } };
  try {
    await store.addRemoteThreadPin({ ref, instanceLabel: "Peer", pinnedVia: "explicit" });
    const entry = { ref, summary, instanceLabel: "Peer" };
    const { writes } = await measureSqliteWrites(async () => {
      await store.updateRemoteThreadPinSnapshots([entry], { onlyMissing: true });
      for (let i = 0; i < 20; i++) {
        await store.updateRemoteThreadPinSnapshots([{ ...entry, summary: { ...summary, title: "Later exact read" } }], { onlyMissing: true });
      }
    });
    expect((await store.readRemoteThreadPinNavigationRows())[0]?.title).toBe("Child");
    expect(writes.commits).toBe(1);
    expectSqliteWriteBudget({ scenario: "navigation-summaryless-pin-hydration", writes,
      note: "One atomic fill per summaryless mount; 20 later exact reads add no commits. At 200 new mounts/day and 4 KiB/page: ~0.8 MB/day per dirty page. Existing mounts add 0 MB/day." });
    const unmounted = buildFederatedThreadRef({ backend: "codex", threadId: "unmounted", instanceId: "peer" });
    expect(await store.updateRemoteThreadPinSnapshots([{ ...entry, ref: unmounted }], { onlyMissing: true })).toBe(false);
    const revoked = buildFederatedThreadRef({ backend: "codex", threadId: "revoked", instanceId: "revoked-peer" });
    await store.addRemoteThreadPin({ ref: revoked, instanceLabel: "Revoked peer" });
    await store.tombstoneRemoteThreadPinsForInstance({ instanceId: "revoked-peer" });
    expect(await store.updateRemoteThreadPinSnapshots([{ ...entry, ref: revoked }], { onlyMissing: true })).toBe(false);
  } finally {
    db.close();
    vi.unstubAllEnvs();
  }
});


it.each([
  "/peer/.pwragent/profiles/dev/projects/2026-09-13-35e549",
  "/peer/.pwragnt/projects/2026-09-13-35e549",
  "C:\\Users\\peer\\.pwragent\\profiles\\dev\\projects\\2026-09-13-35e549",
])("keeps remote scratch threads inside Workspaces for %s", (scratchPath) => {
  const remote: NavigationThreadSummary = { id: "scratch", source: "codex", title: "Remote scratch", titleSource: "explicit",
    projectKey: scratchPath,
    linkedDirectories: [{ id: "scratch", kind: "local", label: "2026-09-13-35e549", path: scratchPath }],
    inbox: { inInbox: true },
    federation: { ref: buildFederatedThreadRef({ backend: "codex", threadId: "scratch", instanceId: "peer" }), instanceLabel: "Peer" } };
  const workspace = { key: "workspace:/viewer/.pwragent/projects", kind: "workspace" as const, label: "Workspaces",
    path: "/viewer/.pwragent/projects", threadKeys: [], needsAttentionCount: 0 };
  // A real checkout with the scratch folder's basename must never capture it.
  const collision = { key: "directory:/viewer/2026-09-13-35e549", kind: "directory" as const,
    label: "2026-09-13-35e549", threadKeys: [], needsAttentionCount: 0 };
  for (const directories of [[collision, workspace], []]) {
    const viewer = appendViewerNavigationPins({ threads: [], directories }, [remote, { ...remote, id: "second",
      federation: { ...remote.federation!, ref: buildFederatedThreadRef({ backend: "codex", threadId: "second", instanceId: "other" }) } }]);
    const project = (query: import("@pwragent/shared").NavigationQuery) => projectNavigationQuery({ index: viewer,
      request: { protocol: 2, consumer: "main-sidebar", inventory: "viewer", query } });
    const groups = project({ kind: "directory-index" }).directories;
    const workspaces = groups.filter((directory) => directory.kind === "workspace");
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({ label: "Workspaces", counts: { total: 2 } });
    expect(viewer.directories).toHaveLength(directories.length || 1);
    expect(project({ kind: "directory", directoryKey: workspaces[0]!.key }).entries.map(({ row }) => row.id).sort())
      .toEqual(["scratch", "second"]);
    expect(project({ kind: "exact", identities: [{ backend: "codex", threadId: "scratch", ownerInstanceId: "peer" }], includeAncestry: true })
      .selectionDirectory?.key).toBe(workspaces[0]!.key);
    if (directories.length) {
      expect(workspaces[0]!.key).toBe(workspace.key);
      expect(viewer.directories.find((directory) => directory.key === collision.key)?.threadKeys).toEqual([]);
    } else {
      expect(workspaces[0]).toMatchObject({ localAvailability: "unconfigured" });
      expect(workspaces[0]!.path).toBeUndefined();
    }
    expect(collision.threadKeys).toEqual([]);
    expect(workspace.threadKeys).toEqual([]);
  }
});

const PAUSED: ProjectForgeAutomation = { paused: true, pausedAt: 1, autoFixMergeConflicts: true,
  autoFixCiFailures: true, prWatches: true, refuseThreadMessages: false, wakeupPolicy: "hold" };

function ownerThread(id: string, path: string): NavigationThreadSummary {
  return { id, source: "codex", title: id, titleSource: "explicit", inbox: { inInbox: false },
    linkedDirectories: [{ id: path, kind: "local", label: "repo", path }] };
}

/** The owner's pinned-rows page for these threads, stamped as the viewer stamps it. */
function ownerPinnedRows(params: {
  instanceId: string;
  threads: NavigationThreadSummary[];
  directories: import("@pwragent/shared").NavigationDirectorySummary[];
}): NavigationThreadSummary[] {
  const page = projectNavigationQuery({ index: { threads: params.threads, directories: params.directories },
    request: { protocol: 2, consumer: "main-sidebar", inventory: "owner", readReason: "pins",
      query: { kind: "group-members", roots: params.threads.map((thread) => ({ backend: thread.source, threadId: thread.id })) } } });
  return page.entries.map(({ row }) => ({ ...row, federation: {
    ref: buildFederatedThreadRef({ backend: row.source, threadId: row.id, instanceId: params.instanceId }),
    instanceLabel: params.instanceId } }));
}

function viewerPlaceholder(pins: NavigationThreadSummary[]) {
  const viewer = appendViewerNavigationPins({ threads: [], directories: [] }, pins);
  const page = projectNavigationQuery({ index: viewer,
    request: { protocol: 2, consumer: "main-sidebar", inventory: "viewer", query: { kind: "directory-index" } } });
  expect(page.directories).toHaveLength(1);
  return page.directories[0]!;
}

it("shows a peer project's Forge Automation on the placeholder row standing for it", () => {
  const thread = ownerThread("t1", "/owner/repo");
  const second = ownerThread("t2", "/owner/repo");
  const project = { key: "directory:/owner/repo", kind: "directory" as const, label: "repo", path: "/owner/repo",
    threadKeys: [buildThreadIdentityKey("codex", "t1"), buildThreadIdentityKey("codex", "t2")],
    needsAttentionCount: 0, forgeAutomation: PAUSED };
  const rows = ownerPinnedRows({ instanceId: "peer", threads: [thread, second], directories: [project] });
  expect(rows.map((row) => row.homeProject)).toEqual([
    { directoryKey: project.key, forgeAutomation: PAUSED },
    { directoryKey: project.key, forgeAutomation: PAUSED },
  ]);
  // Only the pinned-rows read carries it; an ordinary lens page does not.
  const lens = projectNavigationQuery({ index: { threads: [thread], directories: [project] },
    request: { protocol: 2, consumer: "main-sidebar", inventory: "owner", query: { kind: "lens", lens: "inbox" } } });
  expect(lens.entries[0]?.row.homeProject).toBeUndefined();

  expect(viewerPlaceholder(rows)).toMatchObject({
    localAvailability: "unconfigured",
    forgeAutomation: PAUSED,
    peerProject: { target: { scope: "remote", instanceId: "peer" }, directoryKey: project.key },
  });
  // A project at the defaults still names itself, so the row can be paused.
  const defaults = ownerPinnedRows({ instanceId: "peer", threads: [thread],
    directories: [{ ...project, forgeAutomation: undefined }] });
  const placeholder = viewerPlaceholder(defaults);
  expect(placeholder.peerProject?.directoryKey).toBe(project.key);
  expect(placeholder.forgeAutomation).toBeUndefined();
});

it("shows no Forge Automation on a placeholder whose threads span peers or projects", () => {
  const thread = ownerThread("t1", "/owner/repo");
  const project = { key: "directory:/owner/repo", kind: "directory" as const, label: "repo", path: "/owner/repo",
    threadKeys: [buildThreadIdentityKey("codex", "t1")], needsAttentionCount: 0, forgeAutomation: PAUSED };
  const peerRows = ownerPinnedRows({ instanceId: "peer", threads: [thread], directories: [project] });
  const otherPeerRows = ownerPinnedRows({ instanceId: "other", threads: [ownerThread("t9", "/other/repo")], directories: [{
    ...project, key: "directory:/other/repo", path: "/other/repo", threadKeys: [buildThreadIdentityKey("codex", "t9")] }] });
  // Another checkout with the same name on the same peer files into the same placeholder.
  const sameNameRows = ownerPinnedRows({ instanceId: "peer", threads: [ownerThread("t3", "/elsewhere/repo")], directories: [{
    ...project, key: "directory:/elsewhere/repo", path: "/elsewhere/repo", threadKeys: [buildThreadIdentityKey("codex", "t3")] }] });
  // An owner that predates `homeProject` names no project.
  const olderOwnerRows = peerRows.map(({ homeProject: _home, ...row }) => row);
  for (const pins of [[...peerRows, ...otherPeerRows], [...peerRows, ...sameNameRows], olderOwnerRows]) {
    const placeholder = viewerPlaceholder(pins);
    expect(placeholder.localAvailability).toBe("unconfigured");
    expect(placeholder.peerProject).toBeUndefined();
    expect(placeholder.forgeAutomation).toBeUndefined();
  }
});

it("never puts a peer's Forge Automation on a local project row", () => {
  const thread = ownerThread("t1", "/owner/repo");
  const project = { key: "directory:/owner/repo", kind: "directory" as const, label: "repo", path: "/owner/repo",
    threadKeys: [buildThreadIdentityKey("codex", "t1")], needsAttentionCount: 0, forgeAutomation: PAUSED };
  const rows = ownerPinnedRows({ instanceId: "peer", threads: [thread], directories: [project] });
  const local = { key: "directory:/viewer/repo", kind: "directory" as const, label: "repo", path: "/viewer/repo",
    threadKeys: [], needsAttentionCount: 0 };
  const viewer = appendViewerNavigationPins({ threads: [], directories: [local] }, rows);
  const page = projectNavigationQuery({ index: viewer,
    request: { protocol: 2, consumer: "main-sidebar", inventory: "viewer", query: { kind: "directory-index" } } });
  expect(page.directories).toHaveLength(1);
  expect(page.directories[0]).toMatchObject({ key: local.key, counts: { total: 1 } });
  expect(page.directories[0]?.forgeAutomation).toBeUndefined();
  expect(page.directories[0]?.peerProject).toBeUndefined();
});
