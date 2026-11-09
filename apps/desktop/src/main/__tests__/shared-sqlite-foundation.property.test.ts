import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateDb as SharedStateDb } from "@pwragent/sqlite-storage/state-db";
import { StateDb as DesktopStateDb } from "../storage/state-db";
import { StateDb, CURRENT_STATE_DB_USER_VERSION } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, openFreshStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const oraclePath = path.join(import.meta.dirname, "fixtures/shared-sqlite-schema-oracle.json");
const hosts = [DesktopStateDb, SharedStateDb, StateDb];

function schema(db: StateDb, beforeOwnerJobs = false): { sha256: string; objects: number; userVersion: number } {
  const rows = db.raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all() as Array<{ tbl_name: string }>;
  const compared = beforeOwnerJobs ? rows.filter(row => row.tbl_name !== "owner_jobs") : rows;
  return {
    sha256: createHash("sha256").update(JSON.stringify(compared)).digest("hex"),
    objects: compared.length,
    userVersion: beforeOwnerJobs ? 80 : db.raw.pragma("user_version", { simple: true }) as number,
  };
}

function schemaDefinition(db: StateDb): unknown {
  const objects = db.raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  return {
    // ALTER TABLE may append a missing column in a different physical order.
    // Column names, types, defaults and constraints must still agree, as must
    // every index, trigger and view. Fresh creation separately pins exact SQL.
    objects: objects.map(row => ({ ...row, sql: row.type === "table" ? null : row.sql })),
    tables: objects.filter(row => row.type === "table").map(row => ({
      name: row.name,
      columns: db.raw.prepare('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY name').all(row.name),
    })),
    userVersion: db.raw.pragma("user_version", { simple: true }),
  };
}

afterEach(() => vi.unstubAllEnvs());

it("retains the exact pre-extraction SQLite schema beneath the additive owner-job migration", () => {
  const db = openFreshStateDb(":memory:");
  try {
    const actual = schema(db, true);
    expect(db.raw.pragma("user_version", { simple: true })).toBe(81);
    if (process.env.UPDATE_SHARED_SQLITE_SCHEMA_ORACLE === "1") {
      writeFileSync(oraclePath, JSON.stringify(actual, null, 2) + "\n");
    }
    expect(actual).toEqual(JSON.parse(readFileSync(oraclePath, "utf8")));
  } finally { db.close(); }
});

it("binds desktop adapters and state compatibility exports to one portable implementation", () => {
  expect(DesktopStateDb).toBe(SharedStateDb);
  expect(StateDb).toBe(SharedStateDb);
  expect(CURRENT_STATE_DB_USER_VERSION).toBe(81);
});

// These are old profile shapes already supported by the versioned ladder.
// SQLite's schema, rather than a list of expected columns, is the oracle.
const upgrades = [
  { version: 70, sql: "ALTER TABLE thread_usage_lines DROP COLUMN account_key" },
  { version: 72, sql: "ALTER TABLE thread_todos DROP COLUMN items_json" },
  { version: 73, sql: "DROP TABLE durable_turn_requests" },
  { version: 74, sql: "DROP TABLE thread_reviews" },
  { version: 76, sql: "DROP TABLE thread_dependencies" },
  { version: 77, sql: "DROP INDEX idx_thread_todos_dependency; ALTER TABLE thread_todos DROP COLUMN dependency_id" },
  { version: 80, sql: "DROP TABLE durable_turn_requests; DROP TABLE thread_reviews; DROP TABLE owner_jobs" },
] as const;

describe.each(upgrades)("shared profile upgrade from v$version: $sql", ({ version, sql }) => {
  it("converges through arbitrary desktop/portable reopen order without losing metadata or adding steady-state writes", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    await fc.assert(fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: hosts.length - 1 }), { minLength: 2, maxLength: 5 }),
      fc.record({ title: fc.string(), pinnedRank: fc.string(), seenAt: fc.nat(),
        parent: fc.record({ backend: fc.constantFrom("codex", "claude"), threadId: fc.string() }) }),
      async (openers, metadata) => {
        const { dbPath, tempDir } = createTempStateDb("shared-sqlite-upgrade-");
        let db: StateDb | undefined;
        try {
          db = openFreshStateDb(dbPath, { profileName: "fixture" });
          const initialSchema = schemaDefinition(db);
          const payload = JSON.stringify(metadata);
          db.raw.prepare("INSERT INTO threads(thread_id, last_seen_at, payload) VALUES (?, ?, ?)")
            .run("fixture-thread", metadata.seenAt, payload);
          db.setSecret("fixture", Buffer.from(metadata.title));
          db.raw.exec(sql);
          db.raw.pragma(`user_version = ${version}`);
          db.close(); db = undefined;
          for (const [index, opener] of openers.entries()) {
            const reopened = await measureSqliteWrites(() => hosts[opener]!.open(dbPath));
            db = reopened.result;
            if (index > 0) expect(reopened.writes.commits).toBe(0);
            const reads = await measureSqliteWrites(() => {
              expect(schemaDefinition(db!)).toEqual(initialSchema);
              expect(db!.getMeta("profile_name")).toBe("fixture");
              expect(db!.getSecret("fixture")).toEqual(Buffer.from(metadata.title));
              expect(db!.raw.prepare("SELECT payload, last_seen_at FROM threads WHERE thread_id = ?").get("fixture-thread"))
                .toEqual({ payload, last_seen_at: metadata.seenAt });
            });
            expect(reads.writes.commits).toBe(0);
            db.close(); db = undefined;
          }
        } finally { db?.close(); removeTempStateDbDir(tempDir); }
      },
    ), { numRuns: 8 });
  });
});

it("retains SQLite transaction variants, rollback and cross-connection visibility through both bindings", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    host: fc.integer({ min: 0, max: hosts.length - 1 }),
    variant: fc.constantFrom("default", "deferred", "immediate", "exclusive"),
    rollback: fc.boolean(), value: fc.string(),
  }), { minLength: 1, maxLength: 12 }), async (commands) => {
    const { dbPath, tempDir } = createTempStateDb("shared-sqlite-transactions-");
    const connections = hosts.map(host => host.open(dbPath));
    let expected: string | undefined;
    try {
      for (const command of commands) {
        const db = connections[command.host]!;
        const writes = await measureSqliteWrites(() => {
          const transaction = db.raw.transaction(() => {
            db.setMeta("fixture-value", command.value);
            if (command.rollback) throw new Error("fixture rollback");
          });
          if (command.rollback) expect(() => transaction[command.variant]()).toThrow("fixture rollback");
          else transaction[command.variant]();
        });
        expect(writes.writes.commits).toBe(command.rollback ? 0 : 1);
        if (!command.rollback) expected = command.value;
        for (const connection of connections) expect(connection.getMeta("fixture-value")).toBe(expected);
      }
    } finally { for (const db of connections) db.close(); removeTempStateDbDir(tempDir); }
  }), { numRuns: 12 });
});
