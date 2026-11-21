import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { buildPullRequestStatusKey, type PrSummary } from "@pwragent/shared/contracts/navigation";
import {
  type PullRequestTerminalDetails,
  type ThreadPullRequestWatchEvent,
} from "@pwragent/shared/contracts/thread-tools";
import { PrStatusWatchCoordinator } from "../pr-status/pr-status-watch";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { StateDb } from "../state/state-db";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const identity = { backend: "codex" as const, threadId: "parked-parent" };
const pr: PrSummary = {
  provider: "github.com", org: "fixture", repo: "project", number: 17,
  title: "Fixture lifecycle", url: "https://github.com/fixture/project/pull/17",
  state: "passing", checkState: "passing", lifecycleState: "merged", headSha: "a".repeat(40),
};

it("selects saved observations, unobserved PRs, and ordered history from the same watch inventory", async () => {
  const fixtures = [
    { id: "saved", backend: "codex", threadId: identity.threadId, prNumber: 17, status: "pending_terminal" },
    { id: "leased", backend: "codex", threadId: identity.threadId, prNumber: 31, status: "notifying_terminal" },
    { id: "duplicate-event", backend: "claude", threadId: identity.threadId, prNumber: 17, status: "notifying_terminal" },
    { id: "new-subscription", backend: "codex", threadId: identity.threadId, prNumber: 17, status: "watching" },
    { id: "legacy-claim", backend: "codex", threadId: identity.threadId, prNumber: 2, status: "dispatching" },
    { id: "other-thread", backend: "codex", threadId: "other", prNumber: 10, status: "watching" },
    { id: "checks", backend: "codex", threadId: identity.threadId, prNumber: 8, status: "watching", checks: true },
    { id: "history-a", backend: "codex", threadId: identity.threadId, prNumber: 11, status: "dispatched", endedAt: 7 },
    { id: "history-b", backend: "codex", threadId: identity.threadId, prNumber: 12, status: "failed", endedAt: 7 },
    { id: "history-c", backend: "codex", threadId: identity.threadId, prNumber: 13, status: "cancelled", endedAt: 4 },
    { id: "history-d", backend: "codex", threadId: identity.threadId, prNumber: 14, status: "superseded", endedAt: 8, checks: true },
    { id: "history-other-backend", backend: "claude", threadId: identity.threadId, prNumber: 15, status: "dispatched", endedAt: 9 },
  ] as const;
  await fc.assert(fc.asyncProperty(
    fc.shuffledSubarray([...fixtures], { minLength: fixtures.length, maxLength: fixtures.length }),
    fc.integer({ min: 1, max: 5 }),
    async (inventory, limit) => {
      const db = openInMemoryStateDb();
      const store = new SqliteOverlayStore(db);
      try {
        const insert = db.raw.prepare(`INSERT INTO pr_status_watches (
          watch_id, backend, thread_id, pr_key, head_sha, notify_on_success, notify_on_failure,
          notify_on_merged, status, lease_owner, lease_expires_at, created_at, updated_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1, ?, ?)`);
        const rows = inventory.map((entry) => {
          const { id, backend, threadId, prNumber, status } = entry;
          const checks = "checks" in entry;
          const snapshot = { ...pr, number: prNumber, url: `https://github.com/fixture/project/pull/${prNumber}` };
          const saved = status === "pending_terminal" || status === "notifying_terminal";
          const unobserved = status === "watching" || status === "dispatching";
          const leased = status === "notifying_terminal" || status === "dispatching";
          const updatedAt = "endedAt" in entry ? entry.endedAt : 3;
          const watch = { watchId: id, backend, threadId, prNumber, prKey: buildPullRequestStatusKey(snapshot),
            prUrl: snapshot.url, kind: checks ? "checks" : "terminal", headSha: checks ? pr.headSha! : "",
            notifyOn: checks ? ["success"] : ["merged"], createdAt: 1, failureHandledByAutoFix: false };
          const observation = saved ? { pr: snapshot, observedAt: 2 } : undefined;
          insert.run(id, backend, threadId, watch.prKey, watch.headSha, Number(checks), Number(!checks),
            status, leased ? "prior-owner" : null, leased ? 10 : null, updatedAt,
            JSON.stringify({ ...watch, terminalObservation: observation }));
          return { watch, status, updatedAt, unobserved, observation, checks };
        });
        for (const thread of [undefined, identity, { ...identity, backend: "claude" as const }]) {
          const scoped = thread ? rows.filter(({ watch }) => watch.backend === thread.backend && watch.threadId === thread.threadId) : rows;
          const observations = new Map(scoped.flatMap(({ observation }) =>
            observation ? [[JSON.stringify(observation), observation] as const] : []));
          expect(await store.listPendingPrTerminalWatchObservations(thread)).toEqual([...observations.values()]);
          for (const unobservedOnly of [false, true]) {
            const keys = scoped.filter((row) => !row.checks && (row.unobserved || (!unobservedOnly && row.observation)))
              .map(({ watch }) => watch.prKey);
            expect(await store.listPendingPrTerminalWatchPrKeys({ ...thread, unobservedOnly })).toEqual([...new Set(keys)].sort());
          }
          if (thread) {
            const history = scoped.filter((row) => !row.unobserved && !row.observation)
              .map(({ watch, status, updatedAt }) => ({ ...watch, status, updatedAt }))
              .sort((a, b) => b.updatedAt - a.updatedAt || b.watchId.localeCompare(a.watchId))
              .slice(0, limit);
            expect(await store.listThreadPrStatusWatchHistory({ ...thread, limit })).toEqual(history);
          }
        }
      } finally { db.close(); }
    },
  ), { numRuns: 25 });
});

