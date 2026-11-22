import type Database from "better-sqlite3";
import {
  buildThreadIdentityKey,
  encodeLegacyThreadIdentityKey,
  type ThreadSubAgentSummary,
} from "@pwragent/shared/contracts/navigation";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { managedChildKeyFromCard } from "./thread-sub-agents";

// ECMAScript String.trim whitespace and line terminators. SQLite's default
// trim only removes ASCII spaces. Use built-ins so older writers can update
// both indexes without registering a function on their connection.
const JS_TRIM_CHARS = "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";
const TRIMMED_CARD_CHILD = "trim(monitor_thread_id, " + JS_TRIM_CHARS + ")";
const PADDED_CARD_CHILD = "monitor_thread_id IS NOT NULL AND monitor_thread_id <> " + TRIMMED_CARD_CHILD;

// Keep the existing raw child index for regular IDs and for older readers
// that name it directly. The second index adds entries only for padded IDs.
const PADDED_CHILD_INDEX = "CREATE INDEX IF NOT EXISTS thread_sub_agents_padded_child"
  + " ON thread_sub_agents(" + TRIMMED_CARD_CHILD + ", thread_id, backend, monitor_thread_id)"
  + " WHERE " + PADDED_CARD_CHILD;

// A legacy parent is one searchable document. Contentless FTS records a
// document deletion by rowid, even if the array names thousands of children.
// Store the parent key so the link survives VACUUM or a projection rekey.
// Hex prefixes find candidates. JS checks exact IDs and legacy array order.
const LEGACY_CHILD_TOKEN_BYTES = 128;
const LEGACY_CHILD_TOKEN = "('x' || hex(substr(CAST(trim(field.value, " + JS_TRIM_CHARS
  + ") AS BLOB), 1, " + LEGACY_CHILD_TOKEN_BYTES + ")))";
const DELETE_NEW_PARENT_DOCUMENT = `
  DELETE FROM thread_managed_legacy_search WHERE rowid IN (
    SELECT rowid FROM thread_managed_legacy_search
    WHERE thread_managed_legacy_search MATCH ('p' || hex(substr(CAST(NEW.thread_id AS BLOB), 1, 128)))
      AND parent_key = NEW.thread_id
  );
`;
const DELETE_OLD_PARENT_DOCUMENT = `
  DELETE FROM thread_managed_legacy_search WHERE rowid IN (
    SELECT rowid FROM thread_managed_legacy_search
    WHERE thread_managed_legacy_search MATCH ('p' || hex(substr(CAST(OLD.thread_id AS BLOB), 1, 128)))
      AND parent_key = OLD.thread_id
  );
`;

const LEGACY_CHILD_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS thread_managed_legacy_search USING fts5(
  children, parent_key UNINDEXED, content='', contentless_delete=1, contentless_unindexed=1,
  tokenize=ascii, detail=none
);
CREATE VIEW IF NOT EXISTS thread_managed_legacy_child_projection AS
SELECT relationship.thread_id AS parent_key,
  'p' || hex(substr(CAST(relationship.thread_id AS BLOB), 1, 128)) || ' ' || `
  + "group_concat(" + LEGACY_CHILD_TOKEN + ", ' ')" + ` AS tokens
FROM thread_navigation_relationships AS relationship
JOIN json_each(CASE WHEN json_valid(relationship.managed_children) THEN
  CASE WHEN json_type(relationship.managed_children, '$[2]') = 'array'
    THEN relationship.managed_children END END, '$[2]') AS card
JOIN json_each(CASE WHEN card.type = 'object' THEN card.value END) AS field
WHERE field.key = 'monitorThreadId' AND field.type = 'text'
GROUP BY relationship.thread_id;

-- INSERT OR REPLACE can displace a document without firing a delete trigger.
CREATE TRIGGER IF NOT EXISTS thread_managed_legacy_children_insert
AFTER INSERT ON thread_navigation_relationships BEGIN` + DELETE_NEW_PARENT_DOCUMENT + `
  INSERT INTO thread_managed_legacy_search(children, parent_key)
    SELECT tokens, parent_key FROM thread_managed_legacy_child_projection WHERE parent_key = NEW.thread_id;
