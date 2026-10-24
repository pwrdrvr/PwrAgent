/**
 * A sparse, durable adjacency projection of parent-owned managed children and
 * ordinary grouped handoffs. Payloads remain authoritative for older writers.
 * Built-in-only SQLite triggers maintain the projection in the writer's own
 * transaction, including writes from connections that never load our JS.
 *
 * Keep identities and array order in JSON: the reader owns backend fallback,
 * JS whitespace trimming, and the legacy malformed-entry stopping behavior.
 * Task text, titles, histories and other overlay metadata never enter this table.
 */
export const THREAD_NAVIGATION_RELATIONSHIPS_SCHEMA = `
CREATE TABLE thread_navigation_relationships (
  thread_id TEXT PRIMARY KEY,
  managed_children TEXT,
  grouped_subthread INTEGER NOT NULL CHECK(grouped_subthread IN (0, 1))
);

CREATE VIEW thread_navigation_relationship_projection AS
SELECT thread_id,
  CASE WHEN json_valid(payload) THEN
    CASE WHEN json_type(payload, '$.subAgents') = 'array'
      AND json_array_length(payload, '$.subAgents') > 0 THEN json_array(
        json_extract(payload, '$.backend'), json_extract(payload, '$.threadId'),
        json((SELECT json_group_array(CASE WHEN type = 'object' THEN json_object(
          'backend', json_extract(value, '$.backend'),
          'monitorThreadId', json_extract(value, '$.monitorThreadId')
        ) ELSE value END) FROM json_each(payload, '$.subAgents'))))
    END
  END AS managed_children,
  CASE WHEN json_valid(payload) THEN
    CASE WHEN json_extract(payload, '$.handoffOrigin.groupingMode') = 'subthread'
      THEN 1 ELSE 0 END
    ELSE 0 END AS grouped_subthread
FROM threads;

INSERT INTO thread_navigation_relationships
SELECT * FROM thread_navigation_relationship_projection
WHERE managed_children IS NOT NULL OR grouped_subthread = 1;

CREATE TRIGGER thread_navigation_relationships_insert AFTER INSERT ON threads BEGIN
  INSERT INTO thread_navigation_relationships
    SELECT * FROM thread_navigation_relationship_projection WHERE thread_id = NEW.thread_id
      AND (managed_children IS NOT NULL OR grouped_subthread = 1)
    ON CONFLICT(thread_id) DO UPDATE SET
      managed_children = excluded.managed_children,
      grouped_subthread = excluded.grouped_subthread
    WHERE managed_children IS NOT excluded.managed_children
      OR grouped_subthread != excluded.grouped_subthread;
  -- INSERT OR REPLACE need not fire delete triggers (recursive_triggers=OFF).
  -- Remove an obsolete projection explicitly even on that older-writer path.
  DELETE FROM thread_navigation_relationships WHERE thread_id = NEW.thread_id
    AND NOT EXISTS (SELECT 1 FROM thread_navigation_relationship_projection
      WHERE thread_id = NEW.thread_id AND (managed_children IS NOT NULL OR grouped_subthread = 1));
END;

CREATE TRIGGER thread_navigation_relationships_update AFTER UPDATE OF payload, thread_id ON threads BEGIN
  DELETE FROM thread_navigation_relationships WHERE thread_id = OLD.thread_id AND OLD.thread_id != NEW.thread_id;
  INSERT INTO thread_navigation_relationships
    SELECT * FROM thread_navigation_relationship_projection WHERE thread_id = NEW.thread_id
      AND (managed_children IS NOT NULL OR grouped_subthread = 1)
    ON CONFLICT(thread_id) DO UPDATE SET
      managed_children = excluded.managed_children,
      grouped_subthread = excluded.grouped_subthread
    WHERE managed_children IS NOT excluded.managed_children
      OR grouped_subthread != excluded.grouped_subthread;
  DELETE FROM thread_navigation_relationships WHERE thread_id = NEW.thread_id
    AND NOT EXISTS (SELECT 1 FROM thread_navigation_relationship_projection
      WHERE thread_id = NEW.thread_id AND (managed_children IS NOT NULL OR grouped_subthread = 1));
END;

CREATE TRIGGER thread_navigation_relationships_delete AFTER DELETE ON threads BEGIN
  DELETE FROM thread_navigation_relationships WHERE thread_id = OLD.thread_id;
END;
`;

/** A table-specific stamp, maintained even by writers that never load our JS.
 * The projection's existing equality guards keep metadata/stream updates from
 * touching this row. Mutations share the writer's transaction and rollback.
 */
export const THREAD_NAVIGATION_RELATIONSHIPS_GENERATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_navigation_relationship_generation (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  generation INTEGER NOT NULL
);
INSERT OR IGNORE INTO thread_navigation_relationship_generation VALUES (1, 0);

CREATE TRIGGER IF NOT EXISTS thread_navigation_relationship_generation_insert
AFTER INSERT ON thread_navigation_relationships BEGIN
  UPDATE thread_navigation_relationship_generation SET generation = generation + 1 WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS thread_navigation_relationship_generation_update
AFTER UPDATE ON thread_navigation_relationships
WHEN OLD.thread_id IS NOT NEW.thread_id
  OR OLD.managed_children IS NOT NEW.managed_children
  OR OLD.grouped_subthread IS NOT NEW.grouped_subthread BEGIN
  UPDATE thread_navigation_relationship_generation SET generation = generation + 1 WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS thread_navigation_relationship_generation_delete
AFTER DELETE ON thread_navigation_relationships BEGIN
  UPDATE thread_navigation_relationship_generation SET generation = generation + 1 WHERE singleton = 1;
END;
`;