async function assertRenamedPendingEvent(renames: number, expiredLease: boolean, outcome: "merged" | "closed"): Promise<void> {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  let current = { ...pr, lifecycleState: outcome };
  const submitTurnIfIdle = vi.fn(async () => ({ status: "started" as const, turnId: "wake" }));
  const coordinator = new PrStatusWatchCoordinator({ store, registry: { submitTurnIfIdle }, now: () => 300 });
  try {
    const watch = { ...identity, watchId: "pending", prKey: buildPullRequestStatusKey(current), prUrl: current.url,
      prNumber: current.number, kind: "terminal" as const, headSha: "", notifyOn: [outcome], createdAt: 1,
      failureHandledByAutoFix: false };
    await store.registerThreadPrStatusWatch({ watch, now: 1 });
    await store.observeThreadPrTerminalWatches({ pr: current, observedAt: 2, outcome, now: 2 });
    if (expiredLease) await store.claimThreadPrTerminalWatches({ prKey: watch.prKey, now: 3,
      ownerId: "exited", leaseExpiresAt: 100, maxAttempts: 3 });
    for (let index = 0; index < renames; index += 1) {
      const next = { ...current, repo: `renamed-${index}`, url: `https://github.com/fixture/renamed-${index}/pull/17` };
      // A reopened PR may also have a new active subscription. Moving
      // an older event must not merge it into that subscription.
      await store.registerThreadPrStatusWatch({ watch: { ...watch, watchId: `active-${index}`,
        prKey: buildPullRequestStatusKey(next), prUrl: next.url }, now: 4 });
      const oldKey = buildPullRequestStatusKey(current);
      const nextKey = buildPullRequestStatusKey(next);
      const canonicalize = { now: 200,
        canonicalizePrKey: (key: string) => key === oldKey ? nextKey : key,
        canonicalizePrUrl: (url: string) => url === current.url ? next.url : url };
      expect(await store.canonicalizeThreadPrStatusWatchKeys(canonicalize)).toBeGreaterThan(0);
      expect(await store.canonicalizeThreadPrStatusWatchKeys(canonicalize)).toBe(0);
      expect(await store.listPendingPrTerminalWatchObservations(identity)).toEqual([{ pr: next, observedAt: 2 }]);
      expect((await store.listActiveThreadPrStatusWatches(identity)).some((row) => row.prKey === nextKey)).toBe(true);
      current = next;
    }
    await store.cancelThreadPrStatusWatchesForPr({ ...identity, prKey: buildPullRequestStatusKey(current), now: 300 });
    expect(await store.listPendingPrTerminalWatchObservations(identity)).toEqual([]);
    await coordinator.handleTerminalSnapshot(current, 2, { fromSavedObservation: true, pendingOnly: true });
    expect(submitTurnIfIdle).not.toHaveBeenCalled();
  } finally { db.close(); }
}

