import { statSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "../state/state-db";
import { createTempStateDb, openFreshStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const start = Date.UTC(2026, 10, 21);
const completedAt = start + 100;
const now = start + 200;
const oldLimits = { observedAt: start - 10, planType: "old", limits: [] };
const newLimits = { observedAt: start + 10, accountKey: "fixture-account", limits: [] };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function identity(id: string) {
  return { backend: "codex", threadId: `thread-${id}`, turnId: `turn-${id}` } as const;
}

type LineKind = "root" | "child" | "superseded" | "missing" | "hydrated" | "monitor" | "cross-provider" | "legacy";
type End = "open" | "inferred" | "observed";

async function addTurn(db: StateDb, id: string, kind: LineKind, end: End = "open") {
  const target = identity(id);
  const usageTurnId = `fixture-turn-${id}`;
  const line: ThreadUsageLineRecord = {
    ...target, usageTurnId, usageLineId: `line-${id}`, provider: "openai",
    source: kind === "hydrated" ? "hydration" : "live",
    scope: kind === "monitor" ? "monitor" : "turn",
    status: kind === "superseded" ? "superseded" : "pending",
    ...(kind === "child" ? { parentThreadId: "fixture-parent" } : {}),
    createdAt: start, startedAt: start - 10,
    priceStatus: "unpriced", currency: "USD",
    inputTokens: 10, cachedInputTokens: 0, uncachedInputTokens: 10, outputTokens: 2,
    reasoningOutputTokens: 0, totalTokens: 12,
    uncachedInputCostMicros: 0, cachedInputCostMicros: 0, outputCostMicros: 0, totalCostMicros: 0,
  };
  await new SqliteOverlayStore(db).upsertThreadUsageLine({ line });
  // Reproduce retained links whose line identity changed independently of the turn.
  if (kind === "legacy") {
    db.raw.prepare(`UPDATE thread_usage_lines SET provider = 'anthropic', backend = 'claude',
      thread_id = 'legacy-thread', turn_id = 'legacy-turn' WHERE usage_line_id = ?`).run(line.usageLineId);
  }
  if (kind === "cross-provider") {
    db.raw.prepare("UPDATE thread_usage_lines SET provider = 'anthropic' WHERE usage_line_id = ?")
      .run(line.usageLineId);
  }
  if (kind === "missing") {
    db.raw.prepare("DELETE FROM thread_usage_lines WHERE usage_line_id = ?").run(line.usageLineId);
  }
  const before = {
    completed_at: end === "open" ? null : start + 40,
    completed_at_inferred: end === "inferred" ? 1 : null,
    rate_limit_snapshot: JSON.stringify(oldLimits),
    updated_at: start + 50,
  };
  db.raw.prepare(`UPDATE thread_usage_turns SET completed_at = @completed_at,
    completed_at_inferred = @completed_at_inferred, rate_limit_snapshot = @rate_limit_snapshot,
    updated_at = @updated_at WHERE usage_turn_id = @usageTurnId`).run({ ...before, usageTurnId });
  const read = () => db.raw.prepare(`SELECT completed_at, completed_at_inferred, rate_limit_snapshot, updated_at
    FROM thread_usage_turns WHERE usage_turn_id = ?`).get(usageTurnId);
  return { target, before, read };
}

it.each([
  "root", "child", "superseded", "missing", "hydrated", "monitor", "cross-provider", "legacy",
] satisfies LineKind[])("records the first observed end for qualifying %s lines only", async (kind) => {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    for (const end of ["open", "inferred", "observed"] satisfies End[]) {
      for (const batch of [false, true]) {
        const { target, before, read } = await addTurn(db, `target-${end}-${batch}`, kind, end);
        const record = (at: number) => batch
          ? store.completeThreadUsageTurns({ completedAt: at, turns: [target, target, identity("absent")] })
          : store.completeThreadUsageTurn({ ...target, completedAt: at, limitObservation: newLimits });
        const eligible = end !== "observed" && (kind === "root" || kind === "cross-provider" || kind === "legacy");
        const expected = eligible ? {
          completed_at: completedAt, completed_at_inferred: null, updated_at: now,
          rate_limit_snapshot: batch ? before.rate_limit_snapshot : JSON.stringify(newLimits),
        } : before;
        expect(await record(completedAt)).toBe(batch ? Number(eligible) : eligible);
        expect(read()).toEqual(expected);
        expect(await record(completedAt + 1000)).toBe(batch ? 0 : false);
        expect(read()).toEqual(expected);
      }
    }
  } finally {
    vi.restoreAllMocks();
    db.close();
  }
});

function seedHistory(db: StateDb, from: number, to: number) {
  const inventory = `WITH RECURSIVE history(id) AS (
    SELECT @from UNION ALL SELECT id + 1 FROM history WHERE id + 1 < @to
  )`;
  db.raw.transaction(() => {
    db.raw.prepare(`${inventory} INSERT INTO thread_usage_turns
      (usage_turn_id, provider, backend, thread_id, turn_id, observed_at, updated_at)
      SELECT 'history:' || id, 'openai', 'codex', 'history-thread:' || id, 'turn:' || id, @start, @start
      FROM history`).run({ from, to, start });
    db.raw.prepare(`${inventory} INSERT INTO thread_usage_lines
      (usage_line_id, usage_turn_id, provider, backend, thread_id, turn_id, source, scope, status,
       created_at, updated_at, input_tokens, cached_input_tokens, uncached_input_tokens, output_tokens,
       reasoning_output_tokens, total_tokens, price_status, currency, uncached_input_cost_micros,
       cached_input_cost_micros, output_cost_micros, total_cost_micros)
      SELECT 'history-line:' || id, 'history:' || id, 'openai', 'codex', 'history-thread:' || id, 'turn:' || id,
        'live', 'turn', 'pending', @start, @start, 10, 0, 10, 2, 0, 12, 'unpriced', 'USD', 0, 0, 0, 0
      FROM history`).run({ from, to, start });
  })();
}

function observeCompletionPlans(db: StateDb) {
  const plans: string[][] = [];
  const prepare = db.raw.prepare.bind(db.raw);
  const spy = vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!/\b(?:FROM|UPDATE) thread_usage_turns\b/.test(sql)) return statement;
    function observe<T>(execute: (...bindings: unknown[]) => T) {
      return (...bindings: unknown[]) => {
        const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{ detail: string }>;
        plans.push(plan.map(({ detail }) => detail));
        return execute(...bindings);
      };
    }
    statement.get = observe(statement.get.bind(statement));
    statement.all = observe(statement.all.bind(statement));
    statement.run = observe(statement.run.bind(statement));
    return statement;
  });
  return { plans, restore: () => spy.mockRestore() };
}

