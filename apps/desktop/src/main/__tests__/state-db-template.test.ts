import Database from "better-sqlite3";
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
    // Per-connection settings `StateDb.open` applies; a served image must
    // still get them.
    busyTimeout: db.raw.pragma("busy_timeout", { simple: true }),
    foreignKeys: db.raw.pragma("foreign_keys", { simple: true }),
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
    // The patch keeps the real open on the class. Without it, `served` below
    // would be a fresh database and every assertion here would hold anyway.
    expect(
      (StateDb as unknown as Record<symbol, unknown>)[
        Symbol.for("pwragent.test.stateDbOriginalOpen")
      ],
    ).toBeTypeOf("function");

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

  it.each([undefined, "work"])(
    "serves the in-memory database a fresh open builds (profile %s)",
    (profileName) => {
      const options = profileName ? { profileName } : undefined;
      const fresh = openFreshStateDb(":memory:", options);
      const served = StateDb.open(":memory:", options);
      try {
        expect(readdirSync(process.env.PWRAGENT_TEST_STATE_DB_TEMPLATE_DIR!))
          .toContain(profileName ? "memory-776f726b.db" : "memory.db");
        expect(served.raw.memory).toBe(true);
        expect(served.raw.name).toBe(":memory:");
        expect(describeDatabase(served)).toEqual(describeDatabase(fresh));
      } finally {
        fresh.close();
        served.close();
      }
    },
  );

  it("gives each in-memory open its own database", () => {
    const first = StateDb.open(":memory:");
    let second: StateDb | undefined;
    try {
      first.raw.prepare("INSERT INTO meta(key, value) VALUES ('probe', '1')").run();
      // Opened after the write, so a write that reached the shared image
      // would show here.
      second = StateDb.open(":memory:");
      expect(
        second.raw.prepare("SELECT value FROM meta WHERE key = 'probe'").get(),
      ).toBeUndefined();
    } finally {
      first.close();
      second?.close();
    }
  });

  it("leaves a raw in-memory database empty", () => {
    StateDb.open(":memory:").close();
    const raw = new Database(":memory:");
    try {
      expect(
        raw.prepare("SELECT count(*) AS n FROM sqlite_master").get(),
      ).toEqual({ n: 0 });
    } finally {
      raw.close();
    }
  });
});
