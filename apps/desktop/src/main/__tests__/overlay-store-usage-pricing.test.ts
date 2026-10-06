import type { ThreadUsageLineRecord } from "@pwragent/shared";
import { buildLegacyEncodedThreadIdentityKey, usageActivityCoverage } from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { ThreadSearchStore } from "../thread-search/thread-search-store";
import { AutomationStore } from "../automations/automation-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import {
  createTempStateDb,
  openInMemoryStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string | undefined;
const PRICING_CATALOG_TIME = Date.UTC(2026, 3, 23);

/**
 * Move this test onto a real database file and return its path. Only the
 * tests that close the database and reopen the same path need one — whether
 * they rewind `user_version` first to force a migration, or simply read the
 * rows back. A second `:memory:` open is a second empty database, so both
 * would hold while testing nothing.
 */
function useFileStateDb(): string {
  stateDb.close();
  const temp = createTempStateDb("pwragent-usage-pricing-");
  tempDir = temp.tempDir;
  stateDb = StateDb.open(temp.dbPath);
  store = new SqliteOverlayStore(stateDb);
  return temp.dbPath;
}

beforeEach(() => {
  tempDir = undefined;
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  vi.unstubAllEnvs();
  if (tempDir !== undefined) {
    removeTempStateDbDir(tempDir);
  }
});