END;
CREATE TRIGGER IF NOT EXISTS thread_managed_legacy_children_update
AFTER UPDATE ON thread_navigation_relationships
WHEN OLD.managed_children IS NOT NEW.managed_children
  OR OLD.thread_id IS NOT NEW.thread_id BEGIN` + DELETE_OLD_PARENT_DOCUMENT + DELETE_NEW_PARENT_DOCUMENT + `
  INSERT INTO thread_managed_legacy_search(children, parent_key)
    SELECT tokens, parent_key FROM thread_managed_legacy_child_projection WHERE parent_key = NEW.thread_id;
END;
CREATE TRIGGER IF NOT EXISTS thread_managed_legacy_children_delete
AFTER DELETE ON thread_navigation_relationships WHEN OLD.managed_children IS NOT NULL BEGIN` + DELETE_OLD_PARENT_DOCUMENT + `
END;

-- Legacy payloads are already on their way out. Avoid background FTS merges
-- in a thread deletion or card-move transaction.
INSERT INTO thread_managed_legacy_search(thread_managed_legacy_search, rank) VALUES ('automerge', 0);
INSERT INTO thread_managed_legacy_search(thread_managed_legacy_search) VALUES ('delete-all');
INSERT INTO thread_managed_legacy_search(children, parent_key)
  SELECT tokens, parent_key FROM thread_managed_legacy_child_projection;
`;

const MEMBERSHIP_SCHEMA_OBJECTS = [
  "thread_navigation_relationships", "thread_sub_agents", "thread_sub_agents_padded_child",
  "thread_managed_legacy_search", "thread_managed_legacy_child_projection",
  "thread_managed_legacy_children_insert", "thread_managed_legacy_children_update", "thread_managed_legacy_children_delete",
];

export function ensureThreadManagedMembershipSchema(db: Database.Database): void {
  const objects = db.prepare("SELECT name FROM sqlite_master WHERE name IN (SELECT value FROM json_each(?))").pluck();
  const requiredNames = JSON.stringify(MEMBERSHIP_SCHEMA_OBJECTS);
  const names = new Set(objects.all(requiredNames));
  if (names.size === MEMBERSHIP_SCHEMA_OBJECTS.length
    || !names.has("thread_navigation_relationships") || !names.has("thread_sub_agents")) return;
  db.transaction(() => {
    // A concurrent opener can finish installing the schema while we wait.
    if (objects.all(requiredNames).length === MEMBERSHIP_SCHEMA_OBJECTS.length) return;
    db.exec(PADDED_CHILD_INDEX);
    db.exec(LEGACY_CHILD_SCHEMA);
  }).immediate();
}

/** Run inside storage maintenance's write transaction, after parent deletion. */
export function reclaimEmptyLegacyMembershipIndex(db: Database.Database): void {
  // Partial profiles can omit the relationship schema. The segment index
  // has rows only after postings have been written, even after documents
  // were retired. Clearing it leaves pages for the existing vacuum to reclaim.
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'thread_managed_legacy_search_idx'").get()) return;
  const retired = db.prepare(`SELECT 1 WHERE EXISTS (SELECT 1 FROM thread_managed_legacy_search_idx)
    AND NOT EXISTS (SELECT 1 FROM thread_managed_legacy_search)`).get();
  if (retired) {
    db.prepare("INSERT INTO thread_managed_legacy_search(thread_managed_legacy_search) VALUES ('delete-all')").run();
  }
}

/** Read the valid prefix of a legacy array, stopping at a malformed entry. */
export function managedKeysFromLegacyProjection(projection: string): Set<string> {
  const keys = new Set<string>();
  try {
    const [parentBackend, parentId, subAgents] = JSON.parse(projection) as [
      AppServerBackendKind, string, ThreadSubAgentSummary[] | undefined,
    ];
    for (const subAgent of subAgents ?? []) {
      const threadId = subAgent.monitorThreadId?.trim();
      const backend = subAgent.backend ?? parentBackend;
      if (!threadId || (backend === parentBackend && threadId === parentId)) continue;
      keys.add(buildThreadIdentityKey(backend, threadId));
    }
  } catch {
    // A malformed overlay does not affect any other parent.
  }
  return keys;
}

const REQUESTED_CHILD_IDS = "WITH child_ids AS (SELECT value FROM json_each(@childIds))";
const SCOPED_MANAGED_MEMBERSHIP = `
SELECT thread_id, grouped_subthread, NULL AS projection, NULL AS backend, NULL AS child
  FROM thread_navigation_relationships
  WHERE thread_id IN (SELECT value FROM json_each(@storageKeys)) AND grouped_subthread = 1
