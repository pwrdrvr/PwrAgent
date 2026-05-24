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
