import type BetterSqlite3 from "better-sqlite3";
import {
  MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES,
  type AppServerThreadActivityEntry,
} from "@pwragent/shared";
import { LegacyPayloadArrayMove } from "./legacy-payload-array-move";

/**
 * PwrAgent-authored turn and monitor usage rows, one row per activity.
 *
 * They used to live in the thread's `threads.payload.immutableUsageActivities`
 * array: up to 100 entries, 65-115 KB on a busy thread, so every scalar
 * overlay write (model settings, seen watermark, PR list) rewrote them and
 * every overlay read parsed them. Here an append writes one row and an
 * overlay read touches none.
 *
 * `thread_id` is the thread's `threads.thread_id` storage key. Rows are
 * immutable and appended in order, so the rowid is the array order. Only the
 * turn id a lookup filters on is a column.
 *
 * Older PwrAgent builds that share the profile still write the whole payload,
 * including any array they hold. The capture triggers move such an array into
 * this table inside the writer's own transaction, so an older build can add
 * activities but never erase them.
 */
const TABLES = `
CREATE TABLE IF NOT EXISTS thread_usage_activities (
  thread_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  turn_id TEXT,
  activity TEXT NOT NULL,
  PRIMARY KEY (thread_id, activity_id)
);
CREATE INDEX IF NOT EXISTS thread_usage_activities_by_turn
  ON thread_usage_activities(thread_id, turn_id)
  WHERE turn_id IS NOT NULL;
`;

/**
 * One statement shared by both capture triggers; NEW is the `threads` row.
 * An activity already stored is kept as stored. The trim keeps the newest 100
 * (`MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES`), as the array did.
 */
const CAPTURE_BODY = `
  INSERT INTO thread_usage_activities(thread_id, activity_id, turn_id, activity)
  SELECT NEW.thread_id, json_extract(value, '$.id'),
    CASE WHEN json_type(value, '$.turn.id') = 'text' THEN json_extract(value, '$.turn.id') END, value
  FROM json_each(NEW.payload, '$.immutableUsageActivities')
  WHERE type = 'object' AND json_type(value, '$.id') = 'text'
  ORDER BY key
  ON CONFLICT(thread_id, activity_id) DO NOTHING;
  DELETE FROM thread_usage_activities WHERE thread_id = NEW.thread_id AND rowid NOT IN (
    SELECT rowid FROM thread_usage_activities WHERE thread_id = NEW.thread_id ORDER BY rowid DESC LIMIT 100);
  UPDATE threads SET payload = json_remove(payload, '$.immutableUsageActivities') WHERE thread_id = NEW.thread_id;
`;

const HAS_ACTIVITY_ARRAY = `CASE WHEN json_valid(NEW.payload) THEN json_type(NEW.payload, '$.immutableUsageActivities') = 'array' ELSE 0 END`;

