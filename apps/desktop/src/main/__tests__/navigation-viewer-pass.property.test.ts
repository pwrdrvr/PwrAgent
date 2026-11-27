import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { buildFederatedThreadRef } from "@pwragent/shared/contracts/federation";
import {
  buildThreadIdentityKey,
  type NavigationQueryRequest,
  type NavigationSnapshot,
  type NavigationThreadSummary,
  type PrSummary,
} from "@pwragent/shared/contracts/navigation";
import type { AppServerListThreadsResponse } from "@pwragent/shared/contracts/normalized-app-server";
import { type AgentEvent } from "@pwragent/shared/contracts/agent";
import { type ProjectForgeAutomation } from "@pwragent/shared/project-forge-automation";
import type { ThreadPullRequestWatchSummary } from "@pwragent/shared/contracts/thread-tools";
import type { StackSummary } from "@pwragent/shared/stacks/stack-status";
import * as gitExecutable from "../app-server/git-executable";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { isolateProcessGitEnvironment, runIsolatedGitSync } from "./helpers/isolated-git";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { RemoteThreadSummaryCache } from "../federation/remote-thread-summary-cache";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { NavigationWindowQueries } from "../../renderer/src/lib/navigation-window-queries";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { getDesktopNavigationQueryPool } from "../app-server/navigation-query-pool";
import { NavigationIndexReadPool } from "../app-server/navigation-index-read-pool";
import type { ForgeCiClient } from "../pr-status/forge-ci-client";
import * as projection from "@pwragent/owner-core/navigation-query-projection";

const current = vi.hoisted(() => ({
  store: undefined as unknown as SqliteOverlayStore,
  registry: undefined as unknown as DesktopBackendRegistry,
  cache: undefined as unknown as RemoteThreadSummaryCache,
}));
vi.mock("../storage/desktop-overlay-store", () => ({ getDesktopOverlayStore: () => current.store }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: () => current.registry }));
vi.mock("../app-server/scratch-projects", () => ({ resolveScratchProjectsRoots: () => [] }));
// The synthetic /fixture projects are primary checkouts. Resolve their ownership
// without disk I/O so the fixture can drain the pass through microtasks.
vi.mock("../git-info/worktree-store", () => ({
  resolveWorktreeRepositoryDirectory: async () => undefined,
  readSeparateGitProjectCheckout: async () => undefined,
}));
vi.mock("../messaging/messaging-bindings-snapshot", () => ({ buildNavigationIndexMessagingBindings: async () => new Map() }));
vi.mock("../federation/federation-runtime", () => ({ getDesktopFederationRuntime: () => ({
  remoteThreadSummaries: () => current.cache, health: async () => ({ instanceId: "viewer" }),
}) }));
import { initializeDesktopAppServerService, resetAppServerServiceForTests } from "../app-server/desktop-app-server-service";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each([1, 2, 3, 4, 5, 6, 7, 8])("preserves %i physical source admissions when each source has a derived viewer", async (n) => {
  const pool = new NavigationIndexReadPool();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const index = { threads: [], directories: [] };
  const loads = Array.from({ length: n }, (_, i) => vi.fn(async () => { await gate; return { ...index, localInstanceId: String(i) }; }));
  const reads = loads.map((load, i) => pool.read(`viewer-${i}`,
    (signal) => pool.read(`owner-${i}`, load, signal), undefined, undefined, "projection"));
  try {
    expect(pool.usage()).toEqual({ physical: n, readers: 2 * n });
    if (n === 8) await expect(pool.read("over-capacity", async () => index)).rejects.toThrow("source admission is full");
    finish();
    const rows = await Promise.all(reads);
    expect(rows.map((row) => row.localInstanceId)).toEqual(Array.from({ length: n }, (_, i) => String(i)));
    for (const load of loads) expect(load).toHaveBeenCalledTimes(1);
  } finally { finish(); await Promise.allSettled(reads); }
});

async function until(predicate: () => boolean) {
  for (let i = 0; i < 1000 && !predicate(); i++) await Promise.resolve();
  expect(predicate()).toBe(true);
}

function thread(id: string, directory: number): NavigationThreadSummary {
  return { id, source: "codex", title: id, titleSource: "explicit", threadStatus: "idle",
    createdAt: 1, updatedAt: 1, inbox: { inInbox: false }, linkedDirectories: [{ id: `repo-${directory}`,
      kind: "local", path: `/fixture/project-${directory}`, label: `project-${directory}` }] };
}

