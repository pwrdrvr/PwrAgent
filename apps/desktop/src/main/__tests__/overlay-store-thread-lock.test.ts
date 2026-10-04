import type { AppServerThreadSummary, ThreadLock } from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import type { StateDb } from "../state/state-db";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { openInMemoryStateDb } from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;

beforeEach(() => {
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  vi.unstubAllEnvs();
  stateDb.close();
});

const thread = { backend: "codex" as const, threadId: "thread-1" };
const lock: ThreadLock = {
  note: "Worktree handed to another agent to fix the act() warnings.",
  lockedAt: 1_000,
  source: "operator",
};

function provider(): AppServerThreadSummary {
  return {
    id: thread.threadId,
    source: "codex",
    title: "Add /fork parameters",
    titleSource: "explicit",
    updatedAt: 1,
    linkedDirectories: [],
  };
}

describe("SqliteOverlayStore — thread lock", () => {
  it("stores a lock beside the thread's other overlay state and clears it", async () => {
    await store.setThreadReaction({ ...thread, emoji: "✅", present: true });
    await store.setThreadLock({ ...thread, lock });
    expect(await store.getThreadOverlayState(thread)).toMatchObject({ lock, reactions: ["✅"] });

    const unlocked = await store.setThreadLock({ ...thread, lock: undefined });
    expect(unlocked).not.toHaveProperty("lock");
    expect(unlocked.reactions).toEqual(["✅"]);
    expect(await store.getThreadOverlayState(thread)).not.toHaveProperty("lock");
  });

  it("projects the lock into the navigation index and the materialized thread", async () => {
    await store.setThreadLock({ ...thread, lock });
    const indexed = store.readNavigationQueryIndex({ backend: "all", threads: [provider()] });
    expect(indexed.threads[0]?.lock).toEqual(lock);

    await store.setThreadLock({ ...thread, lock: undefined });
    expect(store.readNavigationQueryIndex({ backend: "all", threads: [provider()] }).threads[0]?.lock)
      .toBeUndefined();
  });

  it("costs one commit to lock and one to unlock, and none to unlock an unlocked thread", async () => {
    // Metrics attach when the database opens, so this test opens its own.
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const db = openInMemoryStateDb();
    try {
      const measured = new SqliteOverlayStore(db);
      const { writes } = await measureSqliteWrites(async () => {
        await measured.setThreadLock({ ...thread, lock });
        await measured.setThreadLock({ ...thread, lock: undefined });
        await measured.setThreadLock({ ...thread, lock: undefined });
      });
      expectSqliteWriteBudget({
        scenario: "thread-lock-toggle",
        writes,
        note: "An operator or agent lock and unlock: one commit each, never on a timer or per turn; a redundant unlock writes nothing. 50 toggles/day at ~4 KiB/commit is ~0.4 MB/day",
      });
    } finally {
      db.close();
    }
  });
});