describe("SqliteOverlayStore thread usage pricing ledger", () => {
  it("keeps an unfinished interval only while its ledger row can hold usage in the window", async () => {
    const start = PRICING_CATALOG_TIME;
    await store.upsertThreadUsageLine({ line: buildUsageLine({
      source: "live", status: "pending", turnUsageAttributed: true,
      startedAt: start, completedAt: undefined,
    }) });
    stateDb.raw.prepare("UPDATE thread_usage_lines SET updated_at = ?").run(start + 5000);
    const overlapping = { from: start + 1000, to: start + 20_000 };
    const open = await store.readUsageActivity(overlapping);
    expect(open.rows).toHaveLength(1);
    expect(open.rows[0].line.completedAt).toBeUndefined();
    expect(usageActivityCoverage(open.rows[0], overlapping.from, overlapping.to)).toBe("boundary");

    // A turn whose completion was never observed recorded nothing after its
    // last update, so it does not match every later window.
    expect((await store.readUsageActivity({ from: start + 10_000, to: start + 20_000 })).rows).toHaveLength(0);

    // A real end before the window excludes it, including when only the
    // separate turn record received the terminal event.
    await store.completeThreadUsageTurn({ backend: "codex", threadId: "thread-1", turnId: "turn-1", completedAt: start + 500 });
    expect((await store.readUsageActivity(overlapping)).rows).toHaveLength(0);
  });

  it("completes monitor lines when written and rolls background helpers up per parent thread", async () => {
    const start = PRICING_CATALOG_TIME;
    // The store reprices each line on write, so every line here costs 16,100 micros.
    const monitor = (id: string, sourceItemId: string, createdAt: number) => buildUsageLine({
      usageLineId: `monitor-${id}`, scope: "monitor", source: "live", status: "finalized", sourceItemId,
      threadId: `helper-${id}`, turnId: `helper-turn-${id}`, parentThreadId: "thread-1", createdAt,
    });
    for (const line of [
      monitor("a", "system:token-miser:a", start + 1000),
      monitor("b", "system:token-miser:b", start + 2000),
      monitor("c", "system:title-helper:c", start + 3000),
      monitor("old", "system:token-miser:old", start - 60_000),
      monitor("review", "review:r", start + 4000),
    ]) await store.upsertThreadUsageLine({ line });
    // One chart bucket is ten seconds wide, so both Token Miser runs share one.
    const window = { from: start, to: start + 240_000 };
    const { rows, truncated } = await store.readUsageActivity(window);
    expect(truncated).toBe(false);
    const rollups = rows.filter((row) => row.rollup).sort((a, b) => a.rollup!.kind.localeCompare(b.rollup!.kind));
    expect(rollups.map((row) => [row.rollup, row.line.threadId, row.line.totalCostMicros])).toEqual([
      [{ kind: "title-helper", count: 1 }, "thread-1", 16_100],
      [{ kind: "token-miser", count: 2 }, "thread-1", 32_200],
    ]);
    expect(rollups[1].line).toMatchObject({ scope: "monitor", startedAt: start + 1000, completedAt: start + 2000, totalTokens: 2600 });
    // A helper outside the window is not read; any other monitor stays its own line.
    const review = rows.find((row) => row.line.usageLineId === "monitor-review")!;
    expect(review.line.completedAt).toBe(start + 4000);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => usageActivityCoverage(row, window.from, window.to) === "contained")).toBe(true);
    // Owners sharing one ledger derive the same rollup id, so a viewer counts it once.
    expect((await store.readUsageActivity(window)).rows.filter((row) => row.rollup).map((row) => row.line.usageLineId))
      .toEqual(rows.filter((row) => row.rollup).map((row) => row.line.usageLineId));
  });

  it("bounds title hydration and uses the identity index across a large history", async () => {
    const start = PRICING_CATALOG_TIME;
    const insertDocument = stateDb.raw.prepare(`
      INSERT INTO thread_search_documents
        (identity_key, backend, thread_id, title, linked_directories_json, display_json, indexed_at)
      VALUES (?, 'acp:qwen', ?, ?, '[]', '{}', ?)
    `);
    const insertUsage = stateDb.raw.prepare(`
      INSERT INTO thread_usage_lines
        (usage_line_id, backend, thread_id, source, scope, status, created_at, completed_at,
         turn_usage_attributed, input_tokens, cached_input_tokens, uncached_input_tokens,
         output_tokens, reasoning_output_tokens, total_tokens, price_status, currency,
         uncached_input_cost_micros, cached_input_cost_micros, output_cost_micros, total_cost_micros, updated_at)
      VALUES (?, 'acp:qwen', ?, 'live', 'turn', 'pending', ?, ?, 1, 10, 0, 10, 2, 1, 12,
              'unpriced', 'USD', 0, 0, 0, 0, ?)
    `);
    stateDb.raw.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        const id = `large-${index}`;
        insertDocument.run(buildLegacyEncodedThreadIdentityKey("acp:qwen", id), id, `Title ${id}`, start);
        if (index < 5001) insertUsage.run(id, id, start, start + 1000, start + index);
      }
    })();
    const prepare = vi.spyOn(stateDb.raw, "prepare");
    const snapshot = await store.readUsageActivity({ from: start, to: start + 2000 });
    const titleQueries = prepare.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes("FROM thread_search_documents"));
    prepare.mockRestore();
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.rows).toHaveLength(5000);
    expect(snapshot.rows.every((row) => row.title === `Title ${row.line.threadId}`)).toBe(true);
    expect(titleQueries).toHaveLength(1);
    const plan = stateDb.raw.prepare(`EXPLAIN QUERY PLAN ${titleQueries[0]}`).all(
      JSON.stringify(snapshot.rows.map((row) => buildLegacyEncodedThreadIdentityKey("acp:qwen", row.line.threadId))),
    ) as Array<{ detail: string }>;
    expect(plan.some((row) => /SEARCH thread_search_documents USING INDEX.*\(identity_key=\?\)/.test(row.detail))).toBe(true);
    expect(plan.some((row) => /SCAN thread_search_documents/.test(row.detail))).toBe(false);
  });

  it("uses an automation's visible thread title for headless usage, including archived titles", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    useFileStateDb();
    const start = PRICING_CATALOG_TIME;
    await store.upsertThreadUsageLine({ line: buildUsageLine({
      source: "live", status: "pending", startedAt: start,
      threadId: "headless-thread",
    }) });
    stateDb.raw.prepare(`
      INSERT INTO thread_search_documents
        (identity_key, backend, thread_id, title, archived_at,
         linked_directories_json, display_json, indexed_at)
      VALUES (?, 'codex', 'agent-thread', 'Search/Signals Agent', ?, '[]', '{}', ?)
    `).run(buildLegacyEncodedThreadIdentityKey("codex", "agent-thread"), start, start);
    stateDb.raw.prepare(`
      INSERT INTO automations
        (automation_id, backend, thread_id, name, status, backlog_policy,
         created_at, updated_at, payload)
      VALUES ('automation-1', 'codex', 'agent-thread', 'Search Bots', 'active',
              'skip', ?, ?, '{}')
    `).run(start, start);
    const { writes } = await measureSqliteWrites(() => stateDb.raw.prepare(`
      INSERT INTO automation_runs
        (run_id, automation_id, backend, thread_id, status, trigger,
         created_at, updated_at, payload)
      VALUES ('run-1', 'automation-1', 'codex', 'agent-thread', 'failed',
              'schedule', ?, ?, '{"backendThreadId":"headless-thread"}')
    `).run(start, start));
    expectSqliteWriteBudget({
      scenario: "automation-run-usage-title-index",
      writes,
      note: "One automation run insert, including indexed owner and execution thread identities, remains one commit",
    });
    stateDb.raw.prepare(`
      INSERT INTO automation_runs
        (run_id, automation_id, backend, thread_id, status, trigger,
         created_at, updated_at, payload)
      VALUES ('run-corrupt', 'automation-1', 'codex', 'agent-thread', 'failed',
              'schedule', ?, ?, '{not-json')
    `).run(start, start);

    const prepare = vi.spyOn(stateDb.raw, "prepare");
    const snapshot = await store.readUsageActivity({ from: start, to: start + 5000 });
    const automationQuery = prepare.mock.calls.map(([sql]) => sql).find((sql) =>
      sql.includes("FROM automation_runs r"));
    prepare.mockRestore();
    expect(automationQuery).toBeDefined();
    const plan = stateDb.raw.prepare(`EXPLAIN QUERY PLAN ${automationQuery}`).all(
      JSON.stringify(["headless-thread"]),
    ) as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes("idx_automation_runs_execution_thread_valid"))).toBe(true);
    expect(snapshot.rows[0].title).toBe("Search/Signals Agent");
    new ThreadSearchStore(stateDb).deleteThread({
      backend: "codex", threadId: "agent-thread",
    });
    const archived = await store.readUsageActivity({ from: start, to: start + 5000 });
    expect(archived.rows[0].title).toBe("Search/Signals Agent");
  });

  it("retains a headless usage title after automation run history is pruned", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    useFileStateDb();
    const start = PRICING_CATALOG_TIME;
    const automations = new AutomationStore(stateDb, { runHistoryLimit: 1 });
    automations.createAutomation({
      id: "automation-1", backend: "codex", threadId: "agent-thread",
      name: "Search Bots", taskPrompt: "Search", now: start,
      schedule: { kind: "interval", every: 5, unit: "minutes" },
    });
    stateDb.raw.prepare(`
      INSERT INTO thread_search_documents
        (identity_key, backend, thread_id, title,
         linked_directories_json, display_json, indexed_at)
      VALUES (?, 'codex', 'agent-thread', 'Search/Signals Agent', '[]', '{}', ?)
    `).run(buildLegacyEncodedThreadIdentityKey("codex", "agent-thread"), start);
    automations.createRun({
      id: "run-1", automationId: "automation-1", trigger: "scheduled", now: start,
    });
    automations.markRunStarted({
      runId: "run-1", backendThreadId: "headless-thread",
      backendTurnId: "turn-1", now: start + 1,
    });
    await store.upsertThreadUsageLine({ line: buildUsageLine({
      source: "live", status: "pending", startedAt: start,
      threadId: "headless-thread",
    }) });
    expect(automations.getRun("run-1")?.backendThreadId).toBe("headless-thread");
    const prepare = vi.spyOn(stateDb.raw, "prepare");
    const { writes } = await measureSqliteWrites(() => automations.createRun({
      id: "run-2", automationId: "automation-1", trigger: "scheduled", now: start + 2,
    }));
    const usageQuery = prepare.mock.calls.map(([sql]) => sql).find((sql) =>
      sql.includes("SELECT 1 FROM thread_usage_lines"));
    prepare.mockRestore();
    expect(usageQuery).toBeDefined();
    const plan = stateDb.raw.prepare(`EXPLAIN QUERY PLAN ${usageQuery}`).all(
      "codex", "headless-thread",
    ) as Array<{ detail: string }>;
    expect(plan.some((row) => /SEARCH thread_usage_lines USING.*idx_thread_usage_lines_read_thread/.test(row.detail))).toBe(true);
    expectSqliteWriteBudget({
      scenario: "automation-run-prune-retain-usage-title",
      writes,
      note: "Creating a run and pruning an older run retains its usage title in the existing prune transaction",
    });

    expect(automations.getRun("run-1")).toBeUndefined();
    expect(stateDb.raw.prepare(
      "SELECT identity_key, title FROM thread_usage_titles",
    ).all()).toEqual([{ identity_key: buildLegacyEncodedThreadIdentityKey(
      "codex", "headless-thread",
    ), title: "Search/Signals Agent" }]);
    expect((await store.readUsageActivity({ from: start, to: start + 5000 })).rows[0].title)
      .toBe("Search/Signals Agent");
  });

  it.each(["none", "other-backend", "superseded", "corrupt-run"] as const)("does not retain pruned execution titles with %s usage", async (usage) => {
    if (usage === "none") {
      vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
      useFileStateDb();
    }
    const start = PRICING_CATALOG_TIME;
    const automations = new AutomationStore(stateDb, { runHistoryLimit: 1 });
    automations.createAutomation({
      id: "automation-1", backend: "codex", threadId: "agent-thread",
      name: "Search Bots", taskPrompt: "Search", now: start,
      schedule: { kind: "interval", every: 5, unit: "minutes" },
    });
    for (let index = 0; index < 3; index += 1) {
      const { writes } = await measureSqliteWrites(() => automations.createRun({
        id: `run-${index}`, automationId: "automation-1", trigger: "scheduled",
        now: start + index * 2,
      }));
      if (usage === "none" && index > 0) {
        expectSqliteWriteBudget({
          scenario: "automation-run-prune-without-usage",
          writes,
          note: "Creating a run and pruning an older execution with no visible usage writes no retained title",
        });
      }
      automations.markRunStarted({
        runId: `run-${index}`, backendThreadId: `headless-${index}`,
        backendTurnId: `turn-${index}`, now: start + index * 2 + 1,
      });
      if (usage === "corrupt-run") {
        stateDb.raw.prepare("UPDATE automation_runs SET payload = ? WHERE run_id = ?")
          .run("{not-json", `run-${index}`);
      } else if (usage !== "none") {
        await store.upsertThreadUsageLine({ line: buildUsageLine({
          usageLineId: `usage-${index}`, threadId: `headless-${index}`,
          backend: usage === "other-backend" ? "acp:qwen" : "codex",
          status: usage === "superseded" ? "superseded" : "pending",
        }) });
      }
    }

    expect(automations.getRun("run-0")).toBeUndefined();
    expect(automations.getRun("run-1")).toBeUndefined();
    expect(stateDb.raw.prepare("SELECT run_id FROM automation_runs").all())
      .toEqual([{ run_id: "run-2" }]);
    expect(stateDb.raw.prepare("SELECT * FROM thread_usage_titles").all()).toEqual([]);
  });

  it("keeps the last indexed title for usage after navigation prunes the thread", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    useFileStateDb();
    const start = PRICING_CATALOG_TIME;
    await store.upsertThreadUsageLine({ line: buildUsageLine({
      source: "live", status: "pending", startedAt: start,
    }) });
    const identityKey = buildLegacyEncodedThreadIdentityKey("codex", "thread-1");
    stateDb.raw.prepare(`
      INSERT INTO thread_search_documents
        (identity_key, backend, thread_id, title,
         linked_directories_json, display_json, indexed_at)
      VALUES (?, 'codex', 'thread-1', 'Last known title', '[]', '{}', ?)
    `).run(identityKey, start);
    const { writes } = await measureSqliteWrites(() =>
      new ThreadSearchStore(stateDb).deleteThread({
        backend: "codex", threadId: "thread-1",
      }));
    expectSqliteWriteBudget({
      scenario: "prune-usage-thread-search-title",
      writes,
      note: "Preserving a last-known usage title shares the existing search-document deletion transaction",
    });

    const snapshot = await store.readUsageActivity({ from: start, to: start + 5000 });
    expect(snapshot.rows[0].title).toBe("Last known title");
  });

  it("reads usage activity without writes and retains completed pending turn timing", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    useFileStateDb();
    const start = PRICING_CATALOG_TIME;
    await store.upsertThreadUsageLine({ line: buildUsageLine({
      source: "live", status: "pending", turnUsageAttributed: true, startedAt: start,
    }) });
    await store.completeThreadUsageTurn({ backend: "codex", threadId: "thread-1", turnId: "turn-1", completedAt: start + 4000 });
    const result = await measureSqliteWrites(async () => await store.readUsageActivity({ from: start, to: start + 5000 }));
    expect(result.writes.commits).toBe(0);
    const snapshot = await store.readUsageActivity({ from: start, to: start + 5000 });
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].line).toMatchObject({ status: "pending", startedAt: start, completedAt: start + 4000, turnUsageAttributed: true });
    // A start-time cutoff must still return an overlapping row for the coverage classifier.
    expect((await store.readUsageActivity({ from: start + 2000, to: start + 5000 })).rows).toHaveLength(1);
    await expect(store.readUsageActivity({ from: start, to: start + 32 * 86400000 })).rejects.toThrow("31 days");
  });

  it("records the owner's account limits in the same completion commit and relays each reading once", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    useFileStateDb();
    const start = PRICING_CATALOG_TIME;
    const reading = { observedAt: start + 3_500, accountKey: "acct", planType: "plus", limits: [
      { name: "5h limit", windowKey: "primary" as const, usedPercent: 41, resetAt: start + 3_600_000, windowMinutes: 300 },
      { name: "Weekly limit", windowKey: "secondary" as const, usedPercent: 9, resetAt: start + 7 * 86_400_000, windowMinutes: 10_080 },
    ] };
    for (const turnId of ["turn-1", "turn-2"]) {
      await store.upsertThreadUsageLine({ line: buildUsageLine({
        source: "live", status: "pending", turnUsageAttributed: true, startedAt: start, turnId,
        usageLineId: `line-${turnId}`,
      }) });
    }
    const { result, writes } = await measureSqliteWrites(() => store.completeThreadUsageTurn({
      backend: "codex", threadId: "thread-1", turnId: "turn-1", completedAt: start + 4_000, limitObservation: reading,
    }));
    expect(result).toBe(true);
    expectSqliteWriteBudget({
      scenario: "completed-turn-usage-limit-reading",
      writes,
      note: "One completion carrying the owner's account-limit reading: the reading rides the completion UPDATE, so still one commit per completed turn",
    });
    // A second turn completing on the same reading relays it only once.
    await store.completeThreadUsageTurn({
      backend: "codex", threadId: "thread-1", turnId: "turn-2", completedAt: start + 4_500, limitObservation: reading,
    });
    const snapshot = await store.readUsageActivity({ from: start, to: start + 5_000 });
    expect(snapshot.limitHistory).toEqual([reading]);
    expect(snapshot.rows.map((row) => row.accountKey)).toEqual(["acct", "acct"]);
    // A corrupt stored reading is dropped, not thrown.
    stateDb.raw.prepare("UPDATE thread_usage_turns SET rate_limit_snapshot = ? WHERE turn_id = ?").run("{not json", "turn-2");
    const corrupt = await store.readUsageActivity({ from: start, to: start + 5_000 });
    expect(corrupt.limitHistory).toEqual([reading]);
    expect(corrupt.rows.find((row) => row.line.turnId === "turn-2")?.accountKey).toBeUndefined();
  });

  it("uses one commit to record a completed turn after its usage row was flushed", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    useFileStateDb();
    await store.upsertThreadUsageLine({
      line: buildUsageLine({ source: "live", status: "pending", startedAt: PRICING_CATALOG_TIME }),
    });

    const { result, writes } = await measureSqliteWrites(() => store.completeThreadUsageTurn({
      backend: "codex", threadId: "thread-1", turnId: "turn-1",
      completedAt: PRICING_CATALOG_TIME + 4_000,
    }));
    expect(result).toBe(true);
    expectSqliteWriteBudget({
      scenario: "completed-turn-usage-duration",
      writes,
      note: "One completion after the live usage row was flushed: one commit per completed turn; zero additional commits for repeated terminal events",
    });
    expect(writes.commits).toBe(1);
    const repeated = await measureSqliteWrites(() => store.completeThreadUsageTurn({
      backend: "codex", threadId: "thread-1", turnId: "turn-1",
      completedAt: PRICING_CATALOG_TIME + 4_000,
    }));
    expect(repeated.writes.commits).toBe(0);
  });

  it("repairs unfinished turns in one commit, ending each at its last usage write", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    useFileStateDb();
    const start = PRICING_CATALOG_TIME;
    const seedLiveTurn = (turnId: string, threadId: string, startedAt: number) =>
      store.upsertThreadUsageLine({ line: buildUsageLine({
        source: "live", status: "pending", turnUsageAttributed: true,
        threadId, turnId, startedAt, createdAt: startedAt, usageLineId: `line-${turnId}`,
      }) });
    await seedLiveTurn("interrupted", "thread-1", start);
    await seedLiveTurn("next", "thread-1", start + 30_000);
    await seedLiveTurn("recent", "thread-2", start);
    // A row written later for an older turn in the same thread must not cap
    // `next`, which it did not follow.
    await store.upsertThreadUsageLine({ line: buildUsageLine({
      source: "live", status: "pending", turnUsageAttributed: true, threadId: "thread-1",
      turnId: "backfilled-earlier", startedAt: start - 60_000, createdAt: start + 120_000,
      usageLineId: "line-backfilled-earlier",
    }) });
    await store.completeThreadUsageTurn({
      backend: "codex", threadId: "thread-1", turnId: "backfilled-earlier", completedAt: start - 1_000,
    });
    await seedLiveTurn("finished", "thread-3", start);
    await store.completeThreadUsageTurn({
      backend: "codex", threadId: "thread-3", turnId: "finished", completedAt: start + 5_000,
    });
    // A helper's monitor line never gets a completion; the read side dates it.
    await store.upsertThreadUsageLine({ line: buildUsageLine({
      source: "monitor", scope: "monitor", status: "finalized", parentThreadId: "thread-1",
      threadId: "helper", turnId: "helper-turn", usageLineId: "line-helper",
    }) });
    const setLastWrite = stateDb.raw.prepare(
      "UPDATE thread_usage_lines SET updated_at = ? WHERE usage_line_id = ?",
    );
    // `interrupted` wrote usage after `next` began, so the next start caps it.
    setLastWrite.run(start + 60_000, "line-interrupted");
    setLastWrite.run(start + 90_000, "line-next");
    setLastWrite.run(start + 200_000, "line-recent");
    const readTurns = () => stateDb.raw.prepare(
      `SELECT turn_id, completed_at, completed_at_inferred FROM thread_usage_turns
        ORDER BY turn_id`,
    ).all();

    const { result, writes } = await measureSqliteWrites(() =>
      store.repairUnfinishedThreadUsageTurns({ lastWriteBefore: start + 100_000, limit: 10 }));

    expect(result).toEqual({ repaired: 2, remaining: false, datedByFirstWrite: 0 });
    expectSqliteWriteBudget({
      scenario: "usage-turn-startup-repair",
      writes,
      note: "Startup repair of two unfinished ledger turns: one transaction however many turns; zero commits when none qualify",
    });
    expect(readTurns()).toEqual([
      { turn_id: "backfilled-earlier", completed_at: start - 1_000, completed_at_inferred: null },
      { turn_id: "finished", completed_at: start + 5_000, completed_at_inferred: null },
      { turn_id: "helper-turn", completed_at: null, completed_at_inferred: null },
      { turn_id: "interrupted", completed_at: start + 30_000, completed_at_inferred: 1 },
      { turn_id: "next", completed_at: start + 90_000, completed_at_inferred: 1 },
      { turn_id: "recent", completed_at: null, completed_at_inferred: null },
    ]);

    const repeated = await measureSqliteWrites(() =>
      store.repairUnfinishedThreadUsageTurns({ lastWriteBefore: start + 100_000, limit: 10 }));
    expect(repeated.result.repaired).toBe(0);
    expect(repeated.writes.commits).toBe(0);

    // A turn that was still live somewhere replaces the estimate with its
    // observed end, once.
    const complete = (completedAt: number) => store.completeThreadUsageTurn({
      backend: "codex", threadId: "thread-1", turnId: "next", completedAt,
    });
    expect(await complete(start + 95_000)).toBe(true);
    expect(await complete(start + 99_000)).toBe(false);
    expect(readTurns()).toContainEqual(
      { turn_id: "next", completed_at: start + 95_000, completed_at_inferred: null },
    );
  });

  it("ends a turn at its first usage write when its last write is a bulk rewrite", async () => {
    const start = PRICING_CATALOG_TIME;
    const turnIds = Array.from({ length: 64 }, (_, index) => `restamped-${String(index).padStart(2, "0")}`);
    for (const [index, turnId] of turnIds.entries()) {
      await store.upsertThreadUsageLine({ line: buildUsageLine({
        source: "live", status: "pending", turnUsageAttributed: true,
        threadId: `thread-${turnId}`, turnId, startedAt: start + index,
        createdAt: start + index + 1_000, usageLineId: `line-${turnId}`,
      }) });
    }
    await store.upsertThreadUsageLine({ line: buildUsageLine({
      source: "live", status: "pending", turnUsageAttributed: true,
      threadId: "thread-own", turnId: "own", startedAt: start + 100, createdAt: start + 100,
      usageLineId: "line-own",
    }) });
    // A repricing migration stamps every row it rewrites with one time.
    stateDb.raw.prepare(
      "UPDATE thread_usage_lines SET updated_at = ? WHERE usage_line_id LIKE 'line-restamped-%'",
    ).run(start + 500_000);
    stateDb.raw.prepare("UPDATE thread_usage_lines SET updated_at = ? WHERE usage_line_id = 'line-own'")
      .run(start + 400_000);

    const first = await store.repairUnfinishedThreadUsageTurns({ lastWriteBefore: start + 1_000_000, limit: 40 });
    const rest = await store.repairUnfinishedThreadUsageTurns({ lastWriteBefore: start + 1_000_000, limit: 40 });

    // Oldest first: `own` began before every restamped turn.
    expect(first).toEqual({ repaired: 40, remaining: true, datedByFirstWrite: 39 });
    expect(rest).toEqual({ repaired: 25, remaining: false, datedByFirstWrite: 25 });
    const completedAt = (turnId: string) => (stateDb.raw.prepare(
      "SELECT completed_at FROM thread_usage_turns WHERE turn_id = ?",
    ).get(turnId) as { completed_at: number }).completed_at;
    expect(turnIds.map(completedAt)).toEqual(turnIds.map((_, index) => start + index + 1_000));
    expect(completedAt("own")).toBe(start + 400_000);
  });

  it("records one shutdown end for every running turn in one commit", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    useFileStateDb();
    const start = PRICING_CATALOG_TIME;
    for (const turnId of ["running-1", "running-2", "finished"]) {
      await store.upsertThreadUsageLine({ line: buildUsageLine({
        source: "live", status: "pending", turnUsageAttributed: true,
        turnId, startedAt: start, usageLineId: `line-${turnId}`,
      }) });
    }
    await store.completeThreadUsageTurn({
      backend: "codex", threadId: "thread-1", turnId: "finished", completedAt: start + 1_000,
    });
    const turns = ["running-1", "running-2", "finished", "no-usage-yet"].map((turnId) => ({
      backend: "codex" as const, threadId: "thread-1", turnId,
    }));

    const { result, writes } = await measureSqliteWrites(() =>
      store.completeThreadUsageTurns({ completedAt: start + 9_000, turns }));

    expect(result).toBe(2);
    expectSqliteWriteBudget({
      scenario: "usage-turn-shutdown-completion",
      writes,
      note: "Two turns still running at shutdown: one commit per shutdown, only when a running turn has a ledger row",
    });
    expect(stateDb.raw.prepare(
      "SELECT turn_id, completed_at FROM thread_usage_turns ORDER BY turn_id",
    ).all()).toEqual([
      { turn_id: "finished", completed_at: start + 1_000 },
      { turn_id: "running-1", completed_at: start + 9_000 },
      { turn_id: "running-2", completed_at: start + 9_000 },
    ]);
    const idle = await measureSqliteWrites(() =>
      store.completeThreadUsageTurns({ completedAt: start + 10_000, turns }));
    expect(idle.result).toBe(0);
    expect(idle.writes.commits).toBe(0);
  });

  it("retains a terminal turn time without blocking a later usage update", async () => {
    const startedAt = PRICING_CATALOG_TIME;
    const completedAt = startedAt + 4_000;
    const line = buildUsageLine({
      source: "live", status: "pending", startedAt,
      completedAt: undefined, turnUsageAttributed: true,
    });
    await store.upsertThreadUsageLine({ line });

    expect(await store.completeThreadUsageTurn({
      backend: "codex", threadId: "thread-1", turnId: "turn-1", completedAt,
    })).toBe(true);
    expect((await store.readThreadPricing({ backend: "codex", threadId: "thread-1" })).lines[0])
      .toMatchObject({ startedAt, completedAt, status: "pending" });

    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        ...line, inputTokens: 1_100, uncachedInputTokens: 900,
        totalTokens: 1_400,
      }),
    });
    expect((await store.readThreadPricing({ backend: "codex", threadId: "thread-1" })).lines[0])
      .toMatchObject({ completedAt, inputTokens: 1_100 });
    expect(await store.completeThreadUsageTurn({
      backend: "codex", threadId: "thread-1", turnId: "turn-1", completedAt,
    })).toBe(false);
  });

  it.each(["live", "hydration", "backfill"] as const)(
    "preserves finalized turn accounting across restart and %s replacement",
    async (source) => {
      const dbPath = useFileStateDb();
      const first = buildUsageLine({
        source: "live", status: "pending", turnUsageAttributed: true,
        cumulativeTotalTokens: 1_300,
      });
      await store.upsertThreadUsageLine({ line: first });
      // Completion alone must still allow a legitimate final usage update.
      const final = buildUsageLine({
        ...first, inputTokens: 1_100, uncachedInputTokens: 900,
        totalTokens: 1_400, cumulativeTotalTokens: 1_400,
      });
      await store.upsertThreadUsageLine({ line: final });
      const second = buildUsageLine({
        source: "live", status: "pending", turnUsageAttributed: true,
        usageLineId: "line-2", turnId: "turn-2", sourceItemId: "item-2",
        createdAt: first.createdAt + 1,
        cumulativeTotalTokens: 2_700,
      });
      await store.upsertThreadUsageLine({ line: second });
      const before = await store.readThreadPricing({ backend: "codex", threadId: "thread-1" });
      // Exercise the upgrade too: existing non-overlapping rows must acquire
      // durable boundaries without needing another live notification.
      stateDb.raw.exec(`
        DROP TRIGGER protect_finalized_thread_usage_insert;
        DROP TRIGGER protect_finalized_thread_usage_update;
        DROP TRIGGER protect_thread_usage_boundary_update;
        DROP TABLE thread_usage_boundaries;
        PRAGMA user_version = 59;
      `);
      stateDb.close();
      stateDb = StateDb.open(dbPath);
      store = new SqliteOverlayStore(stateDb);
      await store.upsertThreadUsageLine({
        line: buildUsageLine({
          ...first, source, usageLineId: source === "live" ? "line-1" : "replacement",
          inputTokens: 100_000, uncachedInputTokens: 99_800,
          totalTokens: 100_300, cumulativeTotalTokens: 100_300,
        }),
      });
      expect(stateDb.raw.prepare(
        "UPDATE thread_usage_lines SET total_tokens = 999999 WHERE usage_line_id = ?",
      ).run("line-1").changes).toBe(0);
      expect(stateDb.raw.prepare(
        "UPDATE thread_usage_lines SET total_cost_micros = 999999 WHERE usage_line_id = ?",
      ).run("line-1").changes).toBe(0);
      // An older writer that does not know about finalization cannot insert a
      // second billable row for the same finalized turn either.
      stateDb.raw.exec("CREATE TEMP TABLE usage_copy AS SELECT * FROM thread_usage_lines WHERE usage_line_id = 'line-1'");
      stateDb.raw.exec("UPDATE usage_copy SET usage_line_id = 'raw-replacement'");
      stateDb.raw.exec("INSERT INTO thread_usage_lines SELECT * FROM usage_copy");
      const after = await store.readThreadPricing({ backend: "codex", threadId: "thread-1" });
      expect(after).toEqual(before);
      // The new turn remains writable after reopening the database.
      await store.upsertThreadUsageLine({
        line: { ...second, inputTokens: 1_100, uncachedInputTokens: 900,
          totalTokens: 1_400, cumulativeTotalTokens: 2_800 },
      });
      const advanced = await store.readThreadPricing({ backend: "codex", threadId: "thread-1" });
      expect(advanced.lines.find((line) => line.turnId === "turn-2")?.totalTokens).toBe(1_400);
      expect(advanced.lines.find((line) => line.turnId === "turn-1")).toEqual(
        before.lines.find((line) => line.turnId === "turn-1"),
      );
    },
  );

  it.each([false, true])("finalizes before a coalesced stale write (reversed=%s)", async (reversed) => {
    const first = buildUsageLine({ source: "live", cumulativeTotalTokens: 1_300 });
    await store.upsertThreadUsageLine({ line: first });
    const successor = buildUsageLine({
      source: "live", usageLineId: "line-2", turnId: "turn-2", cumulativeTotalTokens: 2_600,
    });
    const stale = { ...first, inputTokens: 100_000, uncachedInputTokens: 99_800,
      totalTokens: 100_300, cumulativeTotalTokens: 100_300 };
    await store.upsertThreadUsageLines({ lines: reversed ? [successor, stale] : [stale, successor] });
    const pricing = await store.readThreadPricing({ backend: "codex", threadId: "thread-1" });
    expect(pricing.lines.find((line) => line.turnId === "turn-1")?.totalTokens).toBe(1_300);
    expect(pricing.summaries[0]?.totalTokens).toBe(2_600);
  });

  it.each([0, 1_300])("keeps equal-total replays from finalizing the active turn (prefix=%s)", async (prefix) => {
    const empty = buildUsageLine({
      source: "live", inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0,
      outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, cumulativeTotalTokens: 0,
    });
    const first = prefix === 0 ? empty : buildUsageLine({ source: "live", cumulativeTotalTokens: prefix });
    await store.upsertThreadUsageLine({ line: first });
    const second = { ...empty, usageLineId: "line-2", turnId: "turn-2", cumulativeTotalTokens: prefix };
    await store.upsertThreadUsageLine({ line: second });
    await store.upsertThreadUsageLine({ line: first });
    const advanced = buildUsageLine({
      source: "live", usageLineId: "line-2", turnId: "turn-2", cumulativeTotalTokens: prefix + 1_300,
    });
    await store.upsertThreadUsageLine({ line: advanced });
    await store.upsertThreadUsageLine({ line: { ...first, totalTokens: 999_999, cumulativeTotalTokens: 999_999 } });
    const pricing = await store.readThreadPricing({ backend: "codex", threadId: "thread-1" });
    expect(pricing.lines.find((line) => line.turnId === "turn-1")?.totalTokens).toBe(prefix);
    expect(pricing.lines.find((line) => line.turnId === "turn-2")?.totalTokens).toBe(1_300);
  });

  it("accepts a missing final request within a durable successor boundary", async () => {
    const dbPath = useFileStateDb();
    const first = buildUsageLine({ source: "live", cumulativeTotalTokens: 1_300 });
    await store.upsertThreadUsageLine({ line: first });
    await store.upsertThreadUsageLine({ line: buildUsageLine({
      source: "live", usageLineId: "line-2", turnId: "turn-2", cumulativeTotalTokens: 3_300,
    }) });
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
    // Even while the final request is missing, the persisted ceiling and
    // baseline reject a later turn's total or a freshly reset accumulator.
    await store.upsertThreadUsageLine({ line: {
      ...first, inputTokens: 3_000, uncachedInputTokens: 2_800,
      totalTokens: 3_300, cumulativeTotalTokens: 3_300,
    } });
    await store.upsertThreadUsageLine({ line: {
      ...first, totalTokens: 100, cumulativeTotalTokens: 1_900,
    } });
    expect(stateDb.raw.prepare(
      "UPDATE thread_usage_lines SET total_tokens = 3300, cumulative_total_tokens = 3300 WHERE usage_line_id = ?",
    ).run("line-1").changes).toBe(0);
    const bounded = await store.readThreadPricing({ backend: "codex", threadId: "thread-1" });
    expect(bounded.lines.find((line) => line.turnId === "turn-1")?.totalTokens).toBe(1_300);
    const final = { ...first, inputTokens: 1_700, uncachedInputTokens: 1_500,
      totalTokens: 2_000, cumulativeTotalTokens: 2_000 };
    await store.upsertThreadUsageLine({ line: final });
    let pricing = await store.readThreadPricing({ backend: "codex", threadId: "thread-1" });
    expect(pricing.lines.find((line) => line.turnId === "turn-1")?.totalTokens).toBe(2_000);
    expect(pricing.summaries[0]?.totalTokens).toBe(3_300);
    await store.upsertThreadUsageLine({ line: { ...final, totalTokens: 3_300, cumulativeTotalTokens: 3_300 } });
    pricing = await store.readThreadPricing({ backend: "codex", threadId: "thread-1" });
    expect(pricing.summaries[0]?.totalTokens).toBe(3_300);
  });

  it.each([false, true])("enriches protected metadata without accepting stale usage (priced=%s)", async (priced) => {
    const dbPath = useFileStateDb();
    const first = buildUsageLine({
      source: "live", model: priced ? "gpt-5.5" : undefined,
      serviceTier: undefined, reasoningEffort: undefined,
      cumulativeTotalTokens: 1_300,
    });
    await store.upsertThreadUsageLine({ line: first });
    await store.upsertThreadUsageLine({ line: buildUsageLine({
      source: "live", usageLineId: "line-2", turnId: "turn-2", cumulativeTotalTokens: 2_600,
    }) });
    const before = (await store.readThreadPricing({ backend: "codex", threadId: "thread-1" }))
      .lines.find((line) => line.turnId === "turn-1")!;
    // Simulate v60's restriction on filling a missing pricing field. Reopening
    // must replace that trigger while retaining the separate token guards.
    stateDb.raw.exec(`
      DROP TRIGGER protect_finalized_thread_usage_update;
      CREATE TRIGGER protect_finalized_thread_usage_update
      BEFORE UPDATE ON thread_usage_lines
      WHEN OLD.service_tier IS NOT NEW.service_tier
      BEGIN SELECT RAISE(IGNORE); END;
      PRAGMA user_version = 60;
    `);
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
    const hydration = buildUsageLine({
      source: "hydration", usageLineId: "hydrated-replacement", model: "gpt-5.5",
      startedAt: first.createdAt - 100, completedAt: first.createdAt + 1_000,
      finalContextTokens: 600, peakContextTokens: 900, modelContextWindow: 258_400,
      inputTokens: 100_000, uncachedInputTokens: 99_800,
      totalTokens: 100_300, cumulativeTotalTokens: 100_300,
      totalCostMicros: 900_000_000,
    });
    await store.upsertThreadUsageLine({ line: hydration });
    const pricing = await store.readThreadPricing({ backend: "codex", threadId: "thread-1" });
    expect(pricing.lines).toHaveLength(2);
    const enriched = pricing.lines.find((line) => line.turnId === "turn-1")!;
    expect(enriched).toMatchObject({
      usageLineId: "line-1", source: "live", model: "gpt-5.5", serviceTier: "standard",
      startedAt: first.createdAt - 100, completedAt: first.createdAt + 1_000,
      finalContextTokens: 600, peakContextTokens: 900, modelContextWindow: 258_400,
      inputTokens: before.inputTokens, totalTokens: before.totalTokens,
      cumulativeTotalTokens: before.cumulativeTotalTokens, priceStatus: "priced",
    });
    expect(enriched.totalCostMicros).toBe(priced ? before.totalCostMicros : 16_100);
    await store.upsertThreadUsageLine({ line: {
      ...hydration, model: "gpt-6-astra", completedAt: first.createdAt + 9_000,
      modelContextWindow: 999_999,
    } });
    expect(await store.readThreadPricing({ backend: "codex", threadId: "thread-1" })).toEqual(pricing);
  });

  it("keeps a protected Astra aggregate priced when hydration supplies a context ceiling", async () => {
    const first = buildUsageLine(buildAstraAggregateOverrides({
      source: "live", cumulativeTotalTokens: 1_658_805,
    }));
    await store.upsertThreadUsageLine({ line: first });
    await store.upsertThreadUsageLine({ line: {
      ...first, usageLineId: "line-2", turnId: "turn-2", cumulativeTotalTokens: 3_317_610,
    } });
    const before = await store.readThreadPricing({ backend: "codex", threadId: "thread-1" });
    expect(before.lines.find((line) => line.turnId === "turn-1")?.priceStatus).toBe("priced");
    await store.upsertThreadUsageLine({ line: {
      ...first, source: "hydration", usageLineId: "hydrated-astra",
      modelContextWindow: 258_400, totalTokens: 9_999_999, cumulativeTotalTokens: 9_999_999,
    } });
    const after = await store.readThreadPricing({ backend: "codex", threadId: "thread-1" });
    expect(after.lines).toHaveLength(2);
    expect(after.lines.find((line) => line.turnId === "turn-1")).toMatchObject({
      priceStatus: "priced", modelContextWindow: 258_400,
      totalTokens: 1_658_805, cumulativeTotalTokens: 1_658_805,
      totalCostMicros: 3_269_538,
    });
  });

  it("upserts a priced usage line and cached summary idempotently", async () => {
    const line = buildUsageLine();

    await store.upsertThreadUsageLine({ line });
    await store.upsertThreadUsageLine({ line });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines).toHaveLength(1);
    expect(pricing.summaries).toEqual([
      expect.objectContaining({
        cachedInputTokens: 200,
        currency: "USD",
        inputTokens: 1_000,
        outputTokens: 300,
        pricedUsageLineCount: 1,
        threadId: "thread-1",
        totalCostMicros: 16_100,
        totalTokens: 1_300,
        uncachedInputTokens: 800,
        unpricedUsageLineCount: 0,
        usageLineCount: 1,
      }),
    ]);
  });

  it("round-trips request-component pricing for a mixed-band Astra turn", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        cacheWriteInputCostMicros: 375_000,
        cacheWriteInputTokens: 20_000,
        cachedInputCostMicros: 300_000,
        cachedInputTokens: 200_000,
        createdAt: Date.UTC(2026, 8, 5),
        inputTokens: 500_000,
        model: "gpt-6-astra",
        outputCostMicros: 1_250_000,
        outputTokens: 20_000,
        pricingBasis: "request-components",
        pricingCatalogVersion: "2026-09-04",
        pricingRateId: undefined,
        reasoningOutputTokens: 0,
        totalCostMicros: 6_625_000,
        totalTokens: 520_000,
        uncachedInputCostMicros: 4_700_000,
        uncachedInputTokens: 300_000,
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      cacheWriteInputCostMicros: 375_000,
      cacheWriteInputTokens: 20_000,
      cachedInputCostMicros: 300_000,
      priceStatus: "priced",
      pricingBasis: "request-components",
      totalCostMicros: 6_625_000,
      uncachedInputCostMicros: 4_700_000,
    });
    expect(pricing.lines[0]?.pricingRateId).toBeUndefined();
    expect(pricing.summaries[0]).toMatchObject({
      totalCostMicros: 6_625_000,
      unpricedUsageLineCount: 0,
    });
  });

  it.each(["unchanged", "tokens", "settings"])(
    "preserves observed request prices only for equivalent aggregate refreshes (%s)",
    async (change) => {
      const unchanged = change === "unchanged";
      const line = buildUsageLine({
        source: "live", scope: "turn", status: "pending",
        createdAt: Date.UTC(2026, 8, 5), model: "gpt-6-astra",
        inputTokens: 400_000, uncachedInputTokens: 200_000,
        cachedInputTokens: 200_000, outputTokens: 20_000,
        reasoningOutputTokens: 0, totalTokens: 420_000,
        totalCostMicros: 5_900_000, uncachedInputCostMicros: 4_000_000,
        cachedInputCostMicros: 400_000, outputCostMicros: 1_500_000,
        pricingBasis: "request-components", pricingCatalogVersion: "2026-09-04",
        pricingRateId: "openai:2026-09-04:gpt-6-astra:standard:input-gt-272k",
      });
      await store.upsertThreadUsageLine({ line });
      await store.upsertThreadUsageLine({ line: {
        ...line,
        completedAt: line.createdAt + 60_000,
        status: "finalized",
        pricingBasis: undefined, pricingRateId: undefined,
        priceStatus: "unpriced", priceUnavailableReason: "insufficient-token-breakdown",
        totalCostMicros: 0, cachedInputCostMicros: 0,
        uncachedInputCostMicros: 0, outputCostMicros: 0,
        ...(change === "tokens" ? { outputTokens: 21_000, totalTokens: 421_000 } : {}),
        ...(change === "settings" ? { serviceTier: "unsupported" } : {}),
      } });
      const pricing = await store.readThreadPricing({ backend: "codex", threadId: "thread-1" });
      expect(pricing.lines[0]).toMatchObject({
        completedAt: line.createdAt + 60_000,
        status: "finalized",
        priceStatus: change === "settings" ? "unpriced" : "priced",
        totalCostMicros: unchanged ? line.totalCostMicros : change === "tokens" ? 3_250_000 : 0,
      });
      if (unchanged) {
        expect(pricing.lines[0]).toMatchObject({
          pricingBasis: "request-components",
          cachedInputCostMicros: 400_000,
          uncachedInputCostMicros: 4_000_000,
          outputCostMicros: 1_500_000,
        });
        expect(pricing.lines[0]?.priceUnavailableReason).toBeUndefined();
        expect(pricing.summaries[0]?.totalCostMicros).toBe(line.totalCostMicros);
      }
    },
  );

  it("does not rewrite a finalized usage line model when thread settings change later", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        cachedInputTokens: 0,
        createdAt: Date.UTC(2026, 6, 13, 0, 31),
        inputTokens: 29_818,
        model: "gpt-5.6-sol",
        outputTokens: 84,
        pricingCatalogVersion: "2026-07-09",
        pricingRateId: "openai:2026-07-09:gpt-5.6-sol:standard",
        reasoningOutputTokens: 69,
        totalTokens: 29_902,
        turnId: "turn-1231",
        uncachedInputTokens: 29_818,
        usageLineId: "turn-1231-usage",
      }),
    });

    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        cachedInputTokens: 0,
        createdAt: Date.UTC(2026, 6, 13, 0, 33),
        inputTokens: 29_818,
        model: "gpt-5.6-terra",
        outputTokens: 84,
        reasoningOutputTokens: 69,
        totalTokens: 29_902,
        turnId: "turn-1231",
        uncachedInputTokens: 29_818,
        usageLineId: "turn-1231-usage",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      model: "gpt-5.6-sol",
      pricingRateId: "openai:2026-07-09:gpt-5.6-sol:standard",
      totalCostMicros: 153_680,
      uncachedInputCostMicros: 149_090,
    });
    expect(pricing.summaries[0]).toMatchObject({
      totalCostMicros: 153_680,
      unpricedUsageLineCount: 0,
      usageLineCount: 1,
    });

    const turn = stateDb.raw
      .prepare(
        "SELECT model, pricing_rate_id FROM thread_usage_lines WHERE usage_line_id = ?",
      )
      .get("turn-1231-usage") as {
      model: string | null;
      pricing_rate_id: string | null;
    };
    const usageTurn = stateDb.raw
      .prepare("SELECT model FROM thread_usage_turns WHERE turn_id = ?")
      .get("turn-1231") as { model: string | null };
    expect(turn).toEqual({
      model: "gpt-5.6-sol",
      pricing_rate_id: "openai:2026-07-09:gpt-5.6-sol:standard",
    });
    expect(usageTurn).toEqual({ model: "gpt-5.6-sol" });
  });

  it("prices a finished worker line once its model is known, and the thread total follows", async () => {
    const start = PRICING_CATALOG_TIME;
    await store.upsertThreadUsageLine({ line: buildUsageLine({
      createdAt: start, sourceItemId: "parent-turn", turnId: "turn-parent", usageLineId: "parent-turn",
    }) });
    // A Codex native worker's usage, written before anything named its model.
    const {
      model: _model, pricingCatalogId: _catalog, pricingCatalogVersion: _version,
      pricingRateId: _rate, reasoningEffort: _effort, ...unpriced
    } = buildUsageLine({
      createdAt: start + 1000, parentThreadId: "thread-1", scope: "monitor",
      settingsConfidence: "unknown", settingsSource: "monitor", source: "live",
      sourceItemId: "codex-native:worker-1", threadId: "worker-1", turnId: "turn-worker",
      usageLineId: "worker-usage",
    });
    await store.upsertThreadUsageLine({ line: { ...unpriced, priceStatus: "unpriced", totalCostMicros: 0 } });
    let pricing = await store.readThreadPricing({ backend: "codex", threadId: "thread-1" });
    expect(pricing.lines.find((line) => line.usageLineId === "worker-usage")).toMatchObject({
      priceStatus: "unpriced", priceUnavailableReason: "missing-model",
    });
    expect(pricing.summaries[0]).toMatchObject({ totalCostMicros: 16_100, unpricedUsageLineCount: 1 });

    await store.upsertThreadUsageLine({ line: {
      ...unpriced, model: "gpt-5.5", priceStatus: "unpriced", reasoningEffort: "high", totalCostMicros: 0,
    } });
    pricing = await store.readThreadPricing({ backend: "codex", threadId: "thread-1" });
    expect(pricing.lines.find((line) => line.usageLineId === "worker-usage")).toMatchObject({
      model: "gpt-5.5", priceStatus: "priced", totalCostMicros: 16_100,
    });
    // The summary is recomputed from the lines, so the repaired row moves the
    // thread total, and every running total after it is derived from these.
    expect(pricing.summaries[0]).toMatchObject({
      pricedUsageLineCount: 2, totalCostMicros: 32_200, unpricedUsageLineCount: 0,
    });
  });

  it("stores running totals on usage lines without adding them to summaries", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        cachedInputTokens: 200,
        cumulativeCachedInputTokens: 10_200,
        cumulativeInputTokens: 11_000,
        cumulativeOutputTokens: 500,
        cumulativeReasoningOutputTokens: 100,
        cumulativeTotalCostMicros: 42_000,
        cumulativeTotalTokens: 11_600,
        cumulativeUncachedInputTokens: 800,
        inputTokens: 1_000,
        outputTokens: 50,
        reasoningOutputTokens: 10,
        totalCostMicros: 5_900,
        totalTokens: 1_060,
        uncachedInputTokens: 800,
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      cumulativeCachedInputTokens: 10_200,
      cumulativeInputTokens: 11_000,
      cumulativeOutputTokens: 500,
      cumulativeReasoningOutputTokens: 100,
      cumulativeTotalCostMicros: 42_000,
      cumulativeTotalTokens: 11_600,
      cumulativeUncachedInputTokens: 800,
      inputTokens: 1_000,
      totalCostMicros: 5_900,
      totalTokens: 1_060,
    });
    expect(pricing.summaries[0]).toMatchObject({
      cachedInputTokens: 200,
      inputTokens: 1_000,
      outputTokens: 50,
      reasoningOutputTokens: 10,
      totalCostMicros: 5_900,
      totalTokens: 1_060,
    });
  });

  it("round-trips observed context-replay tallies through the turn record", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        observedColdReplayCount: 2,
        observedColdReplayUncachedTokens: 322_900,
        observedHotReplayCachedTokens: 672_200,
        observedHotReplayCount: 4,
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    // The tally is stored on thread_usage_turns and re-attached to the displayed
    // line at read time.
    expect(pricing.lines[0]).toMatchObject({
      observedColdReplayCount: 2,
      observedColdReplayUncachedTokens: 322_900,
      observedHotReplayCachedTokens: 672_200,
      observedHotReplayCount: 4,
    });
    const turn = stateDb.raw
      .prepare(
        `SELECT observed_cold_replay_count,
                observed_cold_replay_uncached_tokens,
                observed_hot_replay_cached_tokens,
                observed_hot_replay_count
         FROM thread_usage_turns
         WHERE usage_turn_id = ?`,
      )
      .get(pricing.lines[0]?.usageTurnId) as {
        observed_cold_replay_count: number | null;
        observed_cold_replay_uncached_tokens: number | null;
        observed_hot_replay_cached_tokens: number | null;
        observed_hot_replay_count: number | null;
      };
    expect(turn).toEqual({
      observed_cold_replay_count: 2,
      observed_cold_replay_uncached_tokens: 322_900,
      observed_hot_replay_cached_tokens: 672_200,
      observed_hot_replay_count: 4,
    });
    // DEPRECATED dual-write (issue #947): the tally is also mirrored onto
    // thread_usage_lines so older locally-run builds keep displaying it. Remove
    // this assertion when the dual-write is dropped.
    const line = stateDb.raw
      .prepare(
        `SELECT observed_cold_replay_count,
                observed_cold_replay_uncached_tokens,
                observed_hot_replay_cached_tokens,
                observed_hot_replay_count
         FROM thread_usage_lines
         WHERE usage_line_id = ?`,
      )
      .get(pricing.lines[0]?.usageLineId) as {
        observed_cold_replay_count: number | null;
        observed_cold_replay_uncached_tokens: number | null;
        observed_hot_replay_cached_tokens: number | null;
        observed_hot_replay_count: number | null;
      };
    expect(line).toEqual({
      observed_cold_replay_count: 2,
      observed_cold_replay_uncached_tokens: 322_900,
      observed_hot_replay_cached_tokens: 672_200,
      observed_hot_replay_count: 4,
    });
    // Observation-derived tallies must not leak into the priced summary totals.
    expect(pricing.summaries[0]).not.toHaveProperty("observedColdReplayCount");
  });

  it("persists final and peak context in the existing turn usage update", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        finalContextTokens: 243_864,
        modelContextWindow: 258_400,
        peakContextTokens: 243_864,
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        finalContextTokens: 131_443,
        modelContextWindow: 258_400,
        peakContextTokens: 131_443,
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(pricing.lines[0]).toMatchObject({
      finalContextTokens: 131_443,
      modelContextWindow: 258_400,
      peakContextTokens: 243_864,
    });
  });

  it("preserves a persisted observed tally when the same line re-upserts without one", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        observedColdReplayCount: 1,
        observedColdReplayUncachedTokens: 150_000,
        observedHotReplayCount: 3,
        observedHotReplayCachedTokens: 450_000,
        source: "live",
        status: "pending",
        usageLineId: "live:thread-1:turn-1",
      }),
    });

    // Same usageLineId re-upserts (e.g. accumulator reset after restart) with no
    // observed fields — the turn-record COALESCE must not erase the persisted
    // tally.
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        source: "live",
        status: "pending",
        usageLineId: "live:thread-1:turn-1",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      observedColdReplayCount: 1,
      observedColdReplayUncachedTokens: 150_000,
      observedHotReplayCount: 3,
      observedHotReplayCachedTokens: 450_000,
    });
  });

  it("round-trips a parent-scoped monitor line's observed tally through the turn record", async () => {
    const monitorLine: Partial<ThreadUsageLineRecord> = {
      parentThreadId: "thread-1",
      scope: "monitor",
      source: "monitor",
      sourceItemId: "review:turn-review-1",
      threadId: "monitor-thread-1",
      turnId: "turn-review-1",
      usageLineId:
        "codex:thread-1:review:turn-review-1:monitor-thread-1:turn-review-1:monitor",
    };
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        ...monitorLine,
        observedColdReplayCount: 1,
        observedColdReplayUncachedTokens: 152_000,
        observedHotReplayCount: 8,
        observedHotReplayCachedTokens: 4_207_616,
      }),
    });

    // The parent-thread read picks the monitor line up through the
    // parent_thread_id branch and must join the tally back from its
    // child-thread-scoped turn record.
    let pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      scope: "monitor",
      threadId: "monitor-thread-1",
      usageTurnId: "openai:codex:monitor-thread-1:turn-review-1",
      observedColdReplayCount: 1,
      observedColdReplayUncachedTokens: 152_000,
      observedHotReplayCount: 8,
      observedHotReplayCachedTokens: 4_207_616,
    });

    // A later tally-less re-upsert of the same monitor line (e.g. a duplicate
    // usage emission after restart) must not wipe the persisted counts.
    await store.upsertThreadUsageLine({ line: buildUsageLine(monitorLine) });
    pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      observedColdReplayCount: 1,
      observedColdReplayUncachedTokens: 152_000,
      observedHotReplayCount: 8,
      observedHotReplayCachedTokens: 4_207_616,
    });
  });

  it("keeps the observed tally on the turn record when hydration supersedes the live line", async () => {
    // Live turn we observed replays for.
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        completedAt: undefined,
        model: "gpt-5.5",
        observedColdReplayCount: 1,
        observedColdReplayUncachedTokens: 150_000,
        observedHotReplayCount: 4,
        observedHotReplayCachedTokens: 600_000,
        serviceTier: "standard",
        source: "live",
        status: "pending",
        usageLineId: "live:thread-1:turn-1",
      }),
    });

    // Transcript hydration for the same turn (no observed tally, different id,
    // distinct turn metadata) — this is what readThread persists on every thread
    // open. It now supersedes the live line normally.
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        completedAt: 55_000,
        model: "gpt-5.5-codex",
        serviceTier: "priority",
        source: "hydration",
        status: "finalized",
        usageLineId: "codex:thread-1:turn-1:total:item-9",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    // Exactly one line survives — the hydration line — and the observed tally,
    // stored on the turn record, is re-attached to it.
    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      usageLineId: "codex:thread-1:turn-1:total:item-9",
      source: "hydration",
      model: "gpt-5.5-codex",
      observedColdReplayCount: 1,
      observedColdReplayUncachedTokens: 150_000,
      observedHotReplayCount: 4,
      observedHotReplayCachedTokens: 600_000,
    });
    // No double-counting: hydration superseded the live line, not added to it.
    expect(pricing.summaries[0]?.usageLineCount).toBe(1);

    // Turn metadata now reflects the hydration line (COALESCE let it win), while
    // the observed tally is preserved.
    const turn = stateDb.raw
      .prepare(
        `SELECT model,
                service_tier,
                completed_at,
                observed_cold_replay_count,
                observed_hot_replay_count
         FROM thread_usage_turns
         WHERE usage_turn_id = ?`,
      )
      .get(pricing.lines[0]?.usageTurnId) as {
        model: string | null;
        service_tier: string | null;
        completed_at: number | null;
        observed_cold_replay_count: number | null;
        observed_hot_replay_count: number | null;
      };
    expect(turn).toEqual({
      model: "gpt-5.5-codex",
      service_tier: "priority",
      completed_at: 55_000,
      observed_cold_replay_count: 1,
      observed_hot_replay_count: 4,
    });
  });

  it.each(["latest-request", "total"] as const)(
    "keeps an attributed live turn aggregate when hydration only has %s usage",
    async (scope) => {
      await store.upsertThreadUsageLine({
        line: buildUsageLine({
          cachedInputTokens: 24_545_792,
          inputTokens: 25_139_426,
          outputTokens: 66_567,
          reasoningOutputTokens: 24_064,
          scope: "turn",
          source: "live",
          status: "pending",
          totalTokens: 25_205_993,
          turnUsageAttributed: true,
          uncachedInputTokens: 593_634,
          usageLineId: "codex:thread-1:turn-1:live-token-usage",
        }),
      });

      await store.upsertThreadUsageLine({
        line: buildUsageLine({
          cachedInputTokens: 111_232,
          completedAt: 55_000,
          inputTokens: 112_017,
          outputTokens: 319,
          reasoningOutputTokens: 90,
          scope,
          source: "hydration",
          status: "finalized",
          totalTokens: 112_426,
          uncachedInputTokens: 785,
          usageLineId: `codex:thread-1:turn-1:${scope}:item-9`,
        }),
      });

      const pricing = await store.readThreadPricing({
        backend: "codex",
        threadId: "thread-1",
      });

      expect(pricing.lines).toHaveLength(1);
      expect(pricing.lines[0]).toMatchObject({
        completedAt: 55_000,
        inputTokens: 25_139_426,
        scope: "turn",
        source: "live",
        usageLineId: "codex:thread-1:turn-1:live-token-usage",
      });
      expect(pricing.summaries[0]?.usageLineCount).toBe(1);
    },
  );

  it("keeps the original usage line timestamp when live usage is updated", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        createdAt: PRICING_CATALOG_TIME,
        source: "live",
        status: "pending",
        totalCostMicros: 4_000,
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        createdAt: PRICING_CATALOG_TIME + 1_000,
        inputTokens: 1_400,
        source: "live",
        status: "pending",
        totalCostMicros: 16_100,
        totalTokens: 1_700,
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      createdAt: PRICING_CATALOG_TIME,
      inputTokens: 1_400,
      totalCostMicros: 16_100,
      totalTokens: 1_700,
    });
  });

  it("stores usage turn start time separately from usage line timestamp", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        completedAt: 20_000,
        createdAt: 20_100,
        source: "live",
        startedAt: 10_000,
        status: "pending",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    const turn = stateDb.raw
      .prepare(
        `SELECT started_at, completed_at, observed_at
         FROM thread_usage_turns
         WHERE usage_turn_id = ?`,
      )
      .get(pricing.lines[0]?.usageTurnId) as {
        completed_at: number | null;
        observed_at: number | null;
        started_at: number | null;
      };

    expect(pricing.lines[0]).toMatchObject({
      completedAt: 20_000,
      createdAt: 20_100,
    });
    expect(turn).toMatchObject({
      completed_at: 20_000,
      observed_at: 20_100,
      started_at: 10_000,
    });
  });

  it("returns usage line start time for completed turn durations", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        completedAt: 20_000,
        createdAt: 20_100,
        startedAt: 10_000,
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      completedAt: 20_000,
      createdAt: 20_100,
      startedAt: 10_000,
    });
  });

  it("lets hydration replace a live fallback start time with the turn start", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        completedAt: undefined,
        createdAt: 20_000,
        source: "live",
        status: "pending",
        usageLineId: "live:thread-1:turn-1",
      }),
    });

    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        completedAt: 20_100,
        createdAt: 20_100,
        source: "hydration",
        startedAt: 10_000,
        status: "finalized",
        usageLineId: "codex:thread-1:turn-1:latest-request:item-1",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    const turn = stateDb.raw
      .prepare(
        `SELECT started_at, completed_at
         FROM thread_usage_turns
         WHERE usage_turn_id = ?`,
      )
      .get(pricing.lines[0]?.usageTurnId) as {
        completed_at: number | null;
        started_at: number | null;
      };

    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      completedAt: 20_100,
      startedAt: 10_000,
      usageLineId: "codex:thread-1:turn-1:latest-request:item-1",
    });
    expect(turn).toMatchObject({
      completed_at: 20_100,
      started_at: 10_000,
    });
  });

  it("does not erase known turn settings when usage updates omit them", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        createdAt: 1_000,
        fastMode: true,
        model: "gpt-5.5",
        serviceTier: "priority",
        settingsConfidence: "exact",
        settingsSource: "turn-context",
        source: "live",
        status: "pending",
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        createdAt: 2_000,
        fastMode: undefined,
        model: undefined,
        serviceTier: undefined,
        settingsConfidence: "unknown",
        settingsSource: "unknown",
        source: "live",
        status: "pending",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    const turn = stateDb.raw
      .prepare(
        `SELECT model, service_tier, fast_mode, settings_source, settings_confidence
         FROM thread_usage_turns
         WHERE usage_turn_id = ?`,
      )
      .get(pricing.lines[0]?.usageTurnId) as {
        fast_mode: number | null;
        model: string | null;
        service_tier: string | null;
        settings_confidence: string | null;
        settings_source: string | null;
      };

    expect(pricing.lines[0]).toMatchObject({
      fastMode: true,
      model: "gpt-5.5",
      serviceTier: "priority",
      settingsConfidence: "exact",
      settingsSource: "turn-context",
    });
    expect(turn).toEqual({
      fast_mode: 1,
      model: "gpt-5.5",
      service_tier: "priority",
      settings_confidence: "exact",
      settings_source: "turn-context",
    });
  });

  it("excludes superseded rows from active summaries while preserving diagnostics", async () => {
    await store.upsertThreadUsageLine({ line: buildUsageLine() });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        status: "superseded",
        totalCostMicros: 16_100,
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        outputTokens: 600,
        totalCostMicros: 25_100,
        totalTokens: 1_600,
        usageLineId: "line-1-hydrated",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines.map((line) => line.usageLineId)).toEqual([
      "line-1-hydrated",
    ]);
    expect(pricing.summaries[0]).toMatchObject({
      outputTokens: 600,
      totalCostMicros: 25_100,
      totalTokens: 1_600,
      usageLineCount: 1,
    });
  });

  it("rolls sub-agent usage into the parent thread once", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        parentThreadId: "thread-1",
        threadId: "monitor-thread-1",
        totalCostMicros: 16_100,
        usageLineId: "monitor-line-1",
      }),
    });

    const parentPricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    const monitorPricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "monitor-thread-1",
    });

    expect(parentPricing.lines).toHaveLength(1);
    expect(parentPricing.summaries[0]).toMatchObject({
      threadId: "thread-1",
      totalCostMicros: 16_100,
      usageLineCount: 1,
    });
    expect(monitorPricing.lines).toHaveLength(1);
    expect(monitorPricing.summaries).toEqual([]);
  });

  it("tracks unpriced token rows separately from priced cost totals", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        model: undefined,
        priceStatus: "unpriced",
        priceUnavailableReason: "missing-model",
        pricingCatalogId: undefined,
        pricingCatalogVersion: undefined,
        pricingRateId: undefined,
        totalCostMicros: 0,
        usageLineId: "line-unpriced",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      priceStatus: "unpriced",
      priceUnavailableReason: "missing-model",
    });
    expect(pricing.summaries[0]).toMatchObject({
      pricedUsageLineCount: 0,
      totalCostMicros: 0,
      unpricedUsageLineCount: 1,
      usageLineCount: 1,
    });
  });

  it("estimates aggregate Astra usage at the cheaper rate without a request breakdown", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        cachedInputCostMicros: 0,
        cachedInputTokens: 100_000,
        createdAt: Date.UTC(2026, 8, 5),
        inputTokens: 300_000,
        model: "gpt-6-astra",
        outputCostMicros: 0,
        outputTokens: 10_000,
        priceStatus: "unpriced",
        pricingCatalogId: undefined,
        pricingCatalogVersion: undefined,
        pricingRateId: undefined,
        reasoningOutputTokens: 0,
        scope: "turn",
        totalCostMicros: 0,
        totalTokens: 310_000,
        uncachedInputCostMicros: 0,
        uncachedInputTokens: 200_000,
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      priceStatus: "priced",
      totalCostMicros: 2_600_000,
    });
    expect(pricing.lines[0]?.priceUnavailableReason).toBeUndefined();
  });

  it("prices an aggregate Astra turn when its context window keeps every request under 272K", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine(buildAstraAggregateOverrides({
        modelContextWindow: 258_400,
      })),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      priceStatus: "priced",
      pricingRateId: "openai:2026-09-04:gpt-6-astra:standard:input-lte-272k",
      totalCostMicros: 3_269_538,
    });
    expect(pricing.lines[0]?.priceUnavailableReason).toBeUndefined();
    expect(pricing.summaries).toEqual([
      expect.objectContaining({
        pricedUsageLineCount: 1,
        totalCostMicros: 3_269_538,
        unpricedUsageLineCount: 0,
      }),
    ]);
  });

  it("lazily reprices an older aggregate row behind a priced newer row from its turn context window", async () => {
    // Persisted before the context-window ceiling existed: the aggregate row
    // stayed unpriced while its turn record already carried the window.
    await store.upsertThreadUsageLine({
      line: buildUsageLine(buildAstraAggregateOverrides({
        createdAt: Date.UTC(2026, 8, 5, 20, 40),
        turnId: "turn-old",
        usageLineId: "line-old",
      })),
    });
    stateDb.raw
      .prepare(
        `UPDATE thread_usage_turns
         SET model_context_window = 258400
         WHERE thread_id = 'thread-1'`,
      )
      .run();
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        createdAt: Date.UTC(2026, 8, 5, 21, 0),
        model: "gpt-6-astra",
        sourceItemId: "item-new",
        turnId: "turn-new",
        usageLineId: "line-new",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines.map((line) => line.usageLineId)).toEqual([
      "line-new",
      "line-old",
    ]);
    expect(pricing.lines[0]?.priceStatus).toBe("priced");
    expect(pricing.lines[1]).toMatchObject({
      priceStatus: "priced",
      pricingRateId: "openai:2026-09-04:gpt-6-astra:standard:input-lte-272k",
      totalCostMicros: 3_269_538,
    });
    expect(pricing.summaries).toEqual([
      expect.objectContaining({
        pricedUsageLineCount: 2,
        unpricedUsageLineCount: 0,
      }),
    ]);
  });

  it("uses the usage timestamp when selecting effective pricing rates", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        createdAt: Date.UTC(2026, 0, 1),
        completedAt: Date.UTC(2026, 0, 1),
        usageLineId: "line-before-catalog",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      priceStatus: "unpriced",
      priceUnavailableReason: "missing-rate",
      totalCostMicros: 0,
    });
    expect(pricing.summaries[0]).toMatchObject({
      pricedUsageLineCount: 0,
      totalCostMicros: 0,
      unpricedUsageLineCount: 1,
    });
  });

  it("prices GPT-5.5 usage recorded on its April 23 release date", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        cachedInputTokens: 1_000,
        completedAt: Date.UTC(2026, 3, 23, 18, 0, 0),
        createdAt: Date.UTC(2026, 3, 23, 18, 0, 0),
        inputTokens: 4_000,
        outputTokens: 2_000,
        reasoningOutputTokens: 0,
        totalTokens: 6_000,
        uncachedInputTokens: 3_000,
        usageLineId: "line-april-23-gpt-5-5",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      priceStatus: "priced",
      pricingRateId: "openai:2026-06-16:gpt-5.5:standard",
      totalCostMicros: 75_500,
    });
    expect(pricing.lines[0]?.priceUnavailableReason).toBeUndefined();
    expect(pricing.summaries[0]).toMatchObject({
      pricedUsageLineCount: 1,
      totalCostMicros: 75_500,
      unpricedUsageLineCount: 0,
    });
  });

  it("prices GPT-5.5 usage recorded on June 15", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        cachedInputTokens: 38_272,
        completedAt: Date.UTC(2026, 5, 15, 18, 40, 23),
        createdAt: Date.UTC(2026, 5, 15, 18, 40, 23),
        inputTokens: 80_351,
        outputTokens: 58,
        reasoningOutputTokens: 0,
        totalTokens: 80_409,
        uncachedInputTokens: 42_079,
        usageLineId: "line-june-15-gpt-5-5",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      priceStatus: "priced",
      pricingRateId: "openai:2026-06-16:gpt-5.5:standard",
      totalCostMicros: 231_271,
    });
    expect(pricing.lines[0]?.priceUnavailableReason).toBeUndefined();
    expect(pricing.summaries[0]).toMatchObject({
      pricedUsageLineCount: 1,
      totalCostMicros: 231_271,
      unpricedUsageLineCount: 0,
    });
  });

  it("reprices persisted Grok ACP usage under the xAI provider", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        backend: "acp:grok",
        cachedInputTokens: 11_136,
        completedAt: Date.UTC(2026, 6, 26),
        createdAt: Date.UTC(2026, 6, 26),
        inputTokens: 21_208,
        model: "grok-4.5-build",
        outputTokens: 45,
        priceStatus: "unpriced",
        priceUnavailableReason: "missing-rate",
        pricingCatalogId: undefined,
        pricingCatalogVersion: undefined,
        pricingRateId: undefined,
        reasoningOutputTokens: 28,
        totalCostMicros: 0,
        totalTokens: 21_253,
        uncachedInputTokens: 10_072,
        usageLineId: "line-grok-4-5-build",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "acp:grok",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      priceStatus: "priced",
      pricingCatalogId: "xai-api",
      pricingCatalogVersion: "2026-07-17",
      pricingRateId: "xai:2026-07-17:grok-4.5:standard",
      provider: "xai",
      totalCostMicros: 23_755,
    });
    expect(pricing.lines[0]?.priceUnavailableReason).toBeUndefined();
    expect(pricing.summaries[0]).toMatchObject({
      pricedUsageLineCount: 1,
      provider: "xai",
      totalCostMicros: 23_755,
      unpricedUsageLineCount: 0,
    });
  });

  it("reprices a persisted Grok 4.7 naming helper build alias on the parent thread", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        backend: "acp:grok",
        cachedInputTokens: 1_200,
        completedAt: Date.UTC(2026, 9, 1),
        createdAt: Date.UTC(2026, 9, 1),
        inputTokens: 2_900,
        // Seed the state written before the catalog recognized the alias.
        model: "unknown-grok-model",
        outputTokens: 338,
        parentThreadId: "thread-1",
        reasoningOutputTokens: 327,
        scope: "monitor",
        source: "monitor",
        sourceItemId: "system:title-helper:thread-1",
        threadId: "grok-title-helper",
        totalTokens: 3_238,
        uncachedInputTokens: 1_700,
        usageLineId: "line-grok-4-7-title-helper",
      }),
    });
    stateDb.raw.prepare(
      "UPDATE thread_usage_lines SET model = 'grok-4.7-build' WHERE usage_line_id = ?",
    ).run("line-grok-4-7-title-helper");
    expect(stateDb.raw.prepare(
      "SELECT price_status, provider, total_cost_micros FROM thread_usage_lines WHERE usage_line_id = ?",
    ).get("line-grok-4-7-title-helper")).toEqual({
      price_status: "unpriced",
      provider: "openai",
      total_cost_micros: 0,
    });

    const pricing = await store.readThreadPricing({
      backend: "acp:grok",
      threadId: "thread-1",
    });

    expect(pricing.lines).toHaveLength(1);
    expect(pricing.lines[0]).toMatchObject({
      model: "grok-4.7-build",
      parentThreadId: "thread-1",
      priceStatus: "priced",
      pricingCatalogId: "xai-api",
      pricingCatalogVersion: "2026-09-21",
      pricingRateId: "xai:2026-09-21:grok-4.7:standard",
      provider: "xai",
      totalCostMicros: 6_028,
    });
    expect(pricing.lines[0]?.priceUnavailableReason).toBeUndefined();
    expect(pricing.summaries).toEqual([
      expect.objectContaining({
        pricedUsageLineCount: 1,
        provider: "xai",
        totalCostMicros: 6_028,
        unpricedUsageLineCount: 0,
      }),
    ]);
  });

  it("reprices persisted Grok 4.6 usage under the xAI provider", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        backend: "acp:grok",
        cachedInputTokens: 128,
        completedAt: Date.UTC(2026, 7, 15),
        createdAt: Date.UTC(2026, 7, 15),
        inputTokens: 155_459,
        model: "grok-4.6",
        outputTokens: 266,
        priceStatus: "unpriced",
        priceUnavailableReason: "missing-rate",
        pricingCatalogId: undefined,
        pricingCatalogVersion: undefined,
        pricingRateId: undefined,
        provider: "xai",
        reasoningOutputTokens: 130,
        totalCostMicros: 0,
        totalTokens: 155_725,
        uncachedInputTokens: 155_331,
        usageLineId: "line-grok-4-6",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "acp:grok",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      priceStatus: "priced",
      pricingCatalogId: "xai-api",
      pricingCatalogVersion: "2026-08-12",
      pricingRateId: "xai:2026-08-12:grok-4.6:standard",
      provider: "xai",
      totalCostMicros: 312_322,
    });
    expect(pricing.lines[0]?.priceUnavailableReason).toBeUndefined();
    expect(pricing.summaries[0]).toMatchObject({
      pricedUsageLineCount: 1,
      provider: "xai",
      totalCostMicros: 312_322,
      unpricedUsageLineCount: 0,
    });
  });

  it("prices Grok 4.6 build turn aggregates above 200K at the account rate", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        backend: "acp:grok",
        cachedInputTokens: 128,
        completedAt: Date.UTC(2026, 7, 15),
        createdAt: Date.UTC(2026, 7, 15),
        inputTokens: 255_459,
        model: "grok-4.6-build",
        outputTokens: 266,
        priceStatus: "unpriced",
        priceUnavailableReason: "missing-rate",
        pricingCatalogId: undefined,
        pricingCatalogVersion: undefined,
        pricingRateId: undefined,
        provider: "xai",
        reasoningOutputTokens: 130,
        totalCostMicros: 0,
        totalTokens: 255_725,
        uncachedInputTokens: 255_331,
        usageLineId: "line-grok-4-6-aggregate",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "acp:grok",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      priceStatus: "priced",
      pricingCatalogId: "xai-api",
      pricingCatalogVersion: "2026-08-12",
      pricingRateId: "xai:2026-08-12:grok-4.6:standard",
      provider: "xai",
      totalCostMicros: 512_322,
    });
    expect(pricing.lines[0]?.priceUnavailableReason).toBeUndefined();
    expect(pricing.summaries[0]).toMatchObject({
      pricedUsageLineCount: 1,
      provider: "xai",
      totalCostMicros: 512_322,
      unpricedUsageLineCount: 0,
    });
  });

  it("lazily reprices older rows in groups of ten while each group makes progress", async () => {
    await seedUnpricedGrokUsageLines({ count: 25, idPrefix: "lazy" });
    stateDb.raw
      .prepare(
        `UPDATE thread_usage_lines
         SET model = 'grok-4.6-build'
         WHERE thread_id = 'thread-1'`,
      )
      .run();

    const pricing = await store.readThreadPricing({
      backend: "acp:grok",
      threadId: "thread-1",
    });

    expect(pricing.lines).toHaveLength(25);
    expect(
      pricing.lines.every((line) => line.priceStatus === "priced"),
    ).toBe(true);
    expect(
      pricing.lines.every(
        (line) =>
          line.pricingRateId === "xai:2026-08-12:grok-4.6:standard",
      ),
    ).toBe(true);
    expect(pricing.summaries).toEqual([
      expect.objectContaining({
        pricedUsageLineCount: 25,
        provider: "xai",
        totalCostMicros: 3_987_650,
        unpricedUsageLineCount: 0,
      }),
    ]);
  });

  it("stops lazy repricing after ten consecutive rows make no progress", async () => {
    await seedUnpricedGrokUsageLines({ count: 20, idPrefix: "stop" });
    stateDb.raw
      .prepare(
        `UPDATE thread_usage_lines
         SET model = 'grok-4.6-build'
         WHERE usage_line_id IN (
           SELECT usage_line_id
           FROM thread_usage_lines
           ORDER BY created_at ASC
           LIMIT 10
         )`,
      )
      .run();

    const pricing = await store.readThreadPricing({
      backend: "acp:grok",
      threadId: "thread-1",
    });

    expect(
      pricing.lines
        .filter((line) => line.model === "grok-4.6-build")
        .every((line) => line.priceStatus === "unpriced"),
    ).toBe(true);
    expect(pricing.summaries).toEqual([
      expect.objectContaining({
        pricedUsageLineCount: 0,
        unpricedUsageLineCount: 20,
      }),
    ]);
  });

  it("reprices persisted Qwen ACP usage under the Qwen provider", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        backend: "acp:qwen",
        cachedInputTokens: 0,
        completedAt: Date.UTC(2026, 6, 28),
        createdAt: Date.UTC(2026, 6, 28),
        inputTokens: 39_286,
        model: "qwen3.7-plus(openai)",
        outputTokens: 90,
        priceStatus: "unpriced",
        priceUnavailableReason: "missing-rate",
        pricingCatalogId: undefined,
        pricingCatalogVersion: undefined,
        pricingRateId: undefined,
        provider: "qwen",
        reasoningOutputTokens: 49,
        totalCostMicros: 0,
        totalTokens: 39_376,
        uncachedInputTokens: 39_286,
        usageLineId: "line-qwen3-7-plus",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "acp:qwen",
      threadId: "thread-1",
    });

    expect(pricing.lines[0]).toMatchObject({
      priceStatus: "priced",
      pricingCatalogId: "qwen-modelstudio-international",
      pricingCatalogVersion: "2026-07-15",
      pricingRateId:
        "qwen:2026-07-15:qwen3.7-plus:standard:input-lte-256k",
      provider: "qwen",
      totalCostMicros: 15_858,
    });
    expect(pricing.lines[0]?.priceUnavailableReason).toBeUndefined();
    expect(pricing.summaries[0]).toMatchObject({
      pricedUsageLineCount: 1,
      provider: "qwen",
      totalCostMicros: 15_858,
      unpricedUsageLineCount: 0,
    });
  });

  it("records one provider-scoped usage turn for multiple usage lines from the same turn", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        source: "live",
        totalCostMicros: 4_000,
        usageLineId: "line-1-live",
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        source: "hydration",
        totalCostMicros: 16_100,
        usageLineId: "line-1-hydrated",
      }),
    });

    const turns = stateDb.raw
      .prepare(
        `SELECT usage_turn_id, provider, backend, thread_id, turn_id, model
         FROM thread_usage_turns
         ORDER BY usage_turn_id`,
      )
      .all() as Array<{
        usage_turn_id: string;
        provider: string;
        backend: string;
        thread_id: string;
        turn_id: string | null;
        model: string | null;
      }>;

    expect(turns).toEqual([
      {
        backend: "codex",
        model: "gpt-5.5",
        provider: "openai",
        thread_id: "thread-1",
        turn_id: "turn-1",
        usage_turn_id: "openai:codex:thread-1:turn-1",
      },
    ]);
  });

  it("keeps pricing summaries separated by provider", async () => {
    await store.upsertThreadUsageLine({ line: buildUsageLine() });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        createdAt: Date.UTC(2026, 6, 26),
        model: "grok-4.5",
        outputCostMicros: 1_800,
        provider: "xai",
        pricingCatalogId: "xai-api",
        pricingCatalogVersion: "2026-07-17",
        pricingRateId: "xai:2026-07-17:grok-4.5:standard",
        totalCostMicros: 3_460,
        uncachedInputCostMicros: 1_600,
        usageLineId: "xai-line-1",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });

    expect(pricing.summaries).toHaveLength(2);
    expect(pricing.summaries).toEqual([
      expect.objectContaining({
        provider: "openai",
        totalCostMicros: 16_100,
        usageLineCount: 1,
      }),
      expect.objectContaining({
        provider: "xai",
        totalCostMicros: 3_460,
        usageLineCount: 1,
      }),
    ]);
  });

  it("persists the fork origin marker and round-trips a fork-baseline line", async () => {
    await store.setThreadForkOrigin({
      backend: "codex",
      threadId: "thread-1",
      forkSourceThreadId: "thread-parent",
    });
    let overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.forkSourceThreadId).toBe("thread-parent");
    expect(overlay?.forkBaselineCaptured).toBeUndefined();

    await store.setThreadForkOrigin({
      backend: "codex",
      threadId: "thread-1",
      forkBaselineCaptured: true,
    });
    overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    // The fork source must survive a later capture-flag write.
    expect(overlay?.forkSourceThreadId).toBe("thread-parent");
    expect(overlay?.forkBaselineCaptured).toBe(true);

    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        usageLineId: "codex:thread-1:fork-baseline",
        scope: "fork-baseline",
        source: "backfill",
        sourceItemId: "fork-baseline",
        turnId: undefined,
        cachedInputTokens: 17_628_672,
        uncachedInputTokens: 1_172_721,
        inputTokens: 18_801_393,
        outputTokens: 46_199,
        reasoningOutputTokens: 9_979,
        totalTokens: 18_847_592,
        cachedInputCostMicros: 0,
        uncachedInputCostMicros: 0,
        outputCostMicros: 0,
        totalCostMicros: 0,
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    const forkLine = pricing.lines.find(
      (line) => line.scope === "fork-baseline",
    );
    expect(forkLine).toMatchObject({
      scope: "fork-baseline",
      cachedInputTokens: 17_628_672,
      uncachedInputTokens: 1_172_721,
      totalCostMicros: 0,
    });
  });

  it("round-trips the turnUsageAttributed flag through sqlite", async () => {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        turnId: "turn-attributed",
        turnUsageAttributed: true,
        usageLineId: "line-attributed",
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        turnId: "turn-unattributed",
        turnUsageAttributed: false,
        usageLineId: "line-unattributed",
      }),
    });

    const pricing = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    const byId = new Map(pricing.lines.map((line) => [line.usageLineId, line]));
    expect(byId.get("line-attributed")?.turnUsageAttributed).toBe(true);
    expect(byId.get("line-unattributed")?.turnUsageAttributed).toBe(false);
    // A line that never set the flag stays undefined, not coerced to a boolean.
    await store.upsertThreadUsageLine({
      line: buildUsageLine({ turnId: "turn-plain", usageLineId: "line-plain" }),
    });
    const after = await store.readThreadPricing({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(
      after.lines.find((line) => line.usageLineId === "line-plain")
        ?.turnUsageAttributed,
    ).toBeUndefined();
  });

  it("backfills legacy live summary rows to turnUsageAttributed=false on migration", async () => {
    const dbPath = useFileStateDb();
    // Legacy whole-thread summary masquerading as a turn (no cumulative
    // breakdown, >= 1M tokens), plus controls that must stay untouched.
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        scope: "turn",
        source: "live",
        status: "pending",
        totalTokens: 2_000_000,
        turnId: "turn-legacy",
        usageLineId: "legacy-summary",
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        cumulativeTotalTokens: 2_000_000,
        scope: "turn",
        source: "live",
        status: "pending",
        totalTokens: 2_000_000,
        turnId: "turn-modern",
        usageLineId: "modern-turn",
      }),
    });
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        scope: "turn",
        source: "live",
        status: "pending",
        totalTokens: 500_000,
        turnId: "turn-small",
        usageLineId: "small-live-turn",
      }),
    });

    // Force the user_version 26 migration to run against the seeded rows, then
    // reassign the module handle so afterEach closes the reopened db.
    stateDb.raw.pragma("user_version = 25");
    stateDb.close();
    stateDb = StateDb.open(dbPath);

    const flagById = new Map(
      (
        stateDb.raw
          .prepare(
            "SELECT usage_line_id, turn_usage_attributed FROM thread_usage_lines",
          )
          .all() as {
          turn_usage_attributed: number | null;
          usage_line_id: string;
        }[]
      ).map((row) => [row.usage_line_id, row.turn_usage_attributed]),
    );
    expect(flagById.get("legacy-summary")).toBe(0);
    expect(flagById.get("modern-turn")).toBeNull();
    expect(flagById.get("small-live-turn")).toBeNull();
  });
});