async function fixture(n: number) {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const db = openInMemoryStateDb();
  const store = current.store = new SqliteOverlayStore(db);
  let rows: NavigationThreadSummary[] = Array.from({ length: n }, (_, i) => [{ ...thread(`root-${i}`, i), threadStatus: "active" as const },
    { ...thread(`child-${i}`, i), parentThreadId: `root-${i}`, parentThreadBackend: "codex" as const }]).flat();
  // Independent managed history must not multiply work for each visible page.
  db.raw.transaction(() => {
    for (let i = 0; i < n; i++) db.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)")
      .run(`codex:child-${i}`, JSON.stringify({ backend: "codex", threadId: `child-${i}`,
        executionMode: "default", extraLinkedDirectories: [], parentThreadId: `root-${i}`, parentThreadBackend: "codex" }));
    for (let i = 0; i < n; i++) db.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)")
      .run(`codex:managed-${i}`, JSON.stringify({ backend: "codex", threadId: `managed-${i}`,
        subAgents: [{ monitorId: `card-${i}`, monitorThreadId: `worker-${i}`, status: "running" }] }));
  })();
  for (let i = 0; i < n; i++) await store.addRemoteThreadPin({
    ref: buildFederatedThreadRef({ backend: "codex", instanceId: "peer", threadId: `remote-${i}` }),
    instanceLabel: "Peer", summary: thread(`remote-${i}`, i),
  });
  const listeners = new Set<(event: AgentEvent) => void>();
  let connected = false;
  let published = 0;
  let publish = () => {};
  let ownerRows = Array.from({ length: n }, (_, i): NavigationThreadSummary => ({ ...thread(`remote-${i}`, i),
    pinnedRank: `owner-${i}`, federation: { ref: buildFederatedThreadRef({ backend: "codex", instanceId: "peer", threadId: `remote-${i}` }),
      instanceLabel: "Peer", peerStatus: "connected" } }));
  const provider = vi.fn(async () => rows);
  const hydrate = vi.fn(async (value: NavigationThreadSummary[]) => value);
  let ownerReadScheduler: fc.Scheduler | undefined;
  const fetchPinnedSnapshot = vi.fn(async (): Promise<NavigationSnapshot> => {
    const snapshot: NavigationSnapshot = { backend: "all", fetchedAt: 1, unchanged: false,
      threads: ownerRows, directories: [], inboxThreadKeys: [], launchpadDefaults: { backend: "codex", executionMode: "default" } };
    return ownerReadScheduler ? await ownerReadScheduler.schedule(Promise.resolve(snapshot), "owner snapshot") : snapshot;
  });
  const geometryReady = Promise.withResolvers<void>();
  current.registry = {
    publishLocalEvent: async (event: AgentEvent) => {
      if (event.notification.method === "navigation/invalidated") geometryReady.resolve();
    },
    listThreads: provider,
    onEvent: (listener: (event: AgentEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    withNavigationPrimaryGitRepositories: (value: NavigationThreadSummary[]) => value,
    hydrateThreadGitWorkingStates: hydrate,
    withNavigationSubAgentActivity: (value: NavigationThreadSummary[]) => value,
    getNavigationInputRequestThreadKeys: () => new Set<string>(),
  } as unknown as DesktopBackendRegistry;
  const cache = current.cache = new RemoteThreadSummaryCache({
    peers: () => connected ? [{ target: { scope: "remote", instanceId: "peer" }, label: "Peer", capabilities: ["thread_navigation"] }] : [],
    fetchSnapshot: vi.fn(), fetchPinnedSnapshot,
    fetchArchivedThreads: async () => [], peerStatus: () => ({ status: connected ? "connected" : "disconnected", label: "Peer" }),
    onPinnedSummariesRefreshed: () => { published++; publish(); },
  });
  const resolve = vi.spyOn(cache, "resolvePinnedThreads");
  const snapshots = vi.spyOn(store, "updateRemoteThreadPinSnapshots");
  const materialize = vi.spyOn(store, "readNavigationQueryIndex");
  const service = initializeDesktopAppServerService();
  const read = vi.fn((request: NavigationQueryRequest) => service.getNavigationQueryPage(request));
  const requests = new Map<string, NavigationQueryRequest>();
  const base = { protocol: 2 as const, consumer: "main-sidebar" as const, inventory: "viewer" as const, pageSize: 1 };
  requests.set("index", { ...base, pageSize: 100, query: { kind: "directory-index" } });
  for (let i = 0; i < n; i++) {
    requests.set(`directory-${i}`, { ...base, query: { kind: "directory", directoryKey: `directory:/fixture/project-${i}` } });
    requests.set(`children-${i}`, { ...base, query: { kind: "children", parent: { backend: "codex", threadId: `root-${i}` } } });
  }
  const queries = new NavigationWindowQueries({ getNavigationQueryPage: read });
  const emit = (event: AgentEvent) => {
    for (const listener of [...listeners]) listener(event);
    queries.invalidate(undefined, undefined, event);
  };
  publish = () => emit({ backend: "codex", notification: { method: "navigation/remoteThreadPins/changed", params: { instanceId: "peer" } } });
  const idle = () => [...queries.getSnapshot().resources.values()].every((r) => !r.loading);
  const reset = () => { read.mockClear(); resolve.mockClear(); snapshots.mockClear(); materialize.mockClear(); provider.mockClear(); hydrate.mockClear(); };
  const mountVerified = async () => {
    queries.setDemand(requests);
    await geometryReady.promise;
    await queries.refresh();
    await until(idle);
  };
  return { db, store, cache, resolve, snapshots, materialize, provider, hydrate, requests, queries, read, emit, idle, reset, mountVerified,
    disconnect: () => {
      connected = false;
      cache.invalidate("peer");
      emit({ backend: "codex", federationTarget: { scope: "remote", instanceId: "peer" },
        notification: { method: "federation/peerStatus/changed", params: { instanceId: "peer", status: "disconnected" } } });
    },
    remote: async (i: number, title: string, active: boolean) => {
      const threadStatus = active ? "active" : "idle";
      const changed = !connected || ownerRows[i]!.title !== title || ownerRows[i]!.threadStatus !== threadStatus;
      connected = true;
      ownerRows = ownerRows.map((row, j) => j === i ? { ...row, title, threadStatus } : row);
      const before = published;
      const reads = fetchPinnedSnapshot.mock.calls.length;
      // Completion of an owner read does not imply a publication: identical
      // rows stay silent. Control the read and drain its reachable work.
      const scheduler = ownerReadScheduler = fc.schedulerFor([1]);
      try {
        cache.invalidate("peer");
        await scheduler.waitIdle();
      } finally { ownerReadScheduler = undefined; }
      expect(fetchPinnedSnapshot).toHaveBeenCalledTimes(reads + 1);
      expect(published - before).toBe(changed ? 1 : 0);
    },
    change: (i: number) => { rows = rows.map((row) => row.id === `root-${i}` ? { ...row, threadStatus: "idle" } : row); },
    close: () => { queries.dispose(); cache.dispose(); for (const listener of [...listeners]) listener({ backend: "codex",
      notification: { method: "thread/status/changed", params: { threadId: "close", status: { type: "idle" } } } }); db.close(); },
  };
}

it("materializes viewer pins once per immutable owner pass, whatever the number of demanded pages", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (n) => {
    const f = await fixture(n);
    try {
      const { writes } = await measureSqliteWrites(async () => {
        f.queries.setDemand(f.requests); await until(f.idle);
      });
      expect(f.read).toHaveBeenCalledTimes(1 + 2 * n);
      expect(f.provider).toHaveBeenCalledTimes(1);
      expect(f.materialize).toHaveBeenCalledTimes(1);
      expect(f.resolve).toHaveBeenCalledTimes(1);
      expect(f.snapshots).toHaveBeenCalledTimes(1);
      expect(writes.commits).toBe(0);
      const pins = f.resolve.mock.calls[0]![0];
      expect(pins.map((pin) => pin.ref.threadId).sort()).toEqual(Array.from({ length: n }, (_, i) => `remote-${i}`).sort());
      expect(f.queries.getSnapshot().resources.get("children-0")!.state.page?.entries.map(({ row }) => buildThreadIdentityKey(row.source, row.id)))
        .toEqual(["codex:child-0"]);
    } finally { f.close(); }
  }), { numRuns: 25 });
});

it("admits births from a mounted owner outside the visible page and fences a newly mounting owner", async () => {
  const f = await fixture(4);
  const birth = (instanceId: string): AgentEvent => ({ backend: "codex", federationTarget: { scope: "remote", instanceId },
    notification: { method: "navigation/invalidated", params: { sourceMethod: "thread/started", threadId: "unseen-child" } } });
  try {
    await f.mountVerified();
    f.reset();
    const attempt = (instanceId: string) => f.queries.invalidate(undefined, undefined, birth(instanceId));
    attempt("other");
    await f.queries.refresh(undefined, undefined, true);
    expect(f.read).not.toHaveBeenCalled();
    attempt("peer");
    await f.queries.refresh(undefined, undefined, true);
    expect(f.read).toHaveBeenCalledTimes(f.requests.size);
    f.reset();
    f.queries.invalidate(undefined, undefined, { backend: "codex", notification: { method: "navigation/remoteThreadPins/changed",
      params: { instanceId: "other", pinned: true } } });
    const next = f.read.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.read.mockImplementationOnce(async (request) => { await gate; return next(request); });
    const pending = f.queries.refresh(undefined, undefined, true);
    await until(() => f.read.mock.calls.length > 0);
    attempt("other");
    release();
    await pending;
    expect(f.read.mock.calls.length).toBeGreaterThan(f.requests.size);
  } finally { f.close(); }
});

