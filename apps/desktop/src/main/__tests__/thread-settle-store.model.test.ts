import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

/**
 * Settle against the owner's real store. A thread is pinned, settled, or
 * neither, never both: Settle clears the pin and marks the thread read in one
 * commit, pinning un-settles, any turn start un-settles, and archive or
 * restore clears it. A repeat of the state a thread is already in writes
 * nothing.
 */

const THREADS = ["a", "b", "c", "d"] as const;
type ThreadId = (typeof THREADS)[number];
type Model = Record<ThreadId, { pinned: boolean; settled: boolean; seenUpdatedAt?: number }>;

type Command =
  | { kind: "pin"; thread: ThreadId }
  | { kind: "unpin"; thread: ThreadId }
  | { kind: "settle"; threads: ThreadId[]; seenUpdatedAt?: number }
  | { kind: "unsettle"; thread: ThreadId }
  | { kind: "turn-start"; thread: ThreadId }
  | { kind: "archive"; thread: ThreadId }
  | { kind: "restore"; thread: ThreadId };

const thread = fc.constantFrom(...THREADS);
const command: fc.Arbitrary<Command> = fc.oneof(
  thread.map((id) => ({ kind: "pin" as const, thread: id })),
  thread.map((id) => ({ kind: "unpin" as const, thread: id })),
  fc.record({
    kind: fc.constant("settle" as const),
    threads: fc.uniqueArray(thread, { minLength: 1, maxLength: 4 }),
    seenUpdatedAt: fc.option(fc.integer({ min: 1, max: 1_000 }), { nil: undefined }),
  }),
  thread.map((id) => ({ kind: "unsettle" as const, thread: id })),
  thread.map((id) => ({ kind: "turn-start" as const, thread: id })),
  thread.map((id) => ({ kind: "archive" as const, thread: id })),
  thread.map((id) => ({ kind: "restore" as const, thread: id })),
);

