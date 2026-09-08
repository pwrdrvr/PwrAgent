import { afterEach, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { openInMemoryStateDb } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

it("reconciles owner PR candidates in one commit and makes unchanged startup reconciliation read-only", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  const threads = Array.from({ length: 120 }, (_, index) => ({ backend: "codex" as const, threadId: `thread-${index}`, prKeys: ["github.com:owner/repo#1"] }));
  try {
    for (const thread of threads) await store.setThreadPrAutoDispatchEnabled({ ...thread, enabled: true });
    const initial = await measureSqliteWrites(() => store.syncThreadPrAutoDispatchCandidatesBatch({ threads, now: 1_000 }));
    expectSqliteWriteBudget({ scenario: "owner-pr-candidate-bootstrap", writes: initial.writes,
      note: "120 owner PR candidates reconciled at startup/provider completion: one commit when membership changes, never per-thread commits; no idle timer writes" });
    expect(initial.writes.commits).toBe(1);
    const winner = await store.getPrAutoDispatchCandidateWinner({ prKey: threads[0]!.prKeys[0]! });
    const unchanged = await measureSqliteWrites(() => store.syncThreadPrAutoDispatchCandidatesBatch({ threads, now: 2_000 }));
    expectSqliteWriteBudget({ scenario: "owner-pr-candidate-unchanged-bootstrap", writes: unchanged.writes,
      note: "120 unchanged owner PR memberships at a later startup/provider completion: zero commits, statements or timestamp rewrites; 0 MB/day idle WAL" });
    expect(unchanged.writes.commits).toBe(0);
    expect(await store.getPrAutoDispatchCandidateWinner({ prKey: threads[0]!.prKeys[0]! })).toEqual(winner);
    await store.setThreadPrAutoDispatchEnabled({ backend: "codex", threadId: "thread-0", enabled: false });
    await store.syncThreadPrAutoDispatchCandidatesBatch({ threads, now: 3_000 });
    expect(await store.getPrAutoDispatchCandidateWinner({ prKey: threads[0]!.prKeys[0]! })).not.toMatchObject({ threadId: "thread-0" });
  } finally { db.close(); }
});