it("shares the physical owner scan with viewers while retaining separate inventories", async () => {
  const f = await fixture(4);
  try {
    const viewer: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", inventory: "viewer",
      query: { kind: "exact", identities: [{ backend: "codex", threadId: "remote-0", ownerInstanceId: "peer" }] } };
    const [mounted, owner] = await Promise.all([f.read(viewer), f.read({ ...viewer, inventory: "owner" })]);
    expect(mounted.entries[0]?.row.id).toBe("remote-0");
    expect(owner.entries).toHaveLength(0);
    expect(f.materialize).toHaveBeenCalledTimes(1);
    expect(f.provider).toHaveBeenCalledTimes(1);
    expect(f.resolve).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

it.each([8, 16])("budgets projection work and real SQLite commits for %i expanded collections", async (n) => {
  const create = projection.createNavigationQuerySnapshot;
  const work = { index: 0, children: 0 };
  const prepared = vi.spyOn(projection, "createNavigationQuerySnapshot").mockImplementation((index, _onWork, owner, previous) =>
    create(index, (stage, rows) => { work[stage] += rows; }, owner, previous));
  const f = await fixture(n);
  try {
    const { writes } = await measureSqliteWrites(async () => {
      f.queries.setDemand(f.requests); await until(f.idle);
    });
    // N roots, N children, N viewer mounts. The owner and viewer share one
    // physical scan, but intentionally prepare distinct 2N and 3N inventories.
    expect(prepared).toHaveBeenCalledTimes(2);
    expect(work).toEqual({ index: 5 * n, children: 8 * n });
    expect(f.read).toHaveBeenCalledTimes(1 + 2 * n);
    expect(f.provider).toHaveBeenCalledTimes(1);
    expect(f.materialize).toHaveBeenCalledTimes(1);
    expect(writes.commits).toBe(0);
    f.reset();
    prepared.mockClear(); work.index = 0; work.children = 0;
    await f.queries.refresh(); await until(f.idle);
    expect(prepared).not.toHaveBeenCalled();
    expect(work.index).toBe(0);
    // Cursor-bearing collections can reuse their admitted projection.
    expect(work.children).toBeLessThanOrEqual(3 * n);
    expect(f.read).toHaveBeenCalledTimes(1 + 2 * n);
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.materialize).not.toHaveBeenCalled();
  } finally { f.close(); prepared.mockRestore(); }
});

async function expectDisconnectedViewer(n: number, selected: number) {
  vi.useFakeTimers();
  const f = await fixture(n);
  const i = selected % n;
  const exact: NavigationQueryRequest = { protocol: 2, inventory: "viewer", consumer: "main-sidebar",
    query: { kind: "exact", identities: Array.from({ length: n }, (_, j) => ({ backend: "codex", threadId: `remote-${j}`, ownerInstanceId: "peer" })) } };
  try {
    f.queries.setDemand(f.requests); await until(f.idle);
    await f.remote(i, "Live owner", true);
    await f.queries.refresh(); await until(f.idle);
    // Warm the post-snapshot-write source generation before disconnecting.
    await f.queries.refresh(); await until(f.idle);
    const warm = await f.read(exact);
    expect(warm.entries.find(({ row }) => row.id === `remote-${i}`)?.row)
      .toMatchObject({ threadStatus: "active", federation: { peerStatus: "connected" } });
    f.reset();
    const version = f.store.readNavigationSourceVersion();
    const { writes } = await measureSqliteWrites(async () => {
      f.disconnect();
      await f.queries.refresh(); await until(f.idle);
    });
    const budget = { ipc: f.read.mock.calls.length, listings: f.provider.mock.calls.length,
      materializations: f.materialize.mock.calls.length, pins: f.resolve.mock.calls.length,
      snapshots: f.snapshots.mock.calls.length, commits: writes.commits };
    const disconnected = await f.read(exact);
    // The owning peer is no longer live; saved rows preserve identity,
    // membership and viewer rank, but never attest to a running turn.
    expect(disconnected.entries).toHaveLength(n);
    for (const { row } of disconnected.entries) {
      expect(row.federation?.peerStatus).toBe("disconnected");
      expect(row.threadStatus).not.toBe("active");
      expect(row.ref.ownerInstanceId).toBe("peer");
      expect(row.pinnedRank).toBe(warm.entries.find((entry) => entry.row.id === row.id)?.row.pinnedRank);
    }
    expect(f.store.readNavigationSourceVersion()).toBe(version);
    expect(budget).toEqual({ ipc: 1 + 2 * n, listings: 0, materializations: 0, pins: 1, snapshots: 1, commits: 0 });
  } finally { f.close(); vi.useRealTimers(); }
}

it("dims a warm active pin immediately when its peer disconnects", async () => {
  await expectDisconnectedViewer(2, 0);
});

it("matches peer connectivity after a warm viewer pass without re-listing the unchanged owner", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom(2, 4, 8), fc.nat(100), expectDisconnectedViewer),
    { numRuns: 5, examples: [[4, 0], [8, 7], [2, 1]] });
});

it("fences a disconnect during an active pin projection without discarding the unchanged owner scan", async () => {
  vi.useFakeTimers();
  const f = await fixture(2);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const exact: NavigationQueryRequest = { protocol: 2, inventory: "viewer", consumer: "main-sidebar",
    query: { kind: "exact", identities: [{ backend: "codex", threadId: "remote-0", ownerInstanceId: "peer" }] } };
  try {
    f.queries.setDemand(f.requests); await until(f.idle);
    await f.remote(0, "Live owner", true);
    await f.queries.refresh(); await until(f.idle);
    await f.queries.refresh(); await until(f.idle); f.reset();
    const original = RemoteThreadSummaryCache.prototype.resolvePinnedThreads.bind(f.cache);
    f.resolve.mockImplementationOnce(async (pins) => { const result = await original(pins); await gate; return result; });
    const { result: [old, fresh], writes } = await measureSqliteWrites(async () => {
      f.emit({ backend: "codex", notification: { method: "navigation/remoteThreadPins/changed", params: { instanceId: "peer" } } });
      const old = f.read(exact);
      await until(() => f.resolve.mock.calls.length === 1);
      f.disconnect();
      const fresh = f.read(exact);
      finish();
      return await Promise.all([old, fresh]);
    });
    expect(old.entries[0]?.row).toMatchObject({ threadStatus: "active", federation: { peerStatus: "connected" } });
    expect(fresh.entries[0]?.row.federation?.peerStatus).toBe("disconnected");
    expect(fresh.entries[0]?.row.threadStatus).not.toBe("active");
    const retained = await f.read(exact);
    expect(retained.entries[0]?.row.federation?.peerStatus).toBe("disconnected");
    expect({ ipc: f.read.mock.calls.length, listings: f.provider.mock.calls.length,
      materializations: f.materialize.mock.calls.length, pins: f.resolve.mock.calls.length,
      snapshots: f.snapshots.mock.calls.length, commits: writes.commits })
      .toEqual({ ipc: 3, listings: 0, materializations: 0, pins: 2, snapshots: 2, commits: 0 });
  } finally { finish(); f.close(); vi.useRealTimers(); }
});

