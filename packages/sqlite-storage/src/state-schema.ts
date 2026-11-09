export const STORAGE_RETENTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_storage_retention (
  backend TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  PRIMARY KEY (backend, thread_id)
);
`;

export const THREAD_DEPENDENCY_SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_dependencies (
  dependency_id TEXT PRIMARY KEY,
  backend TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_dependencies_consumer
  ON thread_dependencies(backend, thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_thread_dependencies_active
  ON thread_dependencies(status) WHERE status IN ('waiting', 'ready', 'dispatching');
`;

export const PROJECT_HELD_WAKEUP_SCHEMA = `
CREATE TABLE IF NOT EXISTS project_held_wakeups (
  entry_id TEXT PRIMARY KEY,
  owner_instance_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  directory_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
`;

export const RESTART_CONTINUATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS restart_continuations (
  entry_id TEXT PRIMARY KEY,
  owner_instance_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
`;

export const MESSAGING_REQUEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS messaging_request_owner (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), owner_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messaging_requests (
  request_id TEXT PRIMARY KEY, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messaging_human_destinations (
  selector TEXT PRIMARY KEY, principal_scope TEXT NOT NULL,
  interacted_at INTEGER NOT NULL, request_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messaging_human_destinations_scope
  ON messaging_human_destinations(principal_scope, interacted_at DESC, selector);
CREATE TABLE IF NOT EXISTS messaging_attachment_operations (
  operation_id TEXT PRIMARY KEY, result TEXT
);
`;

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