describe("Settle state on the owner's store", () => {
  let db: StateDb;
  let store: SqliteOverlayStore;
  let tempDir: string;
  beforeEach(() => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-thread-settle-");
    tempDir = temp.tempDir;
    db = StateDb.open(temp.dbPath);
    store = new SqliteOverlayStore(db);
  });
  afterEach(() => { db.close(); removeTempStateDbDir(tempDir); vi.unstubAllEnvs(); });

  const read = async (id: ThreadId) => await store.getThreadOverlayState({ backend: "codex", threadId: id });

  it("keeps pin and Settle exclusive through any sequence of actions", async () => {
    await fc.assert(fc.asyncProperty(fc.array(command, { maxLength: 30, size: "max" }), async (commands) => {
      for (const id of THREADS) {
        await store.setThreadPin({ backend: "codex", threadId: id, pinned: false });
        store.setThreadsSettled({ threads: [{ backend: "codex", threadId: id }], settled: false, at: 1 });
      }
      const seenBefore = Object.fromEntries(await Promise.all(THREADS.map(async (id) =>
        [id, (await read(id))?.lastSeenUpdatedAt] as const))) as Record<ThreadId, number | undefined>;
      const model: Model = Object.fromEntries(THREADS.map((id) => [id, { pinned: false, settled: false,
        seenUpdatedAt: seenBefore[id] }])) as Model;
      let clock = 100;
      for (const step of commands) {
        clock += 1;
        switch (step.kind) {
          case "pin":
            await store.setThreadPin({ backend: "codex", threadId: step.thread, pinned: true });
            model[step.thread] = { ...model[step.thread], pinned: true, settled: false };
            break;
          case "unpin":
            await store.setThreadPin({ backend: "codex", threadId: step.thread, pinned: false });
            model[step.thread] = { ...model[step.thread], pinned: false };
            break;
          case "settle": {
            const { writes } = await measureSqliteWrites(() => store.setThreadsSettled({
              threads: step.threads.map((id) => ({ backend: "codex" as const, threadId: id,
                ...(step.seenUpdatedAt !== undefined ? { seenUpdatedAt: step.seenUpdatedAt } : {}) })),
              settled: true,
              at: clock,
            }));
            const changing = step.threads.filter((id) => !model[id].settled);
            // One commit for the whole action, none when nothing changes.
            expect(writes.commits).toBe(changing.length > 0 ? 1 : 0);
            for (const id of changing) {
              const seen = step.seenUpdatedAt === undefined ? model[id].seenUpdatedAt
                : Math.max(step.seenUpdatedAt, model[id].seenUpdatedAt ?? 0);
              model[id] = { pinned: false, settled: true, seenUpdatedAt: seen };
            }
            break;
          }
          case "unsettle":
          case "turn-start": {
            // The registry's turn-start hook makes exactly this call.
            const { writes } = await measureSqliteWrites(() => store.setThreadsSettled({
              threads: [{ backend: "codex", threadId: step.thread }], settled: false, at: clock,
            }));
            expect(writes.commits).toBe(model[step.thread].settled ? 1 : 0);
            model[step.thread] = { ...model[step.thread], settled: false };
            break;
          }
          case "archive":
            await store.setThreadArchiveTombstone({ backend: "codex", threadId: step.thread, archivedAt: clock });
            model[step.thread] = { ...model[step.thread], settled: false };
            break;
          case "restore":
            await store.setThreadArchiveTombstone({ backend: "codex", threadId: step.thread, restoredAt: clock });
            model[step.thread] = { ...model[step.thread], settled: false };
            break;
        }
        for (const id of THREADS) {
          const overlay = await read(id);
          expect({
            pinned: Boolean(overlay?.pinnedRank),
            settled: overlay?.settledAt !== undefined,
            seenUpdatedAt: overlay?.lastSeenUpdatedAt,
          }).toEqual({ pinned: model[id].pinned, settled: model[id].settled, seenUpdatedAt: model[id].seenUpdatedAt });
          expect(Boolean(overlay?.pinnedRank) && overlay?.settledAt !== undefined).toBe(false);
        }
      }
    }), { numRuns: 60 });
  });

  it("settles a pinned thread, a bulk list and a turn start within the budget", async () => {
    for (const id of THREADS) await store.setThreadPin({ backend: "codex", threadId: id, pinned: true });
    const { writes } = await measureSqliteWrites(async () => {
      // Settle one pinned thread: pin cleared and read in the same commit.
      store.setThreadsSettled({ threads: [{ backend: "codex", threadId: "a", seenUpdatedAt: 10 }], settled: true, at: 1 });
      // Settle Unpinned… over the rest: one commit for the list.
      store.setThreadsSettled({
        threads: (["b", "c", "d"] as const).map((id) => ({ backend: "codex" as const, threadId: id })),
        settled: true,
        at: 2,
      });
      // A turn start on a settled thread, then on one that is not.
      store.setThreadsSettled({ threads: [{ backend: "codex", threadId: "a" }], settled: false, at: 3 });
      store.setThreadsSettled({ threads: [{ backend: "codex", threadId: "a" }], settled: false, at: 4 });
    });
    expectSqliteWriteBudget({
      note: "Settle one pinned thread, Settle Unpinned… over three, and two turn starts: one commit per action that changes state, none for a turn start on an unsettled thread. ~12 KB WAL per action: at 100 actions/day, ~1.2 MB/day; no idle writes.",
      scenario: "thread-settle-actions",
      writes,
    });
  });

  it("saves a Settled fold in one commit", async () => {
    const { writes } = await measureSqliteWrites(async () => {
      await store.setDirectoryThreadsCollapsed({ directoryKey: "directory:/repo", collapsed: false, section: "settled" });
    });
    const overlay = await store.getDirectoryOverlayState({ directoryKey: "directory:/repo" });
    // The Unpinned fold is a different key: opening Settled leaves it unset.
    expect(overlay).toMatchObject({ settledCollapsed: false });
    expect(overlay?.directoryThreadsCollapsed).toBeUndefined();
    expectSqliteWriteBudget({
      note: "Open one project's Settled section: one commit, as the Unpinned fold. ~8 KB WAL per toggle: at 50 toggles/day, ~0.4 MB/day; no idle writes.",
      scenario: "settled-section-fold",
      writes,
    });
  });
});
