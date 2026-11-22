import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { ScheduledThreadActionService } from "../scheduled-actions/scheduled-thread-action-service";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { StateDb } from "../state/state-db";
import { FileScheduledThreadActionPayloadStore } from "../storage/scheduled-thread-action-payload-store";
import { ScheduledThreadActionStore } from "../storage/scheduled-thread-action-store";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

function observeSql(db: StateDb) {
  const prepare = db.raw.prepare.bind(db.raw);
  const reads: Array<{ sql: string; args: unknown[]; rows: number; plan: string[] }> = [];
  const spy = vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) return statement;
    const record = (args: unknown[], rows: number) => {
      reads.push({ sql, args, rows, plan: (prepare("EXPLAIN QUERY PLAN " + sql).all(...args) as Array<{ detail: string }>).map(row => row.detail) });
    };
    const all = statement.all.bind(statement);
    const get = statement.get.bind(statement);
    const iterate = statement.iterate.bind(statement);
    statement.all = (...args: unknown[]) => {
      const result = all(...args);
      record(args, result.length);
      return result;
    };
    statement.get = (...args: unknown[]) => {
      const result = get(...args);
      record(args, Number(result !== undefined));
      return result;
    };
    statement.iterate = function* (...args: unknown[]) {
      let rows = 0;
      try {
        for (const row of iterate(...args)) {
          rows++;
          yield row;
        }
      } finally {
        record(args, rows);
      }
    };
    return statement;
  });
  return { reads, restore: () => spy.mockRestore() };
}

type Reads = ReturnType<typeof observeSql>["reads"];

async function report(name: string, db: StateDb, reads: Reads) {
  const directory = process.env.PWRAGENT_SCHEDULED_QUERY_REPORT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await db.raw.backup(path.join(directory, name + ".db"));
  writeFileSync(path.join(directory, name + ".json"), JSON.stringify(reads));
}

const now = 40_000;
const projection = { projectionProtocol: 2 as const };
const activeStatuses = new Set(["held", "scheduled", "dispatching", "queued"]);

