import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  PWRAGENT_HOME_ENV,
  PWRAGENT_PROFILE_ENV,
} from "../profile";
import { migrateIfNeeded } from "../state/migration";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "../state/state-db";

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

function writeLegacyConfig(root: string): string {
  const configPath = path.join(root, "xdg-config", "pwragnt", "config.toml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    [
      "[messaging]",
      "enabled = true",
      "",
      "[messaging.discord]",
      "enabled = true",
      'application_id = "1480556454498009352"',
      "",
    ].join("\n"),
    "utf8",
  );
  return configPath;
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
    const root = createTempRoot();
    const dbPath = path.join(root, "state.db");
    const stateDb = StateDb.open(dbPath);
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

  it("upgrades an existing database that predates the source_event_key column", () => {
    const root = createTempRoot();
    const dbPath = path.join(root, "state.db");
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
    const root = createTempRoot();
    const dbPath = path.join(root, "state.db");
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

  it("adds default Agent assignments after the current-main v31 schema", () => {
    const root = createTempRoot();
    const dbPath = path.join(root, "state.db");
    StateDb.open(dbPath).close();
    const raw = new Database(dbPath);
    raw.exec("DROP TABLE messaging_default_agent_assignments");
    raw.pragma("user_version = 31");
    raw.close();

    const stateDb = StateDb.open(dbPath);
    try {
      expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(32);
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

  it("does not copy legacy default settings into a new named profile", () => {
    const root = createTempRoot();
    const pwragentHome = path.join(root, "pwragent");
    writeLegacyConfig(root);

    const outcome = migrateIfNeeded({
      env: {
        [PWRAGENT_HOME_ENV]: pwragentHome,
        [PWRAGENT_PROFILE_ENV]: "dev",
      } as NodeJS.ProcessEnv,
      xdgConfigHome: path.join(root, "xdg-config"),
      xdgStateHome: path.join(root, "xdg-state"),
    });

    const devConfigPath = path.join(
      pwragentHome,
      "profiles",
      "dev",
      "config.toml",
    );

    expect(outcome.status).toBe("fresh-install");
    if (outcome.status !== "fresh-install") throw new Error("expected fresh install");
    expect(fs.existsSync(devConfigPath)).toBe(false);
    expect(readProfileName(outcome.dbPath)).toBe("dev");
  });

  it("still migrates legacy settings into the default profile", () => {
    const root = createTempRoot();
    const pwragentHome = path.join(root, "pwragent");
    const legacyConfigPath = writeLegacyConfig(root);

    const outcome = migrateIfNeeded({
      env: {
        [PWRAGENT_HOME_ENV]: pwragentHome,
      } as NodeJS.ProcessEnv,
      xdgConfigHome: path.join(root, "xdg-config"),
      xdgStateHome: path.join(root, "xdg-state"),
    });

    const defaultConfigPath = path.join(
      pwragentHome,
      "profiles",
      "default",
      "config.toml",
    );

    expect(outcome.status).toBe("migrated");
    if (outcome.status !== "migrated") throw new Error("expected migration");
    expect(fs.readFileSync(defaultConfigPath, "utf8")).toBe(
      fs.readFileSync(legacyConfigPath, "utf8"),
    );
    expect(readProfileName(outcome.dbPath)).toBe("default");
  });
});
