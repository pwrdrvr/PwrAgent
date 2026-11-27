import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_STATE_DB_USER_VERSION,
  SQLITE_AUTO_VACUUM_INCREMENTAL,
  StateDb,
} from "../state/state-db";
import { AutomationStore } from "../storage/automation-store";
import { createTempStateDb, openInMemoryStateDb } from "./sqlite-test-utils";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-migration-"));
  tempRoots.push(root);
  return root;
}

function createTempDbPath(): string {
  const { dbPath, tempDir } = createTempStateDb("pwragent-migration-");
  tempRoots.push(tempDir);
  return dbPath;
}

function readAutoVacuum(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.pragma("auto_vacuum", { simple: true }) as number;
  } finally {
    db.close();
  }
}

function readProfileName(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'profile_name'")
      .get() as { value: string };
    return row.value;
  } finally {
    db.close();
  }
}

describe("state migration", () => {
  it("initializes automation scheduling tables in the profile database", () => {
    const stateDb = openInMemoryStateDb();
    try {
      expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
        CURRENT_STATE_DB_USER_VERSION,
      );
      expect(
        stateDb.raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('automations', 'automation_runs') ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: "automation_runs" }, { name: "automations" }]);
    } finally {
      stateDb.close();
    }
  });

  it("installs the turn lookup index once on an existing automation history", () => {
    const dbPath = createTempDbPath();
    const initial = StateDb.open(dbPath);
    const readRows = (db: StateDb) => db.raw.prepare("SELECT rowid, * FROM automation_runs ORDER BY rowid").all();
    const schemaVersion = (db: StateDb) => db.raw.pragma("schema_version", { simple: true }) as number;
    let rows: unknown[];
    let before: number;
    try {
      const store = new AutomationStore(initial);
      store.createAutomation({
        id: "migration-automation",
        backend: "codex",
        threadId: "migration-thread",
        name: "Migration fixture",
        taskPrompt: "Check.",
        schedule: { kind: "interval", every: 5, unit: "minutes" },
        now: 0,
      });
      store.createRun({ id: "migration-run", automationId: "migration-automation", trigger: "manual", now: 0 });
      store.markRunStarted({ runId: "migration-run", backendTurnId: "migration-turn", now: 1 });
      store.markRunTerminal({ runId: "migration-run", status: "completed", now: 2 });
      initial.raw.exec("DROP INDEX idx_automation_runs_backend_turn");
      rows = readRows(initial);
      expect(rows).toHaveLength(1);
      before = schemaVersion(initial);
    } finally {
      initial.close();
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reopened = StateDb.open(dbPath);
      try {
        expect(schemaVersion(reopened)).toBe(before + 1);
        expect(reopened.raw.pragma("user_version", { simple: true })).toBe(CURRENT_STATE_DB_USER_VERSION);
        expect(readRows(reopened)).toEqual(rows);
        expect(new AutomationStore(reopened).findRunByBackendTurnId({
          backend: "codex",
          backendTurnId: "migration-turn",
        })).toMatchObject({ id: "migration-run", status: "completed" });
      } finally {
        reopened.close();
      }
    }
  });

  it("upgrades an existing database that predates the source_event_key column", () => {
    const dbPath = createTempDbPath();
    // Build a current DB, then roll it back to look like a pre-v23 database
    // without the source_event_key column/index.
    StateDb.open(dbPath).close();
    const raw = new Database(dbPath);
    raw.exec("DROP INDEX IF EXISTS idx_automation_runs_source_event");
    raw.exec("ALTER TABLE automation_runs DROP COLUMN source_event_key");
    raw.pragma("user_version = 22");
    raw.close();

    // Reopening must migrate cleanly. Regression: ensureCurrentSchema runs
    // before migrations, so an index in the schema string referencing the
    // not-yet-added column threw "no such column: source_event_key" on boot.
    const stateDb = StateDb.open(dbPath);
    try {
      expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
        CURRENT_STATE_DB_USER_VERSION,
      );
      const columns = stateDb.raw
        .prepare("PRAGMA table_info(automation_runs)")
        .all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "source_event_key")).toBe(
        true,
      );
      const indexes = stateDb.raw
        .prepare("PRAGMA index_list(automation_runs)")
        .all() as Array<{ name: string }>;
      expect(
        indexes.some(
          (index) => index.name === "idx_automation_runs_source_event",
        ),
      ).toBe(true);
    } finally {
      stateDb.close();
    }
  });

  it("replaces the v30 turn-keyed message origin table", () => {
    const dbPath = createTempDbPath();
    StateDb.open(dbPath).close();
    const raw = new Database(dbPath);
    raw.exec(`
DROP INDEX idx_thread_message_origins_thread;
DROP TABLE thread_message_origins;
CREATE TABLE thread_message_origins (
  backend     TEXT NOT NULL,
  thread_id   TEXT NOT NULL,
  turn_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  payload     TEXT NOT NULL,
  PRIMARY KEY (backend, thread_id, turn_id)
);
CREATE INDEX idx_thread_message_origins_thread
  ON thread_message_origins(backend, thread_id, created_at, turn_id);
INSERT INTO thread_message_origins
VALUES ('codex', 'thread-1', 'turn-1', 1000, '{"kind":"messaging"}');
`);
    raw.pragma("user_version = 30");
    raw.close();

    const stateDb = StateDb.open(dbPath);
    try {
      const columns = stateDb.raw
        .prepare("PRAGMA table_info(thread_message_origins)")
        .all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("message_id");
      expect(columns.map((column) => column.name)).not.toContain("turn_id");
      expect(
        stateDb.raw
          .prepare("SELECT COUNT(*) AS count FROM thread_message_origins")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      stateDb.close();
    }
  });

  it("adds default Agent assignments after the current-main v32 schema", () => {
    const dbPath = createTempDbPath();
    StateDb.open(dbPath).close();
    const raw = new Database(dbPath);
    raw.exec("DROP TABLE messaging_default_agent_assignments");
    raw.pragma("user_version = 32");
    raw.close();

    const stateDb = StateDb.open(dbPath);
    try {
      expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
        CURRENT_STATE_DB_USER_VERSION,
      );
      const indexes = stateDb.raw
        .prepare("PRAGMA index_list(messaging_default_agent_assignments)")
        .all() as Array<{ name: string; unique: number }>;
      expect(indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "idx_messaging_default_agent_assignments_active_scope",
          unique: 1,
        }),
      ]));
    } finally {
      stateDb.close();
    }
  });

  it("runs both v54 and v55 migrations when upgrading a v53 database", () => {
    const dbPath = createTempDbPath();
    StateDb.open(dbPath).close();
    const raw = new Database(dbPath);
    try {
      raw.exec(`
        DROP TABLE thread_compactions;
        DROP INDEX idx_thread_usage_turns_navigation_context;
        DROP INDEX idx_thread_usage_turns_acp_context;
        DROP INDEX idx_thread_usage_turns_pending_acp_compaction;
        ALTER TABLE thread_usage_turns DROP COLUMN acp_compaction_before_tokens;
        ALTER TABLE thread_usage_turns DROP COLUMN final_context_tokens;
        ALTER TABLE thread_usage_turns DROP COLUMN peak_context_tokens;
        ALTER TABLE thread_usage_turns DROP COLUMN model_context_window;
      `);
      raw.pragma("user_version = 53");
    } finally {
      raw.close();
    }

    const stateDb = StateDb.open(dbPath);
    try {
      expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
        CURRENT_STATE_DB_USER_VERSION,
      );
      expect(
        stateDb.raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_compactions'",
          )
          .get(),
      ).toEqual({ name: "thread_compactions" });
      const usageColumns = stateDb.raw
        .prepare("PRAGMA table_info(thread_usage_turns)")
        .all() as Array<{ name: string }>;
      expect(usageColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          "final_context_tokens",
          "peak_context_tokens",
          "model_context_window",
          "acp_compaction_before_tokens",
        ]),
      );
      const usageIndexes = stateDb.raw
        .prepare("PRAGMA index_list(thread_usage_turns)")
        .all() as Array<{ name: string }>;
      expect(usageIndexes.map((index) => index.name)).toEqual(
        expect.arrayContaining([
          "idx_thread_usage_turns_navigation_context",
          "idx_thread_usage_turns_acp_context",
          "idx_thread_usage_turns_pending_acp_compaction",
        ]),
      );
    } finally {
      stateDb.close();
    }
  });

  it("records the profile name in a newly created profile database", () => {
    const root = createTempRoot();
    const dbPath = path.join(root, "profiles", "dev", "state", "state.db");

    const stateDb = StateDb.open(dbPath, { profileName: "dev" });
    stateDb.close();

    expect(readProfileName(dbPath)).toBe("dev");
  });

  it("leaves a new database with incremental auto-vacuum", () => {
    const root = createTempRoot();
    const dbPath = path.join(root, "profiles", "default", "state", "state.db");

    const stateDb = StateDb.open(dbPath, { profileName: "default" });
    stateDb.close();

    expect(readAutoVacuum(dbPath)).toBe(SQLITE_AUTO_VACUUM_INCREMENTAL);
  });
});
