/**
 * Retired Sandboxer bookkeeping schema. Keep existing records for compatibility
 * and operator inspection; no runtime creates or cleans up remote resources.
 */
export const THREAD_SANDBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_sandboxes (
  connection_id TEXT NOT NULL,
  sandbox_id    TEXT NOT NULL,
  backend       TEXT,
  thread_id     TEXT NOT NULL,
  name          TEXT,
  status        TEXT NOT NULL,
  note          TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (connection_id, sandbox_id)
);
CREATE INDEX IF NOT EXISTS idx_thread_sandboxes_pending
  ON thread_sandboxes(thread_id) WHERE status IN ('active', 'stopped');
`;