it.each([1_000, 2_000, 8_000])("bounds scheduler projection and observer work with %i retained terminal actions", async (history) => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const { dbPath, tempDir } = createTempStateDb("scheduled-projection-budget-");
  const db = StateDb.open(dbPath);
  const peer = StateDb.open(dbPath);
  const payloads = new FileScheduledThreadActionPayloadStore(path.join(tempDir, "scheduled-actions"));
  const store = new ScheduledThreadActionStore(db, payloads);
  const publishLocalEvent = vi.fn(async () => undefined);
  let tick!: () => void;
  const scheduler = new ScheduledThreadActionService({
    store, now: () => now,
    registry: {
      publishLocalEvent, onEvent: () => () => undefined,
    } as unknown as DesktopBackendRegistry,
    setTimer: () => ({}) as ReturnType<typeof setTimeout>, clearTimer: () => undefined,
    setLeaseTimer: (callback, delay) => {
      expect(delay).toBe(10_000);
      tick = callback;
      return {} as ReturnType<typeof setInterval>;
    },
    clearLeaseTimer: () => undefined,
  });
  let observed: ReturnType<typeof observeSql> | undefined;
  try {
    const create = (id: string, scheduledFor: number, createdAt: number) => store.create({
      id, backend: "codex", threadId: "fixture", kind: "turn", origin: "desktop", scheduledFor,
      now: createdAt, displayText: id,
    });
    const expected = db.raw.transaction(() => {
      const displayText = "Retained fixture input";
      const payloadRef = payloads.write("retained-fixture", { displayText });
      const insert = db.raw.prepare(`INSERT INTO scheduled_thread_actions
        (action_id, backend, thread_id, kind, origin, status, scheduled_for, created_at, updated_at, payload_ref)
        VALUES (?, 'codex', 'fixture', 'turn', 'desktop', 'cancelled', ?, ?, 2, ?)`);
      const actions = [];
      for (let i = history - 1; i >= 0; i--) {
        const id = `old-${String(i).padStart(5, "0")}`;
        const scheduledFor = 100_000 + i % 5;
        const createdAt = i % 2;
        insert.run(id, scheduledFor, createdAt, payloadRef);
        actions.push({ id, scheduledFor, createdAt, updatedAt: 2, status: "cancelled",
          backend: "codex", threadId: "fixture", kind: "turn", origin: "desktop", displayText });
      }
      create("recent", 100_000, 0);
      actions.push(store.cancel("recent", now)!);
      actions.push(create("active", 100_000, 0));
      return actions.sort((a, b) => a.scheduledFor - b.scheduledFor || a.createdAt - b.createdAt
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    })();
    scheduler.start();
    await scheduler.evaluateDueActions();
    publishLocalEvent.mockClear();

    observed = observeSql(db);
    const window = scheduler.list({ ...projection, terminalUpdatedAfter: now });
    expect(window.actions).toEqual(expected.filter(a => activeStatuses.has(a.status) || a.updatedAt >= now));
    expect(window.complete).toBe(true);
    expect(window.observedAt).toBe(now);
    const windowReads = observed.reads.splice(0);
    await report(`window-${history}`, db, windowReads);

    const first = scheduler.list({ ...projection, includeTerminal: true });
    expect(first.actions).toEqual(expected.slice(0, 100));
    expect(first.complete).toBe(false);
    expect(first.nextCursor).toBeDefined();
    const historyReads = observed.reads.splice(0);
    await report(`history-${history}`, db, historyReads);

    peer.raw.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("unrelated", "test");
    const { writes } = await measureSqliteWrites(tick);
    expect(publishLocalEvent).not.toHaveBeenCalled();
    expect(writes.rowsChanged).toBe(0);
    expect(writes.walBytes).toBe(0);
    const heartbeatReads = observed.reads.splice(0);
    await report(`heartbeat-${history}`, db, heartbeatReads);

    // Work may scale with matching rows and delivered pages. The native plans
    // must seek into the window, and history cannot cross the JS boundary twice.
    const rows = (reads: Reads) => reads.reduce((sum, read) => sum + read.rows, 0);
    const unboundedScans = (reads: Reads) => reads.flatMap(read => read.plan)
      .filter(detail => /^SCAN scheduled_thread_actions\b/.test(detail));
    expect.soft(windowReads.length).toBeLessThanOrEqual(8);
    expect.soft(unboundedScans(windowReads)).toEqual([]);
    expect.soft(rows(historyReads)).toBeLessThanOrEqual(115);
    expect.soft(historyReads.flatMap(read => read.plan).some(detail => /TEMP B-TREE FOR ORDER BY/.test(detail))).toBe(false);
    expect.soft(rows(heartbeatReads)).toBeLessThanOrEqual(15);
    expect.soft(unboundedScans(heartbeatReads)).toEqual([]);
  } finally {
    observed?.restore();
    scheduler.dispose();
    peer.close();
    db.close();
    removeTempStateDbDir(tempDir);
    vi.unstubAllEnvs();
  }
});

