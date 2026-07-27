import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getNativeBinding } from "../state/native-binding";
import {
  CURRENT_STATE_DB_USER_VERSION,
  STATE_DB_JOURNAL_SIZE_LIMIT_BYTES,
  STATE_DB_WAL_AUTOCHECKPOINT_PAGES,
  StateDb,
} from "../state/state-db";
import { ThreadSearchStore } from "../thread-search/thread-search-store";

let stateDb: StateDb;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-state-db-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("StateDb", () => {
  it("creates additive runtime cache tables", () => {
    const tables = stateDb.raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?, ?) ORDER BY name`,
      )
      .all(
        "acp_installed_agents",
        "acp_registry_cache",
        "acp_sessions",
        "pr_lookup_cache",
        "pr_status_cache",
      ) as Array<{ name: string }>;

    expect(tables.map((table) => table.name)).toEqual([
      "acp_installed_agents",
      "acp_registry_cache",
      "acp_sessions",
      "pr_lookup_cache",
      "pr_status_cache",
    ]);
    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
  });

  it("creates provider-aware pull request cache columns", () => {
    const prStatusColumns = stateDb.raw
      .prepare("PRAGMA table_info(pr_status_cache)")
      .all() as Array<{ name: string }>;
    const prLookupColumns = stateDb.raw
      .prepare("PRAGMA table_info(pr_lookup_cache)")
      .all() as Array<{ name: string }>;

    expect(prStatusColumns.map((column) => column.name)).toContain("provider");
    expect(prLookupColumns.map((column) => column.name)).toContain("provider");
  });

  it("creates thread usage pricing ledger tables", () => {
    const tables = stateDb.raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?, ?) ORDER BY name`,
      )
      .all(
        "pricing_catalog_versions",
        "pricing_rates",
        "thread_pricing_summaries",
        "thread_usage_turns",
        "thread_usage_lines",
      ) as Array<{ name: string }>;

    expect(tables.map((table) => table.name)).toEqual([
      "pricing_catalog_versions",
      "pricing_rates",
      "thread_pricing_summaries",
      "thread_usage_lines",
      "thread_usage_turns",
    ]);
  });

  it("creates thread tool accounting tables", () => {
    const tables = stateDb.raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?) ORDER BY name`,
      )
      .all(
        "thread_tool_invocation_alerts",
        "thread_tool_invocations",
      ) as Array<{ name: string }>;

    expect(tables.map((table) => table.name)).toEqual([
      "thread_tool_invocation_alerts",
      "thread_tool_invocations",
    ]);
    expect(indexNames("thread_tool_invocations")).toEqual(
      expect.arrayContaining([
        "idx_thread_tool_invocations_read_thread",
        "idx_thread_tool_invocations_polling",
        "idx_thread_tool_invocations_turn",
      ]),
    );
  });

  it("carries observed context-replay columns on both the turn and the line", () => {
    // The tally's source of truth is thread_usage_turns. The line columns are a
    // DEPRECATED dual-write (issue #947) kept so older locally-run builds — which
    // read the tally off the usage line — keep working against a shared profile
    // DB. Every build must find the columns it expects on a fresh DB.
    const observedColumns = [
      "observed_cold_replay_count",
      "observed_cold_replay_uncached_tokens",
      "observed_hot_replay_cached_tokens",
      "observed_hot_replay_count",
    ];
    const turnColumns = (
      stateDb.raw
        .prepare("PRAGMA table_info(thread_usage_turns)")
        .all() as Array<{ name: string }>
    ).map((column) => column.name);
    const lineColumns = (
      stateDb.raw
        .prepare("PRAGMA table_info(thread_usage_lines)")
        .all() as Array<{ name: string }>
    ).map((column) => column.name);

    for (const column of observedColumns) {
      expect(turnColumns).toContain(column);
      expect(lineColumns).toContain(column);
    }
  });

  it("sets explicit WAL checkpoint and journal size bounds", () => {
    expect(stateDb.raw.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(stateDb.raw.pragma("wal_autocheckpoint", { simple: true })).toBe(
      STATE_DB_WAL_AUTOCHECKPOINT_PAGES,
    );
    expect(stateDb.raw.pragma("journal_size_limit", { simple: true })).toBe(
      STATE_DB_JOURNAL_SIZE_LIMIT_BYTES,
    );
  });

  it("keeps AUTOINCREMENT limited to existing bounded UI history tables", () => {
    const rows = stateDb.raw
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND upper(sql) LIKE '%AUTOINCREMENT%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    expect(rows.map((row) => row.name)).toEqual([
      "composer_draft_journal",
      "messaging_activity_log",
    ]);
  });

  it("indexes thread usage pricing reads and rollups without full line-table scans", () => {
    expect(indexNames("thread_usage_lines")).toEqual(
      expect.arrayContaining([
        "idx_thread_usage_lines_read_parent",
        "idx_thread_usage_lines_read_thread",
        "idx_thread_usage_lines_summary_parent",
        "idx_thread_usage_lines_summary_thread",
      ]),
    );

    const readPlan = queryPlanDetails(
      `SELECT *
       FROM (
         SELECT *
         FROM thread_usage_lines
         WHERE backend = ?
           AND status != 'superseded'
           AND thread_id = ?
         UNION ALL
         SELECT *
         FROM thread_usage_lines
         WHERE backend = ?
           AND status != 'superseded'
           AND parent_thread_id = ?
           AND thread_id != ?
       )
       ORDER BY created_at DESC, usage_line_id DESC`,
      ["codex", "thread-1", "codex", "thread-1", "thread-1"],
    );
    expect(readPlan).toContain("idx_thread_usage_lines_read_thread");
    expect(readPlan).toContain("idx_thread_usage_lines_read_parent");
    expect(readPlan).not.toMatch(/\bSCAN thread_usage_lines\b/);

    const summaryPlan = queryPlanDetails(
      `SELECT
         COUNT(*) AS usage_line_count,
         COALESCE(SUM(total_cost_micros), 0) AS total_cost_micros
       FROM (
         SELECT *
         FROM thread_usage_lines
         WHERE provider = ?
           AND backend = ?
           AND currency = ?
           AND status != 'superseded'
           AND thread_id = ?
         UNION ALL
         SELECT *
         FROM thread_usage_lines
         WHERE provider = ?
           AND backend = ?
           AND currency = ?
           AND status != 'superseded'
           AND parent_thread_id = ?
           AND thread_id != ?
       )`,
      [
        "openai",
        "codex",
        "USD",
        "thread-1",
        "openai",
        "codex",
        "USD",
        "thread-1",
        "thread-1",
      ],
    );
    expect(summaryPlan).toContain("idx_thread_usage_lines_summary_thread");
    expect(summaryPlan).toContain("idx_thread_usage_lines_summary_parent");
    expect(summaryPlan).not.toMatch(/\bSCAN thread_usage_lines\b/);
  });

  it("migrates legacy thread usage pricing rows into provider-scoped usage turns", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "legacy-thread-usage-pricing-state.db");
    const raw = openRawDb(dbPath);
    raw.exec(`
      PRAGMA user_version = 17;
      CREATE TABLE thread_usage_lines (
        usage_line_id              TEXT PRIMARY KEY,
        backend                    TEXT NOT NULL,
        thread_id                  TEXT NOT NULL,
        parent_thread_id           TEXT,
        turn_id                    TEXT,
        source                     TEXT NOT NULL,
        source_item_id             TEXT,
        scope                      TEXT NOT NULL,
        status                     TEXT NOT NULL,
        created_at                 INTEGER NOT NULL,
        completed_at               INTEGER,
        model                      TEXT,
        reasoning_effort           TEXT,
        service_tier               TEXT,
        fast_mode                  INTEGER,
        settings_source            TEXT,
        settings_confidence        TEXT,
        input_tokens               INTEGER NOT NULL,
        cached_input_tokens        INTEGER NOT NULL,
        uncached_input_tokens      INTEGER NOT NULL,
        output_tokens              INTEGER NOT NULL,
        reasoning_output_tokens    INTEGER NOT NULL,
        total_tokens               INTEGER NOT NULL,
        price_status               TEXT NOT NULL,
        price_unavailable_reason   TEXT,
        currency                   TEXT NOT NULL,
        pricing_catalog_id         TEXT,
        pricing_catalog_version    TEXT,
        pricing_rate_id            TEXT,
        uncached_input_cost_micros INTEGER NOT NULL,
        cached_input_cost_micros   INTEGER NOT NULL,
        output_cost_micros         INTEGER NOT NULL,
        total_cost_micros          INTEGER NOT NULL,
        updated_at                 INTEGER NOT NULL
      );
      CREATE TABLE thread_pricing_summaries (
        backend                   TEXT NOT NULL,
        thread_id                 TEXT NOT NULL,
        currency                  TEXT NOT NULL,
        usage_line_count          INTEGER NOT NULL,
        priced_usage_line_count   INTEGER NOT NULL,
        unpriced_usage_line_count INTEGER NOT NULL,
        input_tokens              INTEGER NOT NULL,
        cached_input_tokens       INTEGER NOT NULL,
        uncached_input_tokens     INTEGER NOT NULL,
        output_tokens             INTEGER NOT NULL,
        reasoning_output_tokens   INTEGER NOT NULL,
        total_tokens              INTEGER NOT NULL,
        total_cost_micros         INTEGER NOT NULL,
        updated_at                INTEGER NOT NULL,
        PRIMARY KEY (backend, thread_id, currency)
      );
      INSERT INTO thread_usage_lines (
        usage_line_id,
        backend,
        thread_id,
        parent_thread_id,
        turn_id,
        source,
        source_item_id,
        scope,
        status,
        created_at,
        completed_at,
        model,
        reasoning_effort,
        service_tier,
        fast_mode,
        settings_source,
        settings_confidence,
        input_tokens,
        cached_input_tokens,
        uncached_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        total_tokens,
        price_status,
        price_unavailable_reason,
        currency,
        pricing_catalog_id,
        pricing_catalog_version,
        pricing_rate_id,
        uncached_input_cost_micros,
        cached_input_cost_micros,
        output_cost_micros,
        total_cost_micros,
        updated_at
      ) VALUES (
        'line-1',
        'codex',
        'thread-1',
        NULL,
        'turn-1',
        'hydration',
        'item-1',
        'turn',
        'finalized',
        1000,
        1100,
        'gpt-5.5',
        'high',
        'standard',
        0,
        'turn-context',
        'exact',
        1000,
        200,
        800,
        300,
        100,
        1300,
        'priced',
        NULL,
        'USD',
        'openai-api',
        '2026-06-16',
        'openai:2026-06-16:gpt-5.5:standard',
        900,
        100,
        4000,
        5000,
        1200
      );
      INSERT INTO thread_pricing_summaries VALUES (
        'codex',
        'thread-1',
        'USD',
        1,
        1,
        0,
        1000,
        200,
        800,
        300,
        100,
        1300,
        5000,
        1200
      );
    `);
    raw.close();

    stateDb = StateDb.open(dbPath);

    expect(columnNames("thread_usage_lines")).toContain("provider");
    expect(columnNames("thread_usage_lines")).toContain("usage_turn_id");
    expect(columnNames("thread_pricing_summaries")).toContain("provider");
    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );

    const line = stateDb.raw
      .prepare(
        `SELECT provider, usage_turn_id
         FROM thread_usage_lines
         WHERE usage_line_id = 'line-1'`,
      )
      .get() as { provider: string; usage_turn_id: string };
    const turn = stateDb.raw
      .prepare(
        `SELECT provider, backend, thread_id, turn_id
         FROM thread_usage_turns
         WHERE usage_turn_id = ?`,
      )
      .get(line.usage_turn_id) as {
        provider: string;
        backend: string;
        thread_id: string;
        turn_id: string | null;
      };
    const summary = stateDb.raw
      .prepare(
        `SELECT provider, backend, thread_id, currency, total_cost_micros
         FROM thread_pricing_summaries`,
      )
      .get() as {
        provider: string;
        backend: string;
        thread_id: string;
        currency: string;
        total_cost_micros: number;
      };

    expect(line).toEqual({
      provider: "openai",
      usage_turn_id: "openai:codex:thread-1:turn-1",
    });
    expect(turn).toEqual({
      backend: "codex",
      provider: "openai",
      thread_id: "thread-1",
      turn_id: "turn-1",
    });
    expect(summary).toEqual({
      backend: "codex",
      currency: "USD",
      provider: "openai",
      thread_id: "thread-1",
      total_cost_micros: 5000,
    });
  });

  it("repairs live usage line timestamps that were overwritten by streaming updates", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "live-usage-created-at-repair-state.db");
    stateDb = StateDb.open(dbPath);
    stateDb.raw
      .prepare(
        `INSERT INTO thread_usage_lines (
          usage_line_id,
          usage_turn_id,
          provider,
          backend,
          thread_id,
          turn_id,
          source,
          source_item_id,
          scope,
          status,
          created_at,
          model,
          input_tokens,
          cached_input_tokens,
          uncached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          price_status,
          currency,
          uncached_input_cost_micros,
          cached_input_cost_micros,
          output_cost_micros,
          total_cost_micros,
          updated_at
        ) VALUES (
          'live-line-1',
          'openai:codex:thread-1:turn-1',
          'openai',
          'codex',
          'thread-1',
          'turn-1',
          'live',
          'thread-token-usage',
          'turn',
          'pending',
          2000,
          'gpt-5.5',
          1000,
          200,
          800,
          300,
          100,
          1300,
          'priced',
          'USD',
          900,
          100,
          4000,
          5000,
          2000
        )`,
      )
      .run();
    stateDb.raw
      .prepare(
        `INSERT INTO thread_usage_turns (
          usage_turn_id,
          provider,
          backend,
          thread_id,
          turn_id,
          model,
          settings_source,
          settings_confidence,
          observed_at,
          updated_at
        ) VALUES (
          'openai:codex:thread-1:turn-1',
          'openai',
          'codex',
          'thread-1',
          'turn-1',
          'gpt-5.5',
          'thread-overlay',
          'fallback',
          1000,
          2000
        )`,
      )
      .run();
    stateDb.raw.pragma("user_version = 19");
    stateDb.close();

    stateDb = StateDb.open(dbPath);

    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
    expect(
      (
        stateDb.raw
          .prepare(
            "SELECT created_at FROM thread_usage_lines WHERE usage_line_id = 'live-line-1'",
          )
          .get() as { created_at: number }
      ).created_at,
    ).toBe(1000);
  });

  it("repairs OpenAI usage pricing after embedded catalog date changes", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "usage-pricing-repair-state.db");
    stateDb = StateDb.open(dbPath);
    stateDb.raw
      .prepare(
        `INSERT INTO thread_usage_lines (
          usage_line_id,
          usage_turn_id,
          provider,
          backend,
          thread_id,
          turn_id,
          source,
          source_item_id,
          scope,
          status,
          created_at,
          completed_at,
          model,
          service_tier,
          fast_mode,
          input_tokens,
          cached_input_tokens,
          uncached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          price_status,
          price_unavailable_reason,
          currency,
          uncached_input_cost_micros,
          cached_input_cost_micros,
          output_cost_micros,
          total_cost_micros,
          updated_at
        ) VALUES (
          'live-line-june-15',
          'openai:codex:thread-1:turn-1',
          'openai',
          'codex',
          'thread-1',
          'turn-1',
          'live',
          'thread-token-usage',
          'turn',
          'pending',
          ?,
          ?,
          'gpt-5.5',
          NULL,
          0,
          80351,
          38272,
          42079,
          58,
          0,
          80409,
          'unpriced',
          'missing-rate',
          'USD',
          0,
          0,
          0,
          0,
          ?
        )`,
      )
      .run(
        Date.UTC(2026, 5, 15, 18, 40, 23),
        Date.UTC(2026, 5, 15, 18, 40, 23),
        Date.UTC(2026, 5, 15, 18, 40, 23),
      );
    stateDb.raw
      .prepare(
        `INSERT INTO thread_pricing_summaries (
          provider,
          backend,
          thread_id,
          currency,
          usage_line_count,
          priced_usage_line_count,
          unpriced_usage_line_count,
          input_tokens,
          cached_input_tokens,
          uncached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          total_cost_micros,
          updated_at
        ) VALUES (
          'openai',
          'codex',
          'thread-1',
          'USD',
          1,
          0,
          1,
          80351,
          38272,
          42079,
          58,
          0,
          80409,
          0,
          ?
        )`,
      )
      .run(Date.UTC(2026, 5, 15, 18, 40, 23));
    stateDb.raw.pragma("user_version = 21");
    stateDb.close();

    stateDb = StateDb.open(dbPath);

    const line = stateDb.raw
      .prepare(
        `SELECT price_status, price_unavailable_reason, pricing_rate_id, total_cost_micros
         FROM thread_usage_lines
         WHERE usage_line_id = 'live-line-june-15'`,
      )
      .get() as {
        price_status: string;
        price_unavailable_reason: string | null;
        pricing_rate_id: string | null;
        total_cost_micros: number;
      };
    const summary = stateDb.raw
      .prepare(
        `SELECT priced_usage_line_count, unpriced_usage_line_count, total_cost_micros
         FROM thread_pricing_summaries
         WHERE provider = 'openai'
           AND backend = 'codex'
           AND thread_id = 'thread-1'
           AND currency = 'USD'`,
      )
      .get() as {
        priced_usage_line_count: number;
        total_cost_micros: number;
        unpriced_usage_line_count: number;
      };

    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
    expect(line).toEqual({
      price_status: "priced",
      price_unavailable_reason: null,
      pricing_rate_id: "openai:2026-06-16:gpt-5.5:standard",
      total_cost_micros: 231_271,
    });
    expect(summary).toEqual({
      priced_usage_line_count: 1,
      total_cost_micros: 231_271,
      unpriced_usage_line_count: 0,
    });
  });

  it("migrates legacy Grok pricing without billing fork baselines", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "grok-pricing-provider-repair-state.db");
    stateDb = StateDb.open(dbPath);
    stateDb.raw
      .prepare(
        `INSERT INTO thread_usage_lines (
          usage_line_id,
          usage_turn_id,
          provider,
          backend,
          thread_id,
          turn_id,
          source,
          source_item_id,
          scope,
          status,
          created_at,
          completed_at,
          model,
          service_tier,
          fast_mode,
          input_tokens,
          cached_input_tokens,
          uncached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          price_status,
          price_unavailable_reason,
          currency,
          uncached_input_cost_micros,
          cached_input_cost_micros,
          output_cost_micros,
          total_cost_micros,
          updated_at
        ) VALUES (
          'live-line-grok-4-5',
          'openai:acp-grok:thread-1:turn-1',
          'openai',
          'acp:grok',
          'thread-1',
          'turn-1',
          'live',
          'thread-token-usage',
          'turn',
          'pending',
          ?,
          ?,
          'grok-4.5-build',
          NULL,
          0,
          21208,
          11136,
          10072,
          45,
          28,
          21253,
          'unpriced',
          'missing-rate',
          'USD',
          0,
          0,
          0,
          0,
          ?
        )`,
      )
      .run(
        Date.UTC(2026, 6, 26),
        Date.UTC(2026, 6, 26),
        Date.UTC(2026, 6, 26),
      );
    stateDb.raw
      .prepare(
        `INSERT INTO thread_usage_lines (
          usage_line_id,
          provider,
          backend,
          thread_id,
          parent_thread_id,
          source,
          scope,
          status,
          created_at,
          model,
          input_tokens,
          cached_input_tokens,
          uncached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          price_status,
          currency,
          uncached_input_cost_micros,
          cached_input_cost_micros,
          output_cost_micros,
          total_cost_micros,
          updated_at
        ) VALUES (
          'fork-baseline-grok-4-5',
          'openai',
          'acp:grok',
          'thread-fork',
          'thread-parent',
          'hydration',
          'fork-baseline',
          'finalized',
          ?,
          'grok-4.5-build',
          21208,
          11136,
          10072,
          45,
          28,
          21253,
          'priced',
          'USD',
          0,
          0,
          0,
          0,
          ?
        )`,
      )
      .run(Date.UTC(2026, 6, 26), Date.UTC(2026, 6, 26));
    stateDb.raw.pragma("user_version = 28");
    stateDb.close();

    stateDb = StateDb.open(dbPath);

    const line = stateDb.raw
      .prepare(
        `SELECT
           provider,
           price_status,
           price_unavailable_reason,
           pricing_catalog_id,
           pricing_catalog_version,
           pricing_rate_id,
           total_cost_micros
         FROM thread_usage_lines
         WHERE usage_line_id = 'live-line-grok-4-5'`,
      )
      .get();
    const forkBaseline = stateDb.raw
      .prepare(
        `SELECT
           provider,
           price_status,
           pricing_catalog_id,
           pricing_catalog_version,
           pricing_rate_id,
           uncached_input_cost_micros,
           cached_input_cost_micros,
           output_cost_micros,
           total_cost_micros
         FROM thread_usage_lines
         WHERE usage_line_id = 'fork-baseline-grok-4-5'`,
      )
      .get();
    const summary = stateDb.raw
      .prepare(
        `SELECT provider, priced_usage_line_count, total_cost_micros
         FROM thread_pricing_summaries
         WHERE backend = 'acp:grok'
           AND thread_id = 'thread-1'
           AND currency = 'USD'`,
      )
      .get();
    const forkSummary = stateDb.raw
      .prepare(
        `SELECT provider, priced_usage_line_count, total_cost_micros
         FROM thread_pricing_summaries
         WHERE backend = 'acp:grok'
           AND thread_id = 'thread-parent'
           AND currency = 'USD'`,
      )
      .get();

    expect(line).toEqual({
      provider: "xai",
      price_status: "priced",
      price_unavailable_reason: null,
      pricing_catalog_id: "xai-api",
      pricing_catalog_version: "2026-07-17",
      pricing_rate_id: "xai:2026-07-17:grok-4.5:standard",
      total_cost_micros: 23_755,
    });
    expect(forkBaseline).toEqual({
      provider: "openai",
      price_status: "priced",
      pricing_catalog_id: null,
      pricing_catalog_version: null,
      pricing_rate_id: null,
      uncached_input_cost_micros: 0,
      cached_input_cost_micros: 0,
      output_cost_micros: 0,
      total_cost_micros: 0,
    });
    expect(forkSummary).toEqual({
      provider: "openai",
      priced_usage_line_count: 1,
      total_cost_micros: 0,
    });
    expect(summary).toEqual({
      provider: "xai",
      priced_usage_line_count: 1,
      total_cost_micros: 23_755,
    });
  });

  it("reprices existing GPT-5.6 usage rows when the pricing catalog updates", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "gpt-5-6-pricing-repair-state.db");
    stateDb = StateDb.open(dbPath);
    stateDb.raw
      .prepare(
        `INSERT INTO thread_usage_lines (
          usage_line_id,
          provider,
          backend,
          thread_id,
          source,
          scope,
          status,
          created_at,
          model,
          input_tokens,
          cached_input_tokens,
          uncached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          price_status,
          price_unavailable_reason,
          currency,
          uncached_input_cost_micros,
          cached_input_cost_micros,
          output_cost_micros,
          total_cost_micros,
          updated_at
        ) VALUES (
          'live-line-gpt-5-6-terra',
          'openai',
          'codex',
          'thread-gpt-5-6',
          'live',
          'turn',
          'pending',
          ?,
          'gpt-5.6-terra',
          26291,
          0,
          26291,
          15,
          0,
          26306,
          'unpriced',
          'missing-rate',
          'USD',
          0,
          0,
          0,
          0,
          ?
        )`,
      )
      .run(
        Date.UTC(2026, 6, 12, 22, 50, 30),
        Date.UTC(2026, 6, 12, 22, 50, 30),
      );
    stateDb.raw.pragma("user_version = 26");
    stateDb.close();

    stateDb = StateDb.open(dbPath);

    const line = stateDb.raw
      .prepare(
        `SELECT price_status, price_unavailable_reason, pricing_rate_id, total_cost_micros
         FROM thread_usage_lines
         WHERE usage_line_id = 'live-line-gpt-5-6-terra'`,
      )
      .get() as {
        price_status: string;
        price_unavailable_reason: string | null;
        pricing_rate_id: string | null;
        total_cost_micros: number;
      };
    const summary = stateDb.raw
      .prepare(
        `SELECT priced_usage_line_count, unpriced_usage_line_count, total_cost_micros
         FROM thread_pricing_summaries
         WHERE provider = 'openai'
           AND backend = 'codex'
           AND thread_id = 'thread-gpt-5-6'
           AND currency = 'USD'`,
      )
      .get() as {
        priced_usage_line_count: number;
        total_cost_micros: number;
        unpriced_usage_line_count: number;
      };

    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
    expect(line).toEqual({
      price_status: "priced",
      price_unavailable_reason: null,
      pricing_rate_id: "openai:2026-07-09:gpt-5.6-terra:standard",
      total_cost_micros: 65_953,
    });
    expect(summary).toEqual({
      priced_usage_line_count: 1,
      total_cost_micros: 65_953,
      unpriced_usage_line_count: 0,
    });
  });

  it("rebuilds pricing summaries for parented usage lines only on the parent thread", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "parented-usage-pricing-repair-state.db");
    stateDb = StateDb.open(dbPath);
    stateDb.raw
      .prepare(
        `INSERT INTO thread_usage_lines (
          usage_line_id,
          usage_turn_id,
          provider,
          backend,
          thread_id,
          parent_thread_id,
          turn_id,
          source,
          source_item_id,
          scope,
          status,
          created_at,
          completed_at,
          model,
          service_tier,
          fast_mode,
          input_tokens,
          cached_input_tokens,
          uncached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          price_status,
          price_unavailable_reason,
          currency,
          uncached_input_cost_micros,
          cached_input_cost_micros,
          output_cost_micros,
          total_cost_micros,
          updated_at
        ) VALUES (
          'monitor-line-june-15',
          'openai:codex:monitor-thread-1:turn-1',
          'openai',
          'codex',
          'monitor-thread-1',
          'parent-thread-1',
          'turn-1',
          'monitor',
          'thread-token-usage',
          'monitor',
          'pending',
          ?,
          ?,
          'gpt-5.5',
          NULL,
          0,
          80351,
          38272,
          42079,
          58,
          0,
          80409,
          'unpriced',
          'missing-rate',
          'USD',
          0,
          0,
          0,
          0,
          ?
        )`,
      )
      .run(
        Date.UTC(2026, 5, 15, 18, 40, 23),
        Date.UTC(2026, 5, 15, 18, 40, 23),
        Date.UTC(2026, 5, 15, 18, 40, 23),
      );
    stateDb.raw.pragma("user_version = 21");
    stateDb.close();

    stateDb = StateDb.open(dbPath);

    const summaries = stateDb.raw
      .prepare(
        `SELECT thread_id, priced_usage_line_count, total_cost_micros
         FROM thread_pricing_summaries
         WHERE provider = 'openai'
           AND backend = 'codex'
           AND currency = 'USD'
         ORDER BY thread_id`,
      )
      .all() as Array<{
        priced_usage_line_count: number;
        thread_id: string;
        total_cost_micros: number;
      }>;

    expect(summaries).toEqual([
      {
        priced_usage_line_count: 1,
        thread_id: "parent-thread-1",
        total_cost_micros: 231_271,
      },
    ]);
  });

  it("repairs databases that used version 13 for the old PR cache migration", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "legacy-pr-cache-state.db");
    const raw = openRawDb(dbPath);
    raw.exec(`
      PRAGMA user_version = 13;
      CREATE TABLE pr_status_cache (
        pr_key     TEXT PRIMARY KEY,
        org        TEXT NOT NULL,
        repo       TEXT NOT NULL,
        number     INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        payload    TEXT NOT NULL
      );
    `);
    raw.close();

    stateDb = StateDb.open(dbPath);

    expect(existingTables()).toEqual([
      "pr_lookup_cache",
      "pr_status_cache",
      "thread_search_documents",
      "thread_search_fts",
    ]);
    expect(columnNames("pr_status_cache")).toContain("provider");
    expect(columnNames("pr_lookup_cache")).toContain("provider");
    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
  });

  it("repairs version 13 databases that only have thread search", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "legacy-thread-search-state.db");
    const raw = openRawDb(dbPath);
    raw.exec(`
      PRAGMA user_version = 13;
      CREATE TABLE thread_search_documents (
        identity_key            TEXT PRIMARY KEY,
        backend                 TEXT NOT NULL,
        thread_id               TEXT NOT NULL,
        title                   TEXT NOT NULL,
        title_source            TEXT,
        summary                 TEXT,
        project_key             TEXT,
        created_at              INTEGER,
        updated_at              INTEGER,
        archived_at             INTEGER,
        git_branch              TEXT,
        git_origin_url          TEXT,
        model                   TEXT,
        linked_directories_json TEXT NOT NULL,
        display_json            TEXT NOT NULL,
        indexed_at              INTEGER NOT NULL
      );
      CREATE INDEX idx_thread_search_documents_backend_updated
        ON thread_search_documents(backend, updated_at DESC);
      CREATE INDEX idx_thread_search_documents_project_updated
        ON thread_search_documents(project_key, updated_at DESC);
      CREATE INDEX idx_thread_search_documents_archived
        ON thread_search_documents(archived_at);
      CREATE VIRTUAL TABLE thread_search_fts USING fts5(
        identity_key UNINDEXED,
        title,
        summary,
        project_key,
        directory_labels,
        directory_paths,
        git_branch,
        git_origin_url,
        model,
        backend,
        tokenize = "unicode61 remove_diacritics 2 tokenchars '-_./:'"
      );
    `);
    raw.close();

    stateDb = StateDb.open(dbPath);

    expect(existingTables()).toEqual([
      "pr_lookup_cache",
      "pr_status_cache",
      "thread_search_documents",
      "thread_search_fts",
    ]);
    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
  });

  it("migrates thread search FTS rows to include thread ids", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "legacy-thread-search-fts-state.db");
    createLegacyThreadSearchFtsDb(dbPath, 22);

    stateDb = StateDb.open(dbPath);

    expect(columnNames("thread_search_fts")).toContain("thread_id");
    expect(
      new ThreadSearchStore(stateDb)
        .search({ query: "7f2f4bd1-8e7b-4d3b-92e5", limit: 10 })
        .map((result) => result.threadId),
    ).toEqual(["7f2f4bd1-8e7b-4d3b-92e5-0e9ef15c9c84"]);
    expect(
      new ThreadSearchStore(stateDb)
        .search({ query: "e31f5e66", limit: 10 })
        .map((result) => result.threadId),
    ).toEqual(["session_e31f5e66-7410-4235-aa19-3bbb63ee8c3d"]);
  });

  it("repairs stale thread search FTS tables even at current user_version", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "current-version-stale-thread-search-fts.db");
    createLegacyThreadSearchFtsDb(dbPath, CURRENT_STATE_DB_USER_VERSION);

    stateDb = StateDb.open(dbPath);

    expect(columnNames("thread_search_fts")).toContain("thread_id");
    expect(
      new ThreadSearchStore(stateDb)
        .search({ query: "7f2f4bd1-8e7b-4d3b-92e5", limit: 10 })
        .map((result) => result.threadId),
    ).toEqual(["7f2f4bd1-8e7b-4d3b-92e5-0e9ef15c9c84"]);
  });

  it("repairs stale thread search FTS tables without downgrading newer versions", () => {
    stateDb.close();

    const dbPath = path.join(tempDir, "newer-version-thread-search-fts.db");
    const newerVersion = CURRENT_STATE_DB_USER_VERSION + 1;
    createLegacyThreadSearchFtsDb(dbPath, newerVersion);

    stateDb = StateDb.open(dbPath);

    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      newerVersion,
    );
    expect(columnNames("thread_search_fts")).toContain("thread_id");
  });
});

function createLegacyThreadSearchFtsDb(
  dbPath: string,
  userVersion: number,
): void {
  const raw = openRawDb(dbPath);
  raw.exec(`
      PRAGMA user_version = 22;
      CREATE TABLE thread_search_documents (
        identity_key            TEXT PRIMARY KEY,
        backend                 TEXT NOT NULL,
        thread_id               TEXT NOT NULL,
        title                   TEXT NOT NULL,
        title_source            TEXT,
        summary                 TEXT,
        project_key             TEXT,
        created_at              INTEGER,
        updated_at              INTEGER,
        archived_at             INTEGER,
        git_branch              TEXT,
        git_origin_url          TEXT,
        model                   TEXT,
        linked_directories_json TEXT NOT NULL,
        display_json            TEXT NOT NULL,
        indexed_at              INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE thread_search_fts USING fts5(
        identity_key UNINDEXED,
        title,
        summary,
        project_key,
        directory_labels,
        directory_paths,
        git_branch,
        git_origin_url,
        model,
        backend,
        tokenize = "unicode61 remove_diacritics 2 tokenchars '-_./:'"
      );
      INSERT INTO thread_search_documents (
        identity_key, backend, thread_id, title, title_source, summary,
        project_key, created_at, updated_at, archived_at, git_branch,
        git_origin_url, model, linked_directories_json, display_json, indexed_at
      ) VALUES (
        'codex:7f2f4bd1-8e7b-4d3b-92e5-0e9ef15c9c84',
        'codex',
        '7f2f4bd1-8e7b-4d3b-92e5-0e9ef15c9c84',
        'Release notes',
        'derived',
        'Prepared release copy',
        'PwrAgent',
        1000,
        1000,
        NULL,
        'feat/release',
        NULL,
        'gpt-5.5',
        '[{"id":"dir-1","label":"PwrAgent","path":"/repo/PwrAgent","kind":"local"}]',
        '{}',
        1000
      ), (
        'codex:session_e31f5e66-7410-4235-aa19-3bbb63ee8c3d',
        'codex',
        'session_e31f5e66-7410-4235-aa19-3bbb63ee8c3d',
        'Kimi session',
        'derived',
        'Prepared release copy',
        'PwrAgent',
        1000,
        1000,
        NULL,
        'feat/release',
        NULL,
        'gpt-5.5',
        '[{"id":"dir-1","label":"PwrAgent","path":"/repo/PwrAgent","kind":"local"}]',
        '{}',
        1000
      );
    `);
  raw.pragma(`user_version = ${userVersion}`);
  raw.close();
}

function openRawDb(dbPath: string): BetterSqlite3.Database {
  const nativeBinding = getNativeBinding();
  return new Database(dbPath, nativeBinding ? { nativeBinding } : {});
}

function existingTables(): string[] {
  const rows = stateDb.raw
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?) ORDER BY name`,
    )
    .all(
      "pr_lookup_cache",
      "pr_status_cache",
      "thread_search_documents",
      "thread_search_fts",
    ) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function columnNames(
  tableName:
    | "pr_lookup_cache"
    | "pr_status_cache"
    | "thread_pricing_summaries"
    | "thread_search_fts"
    | "thread_usage_lines",
): string[] {
  const rows = readTableInfo(tableName);
  return rows.map((row) => row.name);
}

function indexNames(
  tableName: "thread_tool_invocations" | "thread_usage_lines",
): string[] {
  return (
    stateDb.raw.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{
      name: string;
    }>
  )
    .map((row) => row.name)
    .sort();
}

function queryPlanDetails(sql: string, params: unknown[]): string {
  return (
    stateDb.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      detail: string;
    }>
  )
    .map((row) => row.detail)
    .join("\n");
}

function readTableInfo(
  tableName:
    | "pr_lookup_cache"
    | "pr_status_cache"
    | "thread_pricing_summaries"
    | "thread_search_fts"
    | "thread_usage_lines",
): Array<{ name: string }> {
  switch (tableName) {
    case "pr_lookup_cache":
      return stateDb.raw.prepare("PRAGMA table_info(pr_lookup_cache)").all() as Array<{
        name: string;
      }>;
    case "pr_status_cache":
      return stateDb.raw.prepare("PRAGMA table_info(pr_status_cache)").all() as Array<{
        name: string;
      }>;
    case "thread_pricing_summaries":
      return stateDb.raw
        .prepare("PRAGMA table_info(thread_pricing_summaries)")
        .all() as Array<{ name: string }>;
    case "thread_search_fts":
      return stateDb.raw
        .prepare("PRAGMA table_info(thread_search_fts)")
        .all() as Array<{ name: string }>;
    case "thread_usage_lines":
      return stateDb.raw
        .prepare("PRAGMA table_info(thread_usage_lines)")
        .all() as Array<{ name: string }>;
  }
}
