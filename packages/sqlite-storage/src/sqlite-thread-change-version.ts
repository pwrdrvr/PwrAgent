import type Database from "better-sqlite3";

const HISTORY = 512;
const versions = new WeakMap<Database.Database, { value: number; rows: string[][] }>();

/** Bounded, connection-local row detail since a previous observation. A gap
 * (including an evicted prefix) must be reconciled from durable state. */
export function sqliteChangedThreadKeys(db: Database.Database, since: number): string[] | undefined {
  const version = versions.get(db);
  if (!version || db.inTransaction || !Number.isSafeInteger(since) || since < 0
    || since > version.value || version.value - since > HISTORY) return undefined;
  const keys = new Set<string>();
  for (let i = since; i < version.value; i++) {
    for (const key of version.rows[i % HISTORY]!) keys.add(key);
  }
  return [...keys];
}

/** Connection-local invalidation, with no persistent rows or WAL writes.
 * External writers are still detected by data_version at the caller. The
 * counter deliberately survives rollback: invalidating too much is safe,
 * whereas publishing a transaction's relationship set after rollback is not.
 */
export function sqliteThreadChangeVersion(db: Database.Database): number {
  let version = versions.get(db);
  if (!version && db.inTransaction) return 0;
  if (!version) {
    version = { value: 0, rows: [] };
    const counter = version;
    db.function("pwragent_threads_changed", { varargs: true }, (...keys: string[]) => {
      counter.rows[counter.value % HISTORY] = keys;
      return ++counter.value;
    });
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const keys = operation === "INSERT" ? "NEW.thread_id" : operation === "DELETE" ? "OLD.thread_id" : "OLD.thread_id, NEW.thread_id";
      db.exec(`CREATE TEMP TRIGGER pwragent_threads_changed_${operation.toLowerCase()}
        AFTER ${operation} ON main.threads BEGIN SELECT pwragent_threads_changed(${keys}); END`);
    }
    versions.set(db, version);
  }
  return version.value;
}
