import type Database from "better-sqlite3";

const versions = new WeakMap<Database.Database, { value: number }>();

/** Connection-local backend invalidation without persistent rows or WAL writes.
 * TEMP triggers also cover raw SQL and other stores sharing this connection.
 * The JS counter survives rollback; callers must not cache transaction reads.
 * External commits still require data_version at the caller.
 */
export function sqliteBackendChangeVersion(db: Database.Database): number {
  let version = versions.get(db);
  if (!version && db.inTransaction) return 0;
  if (!version) {
    version = { value: 0 };
    const counter = version;
    db.function("pwragent_backends_changed", () => ++counter.value);
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      db.exec(`CREATE TEMP TRIGGER pwragent_backends_changed_${operation.toLowerCase()}
        AFTER ${operation} ON main.backends BEGIN SELECT pwragent_backends_changed(); END`);
    }
    versions.set(db, version);
  }
  return version.value;
}