it("uses the complete pin and watched membership for an exact selection's project controls without repeating pin resolution", async () => {
  const cases = [2, 4, 8].flatMap(n => [false, true].flatMap(otherPeer =>
    [false, true].map(otherProject => ({ n, otherPeer, otherProject }))));
  for (const { n, otherPeer, otherProject } of cases) {
    const f = await fixture(n);
    const paused: ProjectForgeAutomation = { paused: true, pausedAt: 1, autoFixMergeConflicts: true,
      autoFixCiFailures: true, prWatches: true, prOffers: true, refuseThreadMessages: false, wakeupPolicy: "hold" };
    const row = (id: string, owner: string, project: string, automation?: ProjectForgeAutomation): NavigationThreadSummary => ({
      ...thread(id, 0), linkedDirectories: [{ id: project, kind: "local", label: "repo", path: project.slice("directory:".length) }],
      homeProject: { directoryKey: project, ...(automation ? { forgeAutomation: automation } : {}) },
      federation: { ref: buildFederatedThreadRef({ backend: "codex", instanceId: owner, threadId: id }), instanceLabel: owner },
    });
    f.provider.mockResolvedValue([]);
    f.resolve.mockResolvedValue({ threads: Array.from({ length: n }, (_, i) => row(`remote-${i}`, "peer", "directory:/owner/repo", paused)),
      refreshed: [], archived: [] });
    const owner = otherPeer ? "other" : "peer";
    const project = otherProject ? "directory:/elsewhere/repo" : "directory:/owner/repo";
    vi.spyOn(f.cache, "resolveWatchedThreads").mockReturnValue([row("watched", owner, project,
      otherPeer || otherProject ? undefined : paused)]);
    const index: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", inventory: "viewer", query: { kind: "directory-index" } };
    const exact: NavigationQueryRequest = { ...index, query: { kind: "exact", resolveFromOwners: true,
      identities: [{ backend: "codex", threadId: "watched", ownerInstanceId: owner }], includeAncestry: true, ancestryScope: "directory" } };
    try {
      const { writes } = await measureSqliteWrites(async () => {
        const pinned = await f.read(index);
        expect(pinned.directories?.[0]?.forgeAutomation).toEqual(paused);
        for (let i = 0; i < 3; i++) {
          const selected = await f.read(exact);
          expect(selected.entries[0]?.row.ref.ownerInstanceId).toBe(owner);
          expect(selected.selectionDirectory?.peerProject).toEqual(otherPeer || otherProject ? undefined
            : { target: { scope: "remote", instanceId: "peer" }, directoryKey: "directory:/owner/repo" });
          expect(selected.selectionDirectory?.forgeAutomation).toEqual(otherPeer || otherProject ? undefined : paused);
        }
        const unchanged = await f.read(index);
        expect(unchanged.directories?.[0]?.peerProject).toEqual({ target: { scope: "remote", instanceId: "peer" }, directoryKey: "directory:/owner/repo" });
        expect(unchanged.directories?.[0]?.forgeAutomation).toEqual(paused);
      });
      expect(writes.commits).toBe(0);
      expect(f.resolve).toHaveBeenCalledTimes(1);
      expect(f.snapshots).toHaveBeenCalledTimes(1);
      expect(f.provider).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  }
});

it.each([4, 8])("budgets manual refresh and automatic turn-end passes with %i directories, children, pins and relationship rows", async (n) => {
  vi.useFakeTimers();
  const f = await fixture(n);
  try {
    f.queries.setDemand(f.requests); await until(f.idle); f.reset();
    const { writes } = await measureSqliteWrites(async () => {
      await f.queries.refresh(); await until(f.idle);
    });
    expectSqliteWriteBudget({ scenario: "navigation-viewer-manual-refresh", writes,
      note: "One explicit refresh of 4/8 directories, children and pins: zero commits, 0 MB/day added WAL." });
    // An explicit full refresh legitimately reads each demanded collection.
    expect({ ipc: f.read.mock.calls.length, provider: f.provider.mock.calls.length,
      materializations: f.materialize.mock.calls.length, pins: f.resolve.mock.calls.length,
      snapshots: f.snapshots.mock.calls.length, commits: writes.commits })
      .toEqual({ ipc: 1 + 2 * n, provider: 0, materializations: 0, pins: 0, snapshots: 0, commits: 0 });
    f.reset();
    // Move past the display lease. The live owner and viewer projections remain available.
    await vi.advanceTimersByTimeAsync(15_001);
    const { writes: coldWrites } = await measureSqliteWrites(async () => {
      await f.queries.refresh(); await until(f.idle);
    });
    expectSqliteWriteBudget({ scenario: "navigation-viewer-cold-manual-refresh", writes: coldWrites,
      note: "One explicit refresh after index expiry, across 4/8 projects: zero commits, 0 MB/day added WAL." });
    expect({ ipc: f.read.mock.calls.length, provider: f.provider.mock.calls.length,
      materializations: f.materialize.mock.calls.length, pins: f.resolve.mock.calls.length,
      snapshots: f.snapshots.mock.calls.length, commits: coldWrites.commits })
      .toEqual({ ipc: 1 + 2 * n, provider: 0, materializations: 0, pins: 0, snapshots: 0, commits: 0 });
    f.reset(); f.change(0);
    const relationshipGeneration = () => f.db.raw.prepare("SELECT generation FROM thread_navigation_relationship_generation").get();
    const before = relationshipGeneration();
    f.db.raw.prepare("UPDATE thread_sub_agents SET status = 'completed', card = json_set(card, '$.status', 'completed')").run();
    expect(relationshipGeneration()).toEqual(before);
    const events: AgentEvent[] = [
      { backend: "codex", notification: { method: "thread/subAgents/updated", params: { threadId: "root-0", subAgents: [] } } },
      { backend: "codex", notification: { method: "thread/subAgents/updated", params: { threadId: "root-0", subAgents: [] } } },
      { backend: "codex", notification: { method: "thread/turnQueue/updated", params: { threadId: "root-0", queuedTurns: [] } } },
      { backend: "codex", notification: { method: "turn/completed", params: { threadId: "root-0", turn: { id: "turn", status: "completed" } } } },
      { backend: "codex", notification: { method: "thread/status/changed", params: { threadId: "root-0", status: { type: "idle" } } } },
    ] as AgentEvent[];
    const { writes: turnWrites } = await measureSqliteWrites(async () => {
      for (const event of events) f.emit(event);
      await f.queries.refresh(undefined, undefined, true); await until(f.idle);
    });
    expectSqliteWriteBudget({ scenario: "navigation-viewer-turn-end", writes: turnWrites,
      note: "One subagent/queue/turn-completed/status wave across 4/8 projects: zero query commits, 0 MB/day added WAL." });
    expect({ ipc: f.read.mock.calls.length, provider: f.provider.mock.calls.length,
      materializations: f.materialize.mock.calls.length, pins: f.resolve.mock.calls.length,
      snapshots: f.snapshots.mock.calls.length, commits: turnWrites.commits })
      .toEqual({ ipc: 3, provider: 0, materializations: 0, pins: 0, snapshots: 0, commits: 0 });
    expect(f.read.mock.calls.map(([request]) => request.query.kind)).toEqual(["directory-index", "directory", "children"]);
    const exact = await f.read({ protocol: 2, inventory: "viewer", consumer: "main-sidebar",
      query: { kind: "exact", identities: [{ backend: "codex", threadId: "root-0" }] } });
    expect(exact.entries[0]?.row.threadStatus).toBe("idle");
  } finally { f.close(); vi.useRealTimers(); }
});

it("keeps an unchanged owner refresh silent and publishes the next changed row", async () => {
  const f = await fixture(2);
  const ref = buildFederatedThreadRef({ backend: "codex", instanceId: "peer", threadId: "remote-0" });
  try {
    f.queries.setDemand(f.requests); await until(f.idle);
    for (const change of [
      { title: "5", active: true },
      { title: "5", active: true },
      { title: " ", active: false },
    ]) {
      await f.remote(0, change.title, change.active);
      await f.store.setRemoteThreadLocalPin({ ref, pinned: false });
      const exact = await f.read({ protocol: 2, inventory: "viewer", consumer: "main-sidebar",
        query: { kind: "exact", identities: [0, 1].map((i) => ({ backend: "codex", threadId: `remote-${i}`, ownerInstanceId: "peer" })) } });
      expect(exact.entries.map(({ row }) => ({ id: row.id, title: row.title, status: row.threadStatus, pinned: Boolean(row.pinnedRank) })))
        .toEqual([
          { id: "remote-0", title: change.title, status: change.active ? "active" : "idle", pinned: false },
          { id: "remote-1", title: "remote-1", status: "idle", pinned: false },
        ]);
    }
  } finally { f.close(); }
});

it("matches the owning peer and viewer pin model after generated publications and pin edits, including off-page identities", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 5 }),
    fc.array(fc.record({ index: fc.nat(100), active: fc.boolean(), pinned: fc.boolean(), title: fc.string({ minLength: 1, maxLength: 20 }) }),
      { minLength: 1, maxLength: 5 }), async (n, changes) => {
      const f = await fixture(n);
      try {
        f.queries.setDemand(f.requests); await until(f.idle);
        const titles = new Map<number, string>();
        const active = new Map<number, boolean>();
        const ranked = new Set<number>();
        for (const change of changes) {
          const i = change.index % n;
          titles.set(i, change.title); active.set(i, change.active);
          await f.remote(i, change.title, change.active);
          const ref = buildFederatedThreadRef({ backend: "codex", instanceId: "peer", threadId: `remote-${i}` });
          await f.store.setRemoteThreadLocalPin({ ref, pinned: change.pinned });
          if (change.pinned) ranked.add(i); else ranked.delete(i);
          const exact = await f.read({ protocol: 2, inventory: "viewer", consumer: "main-sidebar",
            query: { kind: "exact", identities: Array.from({ length: n }, (_, j) => ({ backend: "codex", threadId: `remote-${j}`, ownerInstanceId: "peer" })) } });
          expect(exact.entries).toHaveLength(n);
          for (const { row } of exact.entries) {
            const j = Number(row.id.split("-")[1]);
            expect(row.title).toBe(titles.get(j) ?? `remote-${j}`);
            expect(row.threadStatus).toBe(active.get(j) ? "active" : "idle");
            expect(Boolean(row.pinnedRank)).toBe(ranked.has(j));
            expect(row.pinnedRank).not.toBe(`owner-${j}`);
            expect(row.ref.ownerInstanceId).toBe("peer");
          }
        }
        const ref = buildFederatedThreadRef({ backend: "codex", instanceId: "peer", threadId: "remote-0" });
        await f.store.removeRemoteThreadPin({ ref });
        const removed = await f.read({ protocol: 2, inventory: "viewer", consumer: "main-sidebar",
          query: { kind: "exact", identities: [{ backend: "codex", threadId: "remote-0", ownerInstanceId: "peer" }] } });
        expect(removed.entries).toHaveLength(0);
        await f.store.addRemoteThreadPin({ ref, summary: thread("remote-0", 0), instanceLabel: "Peer" });
        const restored = await f.read({ protocol: 2, inventory: "viewer", consumer: "main-sidebar",
          query: { kind: "exact", identities: [{ backend: "codex", threadId: "remote-0", ownerInstanceId: "peer" }] } });
        expect(restored.entries[0]?.row.ref).toMatchObject({ ownerInstanceId: "peer", threadId: "remote-0" });
      } finally { f.close(); }
    }), { numRuns: 5, examples: [[5, [{ index: 4, active: true, pinned: true, title: "Off page" },
      { index: 4, active: false, pinned: false, title: "Updated" }]]] });
});