UNION ALL
SELECT thread_id, 0, managed_children, NULL, NULL
  FROM thread_navigation_relationships
  WHERE thread_id IN (
    SELECT parent_key FROM child_ids
    CROSS JOIN thread_managed_legacy_search
    WHERE thread_managed_legacy_search MATCH ('x' || hex(substr(CAST(child_ids.value AS BLOB), 1, `
  + LEGACY_CHILD_TOKEN_BYTES + `)))
  )
UNION ALL
SELECT thread_id, 0, NULL, backend, monitor_thread_id
  FROM thread_sub_agents INDEXED BY thread_sub_agents_child
  WHERE monitor_thread_id IS NOT NULL AND monitor_thread_id IN (SELECT value FROM child_ids)
UNION ALL
SELECT thread_id, 0, NULL, backend, monitor_thread_id
  FROM thread_sub_agents INDEXED BY thread_sub_agents_padded_child
  WHERE ` + PADDED_CARD_CHILD + " AND " + TRIMMED_CARD_CHILD + " IN (SELECT value FROM child_ids)";

// Older SQLite capture triggers can put malformed UTF-8 into TEXT columns.
// The JS reader sees replacement characters. For an owner with a replacement
// character, seek candidate bytes by the intact prefix and recheck in JS.
const REPLACEMENT_PROBES = `, replacement_probes AS (
  SELECT CAST(unhex(json_extract(value, '$.lower')) AS TEXT) AS lower_bound,
    CAST(unhex(json_extract(value, '$.upper')) AS TEXT) AS upper_bound,
    json_extract(value, '$.legacyMatch') AS legacy_match
  FROM json_each(@replacementProbes)
), grouped_replacement_probes AS (
  SELECT CAST(unhex(json_extract(value, '$.lower')) AS TEXT) AS lower_bound,
    CAST(unhex(json_extract(value, '$.upper')) AS TEXT) AS upper_bound
  FROM json_each(@groupedReplacementProbes)
)`;
const REPLACEMENT_CANDIDATES = `
UNION ALL
SELECT thread_id, grouped_subthread, NULL, NULL, NULL
  FROM grouped_replacement_probes CROSS JOIN thread_navigation_relationships
  WHERE grouped_subthread = 1 AND thread_id >= lower_bound AND thread_id < upper_bound
UNION ALL
SELECT thread_id, 0, managed_children, NULL, NULL
  FROM thread_navigation_relationships
  WHERE thread_id IN (
    SELECT parent_key FROM replacement_probes
    CROSS JOIN thread_managed_legacy_search
    WHERE thread_managed_legacy_search MATCH replacement_probes.legacy_match
  )
UNION ALL
SELECT thread_id, 0, NULL, backend, monitor_thread_id
  FROM replacement_probes CROSS JOIN thread_sub_agents INDEXED BY thread_sub_agents_child
  WHERE monitor_thread_id IS NOT NULL
    AND monitor_thread_id >= lower_bound AND monitor_thread_id < upper_bound
