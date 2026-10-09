import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent, AppServerThreadSummary, NavigationQueryRequest } from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import budgets from "./fixtures/navigation-listing-budgets.json";

const source = vi.hoisted(() => ({ store: undefined as SqliteOverlayStore | undefined }));
vi.mock("../app-server/desktop-overlay-store", () => ({ getDesktopOverlayStore: () => source.store }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: vi.fn() }));
vi.mock("../app-server/scratch-projects", () => ({ resolveScratchProjectsRoots: () => [] }));
import { loadLocalNavigationQueryIndex } from "../app-server/navigation-query-source";
import { NavigationQueryPool } from "../app-server/navigation-query-pool";
import { NavigationQueryStore } from "../app-server/navigation-query-store";

afterEach(() => { vi.restoreAllMocks(); source.store = undefined; });

it("bounds sidebar refresh work after archive completion and owner PR bookkeeping", async () => {
  const db = openInMemoryStateDb();
  const overlay = new SqliteOverlayStore(db);
  source.store = overlay;
  const threads: AppServerThreadSummary[] = Array.from({ length: 120 }, (_, index) => ({
    id: `fixture-${index}`, source: "codex", title: `Fixture ${index}`, titleSource: "explicit", updatedAt: 10,
    gitBranch: "before",
    linkedDirectories: [{ id: "project", kind: "local", path: "/fixture/project", label: "Fixture" }],
  }));
  const parent = threads[0]!;
  db.raw.transaction(() => {
    for (const thread of threads) db.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run(
      `codex:${thread.id}`, JSON.stringify({ backend: "codex", threadId: thread.id, prAutoDispatchEnabled: true,
        pinnedRank: thread.id === parent.id ? "a" : undefined,
        parentThreadId: thread.id === parent.id ? undefined : parent.id,
        immutableUsageActivities: [{ text: "contrived history ".repeat(2_000) }],
      }),
    );
  })();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const start = new Promise<void>((resolve) => { started = resolve; });
  const listeners = new Set<(event: AgentEvent) => void>();
  let current = threads;
  const rpc = vi.fn();
  const listThreads = vi.fn(async () => {
    const snapshot = current;
    for (let page = 1; page <= 3; page++) {
      rpc(page);
      if (listThreads.mock.calls.length === 1 && page === 1) { started(); await gate; }
    }
    return snapshot;
  });
  const registry = {
    listThreads,
    onEvent: (listener: (event: AgentEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    canonicalizeNavigationThreadPullRequests: async (rows: unknown) => rows,
    hydrateThreadGitWorkingStates: async (rows: unknown) => rows,
    withNavigationSubAgentActivity: (rows: unknown) => rows,
    getNavigationInputRequestThreadKeys: () => new Set<string>(),
  } as unknown as DesktopBackendRegistry;
  const pool = new NavigationQueryPool();
  const store = new NavigationQueryStore();
  const projection = vi.spyOn(overlay, "readNavigationQueryIndex");
  const parse = vi.spyOn(JSON, "parse");
  const requests: NavigationQueryRequest[] = [
    { protocol: 2, consumer: "main-sidebar", pageSize: 10, query: { kind: "directory-index" } },
    { protocol: 2, consumer: "main-sidebar", pageSize: 10, query: { kind: "directory", directoryKey: "directory:/fixture/project" } },
    { protocol: 2, consumer: "main-sidebar", pageSize: 10, query: { kind: "children", parent: { backend: "codex", threadId: parent.id } } },
    { protocol: 2, consumer: "main-sidebar", pageSize: 10, query: { kind: "exact", identities: [{ backend: "codex", threadId: parent.id }] } },
  ];
  let logicalRequests = 0;
  const read = (index: number) => {
    logicalRequests++;
    const request = requests[index % requests.length]!;
    return pool.read({ consumerId: `sidebar-${index}`, request, load: ({ signal }) => store.readPage({
      request, scopeKey: "renderer-local", loadIndex: () => loadLocalNavigationQueryIndex({
        registry, callerReason: "renderer-navigation-query", signal,
      }),
    }) });
  };
  const emit = (method: string) => {
    const event = { backend: "codex", notification: { method, params: { threadId: parent.id, status: { type: "idle" } } } } as AgentEvent;
    for (const listener of listeners) listener(event);
    store.observeAttentionEvent(event);
    pool.invalidateQueryOwner();
  };
  const counts = () => {
    const history = parse.mock.calls.filter(([payload]) => payload.includes("immutableUsageActivities"));
    const compact = parse.mock.calls.filter(([payload]) => payload.includes("handoffGroupSource"));
    return { logicalRequests, indexConstructions: projection.mock.calls.length, providerListings: listThreads.mock.calls.length,
      paginatedRpcs: rpc.mock.calls.length, fullOverlayParses: history.length,
      fullOverlayBytes: history.reduce((bytes, [payload]) => bytes + Buffer.byteLength(payload), 0),
      compactOverlayParses: compact.length, compactOverlayBytes: compact.reduce((bytes, [payload]) => bytes + Buffer.byteLength(payload), 0) };
  };
  try {
    const pending = [read(0)];
    await start;
    current = threads.slice(0, -1).map((thread) => ({ ...thread, threadStatus: "idle" as const, gitBranch: "after" }));
    db.raw.prepare("UPDATE threads SET payload = json_set(payload, '$.lastSeenUpdatedAt', 10) WHERE thread_id = ?")
      .run(`codex:${parent.id}`);
    for (const [index, method] of ["thread/archived", "thread/status/changed", "navigation/thread/seen",
      "navigation/directoryGitStatus/updated", "navigation/threadGitWorkingState/updated"].entries()) {
      emit(method);
      pending.push(read(index + 1));
    }
    release();
    await Promise.all(pending);
    // Owner metadata reconciliation runs after the shared index. This commit
    // updates PR election membership, not navigation rows or provider data.
    const candidates = current.map((thread) => ({ backend: thread.source, threadId: thread.id, prKeys: ["fixture-pr"] }));
    await overlay.syncThreadPrAutoDispatchCandidatesBatch({ threads: candidates, now: 1_000 });
    await Promise.all(Array.from({ length: 34 }, (_, index) => read(index + 6)));
    expect(counts()).toEqual(budgets["sidebar-archive-pr-bookkeeping"]);
    const directoryIndex = await read(0);
    expect(directoryIndex.directories?.map((row) => row.key)).toContain("directory:/fixture/project");
    const directory = await read(1);
    expect(directory.entries[0]?.row.id).toBe(parent.id);
    const exact = await read(3);
    expect(exact.entries[0]?.row.threadStatus).toBe("idle");
    expect(exact.entries[0]?.row.id).toBe(parent.id);
    expect(exact.entries[0]?.row.gitBranch).toBe("after");
    expect(exact.entries[0]?.row.inbox.inInbox).toBe(false);
    const pinned = await store.readPage({ scopeKey: "renderer-local", loadIndex: () => loadLocalNavigationQueryIndex({
      registry, callerReason: "renderer-navigation-query",
    }), request: { ...requests[1]!, query: { kind: "directory", directoryKey: "directory:/fixture/project", roots: "pinned" } } });
    expect(pinned.entries.map((entry) => entry.row.id)).toEqual([parent.id]);
    const children = await read(2);
    expect(children.entries).toHaveLength(10);
    expect(children.nextCursor).toBeTruthy();
    const cursorPage = await store.readPage({ scopeKey: "renderer-local", request: { ...requests[2]!, cursor: children.nextCursor },
      loadIndex: async () => { throw new Error("A continuation must retain its owner snapshot."); } });
    expect(cursorPage.generation).toBe(children.generation);
    expect(cursorPage.entries[0]?.row.id).not.toBe(children.entries[0]?.row.id);
    // A later durable navigation change still requires its own fresh work.
    await overlay.setThreadExecutionMode({ backend: "codex", threadId: parent.id, executionMode: "full-access" });
    expect((await read(3)).entries[0]?.row.executionMode).toBe("full-access");
    expect(projection).toHaveBeenCalledTimes(2);
    expect(listThreads).toHaveBeenCalledTimes(3);
  } finally {
    release();
    for (let index = 0; index < 40; index++) pool.release(`sidebar-${index}`);
    emit("thread/name/updated");
    db.close();
  }
});