it.each([0, 8_000])("seeks within the requested thread with %i recent terminal rows on other threads", async (unrelated) => {
  const db = openInMemoryStateDb();
  const store = new ScheduledThreadActionStore(db);
  const thread = { backend: "codex" as const, threadId: "selected" };
  const observed = observeSql(db);
  try {
    const create = (id: string, scheduledFor: number) => store.create({
      ...thread, id, kind: "turn", origin: "desktop", displayText: id, now: 1, scheduledFor,
    });
    const active = create("active", 10);
    create("old-terminal", 20);
    create("recent-terminal", 30);
    store.cancel("old-terminal", now - 1);
    const recent = store.cancel("recent-terminal", now);
    db.raw.prepare(`WITH RECURSIVE ids(i) AS (
      SELECT 1 WHERE ? > 0 UNION ALL SELECT i + 1 FROM ids WHERE i < ?
    )
    INSERT INTO scheduled_thread_actions
      (action_id, backend, thread_id, kind, origin, status, scheduled_for, created_at, updated_at, payload_ref)
    SELECT 'peer-' || i, 'codex', 'other-' || i, 'turn', 'desktop', 'cancelled', 30, 1, ?, payload_ref
    FROM ids CROSS JOIN scheduled_thread_actions WHERE action_id = 'recent-terminal'`).run(unrelated, unrelated, now);
    observed.reads.length = 0;

    const page = store.listProjectionPage({ ...projection, ...thread, terminalUpdatedAfter: now });
    expect(page).toMatchObject({ actions: [active, recent], complete: true });
    await report(`thread-window-${unrelated}`, db, observed.reads);
    // Admission, revision, and page reads must all constrain the native
    // table seek by thread, even when other threads have recent history.
    const actionReads = observed.reads.flatMap(read => read.plan)
      .filter(detail => /^(SEARCH|SCAN) scheduled_thread_actions\b/.test(detail));
    expect(actionReads.length).toBeGreaterThan(0);
    expect(actionReads.filter(detail => !/SEARCH scheduled_thread_actions USING INDEX .*\(backend=\? AND thread_id=\?/.test(detail))).toEqual([]);
  } finally {
    observed.restore();
    db.close();
  }
});

async function measureScheduledActionWrites(db: StateDb, action: () => unknown) {
  // SQLite's per-statement changes() excludes the projection triggers. Keep
  // the normal commit/WAL metrics and count every row touched by this action.
  const totalChanges = db.raw.prepare("SELECT total_changes()").pluck();
  const before = Number(totalChanges.get());
  const { writes } = await measureSqliteWrites(action);
  return { ...writes, rowsChanged: Number(totalChanges.get()) - before };
}

it("budgets every mutation of one scheduled action including its projection trigger", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const { dbPath, tempDir } = createTempStateDb("scheduled-action-mutation-budget-");
  const db = StateDb.open(dbPath);
  const store = new ScheduledThreadActionStore(db);
  const id = "mutation-budget";
  const ownerId = "fixture-owner";
  const budget = async (operation: string, note: string, action: () => unknown) => {
    const writes = await measureScheduledActionWrites(db, action);
    expectSqliteWriteBudget({ scenario: "scheduled-projection-" + operation, note, writes });
  };
  try {
    await budget("create", "One schedule insert and its projection trigger in the same commit.", () => store.create({
      id, backend: "codex", threadId: "fixture", kind: "turn", origin: "desktop", displayText: "Scheduled", scheduledFor: now, now,
    }));
    await budget("edit", "One schedule and payload-reference update and its projection trigger in the same commit.",
      () => store.update(id, { now: now + 1, scheduledFor: now + 1, displayText: "Edited" }));
    await budget("claim", "One dispatch claim and its projection trigger in the same commit.",
      () => store.claim(id, { ownerId, now: now + 1, leaseExpiresAt: now + 30_001 }));
    await budget("cancel", "One claimed action ending and its projection trigger in the same commit.",
      () => store.markCancelled(id, now + 2, ownerId));
    await budget("prune", "One retained terminal action removed and its projection trigger in the same commit.",
      () => store.cleanupTerminalBefore(now + 3));
    expect(store.get(id)).toBeUndefined();
  } finally {
    db.close();
    removeTempStateDbDir(tempDir);
    vi.unstubAllEnvs();
  }
});

it("keeps a claimed action's heartbeat to one existing WAL commit", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const { dbPath, tempDir } = createTempStateDb("scheduled-claim-heartbeat-");
  const db = StateDb.open(dbPath);
  const store = new ScheduledThreadActionStore(db);
  let clock = now;
  let tick!: () => void;
  const scheduler = new ScheduledThreadActionService({
    store, now: () => clock, ownerId: "fixture-owner",
    registry: {
      publishLocalEvent: async () => undefined, onEvent: () => () => undefined,
    } as unknown as DesktopBackendRegistry,
    setLeaseTimer: callback => { tick = callback; return {} as ReturnType<typeof setInterval>; },
    clearLeaseTimer: () => undefined,
  });
  try {
    store.create({ id: "claimed", backend: "codex", threadId: "fixture", kind: "turn", origin: "desktop",
      displayText: "Claimed work", scheduledFor: now, now });
    store.claim("claimed", { ownerId: "fixture-owner", leaseExpiresAt: now + 30_000, now });
    scheduler.start();
    await scheduler.evaluateDueActions();
    clock += 10_000;
    const writes = await measureScheduledActionWrites(db, tick);
    expect(store.get("claimed")).toMatchObject({ status: "dispatching", updatedAt: clock });
    expectSqliteWriteBudget({ scenario: "scheduled-claimed-heartbeat",
      note: "One existing claimed lease renews every 10 seconds in one commit and one WAL frame. At 0.1 commit/s for 24 hours, 35.6 MB/day of existing WAL and zero additional projection WAL.", writes });
  } finally {
    scheduler.dispose();
    db.close();
    removeTempStateDbDir(tempDir);
    vi.unstubAllEnvs();
  }
});
