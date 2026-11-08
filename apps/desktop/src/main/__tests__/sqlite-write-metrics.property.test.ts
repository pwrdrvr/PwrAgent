import Database from "better-sqlite3";
import fc from "fast-check";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  attachSqliteWriteMetrics,
  measureSqliteWrites,
  readSqliteWriteMetrics,
  resetSqliteWriteMetrics,
  type SqliteTableWriteMetrics,
} from "../state/sqlite-write-metrics";

let db: Database.Database;
let updates: Record<string, Database.Statement>;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE meta (id INTEGER PRIMARY KEY, value TEXT);
    CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT);
    CREATE TABLE untouched (id INTEGER PRIMARY KEY, value TEXT);
  `);
  for (const table of ["meta", "items", "untouched"]) {
    const insert = db.prepare(`INSERT INTO ${table} (id, value) VALUES (?, 'initial')`);
    for (let id = 0; id < 4; id++) insert.run(id);
  }
  attachSqliteWriteMetrics({ db, dbPath: ":memory:" });
  updates = {
    meta: db.prepare("UPDATE meta SET value = ? WHERE id < ?"),
    items: db.prepare("UPDATE items SET value = ? WHERE id < ?"),
    untouched: db.prepare("UPDATE untouched SET value = ? WHERE id < ?"),
  };
  resetSqliteWriteMetrics();
});

afterEach(() => db.close());

it.each([0, 1])("reports the same meta table delta for consecutive identical writes (%i rows)", async (rows) => {
  for (let index = 0; index < 2; index++) {
    const { writes } = await measureSqliteWrites(() => updates.meta.run("same", rows));
    expect(writes).toMatchObject({ commits: 1, statements: 1, rowsChanged: rows });
    expect(writes.tables).toEqual([
      { table: "meta", commits: 1, statements: 1, rowsChanged: rows },
    ]);
  }
});

it("matches each measured batch's table counters to its writes regardless of prior counters", async () => {
  const write = fc.record({
    table: fc.constantFrom("meta", "items"),
    rows: fc.integer({ min: 0, max: 4 }),
  });
  const batch = fc.record({
    transaction: fc.boolean(),
    writes: fc.array(write, { maxLength: 8 }),
  });
  await fc.assert(fc.asyncProperty(
    fc.array(write, { maxLength: 8 }),
    fc.array(batch, { minLength: 1, maxLength: 8 }),
    async (priorWrites, batches) => {
      resetSqliteWriteMetrics();
      // Existing counters include a table that no measured callback touches.
      for (const op of priorWrites) updates[op.table].run("prior", op.rows);
      updates.meta.run("prior", 1);
      updates.untouched.run("prior", 4);

      for (const current of batches) {
        const before = readSqliteWriteMetrics();
        const saved = structuredClone(before);
        const expected = new Map<string, SqliteTableWriteMetrics>();
        let rowsChanged = 0;
        // Model only this callback's operations, independently of snapshots.
        for (const op of current.writes) {
          const counters = expected.get(op.table) ?? {
            table: op.table, commits: 0, statements: 0, rowsChanged: 0,
          };
          counters.commits += current.transaction ? 0 : 1;
          counters.statements += 1;
          counters.rowsChanged += op.rows;
          expected.set(op.table, counters);
          rowsChanged += op.rows;
        }
        const run = () => {
          for (const op of current.writes) updates[op.table].run("measured", op.rows);
        };
        const { writes } = await measureSqliteWrites(() => {
          if (current.transaction) db.transaction(run)();
          else run();
        });
        expect(writes).toMatchObject({
          commits: current.transaction ? Number(current.writes.length > 0) : current.writes.length,
          statements: current.writes.length,
          rowsChanged,
        });
        const byTable = (left: SqliteTableWriteMetrics, right: SqliteTableWriteMetrics) =>
          left.table.localeCompare(right.table);
        expect([...writes.tables].sort(byTable)).toEqual([...expected.values()].sort(byTable));
        expect(before).toEqual(saved);
      }
    },
  ), { numRuns: 50 });
});

it("gives callers independent ownership of snapshot table counters", () => {
  updates.meta.run("before", 1);
  const first = readSqliteWriteMetrics()!;
  const second = readSqliteWriteMetrics()!;
  const saved = structuredClone(second);
  first.tables[0].commits += 100;
  first.tables[0].statements += 100;
  first.tables[0].rowsChanged += 100;
  first.tables[0].table = "changed by caller";
  expect(second).toEqual(saved);
  expect(readSqliteWriteMetrics()).toEqual(saved);
});
