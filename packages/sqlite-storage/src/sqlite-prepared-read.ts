import type BetterSqlite3 from "better-sqlite3";

const reads = new WeakMap<BetterSqlite3.Database, {
  prepare: unknown;
  statements: Map<string, BetterSqlite3.Statement>;
}>();

/** Reuse compiled SQL for fixed read shapes. Execution still reads the current transaction or database snapshot. */
export function prepareSqliteRead(db: BetterSqlite3.Database, sql: string): BetterSqlite3.Statement {
  // Instrumentation can replace prepare. Drop the old statements so those
  // executions are observable by the current wrapper.
  const prepare = Reflect.get(db, "prepare");
  let cache = reads.get(db);
  if (!cache || cache.prepare !== prepare) {
    cache = { prepare, statements: new Map() };
    reads.set(db, cache);
  }
  let statement = cache.statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    cache.statements.set(sql, statement);
  }
  return statement;
}
