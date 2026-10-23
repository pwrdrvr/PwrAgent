import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadReplay, AppServerThreadSummary, ThreadUsageLineRecord } from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import * as appState from "../state/app-state";
import { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

let db: StateDb;
let tempDir: string;

beforeEach(() => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const fixture = createTempStateDb("owner-search-persistence-");
  tempDir = fixture.tempDir;
  db = StateDb.open(fixture.dbPath);
  vi.spyOn(appState, "getAppStateDb").mockReturnValue(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  db.close();
  removeTempStateDbDir(tempDir);
});

describe("production owner content search persistence", () => {
  it("does not hydrate usage or pricing for matching or nonmatching candidates", async () => {
    const threads: AppServerThreadSummary[] = ["match", "unrelated-one", "unrelated-two"].map((id) => ({
      id, source: "codex", title: "Mail audit", titleSource: "explicit", linkedDirectories: [],
    }));
    const replays = new Map(threads.map((thread) => [thread.id, usageReplay(thread.id)]));
    const readThread = vi.fn(async ({ threadId }: { threadId: string }) => replays.get(threadId)!);
    const client = {
      close: async () => {},
      getInitializeResult: async () => ({ methods: ["thread/read", "thread/list"] }),
      listNativeSubAgentThreads: async () => [],
      listThreads: vi.fn(async () => threads),
      onNotification: () => () => {},
      onPendingRequest: () => () => {},
      readThread,
    };
    const store = new SqliteOverlayStore(db);
    const readPricing = vi.spyOn(store, "readThreadPricing");
    const registry = new DesktopBackendRegistry({ codexClient: client as never, overlayStore: store, messagingStore: null });
    const listWithMaintenance = vi.spyOn(registry, "listThreads");
    // Injecting a protocol client disables the inspection factory in tests.
    // Enable that real factory too so reverting owner routing reproduces the
    // production hydration writes rather than "search unavailable".
    (registry as unknown as { threadInspectionSearchService: undefined }).threadInspectionSearchService = undefined;
    try {
      // Cold transcripts have twenty unhydrated usage lines each. Searching
      // must not turn all sixty into usage-ledger commits, even on a miss.
      const request = { searchId: "first", request: { query: "DKIM", filters: { backend: "codex" as const } } };
      const { result, writes } = await measureSqliteWrites(async () => await registry.ownerContentSearch.run(
        request, { requesterInstanceId: "viewer" }));
      expect(result.results.map((hit) => hit.threadId)).toEqual(["match"]);
      expect(result.unavailableScopes).toEqual([]);
      expect(readThread).toHaveBeenCalledTimes(3);
      expect(readPricing).not.toHaveBeenCalled();
      expect(listWithMaintenance).not.toHaveBeenCalled();
      expect(client.listThreads).toHaveBeenCalledWith(expect.objectContaining({
        enrichDirectories: false, skipArchivedMetadataRefresh: true,
      }), expect.any(Object));
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM thread_usage_lines").get()).toEqual({ count: 0 });
      expect(writes.commits).toBe(1);
      expectSqliteWriteBudget({ scenario: "owner-content-search-cold-usage", writes,
        note: "Real registry and SQLite: one metadata batch for three cold candidates with 60 usage lines, including two nonmatches; no usage/pricing/directory hydration. Transcript persistence adds 0 MB/day." });

      const repeated = await measureSqliteWrites(async () => {
        for (let index = 0; index < 20; index += 1) {
          await registry.ownerContentSearch.run({ ...request, searchId: `repeat-${index}` }, { requesterInstanceId: "viewer" });
        }
      });
      expect(repeated.writes.commits).toBe(0);
      expectSqliteWriteBudget({ scenario: "owner-content-search-cold-usage-repeated", writes: repeated.writes,
        note: "20 real owner searches of unchanged metadata and unhydrated usage-bearing transcripts: 0 commits and 0 MB/day at 20 queries/day." });

      // Prove these fixtures reach the stateful production path when opened
      // normally; an empty replay or mocked overlay store cannot pass this.
      await registry.readThread({ backend: "codex", threadId: "unrelated-one", viewOnly: false });
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM thread_usage_lines").get()).toEqual({ count: 20 });
    } finally {
      await registry.close();
    }
  });
});

function usageReplay(threadId: string): AppServerThreadReplay {
  const text = threadId === "match" ? "Check DKIM and DMARC" : "Review mail routing";
  return {
    messages: [{ id: `${threadId}-message`, role: "user", text }],
    entries: Array.from({ length: 20 }, (_, index) => {
      const turnId = `${threadId}-turn-${index}`;
      const usageLine: ThreadUsageLineRecord = {
        backend: "codex", threadId, turnId, usageLineId: `${threadId}-usage-${index}`,
        provider: "openai", model: "gpt-5.5", scope: "turn", source: "hydration", sourceItemId: turnId,
        status: "finalized", priceStatus: "unpriced", currency: "USD", createdAt: 2000, completedAt: 2000,
        inputTokens: 1500, cachedInputTokens: 1200, uncachedInputTokens: 300, outputTokens: 150,
        reasoningOutputTokens: 0, totalTokens: 1650, uncachedInputCostMicros: 0, cachedInputCostMicros: 0,
        outputCostMicros: 0, totalCostMicros: 0,
      };
      return { type: "activity", id: turnId, summary: "Turn usage", status: "completed", details: [],
        turn: { id: turnId, status: "completed" }, usageLine };
    }),
    pagination: { supportsPagination: false, hasPreviousPage: false },
  };
}
