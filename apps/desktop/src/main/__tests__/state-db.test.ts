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
  it("creates ACP registry, installed-agent, and session tables", () => {
    const tables = stateDb.raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?) ORDER BY name`,
      )
      .all("acp_installed_agents", "acp_registry_cache", "acp_sessions") as Array<{
      name: string;
    }>;

    expect(tables.map((table) => table.name)).toEqual([
      "acp_installed_agents",
      "acp_registry_cache",
      "acp_sessions",
    ]);
    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
  });
});