it.each([4, 8])("bounds an automatic completion overtaking a row update with %i projects", async (n) => {
  const f = await fixture(n);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  try {
    await f.mountVerified(); f.reset(); f.change(0);
    f.hydrate.mockImplementationOnce(async (rows) => { await gate; return rows; });
    const { writes } = await measureSqliteWrites(async () => {
      f.emit({ backend: "codex", notification: { method: "thread/subAgents/updated", params: { threadId: "root-0", subAgents: [] } } } as AgentEvent);
      const first = f.queries.refresh(undefined, undefined, true);
      await until(() => f.hydrate.mock.calls.length === 1);
      f.emit({ backend: "codex", notification: { method: "turn/completed", params: { threadId: "root-0", turn: { id: "turn", status: "completed" } } } } as AgentEvent);
      f.emit({ backend: "codex", notification: { method: "thread/status/changed", params: { threadId: "root-0", status: { type: "idle" } } } });
      const second = f.queries.refresh(undefined, undefined, true);
      finish(); await Promise.all([first, second]); await until(f.idle);
    });
    expectSqliteWriteBudget({ scenario: "navigation-viewer-pending-turn-end", writes,
      note: "A completion/status boundary overtakes a pending listing across 4/8 projects: zero query commits, 0 MB/day added WAL." });
    expect({ ipc: f.read.mock.calls.length, listings: f.provider.mock.calls.length,
      materializations: f.materialize.mock.calls.length, pins: f.resolve.mock.calls.length, snapshots: f.snapshots.mock.calls.length })
      .toEqual({ ipc: 6, listings: 0, materializations: 0, pins: 0, snapshots: 0 });
    const exact = await f.read({ protocol: 2, inventory: "viewer", consumer: "main-sidebar",
      query: { kind: "exact", identities: [{ backend: "codex", threadId: "root-0" }] } });
    expect(exact.entries[0]?.row.threadStatus).toBe("idle");
  } finally { finish(); f.close(); }
});

it("fences a pin membership edit during a pending projection and retains the old cursor's inventory", async () => {
  const f = await fixture(4);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const original = RemoteThreadSummaryCache.prototype.resolvePinnedThreads.bind(f.cache);
  f.resolve.mockImplementationOnce(async (pins) => { const result = await original(pins); await gate; return result; });
  try {
    const request: NavigationQueryRequest = { protocol: 2, inventory: "viewer", consumer: "main-sidebar", pageSize: 1,
      query: { kind: "lens", lens: "recents" } };
    const old = f.read(request);
    await until(() => f.resolve.mock.calls.length === 1);
    await f.store.addRemoteThreadPin({ ref: buildFederatedThreadRef({ backend: "codex", instanceId: "peer", threadId: "new-off-page" }),
      summary: thread("new-off-page", 0), instanceLabel: "Peer" });
    const fresh = f.read({ ...request, query: { kind: "exact", identities: [{ backend: "codex", threadId: "new-off-page", ownerInstanceId: "peer" }] } });
    finish();
    const first = await old;
    expect((await fresh).entries[0]?.row.id).toBe("new-off-page");
    expect(first.nextCursor).toBeDefined();
    const second = await f.read({ ...request, cursor: first.nextCursor });
    expect(second.generation).toBe(first.generation);
    expect(second.entries.some(({ row }) => row.id === "new-off-page")).toBe(false);
    expect(f.resolve).toHaveBeenCalledTimes(2);
  } finally { finish(); f.close(); }
});

it("lets a remaining consumer finish the shared viewer projection after another consumer cancels", async () => {
  const f = await fixture(4);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const original = RemoteThreadSummaryCache.prototype.resolvePinnedThreads.bind(f.cache);
  f.resolve.mockImplementationOnce(async (pins) => { const result = await original(pins); await gate; return result; });
  const pool = getDesktopNavigationQueryPool();
  const service = initializeDesktopAppServerService();
  try {
    const first = service.getNavigationQueryPage(f.requests.get("index")!, "cancel-viewer").catch((error: unknown) => error);
    const second = service.getNavigationQueryPage(f.requests.get("children-0")!, "retain-viewer");
    await until(() => f.resolve.mock.calls.length === 1);
    pool.release("cancel-viewer");
    finish();
    expect(await first).toMatchObject({ code: "navigation_busy" });
    expect((await second).entries.map(({ row }) => row.id)).toEqual(["child-0"]);
    expect(f.resolve).toHaveBeenCalledTimes(1);
  } finally { finish(); pool.release("cancel-viewer"); pool.release("retain-viewer"); f.close(); }
});

