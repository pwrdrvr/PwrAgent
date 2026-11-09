export const DURABLE_TURN_REQUEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS durable_turn_requests (
  caller_scope TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  receipt_json TEXT NOT NULL,
  queue_entry_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (caller_scope, request_id)
);
CREATE INDEX IF NOT EXISTS idx_durable_turn_requests_expiry
  ON durable_turn_requests(expires_at);
`;