UNION ALL
SELECT thread_id, 0, NULL, backend, monitor_thread_id
  FROM replacement_probes CROSS JOIN thread_sub_agents INDEXED BY thread_sub_agents_padded_child
  WHERE ` + PADDED_CARD_CHILD + " AND " + TRIMMED_CARD_CHILD + " >= lower_bound"
  + " AND " + TRIMMED_CARD_CHILD + " < upper_bound";

type ReplacementRange = { lower: string; upper: string };
type ReplacementProbe = ReplacementRange & { legacyMatch: string };

function replacementRange(id: string, prefix: Buffer): ReplacementRange {
  const lower = prefix.toString("hex") + "80";
  if (prefix.length === 0) {
    // An invalid sequence consumes at most as many bytes as the UTF-8
    // encoding of its replacement character. One more byte bounds the seek.
    return { lower, upper: "ff".repeat(Buffer.byteLength(id) + 1) };
  }
  const last = prefix.length - 1;
  prefix.writeUInt8(prefix.readUInt8(last) + 1, last);
  return { lower, upper: prefix.toString("hex") };
}

function replacementProbe(id: string, replacementIndex: number): ReplacementProbe {
  const prefix = Buffer.from(id.slice(0, replacementIndex));
  const token = "x" + prefix.subarray(0, LEGACY_CHILD_TOKEN_BYTES).toString("hex");
  const legacyMatch = prefix.length >= LEGACY_CHILD_TOKEN_BYTES ? token
    : [..."89abcdef"].map((nibble) => token + nibble + "*").join(" OR ");
  return { ...replacementRange(id, prefix), legacyMatch };
}

type MembershipRow = {
  thread_id: string;
  grouped_subthread: number;
  projection: string | null;
  backend: string | null;
  child: string | null;
};

type MembershipBindings = { childIds: string; storageKeys: string };
type ReplacementBindings = MembershipBindings & { replacementProbes: string; groupedReplacementProbes: string };

/** One SQLite snapshot of only the candidate relationships and group flags. */
export function prepareScopedManagedMembership(db: Database.Database) {
  const statement = db.prepare<MembershipBindings, MembershipRow>(REQUESTED_CHILD_IDS + SCOPED_MANAGED_MEMBERSHIP);
  let replacementStatement: Database.Statement<ReplacementBindings, MembershipRow> | undefined;
  const readRows = (bindings: MembershipBindings, probes: ReplacementProbe[], groupedProbes: ReplacementRange[]): MembershipRow[] => {
    if (probes.length === 0 && groupedProbes.length === 0) return statement.all(bindings);
    replacementStatement ??= db.prepare(
      REQUESTED_CHILD_IDS + REPLACEMENT_PROBES + SCOPED_MANAGED_MEMBERSHIP + REPLACEMENT_CANDIDATES,
    );
    return replacementStatement.all({
      ...bindings, replacementProbes: JSON.stringify(probes), groupedReplacementProbes: JSON.stringify(groupedProbes),
    });
  };
  return (keys: readonly string[]) => readScopedManagedMembership(readRows, keys);
}

function readScopedManagedMembership(
  readRows: (bindings: MembershipBindings, probes: ReplacementProbe[], groupedProbes: ReplacementRange[]) => MembershipRow[],
  keys: readonly string[],
): Set<string> {
  if (keys.length === 0) return new Set();
  const storageKeys = new Set(keys.map((key) => encodeLegacyThreadIdentityKey(key) ?? key));
  const wanted = new Set(keys);
  const childIds = new Set<string>();
  for (const key of wanted) {
    // Imported backend strings are opaque to the old reader. A malformed
    // backend containing ':' can produce the same key as an ID containing
    // ':', so probe each split and let the existing identity logic decide.
    for (let separator = key.indexOf(":"); separator !== -1; separator = key.indexOf(":", separator + 1)) {
      const id = key.slice(separator + 1);
      if (id && id.trim() === id) childIds.add(id);
    }
  }
  const managed = new Set<string>();
  if (childIds.size === 0) return managed;
  const probes: ReplacementProbe[] = [];
  for (const id of childIds) {
    const replacement = id.indexOf("\ufffd");
    if (replacement !== -1) probes.push(replacementProbe(id, replacement));
  }
  const groupedProbes: ReplacementRange[] = [];
  for (const key of storageKeys) {
    const replacement = key.indexOf("\ufffd");
    if (replacement !== -1) groupedProbes.push(replacementRange(key, Buffer.from(key.slice(0, replacement))));
  }
  const rows = readRows({ childIds: JSON.stringify([...childIds]), storageKeys: JSON.stringify([...storageKeys]) }, probes, groupedProbes);
  const grouped = new Set<string>();
  for (const row of rows) {
    if (row.child !== null) {
      const key = managedChildKeyFromCard(row.thread_id, row.backend, row.child);
      if (key && wanted.has(key)) managed.add(key);
    } else if (row.projection) {
      for (const key of managedKeysFromLegacyProjection(row.projection)) {
        if (wanted.has(key)) managed.add(key);
      }
    } else if (row.grouped_subthread === 1 && storageKeys.has(row.thread_id)) {
      grouped.add(row.thread_id);
    }
  }
  for (const key of managed) {
    if (grouped.has(encodeLegacyThreadIdentityKey(key) ?? key)) managed.delete(key);
  }
  return managed;
}
