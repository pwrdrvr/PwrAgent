import { afterEach, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import type { NavigationThreadSummary } from "@pwragent/shared";

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

it("adds zero SQLite commits for real overlay-backed query, facet, cursor and Attention reads", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const db = openInMemoryStateDb();
  mocks.store = new SqliteOverlayStore(db);
  mocks.threads = Array.from({ length: 1000 }, (_, index) => ({
    source: "codex", id: `thread-${index}`, title: `Thread ${index}`, titleSource: "derived",
    createdAt: index + 1, updatedAt: index + 1, threadStatus: "active", linkedDirectories: [], inbox: { inInbox: true },
  }));
  try {
    const queries = new NavigationQueryStore();
    const { writes } = await measureSqliteWrites(async () => {
      const loadIndex = () => loadLocalNavigationQueryIndex({ callerReason: "navigation-write-budget" });
      const request = { protocol: 2 as const, consumer: "star-map" as const,
        query: { kind: "star-map" as const, filters: {} }, pageSize: 10,
        attentionView: { id: "window", promoteOnTurnEnd: true } };
      const first = await queries.readPage({ loadIndex, request, scopeKey: "viewer" });
      expect(first.counts.active).toBe(1000);
      expect(first.facets?.matches.approval).toBe(1);
      await queries.readPage({ loadIndex, request: { ...request, cursor: first.nextCursor }, scopeKey: "viewer" });
      await queries.readPage({ loadIndex, request, scopeKey: "viewer" });
    });
    expectSqliteWriteBudget({ scenario: "navigation-owner-query-reads", writes,
      note: "1,000 real overlay-backed rows, owner Attention metadata, facet counts, page continuation and repeated query: zero commits; 0 MB/day added WAL" });
    expect(writes.commits).toBe(0);
  } finally { db.close(); }
});
