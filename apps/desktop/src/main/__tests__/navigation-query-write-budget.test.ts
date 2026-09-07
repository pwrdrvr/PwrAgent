import { afterEach, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { buildFederatedThreadRef, type NavigationThreadSummary } from "@pwragent/shared";

const mocks = vi.hoisted(() => ({
  store: undefined as unknown as SqliteOverlayStore,
  threads: [] as NavigationThreadSummary[],
}));
vi.mock("../app-server/desktop-overlay-store", () => ({ getDesktopOverlayStore: () => mocks.store }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: () => ({
  listThreads: async () => mocks.threads,
  canonicalizeNavigationThreadPullRequests: async (threads: NavigationThreadSummary[]) => threads,
  hydrateThreadGitWorkingStates: async (threads: NavigationThreadSummary[]) => threads,
  getNavigationInputRequestThreadKeys: () => new Set(["codex:thread-999"]),
}) }));
vi.mock("../app-server/scratch-projects", () => ({ resolveScratchProjectsRoots: () => [] }));
import { loadLocalNavigationQueryIndex } from "../app-server/navigation-query-source";
import { NavigationQueryStore } from "../app-server/navigation-query-store";

afterEach(() => vi.unstubAllEnvs());

it("adds zero SQLite commits for real overlay-backed query, model inventory, facet, cursor and Attention reads", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const db = openInMemoryStateDb();
  mocks.store = new SqliteOverlayStore(db);
  mocks.threads = Array.from({ length: 1000 }, (_, index) => ({
    source: "codex", id: `thread-${index}`, title: `Thread ${index}`, titleSource: "derived",
    createdAt: index + 1, updatedAt: index + 1, threadStatus: "active", linkedDirectories: [], inbox: { inInbox: true },
  }));
  try {
    await mocks.store.addRemoteThreadPin({ ref: buildFederatedThreadRef({ backend: "codex", threadId: "remote", instanceId: "peer" }),
      instanceLabel: "Peer", summary: { ...mocks.threads[0]!, id: "remote", summary: "Selected-only data".repeat(10_000) } });
    await mocks.store.markThreadSeen({ backend: "codex", threadId: "thread-0", seenUpdatedAt: 1 });
    mocks.threads[0] = { ...mocks.threads[0]!, updatedAt: 2000 };
    const queries = new NavigationQueryStore();
    const { writes } = await measureSqliteWrites(async () => {
      const pins = await mocks.store.readRemoteThreadPinNavigationRows();
      expect(pins).toHaveLength(1);
      expect(pins[0]).not.toHaveProperty("summary");
      const loadIndex = () => loadLocalNavigationQueryIndex({ callerReason: "navigation-write-budget" });
      const updated = await queries.readPage({ loadIndex, scopeKey: "exact", request: {
        protocol: 2, consumer: "main-sidebar", query: { kind: "exact", identities: [{ backend: "codex", threadId: "thread-0" }] },
      } });
      expect(updated.entries[0]?.row.inbox).toMatchObject({ inInbox: true, reason: "updated-since-seen" });
      const request = { protocol: 2 as const, consumer: "star-map" as const,
        query: { kind: "star-map" as const, filters: {} }, pageSize: 10,
        attentionView: { id: "window", promoteOnTurnEnd: true } };
      const first = await queries.readPage({ loadIndex, request, scopeKey: "viewer" });
      expect(first.counts.active).toBe(1000);
      expect(first.facets?.matches.approval).toBe(1);
      await queries.readPage({ loadIndex, request: { ...request, cursor: first.nextCursor }, scopeKey: "viewer" });
      await queries.readPage({ loadIndex, request, scopeKey: "viewer" });
      const inventory = await queries.readPage({ loadIndex, scopeKey: "settings", request: {
        protocol: 2, consumer: "settings", backend: "codex", query: { kind: "model-inventory" },
      } });
      expect(inventory.modelGroups?.[0]?.threadCount).toBe(1000);
      const group = await queries.readPage({ loadIndex, scopeKey: "archive", request: {
        protocol: 2, consumer: "main-sidebar", query: { kind: "group-members", roots: [{ backend: "codex", threadId: "thread-0" }] }, pageSize: 10,
      } });
      expect(group.entries.map(({ row }) => row.id)).toEqual(["thread-0"]);
    });
    expectSqliteWriteBudget({ scenario: "navigation-owner-query-reads", writes,
      note: "1,000 real overlay-backed rows, owner Attention metadata, facet counts, model inventory, page continuation and repeated query: zero commits; 0 MB/day added WAL" });
    expect(writes.commits).toBe(0);
  } finally { db.close(); }
});


it("builds the owner index without materializing private provider, overlay, or launchpad collections", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const db = openInMemoryStateDb();
  mocks.store = new SqliteOverlayStore(db);
  const secret = "private selected data ".repeat(100_000);
  mocks.threads = [{ source: "codex", id: "owner", title: "Owner", titleSource: "explicit",
    summary: secret, linkedDirectories: [], inbox: { inInbox: false }, updatedAt: 2,
    codexNativeSubAgents: Array.from({ length: 100 }, (_, i) => ({ threadId: `worker-${i}`, title: secret })),
  }];
  await mocks.store.markThreadSeen({ backend: "codex", threadId: "owner", seenUpdatedAt: 1 });
  db.raw.prepare("UPDATE threads SET payload = ?").run(JSON.stringify({ backend: "codex", threadId: "owner",
    executionMode: "default", extraLinkedDirectories: [], lastSeenUpdatedAt: 1,
    fastMode: true, subthreadsCollapsed: false, prAutoDispatchEnabled: true,
    agent: { name: "Agent", instructions: secret, instructionLineCount: 42, instructionsTooLong: true, createdAt: 1, updatedAt: 2 },
    questionnaireActivityLog: [{ text: secret }], queuedTurns: [{ prompt: secret }],
  }));
  db.raw.prepare("INSERT INTO directory_launchpads(directory_path, payload, created_at, updated_at) VALUES (?, ?, 1, 2)").run("directory:/launchpad", JSON.stringify({
    directoryKey: "directory:/launchpad", directoryKind: "directory", directoryLabel: "Launchpad", directoryPath: "/launchpad",
    backend: "codex", executionMode: "default", prompt: secret, codexEnvironmentRuntime: { output: secret }, createdAt: 1, updatedAt: 2,
  }));
  const legacy = vi.spyOn(mocks.store, "reconcileNavigationSnapshot");
  try {
    const { writes } = await measureSqliteWrites(async () => {
      const index = await loadLocalNavigationQueryIndex({ callerReason: "compact-index-regression" });
      expect(legacy).not.toHaveBeenCalled();
      expect(JSON.stringify(index)).not.toContain("private selected data");
      expect(Buffer.byteLength(JSON.stringify(index), "utf8")).toBeLessThan(8 * 1024);
      expect(index.threads[0]).toMatchObject({ fastMode: true, subthreadsCollapsed: false, prAutoDispatchEnabled: true,
        nativeSubAgentCount: 100, agent: { name: "Agent", instructionLineCount: 42, instructionsTooLong: true } });
      expect(index.directories.find((directory) => directory.key === "directory:/launchpad")?.launchpad?.backend).toBe("codex");
    });
    expect(writes.commits).toBe(0);
  } finally { legacy.mockRestore(); db.close(); }
});