it.each([false, true])("bounds production completion work as unrelated history grows (ANALYZE: %s)", async (analyze) => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const db = openInMemoryStateDb();
  try {
    const store = new SqliteOverlayStore(db);
    let previous = 0;
    for (const size of [1_000, 2_000, 50_000]) {
      seedHistory(db, previous, size);
      previous = size;
      const root = await addTurn(db, `root-${size}`, "root");
      const child = await addTurn(db, `child-${size}`, "child");
      const shutdown = await addTurn(db, `shutdown-${size}`, "legacy", "inferred");
      if (analyze) db.raw.exec("ANALYZE thread_usage_turns; ANALYZE thread_usage_lines;");
      vi.spyOn(Date, "now").mockReturnValue(now);
      async function check<T>(label: string, work: () => Promise<T>, expected: T, commits: number) {
        const observation = observeCompletionPlans(db);
        try {
          const { result, writes } = await measureSqliteWrites(work);
          expect(result).toBe(expected);
          expect(writes.commits).toBe(commits);
          const message = `${label} at ${size} unrelated pairs`;
          expect.soft(observation.plans.length, message).toBeGreaterThan(0);
          expect.soft(observation.plans.length, message).toBeLessThanOrEqual(commits + 1);
          for (const plan of observation.plans) {
            // A persistent equality seek avoids scanning history or building an index over it.
            const accesses = plan.filter((detail) => /^(SCAN|SEARCH)\b/.test(detail));
            expect.soft(accesses.length, message).toBeGreaterThan(0);
            for (const access of accesses) {
              expect.soft(access, message).toMatch(/^SEARCH\b.*\b(?:backend=\? AND thread_id=\? AND turn_id=\?|usage_turn_id=\?)\)/);
              expect.soft(access, message).not.toMatch(/AUTOMATIC/);
            }
          }
        } finally {
          observation.restore();
        }
      }
      await check("terminal miss", () => store.completeThreadUsageTurn({
        ...identity("absent"), completedAt,
      }), false, 0);
      await check("terminal hit", () => store.completeThreadUsageTurn({ ...root.target, completedAt }), true, 1);
      expect(root.read()).toEqual({ ...root.before, completed_at: completedAt, updated_at: now });
      await check("terminal child miss", () => store.completeThreadUsageTurn({ ...child.target, completedAt }), false, 0);
      expect(child.read()).toEqual(child.before);
      await check("shutdown legacy hit", () => store.completeThreadUsageTurns({
        completedAt, turns: [shutdown.target],
      }), 1, 1);
      expect(shutdown.read()).toEqual({
        ...shutdown.before, completed_at: completedAt, completed_at_inferred: null, updated_at: now,
      });
    }
  } finally {
    db.close();
  }
});

