import type Database from "better-sqlite3";
import { sqliteBackendChangeVersion } from "./sqlite-backend-change-version";
import { sqliteThreadChangeVersion } from "./sqlite-thread-change-version";

const versions = new WeakMap<Database.Database, { value: number }>();
export const PROJECT_CHECKOUT_GROUPS_META_KEY = "project-checkout-groups";
const NAVIGATION_TABLES = [
  "directory_launchpads", "directory_overlay", "remote_directory_overlay", "remote_thread_pins",
  "directory_git_status", "thread_git_working_state",
  // Rows carry their messaging bindings; a bind or unbind changes the row.
  "bindings",
];

/** Navigation index inputs, rather than every write on the connection. PR status and election
 * membership, separate usage tables and composer recovery do not change it.
 * TEMP triggers cover raw SQL too, without persistent counters or WAL writes.
 * Counters survive rollback; callers must bypass reuse inside transactions.
 * External commits still require data_version at the caller.
 */
export function sqliteNavigationChangeVersion(db: Database.Database): string {
  let version = versions.get(db);
  if (!version && db.inTransaction) return "transaction";
  if (!version) {
    version = { value: 0 };
    const counter = version;
    db.function("pwragent_navigation_changed", () => ++counter.value);
    for (const table of NAVIGATION_TABLES) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        db.exec(`CREATE TEMP TRIGGER pwragent_navigation_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON main.${table} BEGIN SELECT pwragent_navigation_changed(); END`);
      }
    }
    // Only metadata that enters the owner navigation index.
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const references = operation === "INSERT" ? ["NEW"] : operation === "DELETE" ? ["OLD"] : ["OLD", "NEW"];
      const predicate = references.map((row) =>
        `${row}.key IN ('navigation-unread-baseline-v2', '${PROJECT_CHECKOUT_GROUPS_META_KEY}')`).join(" OR ");
      db.exec(`CREATE TEMP TRIGGER pwragent_navigation_meta_${operation.toLowerCase()}
        AFTER ${operation} ON main.meta WHEN ${predicate}
        BEGIN SELECT pwragent_navigation_changed(); END`);
    }
    versions.set(db, version);
  }
  return `${sqliteThreadChangeVersion(db)}:${sqliteBackendChangeVersion(db)}:${version.value}`;
}
