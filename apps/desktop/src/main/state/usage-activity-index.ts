import type Database from "better-sqlite3";

// A line's fallback endpoint and the authoritative turn endpoint are separate
// admission paths. Either may admit extra rows; the ledger join rechecks the
// exact COALESCE predicates. No timestamp alone represents arbitrary overlap.
const LINE_END = `COALESCE(completed_at,
  CASE WHEN scope = 'monitor' AND status = 'finalized' THEN created_at END, updated_at)`;

export function usageActivityCandidates(kind: "overlap" | "helpers"): string {
  if (kind === "helpers") return `
    SELECT usage_line_id FROM thread_usage_lines
      WHERE scope = 'monitor' AND status = 'finalized' AND created_at >= @from
    UNION
    SELECT l.usage_line_id FROM thread_usage_turns t
      CROSS JOIN thread_usage_lines l ON l.usage_turn_id = t.usage_turn_id
      WHERE t.started_at >= @from AND l.scope = 'monitor' AND l.status = 'finalized'`;
  return `
    SELECT usage_line_id FROM thread_usage_lines
      WHERE status != 'superseded' AND ${LINE_END} >= @from
    UNION
    SELECT l.usage_line_id FROM thread_usage_turns t
      CROSS JOIN thread_usage_lines l ON l.usage_turn_id = t.usage_turn_id
      WHERE t.completed_at >= @from AND l.status != 'superseded'`;
}

export function ensureUsageActivityIndex(db: Database.Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'thread_usage_lines'").get()) return;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_usage_activity_line_end'").get()) return;
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_usage_activity_line_end'").get()) return;
    // Clean up the unmerged R-tree experiment when opening its existing DB.
    for (const trigger of ["key_insert", "key_update", "key_delete", "line_insert", "line_delete",
      "line_update", "turn_insert", "turn_delete", "turn_update"]) {
      db.exec(`DROP TRIGGER IF EXISTS usage_activity_${trigger}`);
    }
    db.exec(`DROP VIEW IF EXISTS usage_activity_endpoints;
      DROP TABLE IF EXISTS usage_activity_intervals;
      DROP TABLE IF EXISTS usage_activity_keys;
      CREATE INDEX IF NOT EXISTS idx_thread_usage_lines_usage_turn
        ON thread_usage_lines(usage_turn_id) WHERE usage_turn_id IS NOT NULL;
      CREATE INDEX idx_usage_activity_line_end ON thread_usage_lines(${LINE_END}) WHERE status != 'superseded';
      CREATE INDEX idx_usage_activity_helper_start ON thread_usage_lines(created_at)
        WHERE scope = 'monitor' AND status = 'finalized';
      CREATE INDEX idx_usage_activity_turn_end ON thread_usage_turns(completed_at) WHERE completed_at IS NOT NULL;
      CREATE INDEX idx_usage_activity_turn_start ON thread_usage_turns(started_at) WHERE started_at IS NOT NULL;`);
  }).immediate();
}
