import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