it("retains legacy ledger rows and gate pricing indexes when upgrading from v83", async () => {
  const { dbPath, tempDir } = createTempStateDb("pwragent-usage-completion-upgrade-");
  let db = openFreshStateDb(dbPath);
  try {
    const { target } = await addTurn(db, "upgrade", "legacy", "inferred");
    const facts = () => ({
      turns: db.raw.prepare("SELECT * FROM thread_usage_turns").all(),
      lines: db.raw.prepare("SELECT * FROM thread_usage_lines").all(),
      gatePricingIndexes: db.raw.prepare(`SELECT name, sql FROM sqlite_schema
        WHERE name IN ('idx_thread_usage_lines_turn', 'idx_thread_usage_lines_source',
          'idx_thread_usage_lines_gate_child_source', 'idx_thread_usage_lines_gate_usage_turn')
        ORDER BY name`).all(),
    });
    const before = facts();
    db.raw.exec(`
      DROP INDEX idx_thread_usage_lines_completion_turn;
      DROP INDEX idx_thread_usage_turns_turn;
      DROP INDEX idx_thread_usage_lines_read_parent;
      CREATE INDEX idx_thread_usage_turns_turn
        ON thread_usage_turns(provider, backend, thread_id, turn_id);
      CREATE INDEX idx_thread_usage_lines_read_parent
        ON thread_usage_lines(backend, parent_thread_id, created_at DESC, usage_line_id DESC)
        WHERE status != 'superseded';
      PRAGMA user_version = 83;
    `);
    db.close();
    db = StateDb.open(dbPath);
    expect(db.raw.pragma("user_version", { simple: true })).toBe(CURRENT_STATE_DB_USER_VERSION);
    expect(facts()).toEqual(before);
    expect(db.raw.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'idx_thread_usage_lines_completion_turn'").get())
      .toBeDefined();
    db.close();

    db = StateDb.open(dbPath);
    expect(statSync(`${dbPath}-wal`).size).toBe(0);
    expect(await new SqliteOverlayStore(db).completeThreadUsageTurns({ completedAt, turns: [target] })).toBe(1);
  } finally {
    db.close();
    removeTempStateDbDir(tempDir);
  }
});
