import type Database from "better-sqlite3";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { parseThreadIdentityKey } from "@pwragent/shared/contracts/navigation";

// Codex and Claude already have direct primary-key lookups for the normal
// storage keys. Index only ACP identities and unusual legacy payload/key
// pairs, so unrelated overlay updates and deletes do not dirty a second tree.
export const SUBTHREAD_GROUP_INDEXES = `
  DROP INDEX IF EXISTS idx_threads_subthread_id;
  CREATE INDEX IF NOT EXISTS idx_threads_subthread_nonstandard_id
    ON threads(CASE WHEN json_valid(payload) THEN json_extract(payload, '$.threadId') END)
    WHERE CASE WHEN json_valid(payload) THEN thread_id NOT IN (
      'codex:' || json_extract(payload, '$.threadId'),
      'claude:' || json_extract(payload, '$.threadId')
    ) END;
  CREATE INDEX IF NOT EXISTS idx_threads_subthread_parent
    ON threads(CASE WHEN json_valid(payload) THEN json_extract(payload, '$.parentThreadId') END)
    WHERE (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.parentThreadId') END) IS NOT NULL;
`;

export function hasSubthreadGroupIndexes(db: Database.Database): boolean {
  return db.prepare(`SELECT count(*) FROM sqlite_schema WHERE type = 'index'
    AND tbl_name = 'threads' AND name IN ('idx_threads_subthread_nonstandard_id', 'idx_threads_subthread_parent')`).pluck().get() === 2;
}

type OverlayRow = {
  storageKey: string;
  backend: AppServerBackendKind | null;
  parentThreadId: string | null;
  parentThreadBackend: AppServerBackendKind | null;
  parentThreadInstanceId: string | null;
  handoffSourceBackend: AppServerBackendKind | null;
  handoffSourceThreadId: string | null;
  tombstoned: number | null;
  archived: number | null;
  restored: number | null;
};

export function prepareSubthreadGroup(db: Database.Database) {
  // Pin each seek so statistics from a large unrelated group cannot turn
  // this into a table scan. The union and sort touch just the matching rows.
  const group = db.prepare(`
    SELECT thread_id AS storageKey, json_extract(payload, '$.backend') AS backend,
      json_extract(payload, '$.parentThreadId') AS parentThreadId,
      json_extract(payload, '$.parentThreadBackend') AS parentThreadBackend,
      json_extract(payload, '$.parentThreadInstanceId') AS parentThreadInstanceId,
      CASE WHEN json_extract(payload, '$.handoffOrigin.groupingMode') = 'subthread'
        THEN json_extract(payload, '$.handoffOrigin.sourceBackend') END AS handoffSourceBackend,
      CASE WHEN json_extract(payload, '$.handoffOrigin.groupingMode') = 'subthread'
        THEN json_extract(payload, '$.handoffOrigin.sourceThreadId') END AS handoffSourceThreadId,
      json_extract(payload, '$.archiveTombstonedAt') AS tombstoned,
      json_extract(payload, '$.archiveRetentionStartedAt') AS archived,
      json_extract(payload, '$.archiveRestoredAt') AS restored
    FROM (
      SELECT rowid FROM threads INDEXED BY idx_threads_subthread_parent
       WHERE (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.parentThreadId') END) = @id
      UNION
      SELECT rowid FROM threads INDEXED BY sqlite_autoindex_threads_1
       WHERE thread_id IN ('codex:' || @id, 'claude:' || @id)
         AND (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.threadId') END) = @id
      UNION
      SELECT rowid FROM threads INDEXED BY idx_threads_subthread_nonstandard_id
       WHERE (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.threadId') END) = @id
         AND CASE WHEN json_valid(payload) THEN thread_id NOT IN (
           'codex:' || json_extract(payload, '$.threadId'),
           'claude:' || json_extract(payload, '$.threadId')
         ) END
    ) AS matches
    CROSS JOIN threads ON threads.rowid = matches.rowid
    ORDER BY matches.rowid
  `);
  const linkedChild = db.prepare(`
    SELECT payload FROM (
      SELECT rowid FROM threads INDEXED BY sqlite_autoindex_threads_1
       WHERE thread_id IN ('codex:' || @id, 'claude:' || @id)
         AND (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.threadId') END) = @id
      UNION ALL
      SELECT rowid FROM threads INDEXED BY idx_threads_subthread_nonstandard_id
       WHERE (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.threadId') END) = @id
         AND CASE WHEN json_valid(payload) THEN thread_id NOT IN (
           'codex:' || json_extract(payload, '$.threadId'),
           'claude:' || json_extract(payload, '$.threadId')
         ) END
    ) AS matches
    CROSS JOIN threads ON threads.rowid = matches.rowid
    WHERE json_extract(payload, '$.parentThreadId') = @parentId
      AND json_extract(payload, '$.parentThreadBackend') = @parentBackend
    LIMIT 2
  `);

  return {
    read(backend: AppServerBackendKind, parentThreadId: string) {
      const rows = group.all({ id: parentThreadId }) as OverlayRow[];
      const scopes = new Map<AppServerBackendKind, Set<string>>([[backend, new Set([parentThreadId])]]);
      // A same-ID parent on a relevant provider can be in its live listing
      // without an overlay of its own. Always ask each scope for that ID.
      for (const row of rows) {
        if (typeof row.backend === "string" && row.backend && !scopes.has(row.backend)) {
          scopes.set(row.backend, new Set([parentThreadId]));
        }
      }
      for (const row of rows) {
        const identity = parseThreadIdentityKey(row.storageKey);
        if (identity) scopes.get(identity.backend)?.add(identity.threadId);
      }
      // An order-only update can create the parent's first overlay. The
      // implicit parent key is already present, so that update cannot
      // invalidate discovery. Re-read its ranks in the write transaction.
      const fingerprint = JSON.stringify([
        [...scopes].map(([scope, ids]) => [scope, [...ids].sort()]),
        rows.filter(row => row.parentThreadId !== null || row.tombstoned !== null
          || row.archived !== null || row.restored !== null),
      ]);
      return { scopes, rows, fingerprint };
    },
    linkedChild(threadId: string, parentThreadId: string, backend: AppServerBackendKind): string | undefined {
      const rows = linkedChild.all({ id: threadId, parentId: parentThreadId, parentBackend: backend }) as { payload: string }[];
      return rows.length === 1 ? rows[0]!.payload : undefined;
    },
  };
}
