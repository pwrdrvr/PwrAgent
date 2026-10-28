import type Database from "better-sqlite3";

/** Remove derived schema from the unmerged interval-index experiment only. */
export function removeUsageActivityIndex(db: Database.Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'usage_activity_keys'").get()) return;
  db.transaction(() => {
    for (const trigger of ["key_insert", "key_update", "key_delete", "line_insert", "line_delete",
      "line_update", "turn_insert", "turn_delete", "turn_update"]) {
      db.exec(`DROP TRIGGER IF EXISTS usage_activity_${trigger}`);
    }
    db.exec(`DROP VIEW IF EXISTS usage_activity_endpoints;
      DROP TABLE IF EXISTS usage_activity_intervals;
      DROP TABLE IF EXISTS usage_activity_keys;
      DROP INDEX IF EXISTS idx_thread_usage_lines_usage_turn;`);
  }).immediate();
}
