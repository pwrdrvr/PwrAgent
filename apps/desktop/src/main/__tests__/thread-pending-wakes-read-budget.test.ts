import { afterEach, expect, it, vi } from "vitest";
import { statSync } from "node:fs";
import path from "node:path";
import { buildThreadPendingWakes, type ThreadPendingWakeReaders } from "../app-server/thread-pending-wakes";
import { ThreadPendingWakesCache } from "../app-server/thread-pending-wakes-cache";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { ThreadDependencyStore } from "../state/thread-dependency-store";
import { ScheduledThreadActionStore } from "../storage/scheduled-thread-action-store";
import { FileScheduledThreadActionPayloadStore } from "../storage/scheduled-thread-action-payload-store";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { expectPendingWakeReadBudget } from "./fixtures/pending-wake-read-budget";

const THREAD = { backend: "codex" as const, threadId: "selected" };
// Two local and two peer callers exercise contention on every tick. Keep the
// tick count and elapsed time so expiry and invalidation retain their coverage.
const CALLERS_PER_TICK = 4;
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it.each([0, 160])("budgets owner projection reads under repeated local and peer demand (%i unrelated threads)", async (unrelated) => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const fixture = createTempStateDb("pending-wake-read-budget-");
  // Read budgets use one connection; only scheduled payloads need real files.
  const db = openInMemoryStateDb();
  const overlay = new SqliteOverlayStore(db);
  const dependencies = new ThreadDependencyStore(db.raw);
  const payloadDirectory = path.join(fixture.tempDir, "payloads");
  const payloads = new FileScheduledThreadActionPayloadStore(payloadDirectory);
  let scheduled = new ScheduledThreadActionStore(db, payloads);
  const watch = { ...THREAD, watchId: "watch", prKey: "github/acme/widgets#1", prUrl: "https://github.com/acme/widgets/pull/1",
    prNumber: 1, headSha: "abc", notifyOn: ["success" as const], createdAt: 1, failureHandledByAutoFix: false };
  try {
    await overlay.registerThreadPrStatusWatch({ watch, now: 1 });
    await overlay.setThreadPrAutoDispatchEnabled({ ...THREAD, enabled: true });
    await overlay.syncThreadPrAutoDispatchCandidates({ ...THREAD, prKeys: [watch.prKey], now: 1 });
    dependencies.register({ ...THREAD, id: "dependency", conditions: [{ backend: "codex", threadId: "upstream", when: "turn_completed" }],
      mode: "all", onFailure: "notify", continuation: "Follow up", status: "waiting", evidence: [], createdAt: 1, updatedAt: 1 });
    scheduled.create({ ...THREAD, id: "scheduled", kind: "turn", origin: "desktop", scheduledFor: 9_000,
      displayText: "Follow up", turn: { input: [{ type: "text", text: "Follow up" }] }, now: 1 });
    for (let i = 0; i < unrelated; i += 1) {
      const other = { backend: "codex" as const, threadId: `other-${i}` };
      await overlay.setThreadPrAutoDispatchEnabled({ ...other, enabled: true });
      await overlay.syncThreadPrAutoDispatchCandidates({ ...other, prKeys: [`unrelated-${i}`, watch.prKey], now: i + 2 });
      scheduled.create({ ...other, id: `other-action-${i}`, kind: "turn", origin: "desktop", scheduledFor: 9_000,
        displayText: "Unrelated ".repeat(200), now: 1 });
    }
    const counts = { requests: 0, builds: 0, sourceCalls: 0, sqliteSelects: 0, sqliteRows: 0, overlayPayloadBytes: 0,
      payloadFileReads: 0, payloadFileBytes: 0 };
    const plans = new Set<string>();
    const prepare = db.raw.prepare.bind(db.raw);
    const recordQuery = (sql: string, args: unknown[]) => {
      counts.sqliteSelects += 1;
      if (sql.includes("FROM pr_auto_dispatch_candidates")) {
        for (const row of prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>) plans.add(row.detail);
      }
    };
    const record = (row: unknown) => {
      if (row === undefined) return;
      counts.sqliteRows += 1;
      const payload = (row as { payload?: unknown }).payload;
      if (typeof payload === "string") counts.overlayPayloadBytes += Buffer.byteLength(payload);
    };
    vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.trimStart().startsWith("SELECT")) return statement;
      // These statements belong to this test's database. Wrap them directly so
      // the uncached control does not retain thousands of spies and call logs.
      const wrap = <Result>(execute: (...args: unknown[]) => Result) => (...args: unknown[]): Result => {
        recordQuery(sql, args);
        const result = execute(...args);
        for (const row of Array.isArray(result) ? result : [result]) record(row);
        return result;
      };
      statement.get = wrap(statement.get.bind(statement));
      statement.all = wrap(statement.all.bind(statement));
      const iterate = statement.iterate.bind(statement);
      statement.iterate = function* (...args: unknown[]) {
        recordQuery(sql, args);
        for (const row of iterate(...args)) { record(row); yield row; }
      };
      return statement;
    });
    const readPayload = payloads.read.bind(payloads);
    vi.spyOn(payloads, "read").mockImplementation((ref, maxBytes) => {
      counts.payloadFileReads += 1;
      counts.payloadFileBytes += statSync(path.join(payloadDirectory, ref)).size;
      return readPayload(ref, maxBytes);
    });
    const sourceReaders: ThreadPendingWakeReaders = {
      prWatches: (thread) => overlay.listActiveThreadPrStatusWatches(thread),
      prWatchHistory: (thread, limit) => overlay.listThreadPrStatusWatchHistory({ ...thread, limit }),
      autoFix: async (thread) => (await overlay.listPrAutoDispatchCandidates(thread)).map((candidate) => ({
        backend: candidate.backend, threadId: candidate.threadId, prKey: candidate.prKey, state: "active" as const,
      })),
      dependencies: async (thread, limit) => dependencies.listPendingWakes(thread.backend, thread.threadId, limit),
      scheduledActions: (thread, endedLimit) => scheduled.listPendingWakes({ ...thread, endedLimit }),
      recentSubAgents: (thread, limit) => overlay.listEndedThreadTaskMonitors({ ...thread, limit }),
      monitors: () => [], backendTasks: async () => [], backendWakes: () => [],
      // The registry's lock check reads this overlay; paused-project and queue state are in memory.
      hold: async (thread) => { await overlay.getThreadOverlayState(thread); return undefined; },
      heldEntries: () => [],
    };
    const readers = Object.fromEntries(Object.entries(sourceReaders).map(([name, read]) => [name, (...args: unknown[]) => {
      counts.sourceCalls += 1;
      return Reflect.apply(read, undefined, args);
    }])) as ThreadPendingWakeReaders;
    // Isolate the cost of owner reuse: the same bounded builder and stores,
    // with completed-result caching and single-flight admission bypassed.
    for (let tick = 0; tick < 32; tick += 1) {
      await Promise.all(Array.from({ length: CALLERS_PER_TICK }, (_, caller) => {
        counts.requests += 1;
        counts.builds += 1;
        return buildThreadPendingWakes(readers, THREAD, { endedLimit: 0, ...(caller % 2 ? { activePrWatches: [watch] } : {}) });
      }));
      await vi.advanceTimersByTimeAsync(25);
    }
    expectPendingWakeReadBudget("uncached-mixed-local-peer-active-burst", { ...counts });
    for (const name of Object.keys(counts) as Array<keyof typeof counts>) counts[name] = 0;
    scheduled = new ScheduledThreadActionStore(db, payloads);
    const cache = new ThreadPendingWakesCache(async (thread, options) => {
      counts.builds += 1;
      return await buildThreadPendingWakes(readers, thread, options);
    });
    // Sequential batches catch completed-result amplification as well as single-flight sharing.
    for (let tick = 0; tick < 32; tick += 1) {
      await Promise.all(Array.from({ length: CALLERS_PER_TICK }, (_, caller) => {
        counts.requests += 1;
        return cache.read(THREAD, { endedLimit: 0, ...(caller % 2 ? { activePrWatches: [watch] } : {}) });
      }));
      await vi.advanceTimersByTimeAsync(25);
    }
    expectPendingWakeReadBudget("mixed-local-peer-active-burst", { ...counts });
    // A source-event storm invalidates freshness, but cannot bypass owner admission.
    const changed = [];
    for (let tick = 0; tick < 32; tick += 1) {
      cache.invalidate(THREAD);
      for (let caller = 0; caller < CALLERS_PER_TICK; caller += 1) {
        counts.requests += 1;
        changed.push(cache.read(THREAD, { endedLimit: 0 }));
      }
      await vi.advanceTimersByTimeAsync(25);
    }
    await Promise.all(changed);
    expectPendingWakeReadBudget("mixed-local-peer-invalidated-burst", { ...counts });
    expect(plans.size).toBeGreaterThan(0);
    expect([...plans].every((plan) => /SEARCH pr_auto_dispatch_candidates USING/.test(plan)), JSON.stringify([...plans])).toBe(true);
    cache.clear();
  } finally {
    vi.restoreAllMocks();
    db.close();
    removeTempStateDbDir(fixture.tempDir);
  }
});
