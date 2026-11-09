import type Database from "better-sqlite3";

const versions = new WeakMap<Database.Database, { value: number }>();

/** Connection-local invalidation, with no persistent rows or WAL writes.
 * External writers are still detected by data_version at the caller. The
 * counter deliberately survives rollback: invalidating too much is safe,
 * whereas publishing a transaction's relationship set after rollback is not.
 */
export function sqliteThreadChangeVersion(db: Database.Database): number {
  let version = versions.get(db);
  if (!version && db.inTransaction) return 0;
  if (!version) {
    version = { value: 0 };
    const counter = version;
    db.function("pwragent_threads_changed", () => ++counter.value);
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      db.exec(`CREATE TEMP TRIGGER pwragent_threads_changed_${operation.toLowerCase()}
        AFTER ${operation} ON main.threads BEGIN SELECT pwragent_threads_changed(); END`);
    }
    versions.set(db, version);
  }
  return version.value;
}