it.each([4, 8])("persists one changed owner pin once across a full refresh with %i projects", async (n) => {
  const f = await fixture(n);
  try {
    f.queries.setDemand(f.requests); await until(f.idle);
    await f.remote(0, "Warm owner", false);
    await f.queries.refresh(); await until(f.idle);
    // Establish the post-write source generation outside the action budget.
    await f.queries.refresh(); await until(f.idle); f.reset();
    const { writes } = await measureSqliteWrites(async () => {
      await f.remote(0, "Changed owner", true);
      await f.queries.refresh(); await until(f.idle);
    });
    expectSqliteWriteBudget({ scenario: "navigation-viewer-owner-publication", writes,
      note: "One changed owner pin across 4/8 projects commits once; unchanged reads add zero. At 200 changes/day: ~0.8 MB/day per dirty 4 KiB page, no new recurring writes." });
    expect(writes.commits).toBe(1);
    expect(f.resolve.mock.calls.length).toBeLessThanOrEqual(2);
    expect(f.snapshots.mock.calls.length).toBeLessThanOrEqual(2);
    const saved = await f.store.readRemoteThreadPinNavigationRows();
    expect(saved.find((row) => row.id === "remote-0")).toMatchObject({ title: "Changed owner", threadStatus: "active" });
  } finally { f.close(); }
});


it.each(["changed catalog", "failed checkout lookup", "failed preflight lookup", "failed inferred checkout lookup"] as const)(
  "keeps stack automation gated with a %s", async (change) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-hold-recheck-"));
  const db = openInMemoryStateDb();
  const restoreGitEnvironment = isolateProcessGitEnvironment();
  const entered = Promise.withResolvers<void>();
  const listing = Promise.withResolvers<AppServerListThreadsResponse>();
  const finish = () => listing.resolve({ backend: "all", fetchedAt: 0, threads: [] });
  const git = (...args: string[]) => runIsolatedGitSync(cwd, args).trim();
  try {
    git("init", "-b", "upper");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "upper");
    const head = git("rev-parse", "HEAD");
    git("branch", "lower");
    if (change === "failed checkout lookup") git("config", "include.path", "fixture-git-include");
    const catalog = path.join(cwd, ".git", "gh-stack");
    const layer = (branch: string, number: number) => ({ branch, head, base: head, pullRequest: { number } });
    const write = (...branches: ReturnType<typeof layer>[]) => writeFile(catalog, JSON.stringify({
      schemaVersion: 1, repository: "github.com:fixture/stack",
      stacks: [{ trunk: { branch: "main", head }, branches }],
    }));
    const inferred = change === "failed inferred checkout lookup";
    if (!inferred) {
      await write(...(change === "changed catalog" ? [layer("upper", 2)] : [layer("lower", 1), layer("upper", 2)]));
    }
    current.store = new SqliteOverlayStore(db);
    resetAppServerServiceForTests();
    const service = initializeDesktopAppServerService();
    vi.spyOn(service as unknown as { prStackDirectories: () => string[] }, "prStackDirectories").mockReturnValue([cwd]);
    const list = vi.spyOn(service, "listThreads").mockImplementation(async () => {
      entered.resolve();
      return await listing.promise;
    });
    const pr: PrSummary = {
      number: 2, provider: "github.com", org: "fixture", repo: "stack", state: "passing",
      lifecycleState: "open", url: "https://github.com/fixture/stack/pull/2", headRefName: "upper",
      ...(inferred && { baseRefName: "lower" }),
    };
    if (inferred) {
      vi.spyOn(service as unknown as { knownStackPullRequests: () => PrSummary[] }, "knownStackPullRequests").mockReturnValue([{
        ...pr, number: 1, url: "https://github.com/fixture/stack/pull/1", headRefName: "lower", baseRefName: "main",
      }]);
    }
    const failCheckout = () => {
      const runGitCommand = gitExecutable.runGitCommand;
      vi.spyOn(gitExecutable, "runGitCommand").mockImplementation((directory, args, options) =>
        directory === cwd && args[0] === "rev-parse"
          ? Promise.reject(Object.assign(new Error("fixture checkout timeout"), { killed: true }))
          : runGitCommand(directory, args, options));
    };
    if (change === "failed preflight lookup") {
      finish();
      expect(await service["prStackHoldEvidence"](pr)).toMatchObject({
        reason: expect.stringContaining("Held by #1:"), lowerKey: "github.com/fixture/stack#1",
      });
      failCheckout();
      expect(await service["prStackHoldEvidence"](pr)).toEqual({ reason: "Held while stack settlement is unavailable" });
      expect(list).toHaveBeenCalledOnce();
      return;
    }
    const gate = change === "changed catalog"
      ? service["readPrStacks"](pr).then((stacks) => stacks[0]?.layers[1])
      : service["prStackHoldEvidence"](pr);
    await entered.promise;
    if (change === "changed catalog") await write(layer("lower", 1), layer("upper", 2));
    else failCheckout();
    finish();
    if (change === "changed catalog") expect(await gate).toMatchObject({ branch: "upper", heldBy: { branch: "lower", number: 1 } });
    else expect(await gate).toEqual({ reason: "Held while stack settlement is unavailable" });
  } finally {
    finish();
    restoreGitEnvironment();
    db.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

it("keys stack automation hold evidence to the blocking PR in the catalog", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-hold-key-"));
  const db = openInMemoryStateDb();
  const restore = isolateProcessGitEnvironment();
  const git = (...args: string[]) => runIsolatedGitSync(cwd, args).trim();
  try {
    git("init", "-b", "upper");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "upper");
    const head = git("rev-parse", "HEAD");
    git("branch", "lower");
    current.store = new SqliteOverlayStore(db);
    resetAppServerServiceForTests();
    const service = initializeDesktopAppServerService();
    vi.spyOn(service as unknown as { prStackDirectories: () => string[] }, "prStackDirectories").mockReturnValue([cwd]);
    vi.spyOn(service, "listThreads").mockResolvedValue({ backend: "all", fetchedAt: 0, threads: [] });

    // The numeric values are labels. Change the catalog once to also check
    // that a prior blocking PR key is not reused.
    for (const [lower, gap] of [[1, 1], [10_000, 100]] as const) {
      const upper = lower + gap;
      await writeFile(path.join(cwd, ".git", "gh-stack"), JSON.stringify({
        schemaVersion: 1, repository: "github.com:fixture/stack",
        stacks: [{ trunk: { branch: "main", head }, branches: [
          { branch: "lower", head, base: head, pullRequest: { number: lower } },
          { branch: "upper", head, base: head, pullRequest: { number: upper } },
        ] }],
      }));
      const pr: PrSummary = {
        number: upper, provider: "github.com", org: "fixture", repo: "stack", state: "passing",
        lifecycleState: "open", url: `https://github.com/fixture/stack/pull/${upper}`, headRefName: "upper",
      };
      expect(await service["prStackHoldEvidence"](pr)).toMatchObject({
        reason: expect.stringContaining(`Held by #${lower}:`), lowerKey: `github.com/fixture/stack#${lower}`,
      });
    }
  } finally {
    restore();
    db.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

it.each(["absent", "unrelated"])("skips listing threads for a standalone PR with an %s catalog under installed Git", async (catalog) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-no-hold-"));
  const restore = isolateProcessGitEnvironment();
  const git = (...args: string[]) => runIsolatedGitSync(cwd, args).trim();
  try {
    git("init", "-b", "standalone");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "standalone");
    if (catalog === "unrelated") {
      const head = git("rev-parse", "HEAD");
      await writeFile(path.join(cwd, ".git", "gh-stack"), JSON.stringify({
        schemaVersion: 1, repository: "github.com:fixture/stack",
        stacks: [{ trunk: { branch: "main", head },
          branches: [{ branch: "separate-layer", head, base: head, pullRequest: { number: 1 } }] }],
      }));
    }
    process.env.PWRAGENT_GIT_PATH = await gitExecutable.resolveGitExecutable();
    resetAppServerServiceForTests();
    const service = initializeDesktopAppServerService();
    vi.spyOn(service as unknown as { prStackDirectories: () => string[] }, "prStackDirectories").mockReturnValue([cwd]);
    const list = vi.spyOn(service, "listThreads").mockRejectedValue(new Error("Thread listing is unavailable"));
    const pr: PrSummary = {
      number: 2, provider: "github.com", org: "fixture", repo: "stack", state: "passing",
      lifecycleState: "open", url: "https://github.com/fixture/stack/pull/2", headRefName: "standalone",
    };
    expect(await service["prStackHoldEvidence"](pr)).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
  } finally {
    restore();
    await rm(cwd, { recursive: true, force: true });
  }
});