const CAPTURE_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS thread_usage_activities_capture_insert
AFTER INSERT ON threads WHEN ${HAS_ACTIVITY_ARRAY} BEGIN ${CAPTURE_BODY} END;
CREATE TRIGGER IF NOT EXISTS thread_usage_activities_capture_update
AFTER UPDATE OF payload ON threads WHEN ${HAS_ACTIVITY_ARRAY} BEGIN ${CAPTURE_BODY} END;
`;

/** Set once every legacy payload array has been moved; later opens skip all scanning. */
export const THREAD_USAGE_ACTIVITIES_MOVED_META_KEY = "thread_usage_activities_moved_v1";

/**
 * Appends trim in batches: a thread may hold this many extra rows before the
 * oldest are deleted, so a busy thread's append is one insert, not an insert
 * and a delete. Every read still returns only the newest
 * `MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES`.
 */
const TRIM_SLACK = 25;

function tableExists(db: BetterSqlite3.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/**
 * Idempotent. Runs from the versioned step and again after the ladder, so a
 * profile that another branch stamped with the same `user_version` converges.
 * Creates no rows and moves no data.
 */
export function ensureThreadUsageActivitySchema(db: BetterSqlite3.Database): void {
  if (!tableExists(db, "threads")) return;
  db.exec(TABLES);
  db.exec(CAPTURE_TRIGGERS);
}

function parseActivity(text: string): AppServerThreadActivityEntry | undefined {
  try {
    return JSON.parse(text) as AppServerThreadActivityEntry;
  } catch {
    return undefined;
  }
}

export class ThreadUsageActivityTable {
  private readonly move: LegacyPayloadArrayMove;

  constructor(
    private readonly db: BetterSqlite3.Database,
    meta: { get(key: string): string | undefined; set(key: string, value: string): void },
  ) {
    this.move = new LegacyPayloadArrayMove(db, meta, "immutableUsageActivities", THREAD_USAGE_ACTIVITIES_MOVED_META_KEY);
  }

  isMoveComplete(): boolean {
    return this.move.isComplete();
  }

  /** Move one thread's legacy array, if it still has one. */
  moveLegacyActivities(storageKey: string): void {
    this.move.moveRow(storageKey);
  }

  /** One bounded slice of the one-time move; see `LegacyPayloadArrayMove.moveSlice`. */
  moveLegacyActivitiesSlice(afterRowid: number, byteBudget: number): number | undefined {
    return this.move.moveSlice(afterRowid, byteBudget);
  }

  /**
   * Append one activity unless the thread already holds its id. Returns
   * whether it was stored. The caller owns the transaction.
   */
  append(storageKey: string, activity: AppServerThreadActivityEntry): boolean {
    const inserted = this.db.prepare(`INSERT INTO thread_usage_activities(thread_id, activity_id, turn_id, activity)
      VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, activity_id) DO NOTHING`).run(
      storageKey,
      activity.id,
      typeof activity.turn?.id === "string" ? activity.turn.id : null,
      JSON.stringify(activity),
    ).changes > 0;
    if (!inserted) return false;
    const { count } = this.db.prepare(
      "SELECT count(*) AS count FROM thread_usage_activities WHERE thread_id = ?",
    ).get(storageKey) as { count: number };
    if (count > MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES + TRIM_SLACK) {
      this.db.prepare(`DELETE FROM thread_usage_activities WHERE thread_id = ? AND rowid NOT IN (
        SELECT rowid FROM thread_usage_activities WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?)`)
        .run(storageKey, storageKey, MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES);
    }
    return true;
  }

  /**
   * The newest `MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES` per thread, oldest
   * first, keyed by storage key. One statement for the whole batch.
   */
  list(storageKeys: readonly string[]): Map<string, AppServerThreadActivityEntry[]> {
    const result = new Map<string, AppServerThreadActivityEntry[]>();
    if (storageKeys.length === 0) return result;
    const rows = this.db.prepare(`SELECT thread_id, activity FROM (
        SELECT thread_id, activity, rowid AS id,
          row_number() OVER (PARTITION BY thread_id ORDER BY rowid DESC) AS newest
        FROM thread_usage_activities
        WHERE thread_id IN (SELECT value FROM json_each(?)))
      WHERE newest <= ?
      ORDER BY thread_id, id`).all(
      JSON.stringify([...new Set(storageKeys)]),
      MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES,
    ) as Array<{ thread_id: string; activity: string }>;
    for (const row of rows) {
      const activity = parseActivity(row.activity);
      if (!activity) continue;
      const activities = result.get(row.thread_id);
      if (activities) activities.push(activity);
      else result.set(row.thread_id, [activity]);
    }
    return result;
  }

  /**
   * The oldest retained activity for a turn, which is what `Array.find` over
   * the array returned. A row past the newest 100 that is awaiting its batch
   * trim is not retained. Parses only the matching rows.
   */
  getForTurn(storageKey: string, turnId: string): AppServerThreadActivityEntry | undefined {
    const rows = this.db.prepare(`SELECT activity FROM thread_usage_activities
      WHERE thread_id = ? AND turn_id = ? AND rowid >= coalesce((
        SELECT rowid FROM thread_usage_activities WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1 OFFSET ?), 0)
      ORDER BY rowid`).all(storageKey, turnId, storageKey, MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES - 1) as Array<{ activity: string }>;
    for (const row of rows) {
      const activity = parseActivity(row.activity);
      if (activity) return activity;
    }
    return undefined;
  }

  /** One statement for the whole batch, however many threads it names. */
  deleteForThreads(storageKeys: readonly string[]): void {
    if (storageKeys.length === 0) return;
    this.db.prepare("DELETE FROM thread_usage_activities WHERE thread_id IN (SELECT value FROM json_each(?))")
      .run(JSON.stringify(storageKeys));
  }
}