async function assertCachedDetailsDelivery(mergeMethod: "merge" | "squash" | "rebase", retries: number): Promise<void> {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  const details: PullRequestTerminalDetails = { outcome: "merged", prKey: buildPullRequestStatusKey(pr),
    prUrl: pr.url, prNumber: pr.number, mergeMethod, mergeCommitSha: "b".repeat(40) };
  const fetchTerminalDetails = vi.fn(async () => details);
  let busy = true;
  const submitted: string[] = [];
  const submitTurnIfIdle = vi.fn(async ({ input }: { input: Array<{ type: string; text?: string }> }) => {
    if (busy) return { status: "busy" as const };
    submitted.push(input[0]?.text ?? "");
    return { status: "started" as const, turnId: "wake" };
  });
  const coordinator = new PrStatusWatchCoordinator({ store, registry: { submitTurnIfIdle }, fetchTerminalDetails, now: () => 100 });
  try {
    await store.registerThreadPrStatusWatch({ now: 1, watch: {
      ...identity, watchId: "details", prKey: buildPullRequestStatusKey(pr), prUrl: pr.url, prNumber: pr.number,
      kind: "terminal", headSha: "", notifyOn: ["merged"], createdAt: 1, failureHandledByAutoFix: false,
    } });
    await coordinator.handleTerminalSnapshot(pr, 2);
    for (let index = 0; index < retries; index += 1) {
      await coordinator.handleTerminalSnapshot(pr, 2, { fromSavedObservation: true, pendingOnly: true });
    }
    busy = false;
    await coordinator.handleTerminalSnapshot(pr, 2, { fromSavedObservation: true, pendingOnly: true });
    expect(fetchTerminalDetails).toHaveBeenCalledTimes(1);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain(`Merge method: ${mergeMethod}`);
    expect(submitted[0]).toContain(details.mergeCommitSha);
    expect(submitted[0]).not.toContain("Using the saved terminal observation");
  } finally { db.close(); }
}

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

  it("cancels a renamed pending merge event when its canonical PR is detached", async () => {
    await assertRenamedPendingEvent(1, false, "merged");
  });

  it("keeps fetched merge details on the first busy retry", async () => {
    await assertCachedDetailsDelivery("merge", 1);
  });

  it("keeps pending events aligned with repository renames and detachment", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 3 }),
      fc.boolean(),
      fc.constantFrom("merged" as const, "closed" as const),
      assertRenamedPendingEvent,
    ), { numRuns: 25 });
  });

  it("delivers previously fetched merge details after any number of busy retries without another forge read", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("merge" as const, "squash" as const, "rebase" as const),
      fc.integer({ min: 1, max: 5 }),
      assertCachedDetailsDelivery,
    ), { numRuns: 25 });
  });

  it("measures pending event key migration as one boundary commit", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("terminal-rename-budget-");
    const db = StateDb.open(temp.dbPath);
    const store = new SqliteOverlayStore(db);
    try {
      await store.registerThreadPrStatusWatch({ now: 1, watch: {
        ...identity, watchId: "rename-budget", prKey: buildPullRequestStatusKey(pr), prUrl: pr.url, prNumber: pr.number,
        kind: "terminal", headSha: "", notifyOn: ["merged"], createdAt: 1, failureHandledByAutoFix: false,
      } });
      await store.observeThreadPrTerminalWatches({ pr, observedAt: 2, outcome: "merged", now: 2 });
      const { writes } = await measureSqliteWrites(async () => {
        for (let index = 0; index < 10; index += 1) {
          await store.canonicalizeThreadPrStatusWatchKeys({ now: 3,
            canonicalizePrKey: (key) => key.replace("/project#", "/renamed#"),
            canonicalizePrUrl: (url) => url.replace("/project/", "/renamed/") });
        }
      });
      expectSqliteWriteBudget({ scenario: "pr-terminal-watch-rename", writes,
        note: "one pending event renamed and nine unchanged syncs: 1 commit/~8.2 KB WAL per rename, 0 idle writes; ~0.4 MB/day at 50 renames/day" });
    } finally { db.close(); removeTempStateDbDir(temp.tempDir); vi.unstubAllEnvs(); }
  });

});
