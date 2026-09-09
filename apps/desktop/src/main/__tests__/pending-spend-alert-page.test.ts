import { afterEach, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { openInMemoryStateDb, createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { StateDb } from "../state/state-db";

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


it("uses the pending-only index for the actual alert query amid unrelated history", async () => {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  try {
    const insert = db.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)");
    db.raw.transaction(() => {
      for (let index = 0; index < 2000; index += 1) {
        insert.run(`history-${index}`, JSON.stringify({ backend: "codex", history: "x".repeat(4096) }));
      }
    })();
    await store.setThreadSpendAlertPending({ backend: "codex", threadId: "pending", alert: {
      alertId: "pending-alert", kind: "thread-spend", threadId: "pending", createdAt: 1,
      currency: "USD", spendMicros: 2, thresholdMicros: 1,
    } });
    const prepare = vi.spyOn(db.raw, "prepare");
    expect((await store.listPendingThreadSpendAlerts({})).alerts).toHaveLength(1);
    const sql = prepare.mock.calls.find(([query]) => query.includes("FROM threads WHERE"))![0];
    prepare.mockRestore();
    const plan = db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(11) as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join("\n")).toContain("idx_threads_pending_spend_alert");
    expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
    await store.acknowledgeThreadSpendAlert({ backend: "codex", threadId: "pending", alertId: "pending-alert" });
    expect(await store.listPendingThreadSpendAlerts({})).toEqual({ alerts: [], hasMore: false });
  } finally { db.close(); }
});


it("indexes existing pending alerts when reopening a current-version profile", async () => {
  const { dbPath, tempDir } = createTempStateDb("pending-alert-index-");
  let db = StateDb.open(dbPath);
  try {
    await new SqliteOverlayStore(db).setThreadSpendAlertPending({ backend: "codex", threadId: "existing", alert: {
      alertId: "existing-alert", kind: "thread-spend", threadId: "existing", createdAt: 1,
      currency: "USD", spendMicros: 2, thresholdMicros: 1,
    } });
    db.raw.exec("DROP INDEX idx_threads_pending_spend_alert");
    const version = db.raw.pragma("user_version", { simple: true });
    db.close();
    db = StateDb.open(dbPath);
    expect(db.raw.pragma("user_version", { simple: true })).toBe(version);
    const indexed = db.raw.prepare(`SELECT thread_id FROM threads INDEXED BY idx_threads_pending_spend_alert
      WHERE json_type(payload, '$.threadSpendAlertPending') = 'object'`).all();
    expect(indexed).toEqual([{ thread_id: "codex:existing" }]);
    expect((await new SqliteOverlayStore(db).listPendingThreadSpendAlerts({})).alerts[0]?.alert.alertId).toBe("existing-alert");
    db.close();
    db = StateDb.open(dbPath);
    expect((await new SqliteOverlayStore(db).listPendingThreadSpendAlerts({})).alerts).toHaveLength(1);
  } finally { db.close(); removeTempStateDbDir(tempDir); }
});
