import type Database from "better-sqlite3";
import { sqliteBackendChangeVersion } from "./sqlite-backend-change-version";
import { sqliteThreadChangeVersion } from "./sqlite-thread-change-version";

const versions = new WeakMap<Database.Database, { owner: number; viewer: number }>();
export const PROJECT_CHECKOUT_GROUPS_META_KEY = "project-checkout-groups";
const OWNER_NAVIGATION_TABLES = [
  "directory_launchpads", "directory_overlay",
  "directory_git_status", "thread_git_working_state",
  // Rows carry their messaging bindings; a bind or unbind changes the row.
  "bindings",
];
const VIEWER_NAVIGATION_TABLES = [
  "remote_directory_overlay", "remote_thread_pins",
];

function ensureNavigationVersion(db: Database.Database): { owner: number; viewer: number } | undefined {
  let version = versions.get(db);
  if (!version && db.inTransaction) return undefined;
  if (!version) {
    version = { owner: 0, viewer: 0 };
    const counter = version;
    db.function("pwragent_navigation_changed", () => ++counter.owner);
    db.function("pwragent_viewer_navigation_changed", () => ++counter.viewer);
    for (const table of OWNER_NAVIGATION_TABLES) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        db.exec(`CREATE TEMP TRIGGER pwragent_navigation_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON main.${table} BEGIN SELECT pwragent_navigation_changed(); END`);
      }
    }
    for (const table of VIEWER_NAVIGATION_TABLES) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        db.exec(`CREATE TEMP TRIGGER pwragent_navigation_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON main.${table} BEGIN SELECT pwragent_viewer_navigation_changed(); END`);
      }
    }
    // Register the keyed change journal before its ledger triggers can fire.
    sqliteThreadChangeVersion(db);
    // Only a turn that beats the best other eligible turn and supplies a
    // different fill contributes to navigation. Each lookup seeks one rival
    // with the same partial index and tie-break as the owner projection.
    db.exec(`
      CREATE TEMP TRIGGER pwragent_context_insert AFTER INSERT ON main.thread_usage_turns
        WHEN NEW.final_context_tokens >= 0 AND NEW.model_context_window > 0 AND COALESCE((
          SELECT (NEW.observed_at, NEW.rowid) > (observed_at, rowid)
            AND (NEW.final_context_tokens, NEW.model_context_window) IS NOT (final_context_tokens, model_context_window)
          FROM thread_usage_turns WHERE backend = NEW.backend AND thread_id = NEW.thread_id AND rowid != NEW.rowid
            AND final_context_tokens >= 0 AND model_context_window > 0
          ORDER BY observed_at DESC, rowid DESC LIMIT 1
        ), 1) BEGIN SELECT pwragent_threads_changed(NEW.backend || ':' || NEW.thread_id); END;
      CREATE TEMP TRIGGER pwragent_context_delete AFTER DELETE ON main.thread_usage_turns
        WHEN OLD.final_context_tokens >= 0 AND OLD.model_context_window > 0 AND COALESCE((
          SELECT (OLD.observed_at, OLD.rowid) > (observed_at, rowid)
            AND (OLD.final_context_tokens, OLD.model_context_window) IS NOT (final_context_tokens, model_context_window)
          FROM thread_usage_turns WHERE backend = OLD.backend AND thread_id = OLD.thread_id
            AND final_context_tokens >= 0 AND model_context_window > 0
          ORDER BY observed_at DESC, rowid DESC LIMIT 1
        ), 1) BEGIN SELECT pwragent_threads_changed(OLD.backend || ':' || OLD.thread_id); END;
      CREATE TEMP TRIGGER pwragent_context_update AFTER UPDATE ON main.thread_usage_turns
        WHEN (NEW.final_context_tokens, NEW.model_context_window, NEW.observed_at, NEW.backend, NEW.thread_id, NEW.rowid)
          IS NOT (OLD.final_context_tokens, OLD.model_context_window, OLD.observed_at, OLD.backend, OLD.thread_id, OLD.rowid)
        BEGIN
          -- Compare the two candidate contributions against the unchanged
          -- ledger (exclude NEW). Identical contributions cancel in pairs.
          SELECT pwragent_threads_changed(OLD.backend || ':' || OLD.thread_id, NEW.backend || ':' || NEW.thread_id) FROM (
            SELECT OLD.backend AS owner, OLD.thread_id AS thread, OLD.observed_at AS observed,
              OLD.rowid AS id, OLD.final_context_tokens AS used, OLD.model_context_window AS capacity
            UNION ALL SELECT NEW.backend, NEW.thread_id, NEW.observed_at, NEW.rowid, NEW.final_context_tokens, NEW.model_context_window
          ) AS candidate
          WHERE used >= 0 AND capacity > 0 AND COALESCE((
            SELECT (candidate.observed, candidate.id) > (observed_at, rowid)
              AND (candidate.used, candidate.capacity) IS NOT (final_context_tokens, model_context_window)
            FROM thread_usage_turns WHERE backend = candidate.owner AND thread_id = candidate.thread AND rowid != NEW.rowid
              AND final_context_tokens >= 0 AND model_context_window > 0
            ORDER BY observed_at DESC, rowid DESC LIMIT 1
          ), 1)
          GROUP BY owner, thread, used, capacity HAVING count(*) = 1 LIMIT 1;
        END;
    `);
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
  return version;
}

/** Navigation index inputs, rather than every write on the connection. PR status and election
 * membership, unrelated usage and composer recovery do not change it.
 * TEMP triggers cover raw SQL too, without persistent counters or WAL writes.
 * Counters survive rollback; callers must bypass reuse inside transactions.
 * External commits still require data_version at the caller.
 */
export function sqliteNavigationChangeVersion(db: Database.Database): string {
  const version = ensureNavigationVersion(db);
  if (!version) return "transaction";
  return `${sqliteThreadChangeVersion(db)}:${sqliteBackendChangeVersion(db)}:${version.owner}:${version.viewer}`;
}

/** Owner-only navigation index inputs, excluding viewer-owned remote pin/overlay tables. */
export function sqliteOwnerNavigationChangeVersion(db: Database.Database): string {
  const version = ensureNavigationVersion(db);
  if (!version) return "transaction";
  return `${sqliteThreadChangeVersion(db)}:${sqliteBackendChangeVersion(db)}:${version.owner}`;
}

export function sqliteViewerNavigationChangeVersion(db: Database.Database): number | undefined {
  return ensureNavigationVersion(db)?.viewer;
}
