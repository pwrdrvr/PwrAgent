import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getNativeBinding } from "../state/native-binding";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "../state/state-db";

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
});

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
    | "thread_usage_lines",
): string[] {
  const rows = readTableInfo(tableName);
  return rows.map((row) => row.name);
}

function readTableInfo(
  tableName:
    | "pr_lookup_cache"
    | "pr_status_cache"
    | "thread_pricing_summaries"
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
    case "thread_usage_lines":
      return stateDb.raw
        .prepare("PRAGMA table_info(thread_usage_lines)")
        .all() as Array<{ name: string }>;
  }
}