it("reuses installed Git for repeated merge offers while reading the live guard and new catalogs", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pwragent-stack-merge-offer-reuse-"));
  const restore = isolateProcessGitEnvironment();
  const start = vi.spyOn(gitSubprocessDiagnostics, "startGit");
  const git = (...args: string[]) => runIsolatedGitSync(cwd, args).trim();
  try {
    git("init", "-b", "upper");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "upper");
    const head = git("rev-parse", "HEAD");
    process.env.PWRAGENT_GIT_PATH = await gitExecutable.resolveGitExecutable();
    resetAppServerServiceForTests();
    const service = initializeDesktopAppServerService();
    vi.spyOn(service as unknown as { prReviewOfferDirectories: () => string[] }, "prReviewOfferDirectories").mockReturnValue([cwd]);
    const requestGithubForMergeOffer = vi.fn<ForgeCiClient["requestGithubForMergeOffer"]>(async (_repo, request) => {
      if (request.graphql) return { data: { repository: { pullRequest: {
        baseRefName: "main", headRefOid: head, timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: [] },
      } } } };
      if (request.path.endsWith("/pulls/2")) return {
        created_at: "2026-01-01T00:00:00Z",
        base: { ref: "main", repo: { default_branch: "main" } },
        head: { ref: "upper", sha: head, repo: { full_name: "fixture/stack" } },
      };
      if (request.path.endsWith("/pulls/1")) return { merged: false };
      throw new Error("Unexpected forge request");
    });
    vi.spyOn(service as unknown as { getForgeCiClient: () => Pick<ForgeCiClient, "requestGithubForMergeOffer"> }, "getForgeCiClient")
      .mockReturnValue({ requestGithubForMergeOffer });
    const pr: PrSummary = {
      number: 2, provider: "github.com", org: "fixture", repo: "stack", state: "passing",
      lifecycleState: "open", url: "https://github.com/fixture/stack/pull/2", headRefName: "upper", baseRefName: "main",
    };
    const offer = () => service["readStackMergeEvidence"]({ backend: "codex", threadId: "fixture" }, pr);
    const checkoutStarts = () => start.mock.calls.filter(([directory, args]) => directory === cwd && args[0] === "rev-parse");
    expect(await offer()).toMatchObject({ blocked: false });
    expect(await offer()).toMatchObject({ blocked: false });
    expect(requestGithubForMergeOffer.mock.calls.filter(([, request]) => request.graphql)).toHaveLength(2);
    expect(checkoutStarts()).toHaveLength(1);
    await writeFile(path.join(cwd, ".git", "gh-stack"), JSON.stringify({
      schemaVersion: 1, repository: "github.com:fixture/stack",
      stacks: [{ trunk: { branch: "main", head }, branches: [
        { branch: "lower", head, base: head, pullRequest: { number: 1 } },
        { branch: "upper", head, base: head, pullRequest: { number: 2 } },
      ] }],
    }));
    expect(await offer()).toMatchObject({ blocked: true, lowerKeys: ["github.com/fixture/stack#1"] });
    expect(requestGithubForMergeOffer.mock.calls.filter(([, request]) => request.path.endsWith("/pulls/2"))).toHaveLength(3);
    expect(checkoutStarts()).toHaveLength(1);
  } finally {
    start.mockRestore();
    restore();
    await rm(cwd, { recursive: true, force: true });
  }
});

it("keeps watch and healthy PR status when a different PR's stack read fails", async () => {
  const db = openInMemoryStateDb();
  try {
    const store = new SqliteOverlayStore(db);
    current.store = store;
    resetAppServerServiceForTests();
    const service = initializeDesktopAppServerService();
    const thread = { backend: "codex" as const, threadId: "fixture" };
    const healthy: PrSummary = {
      number: 2, provider: "github.com", org: "fixture", repo: "stack", state: "passing",
      lifecycleState: "open", url: "https://github.com/fixture/stack/pull/2", headRefName: "healthy",
    };
    const unavailable = { ...healthy, number: 1, url: "https://github.com/fixture/stack/pull/1", headRefName: "unavailable" };
    const watch: ThreadPullRequestWatchSummary = {
      ...thread, watchId: "fixture-watch", prKey: "github.com/fixture/stack#2", prUrl: healthy.url, prNumber: 2,
      headSha: "a".repeat(40), notifyOn: ["success"], createdAt: 1, failureHandledByAutoFix: false,
    };
    const stack: StackSummary = {
      key: "fixture-stack", name: "healthy", repository: "github.com:fixture/stack", inferred: false, trunk: "main",
      layers: [{ branch: "healthy", parent: "main", health: "in_sync", role: "unbound", pullRequest: { number: 2 } }],
    };
    vi.spyOn(store, "listActiveThreadPrStatusWatches").mockResolvedValue([watch]);
    const internals = service as unknown as {
      primaryAttachedPrsForThread: () => PrSummary[];
      readPrReviewReadiness: () => Promise<[]>;
      resolveThreadForgeProject: () => undefined;
      threadForgeDirectoryKey: () => string | undefined;
      readPrStacks: (pr: PrSummary) => Promise<StackSummary[]>;
    };
    vi.spyOn(internals, "threadForgeDirectoryKey").mockReturnValue(undefined);
    vi.spyOn(internals, "primaryAttachedPrsForThread").mockReturnValue([unavailable, healthy]);
    vi.spyOn(internals, "readPrReviewReadiness").mockResolvedValue([]);
    vi.spyOn(internals, "resolveThreadForgeProject").mockReturnValue(undefined);
    vi.spyOn(internals, "readPrStacks").mockImplementation(async ({ number }) => {
      if (number === 1) throw new Error("fixture checkout timeout");
      return [stack];
    });
    const status = await service.getThreadPullRequestAutomationStatus(thread);
    expect(status.watches).toEqual([watch]);
    expect(status.autoFixEnabled).toBe(false);
    expect(status.guidance).toContain("#1 is held while stack settlement is unavailable.");
    expect(status.guidance).toContain("#2 is layer 1 of 1");
  } finally {
    db.close();
  }
});