function buildUsageLine(
  overrides: Partial<ThreadUsageLineRecord> = {},
): ThreadUsageLineRecord {
  return {
    backend: "codex",
    cachedInputCostMicros: 100,
    cachedInputTokens: 200,
    createdAt: PRICING_CATALOG_TIME,
    currency: "USD",
    fastMode: false,
    inputTokens: 1_000,
    model: "gpt-5.5",
    outputCostMicros: 12_000,
    outputTokens: 300,
    priceStatus: "priced",
    provider: "openai",
    pricingCatalogId: "openai-api",
    pricingCatalogVersion: "2026-06-16",
    pricingRateId: "openai:2026-06-16:gpt-5.5:standard",
    reasoningEffort: "high",
    reasoningOutputTokens: 100,
    scope: "turn",
    serviceTier: "standard",
    settingsConfidence: "exact",
    settingsSource: "turn-context",
    source: "hydration",
    sourceItemId: "item-1",
    status: "finalized",
    threadId: "thread-1",
    totalCostMicros: 16_100,
    totalTokens: 1_300,
    turnId: "turn-1",
    uncachedInputCostMicros: 4_000,
    uncachedInputTokens: 800,
    usageLineId: "line-1",
    ...overrides,
  };
}

function buildAstraAggregateOverrides(
  overrides: Partial<ThreadUsageLineRecord> = {},
): Partial<ThreadUsageLineRecord> {
  // A GPT-6 Astra turn whose 19 requests summed to 1.6M input tokens while
  // every request stayed under the 258,400-token context window.
  return {
    cachedInputCostMicros: 0,
    cachedInputTokens: 1_527_808,
    createdAt: Date.UTC(2026, 8, 5),
    inputTokens: 1_648_011,
    model: "gpt-6-astra",
    outputCostMicros: 0,
    outputTokens: 9_663,
    priceStatus: "unpriced",
    priceUnavailableReason: "insufficient-token-breakdown",
    pricingCatalogId: undefined,
    pricingCatalogVersion: undefined,
    pricingRateId: undefined,
    reasoningOutputTokens: 1_131,
    scope: "turn",
    totalCostMicros: 0,
    totalTokens: 1_658_805,
    uncachedInputCostMicros: 0,
    uncachedInputTokens: 120_203,
    ...overrides,
  };
}

async function seedUnpricedGrokUsageLines(params: {
  count: number;
  idPrefix: string;
}): Promise<void> {
  const createdAt = Date.UTC(2026, 7, 15);
  for (let index = 0; index < params.count; index += 1) {
    await store.upsertThreadUsageLine({
      line: buildUsageLine({
        backend: "acp:grok",
        cachedInputCostMicros: 0,
        cachedInputTokens: 315_776,
        createdAt: createdAt + index,
        inputTokens: 316_222,
        model: "unknown-grok-model",
        outputCostMicros: 0,
        outputTokens: 121,
        priceStatus: "unpriced",
        priceUnavailableReason: "missing-rate",
        pricingCatalogId: undefined,
        pricingCatalogVersion: undefined,
        pricingRateId: undefined,
        provider: "openai",
        reasoningOutputTokens: 50,
        sourceItemId: `item-${params.idPrefix}-${index}`,
        totalCostMicros: 0,
        totalTokens: 316_343,
        turnId: `turn-${params.idPrefix}-${index}`,
        uncachedInputCostMicros: 0,
        uncachedInputTokens: 446,
        usageLineId: `line-${params.idPrefix}-${index}`,
      }),
    });
  }
}
