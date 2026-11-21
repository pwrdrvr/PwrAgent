const ACTIVE_STATUSES = "'held', 'scheduled', 'dispatching', 'queued'";
export const ACTIVE_SCHEDULED_ACTION = "status IN (" + ACTIVE_STATUSES + ")";
export const TERMINAL_SCHEDULED_ACTION = "status NOT IN (" + ACTIVE_STATUSES + ")";
export const CLAIMED_SCHEDULED_ACTION = "status IN ('dispatching', 'queued')";

export const SCHEDULED_PROJECTION_COLUMNS = [
  "action_id", "backend", "thread_id", "kind", "origin", "status", "scheduled_for",
  "queue_entry_id", "turn_id", "error_message", "payload_ref", "created_at", "updated_at",
] as const;

export function scheduledProjectionAdmissionBytes(prefix = ""): string {
  const required = ["action_id", "thread_id"].map(column => "length(CAST(" + prefix + column + " AS BLOB))");
  const optional = ["error_message", "payload_ref", "queue_entry_id", "turn_id"]
    .map(column => "COALESCE(length(CAST(" + prefix + column + " AS BLOB)), 0)");
  return "COALESCE(" + [...required, ...optional].join(" + ") + " + 512, 0)";
}

function jsonBytesUpperBound(prefix: string): string {
  // Keys and object punctuation fit in 256 bytes. A text byte needs at
  // most six JSON bytes, and the common short strings can be sized directly.
  // Leave room for JS number formatting and for legacy dynamically typed values.
  return "256 + " + SCHEDULED_PROJECTION_COLUMNS.map((column) => {
    const field = prefix + column;
    const bytes = "length(CAST(" + field + " AS BLOB))";
    return `CASE typeof(${field})
      WHEN 'text' THEN CASE WHEN ${bytes} <= 512 THEN length(CAST(json_quote(${field}) AS BLOB))
        ELSE 2 + 6 * ${bytes} END
      WHEN 'blob' THEN 32 + 4 * ${bytes}
      WHEN 'null' THEN 4
      ELSE 32 END`;
  }).join(" + ");
}

const projectionChangedExceptUpdatedAt = SCHEDULED_PROJECTION_COLUMNS
  .filter(column => column !== "updated_at")
  .map(column => "OLD." + column + " IS NOT NEW." + column)
  .join(" OR\n  ");

// The singleton tracks owner-wide admission and content changes in the writer's
// transaction. Renewed claims are read separately because their timestamp alone
// would otherwise dirty another page every heartbeat.
export const SCHEDULED_ACTION_PROJECTION_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_scheduled_thread_actions_projection_order
  ON scheduled_thread_actions(scheduled_for, created_at, action_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_thread_actions_terminal_updated
  ON scheduled_thread_actions(updated_at)
  WHERE ` + TERMINAL_SCHEDULED_ACTION + `;

CREATE TABLE IF NOT EXISTS scheduled_action_projection_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  generation BLOB NOT NULL,
  admission_bytes INTEGER NOT NULL,
  json_bytes_upper_bound INTEGER NOT NULL
);
INSERT OR IGNORE INTO scheduled_action_projection_state
  SELECT 1, randomblob(16), COALESCE(SUM(` + scheduledProjectionAdmissionBytes() + `), 0), COALESCE(SUM(` + jsonBytesUpperBound("") + `), 0)
  FROM scheduled_thread_actions;

CREATE TRIGGER IF NOT EXISTS scheduled_action_projection_insert AFTER INSERT ON scheduled_thread_actions BEGIN
  UPDATE scheduled_action_projection_state
  SET generation = randomblob(16),
    admission_bytes = admission_bytes + (` + scheduledProjectionAdmissionBytes("NEW.") + `),
    json_bytes_upper_bound = json_bytes_upper_bound + (` + jsonBytesUpperBound("NEW.") + `)
  WHERE singleton = 1;
END;

CREATE TRIGGER IF NOT EXISTS scheduled_action_projection_update
AFTER UPDATE OF ` + SCHEDULED_PROJECTION_COLUMNS.join(", ") + ` ON scheduled_thread_actions
WHEN ` + projectionChangedExceptUpdatedAt + `
  OR (OLD.updated_at IS NOT NEW.updated_at AND (
    NEW.status NOT IN ('dispatching', 'queued')
    OR typeof(OLD.updated_at) NOT IN ('integer', 'real')
    OR typeof(NEW.updated_at) NOT IN ('integer', 'real')
  ))
BEGIN
  UPDATE scheduled_action_projection_state
  SET generation = randomblob(16),
    admission_bytes = admission_bytes + (` + scheduledProjectionAdmissionBytes("NEW.") + `) - (` + scheduledProjectionAdmissionBytes("OLD.") + `),
    json_bytes_upper_bound = json_bytes_upper_bound + (` + jsonBytesUpperBound("NEW.") + `) - (` + jsonBytesUpperBound("OLD.") + `)
  WHERE singleton = 1;
END;

CREATE TRIGGER IF NOT EXISTS scheduled_action_projection_delete AFTER DELETE ON scheduled_thread_actions BEGIN
  UPDATE scheduled_action_projection_state
  SET generation = randomblob(16),
    admission_bytes = admission_bytes - (` + scheduledProjectionAdmissionBytes("OLD.") + `),
    json_bytes_upper_bound = json_bytes_upper_bound - (` + jsonBytesUpperBound("OLD.") + `)
  WHERE singleton = 1;
END;
`;
