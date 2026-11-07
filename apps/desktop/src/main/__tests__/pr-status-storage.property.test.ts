import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { PrAutoDispatchStorage, PrStatusWatchStorage } from "@pwragent/owner-core/pr-status-storage";
import type { PrAutoDispatchBudgetConfig, ThreadPrAutoDispatchPending } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { openInMemoryStateDb } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

const operation = fc.record({
  kind: fc.constantFrom("schedule", "begin", "reserve", "renew", "finish", "cancel", "recover",
    "watch-claim", "watch-renew", "watch-release", "watch-finish"),
  slot: fc.constantFrom(0, 1),
  ownerId: fc.constantFrom("first", "second"),
  advance: fc.integer({ min: 1, max: 70_000 }),
  success: fc.boolean(),
});
const budget: PrAutoDispatchBudgetConfig = { capacity: 3, refillPerMinute: 1, pauseWhenEmpty: true };
const headSha = "a".repeat(40);
const pending = (slot: number, now: number): ThreadPrAutoDispatchPending => ({
  fingerprint: `fingerprint-${slot}`, prKey: "fixture-pr", prNumber: 1,
  prUrl: "https://github.com/example/project/pull/1", headSha,
  eventKinds: ["ci-failure"], createdAt: now, scheduledAt: now,
});

it("preserves SQLite results and write counts through both owner-core PR storage ports", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  // The existing SQLite methods are the oracle. Interleaved owners, expired
  // leases and retries through the extracted contracts must keep their exact
  // results and commit counts, without moving any lifecycle work into a port.
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 30 }), async (operations) => {
    const db = openInMemoryStateDb();
    const oracleDb = openInMemoryStateDb();
    const sqlite = new SqliteOverlayStore(db);
    const oracle = new SqliteOverlayStore(oracleDb);
    const port: PrAutoDispatchStorage & PrStatusWatchStorage = sqlite;
    let now = 1_000;
    try {
      for (const store of [sqlite, oracle]) {
        for (const slot of [0, 1]) {
          await store.setThreadPrAutoDispatchEnabled({ backend: "codex", threadId: `thread-${slot}`, enabled: true });
          await store.scheduleThreadPrAutoDispatch({ backend: "codex", threadId: `thread-${slot}`,
            pending: pending(slot, now), prompt: "Repair the fixture PR.", maxAttempts: 2 });
          await store.registerThreadPrStatusWatch({ watch: {
            watchId: `watch-${slot}`, backend: "codex", threadId: `thread-${slot}`, prKey: "fixture-pr",
            prUrl: "https://github.com/example/project/pull/1", prNumber: 1, headSha,
            notifyOn: ["success", "failure"], createdAt: now + slot, failureHandledByAutoFix: false,
          }, now });
        }
      }
      for (const op of operations) {
        now += op.advance;
        const run = (store: PrAutoDispatchStorage & PrStatusWatchStorage): Promise<unknown> => {
          const identity = { backend: "codex" as const, threadId: `thread-${op.slot}` };
          const claim = { ...identity, fingerprint: `fingerprint-${op.slot}`, ownerId: op.ownerId, now };
          const watch = { watchId: `watch-${op.slot}`, ownerId: op.ownerId, now };
          if (op.kind === "schedule") return store.scheduleThreadPrAutoDispatch({ ...identity,
            pending: pending(op.slot, now), prompt: "Repair the fixture PR.", maxAttempts: 2 });
          if (op.kind === "begin") return store.beginThreadPrAutoDispatch({ ...claim, leaseExpiresAt: now + 60_000, maxAttempts: 2 });
          if (op.kind === "reserve") return store.reserveThreadPrAutoDispatchBudget({ ...claim, config: budget });
          if (op.kind === "renew") return store.renewThreadPrAutoDispatchLease({ ...claim, leaseExpiresAt: now + 60_000 });
          if (op.kind === "finish") return store.finishThreadPrAutoDispatch({ ...claim, budgetConfig: budget,
            status: op.success ? "dispatched" : "failed", refundBudgetReservation: !op.success });
          if (op.kind === "cancel") return store.cancelThreadPrAutoDispatch(claim);
          if (op.kind === "recover") return store.recoverOrphanedThreadPrAutoDispatches({ budgetConfig: budget, now, scheduledAt: now });
          if (op.kind === "watch-claim") return store.claimThreadPrStatusWatches({ prKey: "fixture-pr", headSha,
            outcome: op.success ? "success" : "failure", now, ownerId: op.ownerId, leaseExpiresAt: now + 60_000, maxAttempts: 3 });
          if (op.kind === "watch-renew") return store.renewThreadPrStatusWatchLease({ ...watch, leaseExpiresAt: now + 60_000 });
          if (op.kind === "watch-release") return store.releaseThreadPrStatusWatch({ ...watch, spendAttempt: op.success, maxAttempts: 3 });
          return store.finishThreadPrStatusWatch({ ...watch, prKey: "fixture-pr", headSha, outcome: op.success ? "success" : "failure" });
        };
        const actual = await measureSqliteWrites(() => run(port));
        const expected = await measureSqliteWrites(() => run(oracle));
        expect(actual.result).toEqual(expected.result);
        for (const counter of ["commits", "statements", "rowsChanged"] as const) {
          expect(actual.writes[counter], `${op.kind}: ${counter}`).toBe(expected.writes[counter]);
        }
        for (const slot of [0, 1]) {
          const identity = { backend: "codex" as const, threadId: `thread-${slot}` };
          expect(await port.getThreadPrAutoDispatchPending(identity)).toEqual(await oracle.getThreadPrAutoDispatchPending(identity));
          expect(await port.isThreadPrStatusWatchClaimActive({ watchId: `watch-${slot}`, ownerId: op.ownerId }))
            .toBe(await oracle.isThreadPrStatusWatchClaimActive({ watchId: `watch-${slot}`, ownerId: op.ownerId }));
        }
      }
    } finally { db.close(); oracleDb.close(); }
  }), { numRuns: 25 });
});
