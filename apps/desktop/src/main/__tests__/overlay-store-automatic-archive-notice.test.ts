import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("automatic archive retirement notice state", () => {
  it("records the notice as seen once per profile, with one commit", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const { dbPath, tempDir } = createTempStateDb("pwragent-archive-retired-notice-test-");
    let stateDb = StateDb.open(dbPath);
    try {
      const store = new SqliteOverlayStore(stateDb);
      expect(store.getAutomaticArchiveRetiredNoticeSeenSync()).toBe(false);
      const { writes } = await measureSqliteWrites(async () => {
        await store.markAutomaticArchiveRetiredNoticeSeen();
        // Every way out of the card dismisses it; repeats commit nothing.
        await store.markAutomaticArchiveRetiredNoticeSeen();
        await store.markAutomaticArchiveRetiredNoticeSeen();
      });
      expectSqliteWriteBudget({
        note: "The one-time notice that the hourly sweep no longer archives threads, dismissed three times: one commit per profile, ever.",
        scenario: "automatic-archive-retired-notice",
        writes,
      });
      stateDb.close();
      stateDb = StateDb.open(dbPath);
      expect(new SqliteOverlayStore(stateDb).getAutomaticArchiveRetiredNoticeSeenSync()).toBe(true);
    } finally {
      stateDb.close();
      removeTempStateDbDir(tempDir);
    }
  });

  it("knows whether the profile ever archived a thread", async () => {
    const { dbPath, tempDir } = createTempStateDb("pwragent-archive-retired-history-test-");
    const stateDb = StateDb.open(dbPath);
    try {
      const store = new SqliteOverlayStore(stateDb);
      expect(store.hasArchivedThreadsSync()).toBe(false);
      await store.setThreadPin({ backend: "codex", threadId: "active", pinned: true });
      expect(store.hasArchivedThreadsSync()).toBe(false);
      await store.observeArchivedThreads([{ backend: "codex", threadId: "archived" }], Date.now());
      expect(store.hasArchivedThreadsSync()).toBe(true);
    } finally {
      stateDb.close();
      removeTempStateDbDir(tempDir);
    }
  });
});
