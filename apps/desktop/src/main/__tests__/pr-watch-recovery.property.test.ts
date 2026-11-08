import fc from "fast-check";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildPullRequestStatusKey, type PrSummary, type ThreadPullRequestWatchSummary } from "@pwragent/shared";
import { SqliteOverlayStore as PortableOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { PrStatusWatchCoordinator } from "../pr-status/pr-status-watch";
import { canReclaimPrWatchLease, createPrWatchOwnerId } from "../pr-status/pr-watch-owner";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const runtime = vi.hoisted(() => ({
  instanceId: "runtime-v2-new", startedAt: 1000,
  alive: new Set<number>(), identities: [] as Array<{ instanceId: string; processId: number; startedAt: number }>,
}));
vi.mock("../profile", async (original) => {
  const actual = await original<typeof import("../profile")>();
  return {
    ...actual,
    getProcessRuntimeIdentity: () => ({ instanceId: runtime.instanceId, startedAt: runtime.startedAt }),
    isProcessAlive: (pid: number) => pid === 2147483000 ? runtime.alive.has(pid) : actual.isProcessAlive(pid),
    readProfileRuntimeIdentities: () => runtime.identities,
  };
});
afterEach(() => { runtime.alive.clear(); runtime.identities = []; vi.unstubAllEnvs(); });

const pr: PrSummary = {
  provider: "github.com", org: "fixture", repo: "project", number: 1,
  url: "https://github.com/fixture/project/pull/1", title: "Fixture", state: "passing",
  lifecycleState: "merged", headSha: "a".repeat(40),
};
const prKey = buildPullRequestStatusKey(pr);
const oldPid = 2147483000;
function ownerId(opaque: boolean): string {
  return opaque ? "old-random-uuid" : JSON.stringify({
    kind: "pr-watch-runtime-v1", processId: oldPid,
    instanceId: "runtime-v2-old", startedAt: 1, claimId: "old-coordinator",
  });
}

async function interrupt(store: SqliteOverlayStore, db: StateDb, legacy: boolean, opaque: boolean, owner = ownerId(opaque)) {
  const watch: ThreadPullRequestWatchSummary = {
    watchId: "watch", backend: "codex", threadId: "thread", prKey, prUrl: pr.url,
    prNumber: 1, headSha: pr.headSha!, kind: "terminal", notifyOn: ["merged"],
    createdAt: 1000, failureHandledByAutoFix: false,
  };
  await store.registerThreadPrStatusWatch({ watch, now: 1000 });
  if (!legacy) {
    await store.observeThreadPrTerminalWatches({ pr, observedAt: 1000, outcome: "merged", now: 1000 });
    await store.claimThreadPrTerminalWatches({ prKey, now: 1000, ownerId: owner, leaseExpiresAt: 61000, maxAttempts: 3 });
  } else {
    // Persisted by the pre-retirement version, before terminal observations existed.
    db.raw.prepare(`UPDATE pr_status_watches SET status = 'dispatching', attempt_count = 1,
      lease_owner = ?, lease_expires_at = 61000 WHERE watch_id = 'watch'`).run(owner);
  }
}

async function replay(store: SqliteOverlayStore, now: number, delivered: string[]) {
  const coordinator = new PrStatusWatchCoordinator({ store, now: () => now,
    registry: { submitTurnIfIdle: async ({ threadId }) => { delivered.push(threadId); return { status: "started" }; } },
  });
  // Same two passes as DesktopAppServerService's one startup replay.
  for (const saved of await store.listPendingPrTerminalWatchObservations()) {
    await coordinator.handleTerminalSnapshot(saved.pr, saved.observedAt, { fromSavedObservation: true, pendingOnly: true });
  }
  for (const key of await store.listPendingPrTerminalWatchPrKeys({ unobservedOnly: true })) {
    if (key === prKey) await coordinator.handleTerminalSnapshot(pr, 1000, { fromSavedObservation: true });
  }
}

for (const legacy of [false, true]) {
  for (const opaque of [false, true]) {
    it(`recovers ${legacy ? "legacy dispatching" : "pending terminal"} with ${opaque ? "opaque" : "runtime"} ownership after process exit and startup before lease expiry`, async () => {
      const fixture = createTempStateDb("pr-watch-recovery-");
      let db = StateDb.open(fixture.dbPath);
      try {
        await interrupt(new SqliteOverlayStore(db), db, legacy, opaque);
        db.close();
        db = StateDb.open(fixture.dbPath);
        const store = new SqliteOverlayStore(db);
        runtime.identities = [{ instanceId: runtime.instanceId, startedAt: runtime.startedAt, processId: process.pid }];
        const delivered: string[] = [];
        await replay(store, 1001, delivered);
        await replay(store, 1002, delivered);
        expect(delivered).toEqual(["thread"]);
      } finally { db.close(); removeTempStateDbDir(fixture.tempDir); }
    });
  }
}

it("matches process ownership across exits, sibling startups and lease clock changes", async () => {
  await fc.assert(fc.asyncProperty(
    fc.boolean(), fc.boolean(), fc.array(fc.record({ alive: fc.boolean(), delta: fc.integer({ min: 1, max: 90000 }) }), { minLength: 1, maxLength: 8 }), fc.boolean(),
    async (legacy, opaque, steps, portable) => {
      const db = openInMemoryStateDb();
      try {
        const store = portable
          ? new PortableOverlayStore(db, { canReclaimPrWatchLease })
          : new SqliteOverlayStore(db);
        await interrupt(store, db, legacy, opaque);
        let exited = false;
        let deliveredByModel = false;
        let now = 1000;
        const delivered: string[] = [];
        for (const step of steps) {
          // An exited process never returns; a later startup has a new identity.
          exited ||= !step.alive;
          runtime.alive = exited ? new Set() : new Set([oldPid]);
          runtime.identities = [
            { instanceId: runtime.instanceId, startedAt: runtime.startedAt, processId: process.pid },
            ...(!exited ? [{ instanceId: "runtime-v2-old", startedAt: 1, processId: oldPid }] : []),
          ];
          now += step.delta;
          // No replay may steal a live owner's work, even for an opaque
          // claim: the sole-runtime proof becomes available after exit.
          if (exited) deliveredByModel = true;
          await replay(store, now, delivered);
          expect(delivered).toHaveLength(deliveredByModel ? 1 : 0);
        }
      } finally { db.close(); }
    },
  ), { numRuns: 25 });
});

it("retains lease-based recovery for a portable host without a process ownership policy", async () => {
  const db = openInMemoryStateDb();
  try {
    const store = new PortableOverlayStore(db);
    await interrupt(store, db, false, false);
    const delivered: string[] = [];
    await replay(store, 1001, delivered);
    expect(delivered).toEqual([]);
    await replay(store, 61000, delivered);
    await replay(store, 61001, delivered);
    expect(delivered).toEqual(["thread"]);
  } finally { db.close(); }
});

it("uses a real process exit as the recovery oracle before the lease expires", async () => {
  const child = spawn(process.execPath, ["-e", `process.stdin.resume(); process.stdout.write(JSON.stringify({
    kind: "pr-watch-runtime-v1", processId: process.pid, instanceId: "runtime-v2-child", startedAt: Date.now(), claimId: "child"
  }));`], { stdio: ["pipe", "pipe", "pipe"] });
  const db = openInMemoryStateDb();
  try {
    const [data] = await once(child.stdout, "data");
    const store = new SqliteOverlayStore(db);
    await interrupt(store, db, false, false, String(data));
    const delivered: string[] = [];
    await replay(store, 1001, delivered);
    expect(delivered).toEqual([]);
    const exited = once(child, "exit");
    child.stdin.end();
    await exited;
    await replay(new SqliteOverlayStore(db), 1002, delivered);
    await replay(store, 1003, delivered);
    expect(delivered).toEqual(["thread"]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    db.close();
  }
});

it("does not duplicate an in-flight delivery when another connection replays after lease expiry", async () => {
  const fixture = createTempStateDb("pr-watch-recovery-race-");
  const db = StateDb.open(fixture.dbPath);
  const siblingDb = StateDb.open(fixture.dbPath);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let first: Promise<number> | undefined;
  try {
    const store = new SqliteOverlayStore(db);
    await interrupt(store, db, false, false);
    const delivered: string[] = [];
    const coordinator = new PrStatusWatchCoordinator({ store, now: () => 1001,
      registry: { submitTurnIfIdle: async ({ threadId }) => {
        delivered.push(threadId);
        entered.resolve();
        await finish.promise;
        return { status: "started" };
      } },
    });
    first = coordinator.handleTerminalSnapshot(pr, 1000, { pendingOnly: true, fromSavedObservation: true });
    await entered.promise;
    await replay(new SqliteOverlayStore(siblingDb), 120000, delivered);
    expect(delivered).toEqual(["thread"]);
    finish.resolve();
    await first;
    expect(await store.listPendingPrTerminalWatchObservations()).toEqual([]);
  } finally {
    finish.resolve();
    await first;
    siblingDb.close(); db.close(); removeTempStateDbDir(fixture.tempDir);
  }
});

for (const legacy of [false, true]) {
  it(`budgets ${legacy ? "legacy" : "pending"} startup recovery and live-owner replays`, async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const fixture = createTempStateDb("pr-watch-recovery-budget-");
    const db = StateDb.open(fixture.dbPath);
    try {
      const store = new SqliteOverlayStore(db);
      await interrupt(store, db, legacy, false);
      const delivered: string[] = [];
      runtime.alive.add(oldPid);
      const live = await measureSqliteWrites(async () => {
        for (let i = 0; i < 10; i += 1) await replay(store, 100000 + i, delivered);
      });
      expectSqliteWriteBudget({ scenario: `pr-watch-recovery-${legacy ? "legacy" : "pending"}-live`, writes: live.writes,
        note: "Ten startup replays while a sibling owns delivery, including after lease expiry: zero commits and 0 MB/day recurring writes" });
      runtime.alive.clear();
      const recovery = await measureSqliteWrites(() => replay(store, 1001, delivered));
      expectSqliteWriteBudget({ scenario: `pr-watch-recovery-${legacy ? "legacy" : "pending"}-exit`, writes: recovery.writes,
        note: legacy
          ? "Observe, claim and finish one abandoned legacy wake: 3 commits/28.8 KB WAL; 50 recoveries/day x 28.8 KB = ~1.44 MB/day, zero idle writes"
          : "Claim and finish one abandoned pending wake: 2 commits/16.5 KB WAL; 50 recoveries/day x 16.5 KB = ~0.82 MB/day, zero idle writes" });
      expect(delivered).toEqual(["thread"]);
    } finally { db.close(); removeTempStateDbDir(fixture.tempDir); }
  });
}

it("fences coordinators in one runtime and recognizes a restarted runtime at the same PID", () => {
  const first = createPrWatchOwnerId();
  const second = createPrWatchOwnerId();
  expect(JSON.parse(first)).toMatchObject({ processId: process.pid, instanceId: runtime.instanceId, startedAt: runtime.startedAt });
  expect(first).not.toBe(second);
  expect(canReclaimPrWatchLease(first, 0, 100000)).toBe(false);
  const previous = JSON.stringify({ ...JSON.parse(first), instanceId: "runtime-v2-previous" });
  expect(canReclaimPrWatchLease(previous, 61000, 1001)).toBe(true);
});

it("reads stale live runtime markers without expiring them and refuses incomplete evidence", async () => {
  const profile = await vi.importActual<typeof import("../profile")>("../profile");
  const fixture = createTempStateDb("pr-watch-runtime-markers-");
  const options = { env: { PWRAGENT_HOME: fixture.tempDir }, instanceId: "fixture-runtime", processId: process.pid, now: () => 1 };
  const heartbeat = profile.startProfileRuntimeHeartbeat("fixture", options);
  heartbeat.stopRefreshing();
  try {
    expect(profile.readProfileRuntimeIdentities("fixture", options)).toEqual([
      expect.objectContaining({ instanceId: "fixture-runtime", processId: process.pid, heartbeatAt: 1 }),
    ]);
    expect(existsSync(heartbeat.markerPath)).toBe(true);
    writeFileSync(path.join(path.dirname(heartbeat.markerPath), "unreadable.json"), "{");
    expect(profile.readProfileRuntimeIdentities("fixture", options)).toBeUndefined();
  } finally { heartbeat.stop(); removeTempStateDbDir(fixture.tempDir); }
});
