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
      // Recovery replays the oldest archive first; equal times follow storage order.
      const byThread = (list: ArchiveCleanupIntent[]) => [...list].sort((left, right) => left.threadId.localeCompare(right.threadId));
      expect(byThread(store.recover("new", () => ["new"]))).toEqual(byThread(intents));
      for (let index = 0; index < 100; index += 1) expect(store.recover("other", () => ["new"])).toEqual([]);
      store.save("new", []);
      store.save("new", []);
      expect(store.recover("later", () => [])).toEqual([]);
    });
    expectSqliteWriteBudget({ scenario: "archive-cleanup-130-checkpoint-recover-drain",
      note: "130 jobs: one quit checkpoint writing one row per intent, one recovery claim, one drained deletion; 3 commits per quit/restart cycle, no per-item or timer writes. At 10 cycles/day and about 210 KB WAL per cycle, about 2.1 MB/day; idle is 0 MB/day.", writes });
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
    const rows = (instance: string) => db.raw.prepare("SELECT key FROM meta WHERE key LIKE ?").all(`%"${instance}"%`);
    expect(rows("valid")).toHaveLength(1);
    expect(rows("new")).toHaveLength(0);
  });

  it("recovers an earlier build's single-row checkpoint and rewrites it per intent", () => {
    const { db, store } = fixture();
    db.raw.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run("archive_cleanup_checkpoint_v1:older",
      JSON.stringify({ version: 1, ownerPid: 99, intents: [intent("first"), intent("second")] }));
    expect(store.recover("new", () => [])).toEqual([intent("first"), intent("second")]);
    expect(db.raw.prepare("SELECT key FROM meta WHERE key GLOB 'archive_cleanup_checkpoint_v1:*'").all()).toEqual([]);
    expect(store.recover("later", () => [])).toEqual([intent("first"), intent("second")]);
  });

  it("writes only changed intents, so a release sequence is linear in bytes", () => {
    const { db, store } = fixture();
    const intents = Array.from({ length: 200 }, (_, index) => intent(`waiting-${index}`));
    let bytes = 0;
    const statement = db.raw.prepare.bind(db.raw);
    db.raw.prepare = ((sql: string) => {
      const prepared = statement(sql);
      if (!sql.startsWith("INSERT INTO meta")) return prepared;
      return Object.assign(Object.create(prepared), { run: (key: string, value: string) => {
        bytes += value.length;
        return prepared.run(key, value);
      } });
    }) as typeof db.raw.prepare;
    store.save("owner", intents);
    const first = bytes;
    // Each release removes one intent; nothing else changes.
    for (let index = 1; index <= intents.length; index += 1) store.save("owner", intents.slice(index));
    expect(bytes).toBe(first);
    expect(db.raw.prepare("SELECT key FROM meta WHERE key GLOB 'archive_cleanup_checkpoint_*'").all()).toEqual([]);
  });

  it("does not steal work from a live PID even after its runtime marker disappears", () => {
    const { db, store } = fixture();
    store.save("old", [intent("running-snapshot")]);
    const next = new ArchiveCleanupCheckpointStore(db.raw, { processId: 456, processAlive: (pid) => pid === 123 });
    expect(next.recover("new", () => [])).toEqual([]);
  });
});
