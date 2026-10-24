import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchiveCleanupCheckpointStore, type ArchiveCleanupIntent } from "../state/archive-cleanup-checkpoint";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const databases: StateDb[] = [];
const roots: string[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  roots.splice(0).forEach(removeTempStateDbDir);
  vi.unstubAllEnvs();
});

function fixture() {
  vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
  const { dbPath, tempDir } = createTempStateDb("pwragent-cleanup-checkpoint-");
  roots.push(tempDir);
  const db = StateDb.open(dbPath);
  databases.push(db);
  return { db, store: new ArchiveCleanupCheckpointStore(db.raw, { processId: 123, processAlive: () => false }) };
}

const intent = (threadId: string): ArchiveCleanupIntent => ({ backend: "codex", threadId, archivedAt: 123,
  codexRolloutMissing: false, messagingCleanup: {} });

describe("archive cleanup boundary checkpoints", () => {
  it("saves and claims a 130-job batch with no per-item, idle, or polling writes", async () => {
    const { store } = fixture();
    const intents = Array.from({ length: 130 }, (_, index) => intent(`thread-${index}`));
    const { writes } = await measureSqliteWrites(async () => {
      expect(store.recover("old", () => [])).toEqual([]);
      store.save("old", intents);
      store.save("old", intents);
      expect(store.recover("new", () => ["new"])).toEqual(intents);
      for (let index = 0; index < 100; index += 1) expect(store.recover("other", () => ["new"])).toEqual([]);
      store.save("new", []);
      store.save("new", []);
      expect(store.recover("later", () => [])).toEqual([]);
    });
    expectSqliteWriteBudget({ scenario: "archive-cleanup-130-checkpoint-recover-drain",
      note: "130 jobs: one quit checkpoint, one recovery claim, one drained checkpoint deletion; 3 commits per quit/restart cycle, no per-item or timer writes. At 10 cycles/day and 32 KiB/commit, about 0.94 MB/day; idle is 0 MB/day.", writes });
  });

  it("leaves live owners alone and atomically transfers dead owners to one claimant", () => {
    const { store } = fixture();
    store.save("live", [intent("live-thread")]);
    store.save("dead", [intent("dead-thread")]);
    expect(store.recover("first", () => ["live", "first"])).toEqual([intent("dead-thread")]);
    expect(store.recover("second", () => ["live", "first", "second"])).toEqual([]);
    // Simulate the first claimant crashing before its next clean shutdown.
    expect(store.recover("second", () => ["live", "second"])).toEqual([intent("dead-thread")]);
    expect(store.recover("third", () => ["second", "third"])).toEqual([intent("live-thread")]);
  });

  it("preserves every source checkpoint when any candidate is malformed", () => {
    const { db, store } = fixture();
    store.save("valid", [intent("retained")]);
    db.raw.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run("archive_cleanup_checkpoint_v1:invalid", "{broken");
    expect(() => store.recover("new", () => [])).toThrow();
    expect(db.raw.prepare("SELECT value FROM meta WHERE key = ?").get("archive_cleanup_checkpoint_v1:valid")).toBeDefined();
    expect(db.raw.prepare("SELECT value FROM meta WHERE key = ?").get("archive_cleanup_checkpoint_v1:new")).toBeUndefined();
  });

  it("does not steal work from a live PID even after its runtime marker disappears", () => {
    const { db, store } = fixture();
    store.save("old", [intent("running-snapshot")]);
    const next = new ArchiveCleanupCheckpointStore(db.raw, { processId: 456, processAlive: (pid) => pid === 123 });
    expect(next.recover("new", () => [])).toEqual([]);
  });
});
