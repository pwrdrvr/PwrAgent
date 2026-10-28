import type Database from "better-sqlite3";

/** Keep the turn-to-line lookup index, without persistent interval maintenance. */
export function ensureUsageActivityLookupIndex(db: Database.Database): void {
  const hasIntervals = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'usage_activity_keys'").get();
  const hasLookup = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_thread_usage_lines_usage_turn'").get();
  if (!hasIntervals && hasLookup) return;
  db.transaction(() => {
    if (hasIntervals) {
      // Remove derived schema from the unmerged interval-index experiment.
      for (const trigger of ["key_insert", "key_update", "key_delete", "line_insert", "line_delete",
        "line_update", "turn_insert", "turn_delete", "turn_update"]) {
        db.exec(`DROP TRIGGER IF EXISTS usage_activity_${trigger}`);
      }
      db.exec(`DROP VIEW IF EXISTS usage_activity_endpoints;
        DROP TABLE IF EXISTS usage_activity_intervals;
        DROP TABLE IF EXISTS usage_activity_keys;`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_thread_usage_lines_usage_turn
      ON thread_usage_lines(usage_turn_id) WHERE usage_turn_id IS NOT NULL;`);
  }).immediate();
}
