import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { buildPullRequestStatusKey, type PrSummary, type ThreadPullRequestWatchEvent } from "@pwragent/shared";
import { PrStatusWatchCoordinator } from "../pr-status/pr-status-watch";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const identity = { backend: "codex" as const, threadId: "parked-parent" };
const pr: PrSummary = {
  provider: "github.com", org: "fixture", repo: "project", number: 17,
  title: "Fixture lifecycle", url: "https://github.com/fixture/project/pull/17",
  state: "passing", checkState: "passing", lifecycleState: "merged", headSha: "a".repeat(40),
};

describe("terminal observation retires subscriptions independently of admission", () => {
  it("models a locked parent, terminal observations, restart and eventual delivery", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("merged" as const, "closed" as const),
      fc.constantFrom<ThreadPullRequestWatchEvent[]>(["merged"], ["closed"], ["merged", "closed"]),
      fc.integer({ min: 1, max: 4 }),
      async (outcome, notifyOn, repeats) => {
        const temp = createTempStateDb("terminal-retirement-");
        let db = StateDb.open(temp.dbPath);
        let store = new SqliteOverlayStore(db);
        let locked = true;
        const submitTurnIfIdle = vi.fn(async () => locked
          ? { status: "busy" as const }
          : { status: "started" as const, turnId: "wake" });
        const createCoordinator = () => new PrStatusWatchCoordinator({ store, registry: { submitTurnIfIdle }, now: () => 100 });
        let coordinator = createCoordinator();
        const terminal = { ...pr, lifecycleState: outcome };
        try {
          await store.setThreadLock({ ...identity, lock: { source: "operator", lockedAt: 1, note: "Child owns checkout" } });
          await store.registerThreadPrStatusWatch({ watch: {
            ...identity, watchId: "terminal", prKey: buildPullRequestStatusKey(pr), prUrl: pr.url,
            prNumber: pr.number, headSha: "", kind: "terminal", notifyOn, createdAt: 1, failureHandledByAutoFix: false,
          }, now: 1 });
          for (let index = 0; index < repeats; index += 1) {
            await coordinator.handleTerminalSnapshot(terminal, 2);
            expect(await store.listActiveThreadPrStatusWatches(identity)).toEqual([]);
            expect(await store.listAllActivePrStatusWatches()).toEqual([]);
          }
          expect((await store.getThreadOverlayState(identity))?.lock?.note).toBe("Child owns checkout");
          db.close();
          db = StateDb.open(temp.dbPath);
          store = new SqliteOverlayStore(db);
          coordinator = createCoordinator();
          // History expiry cannot erase an undelivered event held by a lock.
          db.cleanupExpired(Date.now() + 365 * 24 * 60 * 60 * 1_000);
          expect(await store.listActiveThreadPrStatusWatches(identity)).toEqual([]);
          locked = false;
          submitTurnIfIdle.mockClear();
          await coordinator.handleTerminalSnapshot(terminal, 2);
          await coordinator.handleTerminalSnapshot(terminal, 2);
          expect(submitTurnIfIdle).toHaveBeenCalledTimes(notifyOn.includes(outcome) ? 1 : 0);
          expect(await store.listPendingPrTerminalWatchPrKeys()).toEqual([]);
        } finally { db.close(); removeTempStateDbDir(temp.tempDir); }
      },
    ), { numRuns: 25 });
  });

  it("keeps pending events through reopen without retiring a new subscription", async () => {
    const temp = createTempStateDb("terminal-reopen-");
    const db = StateDb.open(temp.dbPath);
    const store = new SqliteOverlayStore(db);
    const submitTurnIfIdle = vi.fn(async () => ({ status: "busy" as const }));
    const coordinator = new PrStatusWatchCoordinator({ store, registry: { submitTurnIfIdle }, now: () => 100 });
    const watch = { ...identity, prKey: buildPullRequestStatusKey(pr), prUrl: pr.url, prNumber: pr.number,
      kind: "terminal" as const, headSha: "", notifyOn: ["closed" as const], createdAt: 1, failureHandledByAutoFix: false };
    try {
      await store.registerThreadPrStatusWatch({ watch: { ...watch, watchId: "old" }, now: 1 });
      const closed = { ...pr, lifecycleState: "closed" as const };
      await coordinator.handleTerminalSnapshot(closed, 2);
      // The provider reopens the PR; the operator requests a new close watch.
      await store.registerThreadPrStatusWatch({ watch: { ...watch, watchId: "new", createdAt: 3 }, now: 3 });
      const [saved] = await store.listPendingPrTerminalWatchObservations();
      await coordinator.handleTerminalSnapshot(saved!.pr, saved!.observedAt, { fromSavedObservation: true, pendingOnly: true });
      expect((await store.listActiveThreadPrStatusWatches(identity)).map((item) => item.watchId)).toEqual(["new"]);
      expect(await store.listPendingPrTerminalWatchObservations()).toEqual([{ pr: closed, observedAt: 2 }]);
      // Archiving revokes both the new subscription and the old pending event.
      await store.observeArchivedThreads([identity], 4);
      await store.setThreadArchiveTombstone({ ...identity, restoredAt: 5 });
      submitTurnIfIdle.mockClear();
      await coordinator.handleTerminalSnapshot(closed, 2, { fromSavedObservation: true, pendingOnly: true });
      expect(submitTurnIfIdle).not.toHaveBeenCalled();
      expect(await store.listPendingPrTerminalWatchObservations()).toEqual([]);
    } finally { db.close(); removeTempStateDbDir(temp.tempDir); }
  });

  it("writes once at observation and never again for duplicate observations", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("terminal-retirement-budget-");
    const db = StateDb.open(temp.dbPath);
    const store = new SqliteOverlayStore(db);
    try {
      await store.registerThreadPrStatusWatch({ now: 1, watch: {
        ...identity, watchId: "budget", prKey: buildPullRequestStatusKey(pr), prUrl: pr.url, prNumber: pr.number,
        kind: "terminal", headSha: "", notifyOn: ["merged"], createdAt: 1, failureHandledByAutoFix: false,
      } });
      const { writes } = await measureSqliteWrites(async () => {
        for (let index = 0; index < 10; index += 1) {
          await store.observeThreadPrTerminalWatches({ pr, observedAt: 2, outcome: "merged", now: 2 });
        }
      });
      expectSqliteWriteBudget({ scenario: "pr-terminal-watch-retire", writes,
        note: "one retirement plus nine duplicate observations: 1 commit/~12.4 KB WAL; ~0.6 MB/day at 50 terminal events/day, zero idle writes" });
    } finally { db.close(); removeTempStateDbDir(temp.tempDir); vi.unstubAllEnvs(); }
  });

});
