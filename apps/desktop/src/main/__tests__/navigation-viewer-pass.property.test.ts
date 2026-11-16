import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import {
  buildFederatedThreadRef,
  buildThreadIdentityKey,
  type AgentEvent,
  type NavigationQueryRequest,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { RemoteThreadSummaryCache } from "../federation/remote-thread-summary-cache";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { NavigationWindowQueries } from "../../renderer/src/lib/navigation-window-queries";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { getDesktopNavigationQueryPool } from "../app-server/navigation-query-pool";
import { NavigationIndexReadPool } from "../app-server/navigation-index-read-pool";

const current = vi.hoisted(() => ({
  store: undefined as unknown as SqliteOverlayStore,
  registry: undefined as unknown as DesktopBackendRegistry,
  cache: undefined as unknown as RemoteThreadSummaryCache,
}));
vi.mock("../storage/desktop-overlay-store", () => ({ getDesktopOverlayStore: () => current.store }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: () => current.registry }));
vi.mock("../app-server/scratch-projects", () => ({ resolveScratchProjectsRoots: () => [] }));
vi.mock("../messaging/messaging-bindings-snapshot", () => ({ buildNavigationIndexMessagingBindings: async () => new Map() }));
vi.mock("../federation/federation-runtime", () => ({ getDesktopFederationRuntime: () => ({
  remoteThreadSummaries: () => current.cache, health: async () => ({ instanceId: "viewer" }),
}) }));
import { initializeDesktopAppServerService } from "../app-server/desktop-app-server-service";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("preserves all eight physical source admissions when each source has a derived viewer", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (n) => {
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
  }), { numRuns: 25, examples: [[8]] });
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
  current.registry = {
    listThreads: provider,
    onEvent: (listener: (event: AgentEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    canonicalizeNavigationThreadPullRequests: async (value: NavigationThreadSummary[]) => value,
    hydrateThreadGitWorkingStates: async (value: NavigationThreadSummary[]) => value,
    withNavigationSubAgentActivity: (value: NavigationThreadSummary[]) => value,
    getNavigationInputRequestThreadKeys: () => new Set<string>(),
  } as unknown as DesktopBackendRegistry;
  const cache = current.cache = new RemoteThreadSummaryCache({
    peers: () => connected ? [{ target: { scope: "remote", instanceId: "peer" }, label: "Peer", capabilities: ["thread_navigation"] }] : [],
    fetchSnapshot: vi.fn(), fetchPinnedSnapshot: async () => ({ backend: "all", fetchedAt: 1, unchanged: false,
      threads: ownerRows, directories: [], inboxThreadKeys: [], launchpadDefaults: { backend: "codex", executionMode: "default" } }),
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
  const reset = () => { read.mockClear(); resolve.mockClear(); snapshots.mockClear(); materialize.mockClear(); provider.mockClear(); };
  return { db, store, cache, resolve, snapshots, materialize, provider, requests, queries, read, emit, idle, reset,
    remote: async (i: number, title: string, active: boolean) => {
      connected = true;
      ownerRows = ownerRows.map((row, j) => j === i ? { ...row, title, threadStatus: active ? "active" : "idle" } : row);
      const before = published; cache.invalidate("peer"); await until(() => published > before);
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
    await vi.advanceTimersByTimeAsync(1001);
    const { writes: coldWrites } = await measureSqliteWrites(async () => {
      await f.queries.refresh(); await until(f.idle);
    });
    expectSqliteWriteBudget({ scenario: "navigation-viewer-cold-manual-refresh", writes: coldWrites,
      note: "One explicit refresh after index expiry, across 4/8 projects: zero commits, 0 MB/day added WAL." });
    expect({ ipc: f.read.mock.calls.length, provider: f.provider.mock.calls.length,
      materializations: f.materialize.mock.calls.length, pins: f.resolve.mock.calls.length,
      snapshots: f.snapshots.mock.calls.length, commits: coldWrites.commits })
      .toEqual({ ipc: 1 + 2 * n, provider: 1, materializations: 1, pins: 1, snapshots: 1, commits: 0 });
    expect(f.resolve.mock.calls.reduce((sum, [pins]) => sum + pins.length, 0)).toBe(n);
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
      .toEqual({ ipc: 3, provider: 1, materializations: 1, pins: 1, snapshots: 1, commits: 0 });
    expect(f.read.mock.calls.map(([request]) => request.query.kind)).toEqual(["directory-index", "directory", "children"]);
    const exact = await f.read({ protocol: 2, inventory: "viewer", consumer: "main-sidebar",
      query: { kind: "exact", identities: [{ backend: "codex", threadId: "root-0" }] } });
    expect(exact.entries[0]?.row.threadStatus).toBe("idle");
  } finally { f.close(); vi.useRealTimers(); }
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
    }), { numRuns: 25 });
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
