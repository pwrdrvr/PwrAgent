import { readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "../state/state-db";
import {
  createTempStateDb,
  openFreshStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

// Guards `test-setup/state-db-template.ts`. A copy has to be the database a
// fresh open would have written, or every suite that opens a new file tests
// something production never creates.

let tempDir: string;

beforeEach(() => {
  tempDir = createTempStateDb("pwragent-state-db-template-").tempDir;
});

afterEach(() => {
  removeTempStateDbDir(tempDir);
});

function describeDatabase(db: StateDb): unknown {
  return {
    autoVacuum: db.raw.pragma("auto_vacuum", { simple: true }),
    journalMode: db.raw.pragma("journal_mode", { simple: true }),
    meta: db.raw.prepare("SELECT key, value FROM meta ORDER BY key").all(),
    schema: db.raw
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
      )
      .all(),
    userVersion: db.raw.pragma("user_version", { simple: true }),
  };
}

describe("desktop-main StateDb template", () => {
  it("is installed for this project", () => {
    const templateDir = process.env.PWRAGENT_TEST_STATE_DB_TEMPLATE_DIR;
    expect(templateDir).toBeTruthy();

    StateDb.open(path.join(tempDir, "served.db")).close();

    expect(readdirSync(templateDir!)).toContain("state.db");
  });

  it.each([undefined, "work"])(
    "serves the database a fresh open writes (profile %s)",
    (profileName) => {
      const options = profileName ? { profileName } : undefined;
      const fresh = openFreshStateDb(path.join(tempDir, "fresh.db"), options);
      const served = StateDb.open(path.join(tempDir, "served.db"), options);
      try {
        expect(served.raw.pragma("user_version", { simple: true })).toBe(
          CURRENT_STATE_DB_USER_VERSION,
        );
        expect(describeDatabase(served)).toEqual(describeDatabase(fresh));
      } finally {
        fresh.close();
        served.close();
      }
    },
  );
});
