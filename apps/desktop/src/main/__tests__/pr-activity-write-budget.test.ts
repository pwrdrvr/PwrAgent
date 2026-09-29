import { afterEach, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { PrAutoDispatchCoordinator } from "../pr-status/pr-auto-dispatch";
import { PrActivityJournal } from "../pr-status/pr-activity";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

it("keeps repeated observations and diagnostic reads free of SQLite writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("pr-activity-budget-");
  const db = StateDb.open(temp.dbPath);
  const store = new SqliteOverlayStore(db);
  const journal = new PrActivityJournal();
  let now = 1_000;
  const pr: PrSummary = {
    provider: "github.com", org: "example", repo: "project", number: 1,
    url: "https://github.com/example/project/pull/1", state: "passing",
    lifecycleState: "open", mergeState: "conflicting", checkState: "passing",
    headSha: "a".repeat(40),
  };
  const coordinator = new PrAutoDispatchCoordinator({
    store,
    registry: { submitTurnIfIdle: async () => ({ status: "started", turnId: "fixture-turn" }) },
    getCurrentPr: () => pr,
    now: () => now,
    onActivity: (event) => journal.record(event),
  });
  const observe = () => coordinator.handleStatusSnapshot({
    pr, threadKeys: ["codex:fixture"], observedAt: now, backgroundPollingEnabled: true,
  });
  try {
    await store.setThreadPrAutoDispatchEnabled({ backend: "codex", threadId: "fixture", enabled: true });
    const [scheduled] = await observe();
    expect(scheduled?.status).toBe("scheduled");
    expect(await coordinator.sendPendingNow({
      backend: "codex", threadId: "fixture", fingerprint: scheduled!.fingerprint!,
    })).toBe(true);
    expect(journal.snapshot().events.some((event) => event.message === "Repair started (attempt 1/2)")).toBe(true);
    const { writes } = await measureSqliteWrites(async () => {
      for (let check = 0; check < 100; check++) {
        now += 60_000;
        await observe();
        journal.record({ category: "check", source: "thread lookup", message: "Checked: conflict",
          threadKeys: ["codex:fixture"], prKeys: ["github.com/example/project#1"] });
        journal.snapshot();
      }
    });
    expect(writes.statements).toBe(0);
    expect(writes.rowsChanged).toBe(0);
    expect(writes.walBytes).toBe(0);
    expectSqliteWriteBudget({
      scenario: "pr-activity-unchanged-observations",
      writes,
      note: "100 unchanged conflict observations after dispatch plus activity reads: 200 read-only transaction commits, zero write statements/rows/WAL bytes; 0 MB/day additional WAL",
    });
  } finally {
    coordinator.close();
    db.close();
    removeTempStateDbDir(temp.tempDir);
  }
});
