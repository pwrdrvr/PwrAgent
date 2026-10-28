import type Database from "better-sqlite3";

/**
 * Index both authoritative interval endpoints. An updated_at index cannot
 * find an old line whose turn alone received completion, and a start index
 * still visits the whole past for every recent window (an end index visits
 * the future for historical windows).
 *
 * R-tree coordinates round outwards to float32. They only admit candidates;
 * the read always rechecks the exact INTEGER timestamps from the ledger.
 * Separate point dimensions also support malformed/reversed intervals with
 * precisely the same predicate as the ledger. No epoch or date-range limit.
 * Stable integer keys survive VACUUM; ledger rowids do not.
 * Coordinates cover whole minutes, so streamed live updates maintain the
 * tree only on a minute boundary, never on every token event. Exact interval
 * checks remain at read time. No timer, separate commit, or idle write.
 */
const SCHEMA = `
CREATE TABLE usage_activity_keys (
  id INTEGER PRIMARY KEY,
  usage_line_id TEXT NOT NULL UNIQUE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE usage_activity_intervals USING rtree(
  id, start_min, start_max, end_min, end_max
);
CREATE INDEX IF NOT EXISTS idx_thread_usage_lines_usage_turn
  ON thread_usage_lines(usage_turn_id) WHERE usage_turn_id IS NOT NULL;

CREATE TRIGGER usage_activity_key_insert AFTER INSERT ON usage_activity_keys BEGIN
  INSERT INTO usage_activity_intervals VALUES (NEW.id, NEW.started_at, NEW.started_at + 60000, NEW.ended_at, NEW.ended_at + 60000);
END;
CREATE TRIGGER usage_activity_key_update AFTER UPDATE OF started_at, ended_at ON usage_activity_keys BEGIN
  UPDATE usage_activity_intervals SET start_min = NEW.started_at, start_max = NEW.started_at + 60000,
    end_min = NEW.ended_at, end_max = NEW.ended_at + 60000 WHERE id = NEW.id;
END;
CREATE TRIGGER usage_activity_key_delete AFTER DELETE ON usage_activity_keys BEGIN
  DELETE FROM usage_activity_intervals WHERE id = OLD.id;
END;

CREATE VIEW usage_activity_endpoints AS
  WITH endpoints AS (
  SELECT l.usage_line_id, COALESCE(t.started_at, l.created_at) AS started_at,
    COALESCE(t.completed_at, l.completed_at,
      CASE WHEN l.scope = 'monitor' AND l.status = 'finalized' THEN l.created_at END,
      l.updated_at) AS ended_at
  FROM thread_usage_lines l LEFT JOIN thread_usage_turns t ON t.usage_turn_id = l.usage_turn_id
  WHERE l.status != 'superseded'
  )
  SELECT usage_line_id,
    (CAST(started_at / 60000 AS INTEGER) - (started_at < 0 AND started_at % 60000 != 0)) * 60000 AS started_at,
    (CAST(ended_at / 60000 AS INTEGER) - (ended_at < 0 AND ended_at % 60000 != 0)) * 60000 AS ended_at
  FROM endpoints;

CREATE TRIGGER usage_activity_line_insert AFTER INSERT ON thread_usage_lines BEGIN
  INSERT INTO usage_activity_keys(usage_line_id, started_at, ended_at)
    SELECT usage_line_id, started_at, ended_at FROM usage_activity_endpoints WHERE usage_line_id = NEW.usage_line_id;
END;
CREATE TRIGGER usage_activity_line_delete AFTER DELETE ON thread_usage_lines BEGIN
  DELETE FROM usage_activity_keys WHERE usage_line_id = OLD.usage_line_id;
END;
CREATE TRIGGER usage_activity_line_update
AFTER UPDATE OF usage_line_id, usage_turn_id, created_at, completed_at, updated_at, scope, status ON thread_usage_lines BEGIN
  DELETE FROM usage_activity_keys WHERE usage_line_id = OLD.usage_line_id
    AND (OLD.usage_line_id != NEW.usage_line_id OR NEW.status = 'superseded');
  INSERT INTO usage_activity_keys(usage_line_id, started_at, ended_at)
    SELECT usage_line_id, started_at, ended_at FROM usage_activity_endpoints WHERE usage_line_id = NEW.usage_line_id
    ON CONFLICT(usage_line_id) DO UPDATE SET started_at = excluded.started_at, ended_at = excluded.ended_at
    WHERE started_at != excluded.started_at OR ended_at != excluded.ended_at;
END;

CREATE TRIGGER usage_activity_turn_insert AFTER INSERT ON thread_usage_turns BEGIN
  INSERT INTO usage_activity_keys(usage_line_id, started_at, ended_at)
    SELECT e.usage_line_id, e.started_at, e.ended_at FROM thread_usage_lines l
      JOIN usage_activity_endpoints e ON e.usage_line_id = l.usage_line_id WHERE l.usage_turn_id = NEW.usage_turn_id
    ON CONFLICT(usage_line_id) DO UPDATE SET started_at = excluded.started_at, ended_at = excluded.ended_at
    WHERE started_at != excluded.started_at OR ended_at != excluded.ended_at;
END;
CREATE TRIGGER usage_activity_turn_delete AFTER DELETE ON thread_usage_turns BEGIN
  INSERT INTO usage_activity_keys(usage_line_id, started_at, ended_at)
    SELECT e.usage_line_id, e.started_at, e.ended_at FROM thread_usage_lines l
      JOIN usage_activity_endpoints e ON e.usage_line_id = l.usage_line_id WHERE l.usage_turn_id = OLD.usage_turn_id
    ON CONFLICT(usage_line_id) DO UPDATE SET started_at = excluded.started_at, ended_at = excluded.ended_at
    WHERE started_at != excluded.started_at OR ended_at != excluded.ended_at;
END;
CREATE TRIGGER usage_activity_turn_update
AFTER UPDATE OF usage_turn_id, started_at, completed_at ON thread_usage_turns
WHEN OLD.usage_turn_id IS NOT NEW.usage_turn_id OR OLD.started_at IS NOT NEW.started_at
  OR OLD.completed_at IS NOT NEW.completed_at BEGIN
  INSERT INTO usage_activity_keys(usage_line_id, started_at, ended_at)
    SELECT e.usage_line_id, e.started_at, e.ended_at FROM thread_usage_lines l
      JOIN usage_activity_endpoints e ON e.usage_line_id = l.usage_line_id
      WHERE l.usage_turn_id IN (OLD.usage_turn_id, NEW.usage_turn_id)
    ON CONFLICT(usage_line_id) DO UPDATE SET started_at = excluded.started_at, ended_at = excluded.ended_at
    WHERE started_at != excluded.started_at OR ended_at != excluded.ended_at;
END;

INSERT INTO usage_activity_keys(usage_line_id, started_at, ended_at)
  SELECT usage_line_id, started_at, ended_at FROM usage_activity_endpoints;
`;

/** One atomic backfill on upgrade; subsequent opens inspect only sqlite_master. */
export function ensureUsageActivityIndex(db: Database.Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'thread_usage_lines'").get()) return;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'usage_activity_keys'").get()) return;
  db.transaction(() => {
    // Another opener may have completed the migration while we waited.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'usage_activity_keys'").get()) db.exec(SCHEMA);
  }).immediate();
}
