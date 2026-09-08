import { afterEach, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { openInMemoryStateDb } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

it("reads only the admitted alert page without overlay payloads or SQLite writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  try {
    for (let index = 0; index < 12; index += 1) {
      const threadId = `thread-${String(index).padStart(2, "0")}`;
      await store.setThreadSpendAlertPending({ backend: "codex", threadId, alert: {
        alertId: `spend-alert:thread:codex:${threadId}`, kind: "thread-spend", threadId,
        createdAt: 1, currency: "USD", spendMicros: 31_000_000, thresholdMicros: 25_000_000,
      } });
    }
    const { result: first, writes } = await measureSqliteWrites(async () => {
      const page = await store.listPendingThreadSpendAlerts({ limit: 10 });
      expect(page.hasMore).toBe(true);
      expect(page.alerts).toHaveLength(10);
      expect(page.alerts[0]).toEqual({ backend: "codex", alert: {
        alertId: "spend-alert:thread:codex:thread-00", kind: "thread-spend", threadId: "thread-00",
        createdAt: 1, currency: "USD", spendMicros: 31_000_000, thresholdMicros: 25_000_000,
      } });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(4096);
      return page;
    });
    expectSqliteWriteBudget({ scenario: "pending-spend-alert-page", writes,
      note: "Ten local alert projections out of twelve pending entries, with no overlay summaries: zero commits; 0 MB/day added WAL" });
    expect(writes.commits).toBe(0);
    for (const { backend, alert } of first.alerts) await store.acknowledgeThreadSpendAlert({
      backend, threadId: alert.threadId, alertId: alert.alertId,
    });
    const second = await store.listPendingThreadSpendAlerts({ limit: 10 });
    expect(second.hasMore).toBe(false);
    expect(second.alerts.map(({ alert }) => alert.threadId)).toEqual(["thread-10", "thread-11"]);
    await expect(store.listPendingThreadSpendAlerts({ limit: 11 })).rejects.toThrow("one and ten");
    await expect(store.listPendingThreadSpendAlerts({ limit: 0 })).rejects.toThrow("one and ten");
  } finally { db.close(); }
});

it("rejects an oversized stored alert before transferring its payload out of SQLite", async () => {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  try {
    await store.setThreadSpendAlertPending({ backend: "codex", threadId: "huge", alert: {
      alertId: "x".repeat(20_000), kind: "thread-spend", threadId: "huge", createdAt: 1,
      currency: "USD", spendMicros: 2, thresholdMicros: 1,
    } });
    await expect(store.listPendingThreadSpendAlerts({})).rejects.toThrow("bounded payload budget");
  } finally { db.close(); }
});