it("switches Auto-fix off for one PR: it leaves the thread's candidacy and guidance, and comes back when switched on", async () => {
  const db = openInMemoryStateDb();
  try {
    const store = new SqliteOverlayStore(db);
    current.store = store;
    current.registry = {
      publishLocalEvent: vi.fn(async () => undefined),
      getThreadInfo: () => undefined,
      invalidateWorktreeWorkingState: vi.fn(),
    } as unknown as DesktopBackendRegistry;
    resetAppServerServiceForTests();
    const service = initializeDesktopAppServerService();
    const thread = { backend: "codex" as const, threadId: "fixture" };
    const upstream: PrSummary = {
      number: 7, provider: "github.com", org: "upstream", repo: "t3code", state: "failing",
      lifecycleState: "open", url: "https://github.com/upstream/t3code/pull/7",
      sourceRepository: { provider: "github.com", org: "fork", repo: "t3code" },
    };
    const fork: PrSummary = {
      number: 3, provider: "github.com", org: "fork", repo: "t3code", state: "failing",
      lifecycleState: "open", url: "https://github.com/fork/t3code/pull/3",
    };
    await store.setThreadPrAutoDispatchEnabled({ ...thread, enabled: true });
    await store.setThreadPullRequests({ ...thread, prs: [upstream, fork], fetchedAt: 1 });
    const internals = service as unknown as {
      attachedPrsByThreadKey: Map<string, { backend: "codex"; primaryRepoKey: string; prs: PrSummary[] }>;
      readPrReviewReadiness: () => Promise<[]>;
      resolveThreadForgeProject: () => undefined;
      threadForgeDirectoryKey: () => string | undefined;
      readPrStacks: () => Promise<StackSummary[]>;
    };
    vi.spyOn(internals, "threadForgeDirectoryKey").mockReturnValue(undefined);
    internals.attachedPrsByThreadKey.set("codex:fixture", {
      backend: "codex", primaryRepoKey: "github.com/fork/t3code", prs: [upstream, fork],
    });
    vi.spyOn(internals, "readPrReviewReadiness").mockResolvedValue([]);
    vi.spyOn(internals, "resolveThreadForgeProject").mockReturnValue(undefined);
    vi.spyOn(internals, "readPrStacks").mockResolvedValue([]);
    const candidates = async () => (await store.listPrAutoDispatchCandidates(thread)).map((row) => row.prKey).sort();

    await service.setThreadPullRequestAutoFix({ ...thread, prKey: "github.com/upstream/t3code#7", enabled: false });
    expect((await store.getThreadOverlayState(thread))?.prs?.map((pr) => [pr.number, pr.autoFixOff])).toEqual([
      [7, true], [3, undefined],
    ]);
    expect(await candidates()).toEqual(["github.com/fork/t3code#3"]);
    expect((await service.getThreadPullRequestAutomationStatus(thread)).guidance)
      .toContain("Auto-fix is switched off for upstream/t3code#7 in this thread");

    // A lookup reports provider status only; the switch survives it.
    await store.setThreadPullRequests({ ...thread, prs: [{ ...upstream, title: "Refreshed" }, fork], fetchedAt: 2 });
    expect((await store.getThreadOverlayState(thread))?.prs?.[0]).toMatchObject({ title: "Refreshed", autoFixOff: true });

    await service.setThreadPullRequestAutoFix({ ...thread, prKey: "github.com/upstream/t3code#7", enabled: true });
    expect(await candidates()).toEqual(["github.com/fork/t3code#3", "github.com/upstream/t3code#7"]);
    expect((await service.getThreadPullRequestAutomationStatus(thread)).guidance).not.toContain("switched off");
  } finally {
    db.close();
  }
});

it("saves a proposed hands-off rule to the thread's project once, and reports the gates to the agent", async () => {
  const { getProjectForgeAutomationIndex } = await import("../app-server/project-forge-automation-index");
  const db = openInMemoryStateDb();
  try {
    const store = new SqliteOverlayStore(db);
    current.store = store;
    current.registry = {
      publishLocalEvent: vi.fn(async () => undefined),
      getThreadInfo: () => undefined,
      getCachedThreadSummary: () => undefined,
      invalidateWorktreeWorkingState: vi.fn(),
    } as unknown as DesktopBackendRegistry;
    resetAppServerServiceForTests();
    const service = initializeDesktopAppServerService();
    const thread = { backend: "codex" as const, threadId: "fixture" };
    const index = getProjectForgeAutomationIndex();
    let stored: ProjectForgeAutomation | undefined;
    vi.spyOn(index, "directoryKeyForThread").mockReturnValue("directory:/work/t3code");
    vi.spyOn(index, "label").mockReturnValue("t3code");
    vi.spyOn(index, "get").mockImplementation(() => stored);
    const save = vi.spyOn(service, "setProjectForgeAutomation").mockImplementation(async (request) => {
      stored = request.automation;
      return {} as Awaited<ReturnType<typeof service.setProjectForgeAutomation>>;
    });

    await expect(service.addThreadProjectHandsOffRule({ ...thread, repository: "github.com/Upstream/t3code", label: "takeover:*" }))
      .resolves.toEqual({ summary: "t3code now leaves PRs into Upstream/t3code labeled takeover:* hands-off" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(stored?.handsOff).toEqual([{ repository: "Upstream/t3code", label: "takeover:*" }]);
    // The same rule again, in any case, changes nothing.
    await expect(service.addThreadProjectHandsOffRule({ ...thread, repository: "upstream/T3CODE", label: "TAKEOVER:*" }))
      .resolves.toMatchObject({ summary: expect.stringContaining("already leaves") });
    expect(save).toHaveBeenCalledTimes(1);
    await expect(service.addThreadProjectHandsOffRule({ ...thread, repository: "t3code" })).rejects.toThrow("owner/name");

    const upstream: PrSummary = {
      number: 7, provider: "github.com", org: "upstream", repo: "t3code", state: "failing", lifecycleState: "open",
      url: "https://github.com/upstream/t3code/pull/7", labels: ["bug", "takeover:maintainer"],
    };
    const fork: PrSummary = {
      number: 3, provider: "github.com", org: "fork", repo: "t3code", state: "failing", lifecycleState: "open",
      url: "https://github.com/fork/t3code/pull/3", autoFixOff: true,
    };
    const internals = service as unknown as {
      primaryAttachedPrsForThread: () => PrSummary[];
      readPrReviewReadiness: () => Promise<[]>;
      readPrStacks: () => Promise<StackSummary[]>;
    };
    vi.spyOn(internals, "primaryAttachedPrsForThread").mockReturnValue([upstream, fork]);
    vi.spyOn(internals, "readPrReviewReadiness").mockResolvedValue([]);
    vi.spyOn(internals, "readPrStacks").mockResolvedValue([]);
    expect((await service.getThreadPullRequestAutomationStatus(thread)).forgeAutomation).toEqual({
      project: "t3code",
      handsOff: [{ repository: "Upstream/t3code", label: "takeover:*" }],
      pullRequests: [
        {
          url: upstream.url, labels: ["bug", "takeover:maintainer"],
          handsOff: { repository: "Upstream/t3code", label: "takeover:*", matchedLabel: "takeover:maintainer" },
        },
        { url: fork.url, autoFixOff: true },
      ],
    });
  } finally {
    db.close();
  }
});
