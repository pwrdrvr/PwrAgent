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

function columnNames(tableName: "pr_lookup_cache" | "pr_status_cache"): string[] {
  const rows = readTableInfo(tableName);
  return rows.map((row) => row.name);
}

function readTableInfo(
  tableName: "pr_lookup_cache" | "pr_status_cache",
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
  }
}
