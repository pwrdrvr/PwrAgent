// Older processes may still write a serialized snapshot as lastSnapshotHash.
// Retain its initialized/not-initialized meaning, but never index or return
// that snapshot. The next complete reconciliation replaces it with a digest.
// Keep the index/read expressions identical; the covering-plan test fails if
// they drift and SQLite starts fetching payloads or evaluating JSON on reads.
export const NAVIGATION_BACKEND_METADATA_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_backends_navigation_metadata ON backends(
  scope,
  CASE WHEN json_valid(payload) THEN json_extract(payload, '$.knownThreadKeys') END,
  CASE WHEN json_valid(payload) THEN
    CASE WHEN length(json_extract(payload, '$.lastSnapshotHash')) <= 71
      THEN json_extract(payload, '$.lastSnapshotHash')
      WHEN json_extract(payload, '$.lastSnapshotHash') IS NOT NULL THEN 'legacy'
    END END
);
`;

// INDEXED BY makes the no-payload-read requirement explicit. The migration
// installs the index before any store opens; SQLite maintains it atomically
// for all writers, including other processes and older application builds.
export const READ_NAVIGATION_BACKEND_METADATA = `
SELECT
  CASE WHEN json_valid(payload) THEN json_extract(payload, '$.knownThreadKeys') END AS known_thread_keys,
  CASE WHEN json_valid(payload) THEN
    CASE WHEN length(json_extract(payload, '$.lastSnapshotHash')) <= 71
      THEN json_extract(payload, '$.lastSnapshotHash')
      WHEN json_extract(payload, '$.lastSnapshotHash') IS NOT NULL THEN 'legacy'
    END END AS snapshot_hash
FROM backends INDEXED BY idx_backends_navigation_metadata WHERE scope = ?
`;
