import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { PWRAGENT_HOME_ENV, PWRAGENT_PROFILE_ENV } from "../profile";
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
    if (outcome.status !== "fresh-install")
      throw new Error("expected fresh install");
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
