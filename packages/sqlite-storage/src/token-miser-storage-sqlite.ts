import type {
  TokenMiserObjectRecord,
  TokenMiserObservationRecord,
  TokenMiserRetentionRecord,
  TokenMiserStorage,
} from "@pwragent/owner-core/token-miser-storage";
import { watchPricingRows } from "./sqlite-pricing-row-changes";
import type { StateDb } from "./state-db";
import { prepareSqliteRead } from "./sqlite-prepared-read";

export const OPEN_REPLAY_GATE = `CASE WHEN json_valid(payload) THEN
  json_extract(payload, '$.replayTrackingVersion') = 2 AND json_type(payload, '$.replayTrackingStoppedAt') IS NULL
  ELSE 0 END`;

type MetadataPageRow = { thread_id: string; created_at: number; object_id: string; payload: string };

export class SqliteTokenMiserStorage<
  Metadata extends TokenMiserObjectRecord,
  Observation extends TokenMiserObservationRecord,
> implements TokenMiserStorage<Metadata, Observation> {
  constructor(private readonly stateDb: StateDb) {}

  private get db() { return this.stateDb.raw; }

  reserveOutputHandles(count: number): number {
    const key = "token_miser_last_output_handle";
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
      const last = row ? Number(row.value) : 0;
      if ((row && (String(last) !== row.value || last < 1)) || !Number.isSafeInteger(last)
        || !Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(last + count)) {
        throw new Error("Invalid Token Miser output handle counter.");
      }
      this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, String(last + count));
      return last + 1;
    }).immediate();
  }

  readMetadata(objectId: string, threadId?: string): Metadata | undefined {
    const row = (threadId === undefined
      ? this.db.prepare("SELECT payload FROM token_miser_objects WHERE object_id = ?").get(objectId)
      : this.db.prepare("SELECT payload FROM token_miser_objects WHERE object_id = ? AND thread_id = ?").get(objectId, threadId)
    ) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as Metadata : undefined;
  }

  readMetadataByIds(objectIds: readonly string[]): Metadata[] {
    const rows = prepareSqliteRead(this.db, `SELECT payload FROM token_miser_objects
      WHERE object_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(objectIds)) as { payload: string }[];
    return rows.map(({ payload }) => JSON.parse(payload) as Metadata);
  }

  listMetadata(threadId?: string): Metadata[] {
    const rows = (threadId === undefined
      ? this.db.prepare("SELECT payload FROM token_miser_objects ORDER BY created_at DESC").all()
      : this.db.prepare("SELECT payload FROM token_miser_objects WHERE thread_id = ? ORDER BY created_at DESC").all(threadId)
    ) as Array<{ payload: string }>;
    return rows.map(({ payload }) => JSON.parse(payload) as Metadata);
  }

  watchPricingMetadata(threadId: string, changed: (id: string) => void) {
    const db = this.db;
    let observationCount: number | undefined;
    const priorMembership = new Map<string, boolean>();
    let version: number | undefined;
    const closeObservations = watchPricingRows(db, "token_miser_observations", threadId, (id, present) => {
      if (observationCount !== undefined && !priorMembership.has(id)) priorMembership.set(id, present);
    });
    const closeMetadata = watchPricingRows(db, "token_miser_objects", threadId, changed);
    type Row = { created_at: number; rowid: number; payload: string };
    const parse = (row: Row) => ({ createdAt: row.created_at, rowid: row.rowid, entry: JSON.parse(row.payload) as Metadata });
    return {
      dataVersion: () => {
        const committed = db.pragma("data_version", { simple: true }) as number;
        if (version !== committed) observationCount = undefined;
        version = committed;
        return committed;
      },
      all: () => (prepareSqliteRead(db, "SELECT created_at, rowid, payload FROM token_miser_objects WHERE thread_id = ?")
        .all(threadId) as Row[]).map(parse),
      get: (id: string) => {
        const row = prepareSqliteRead(db, "SELECT created_at, rowid, payload FROM token_miser_objects WHERE object_id = ? AND thread_id = ?")
          .get(id, threadId) as Row | undefined;
        return row && parse(row);
      },
      observationCount: () => {
        if (observationCount === undefined) {
          observationCount = (prepareSqliteRead(db, "SELECT count(*) AS n FROM token_miser_observations WHERE thread_id = ?")
            .get(threadId) as { n: number }).n;
        } else {
          // Compare the first before-image with the final committed membership.
          // A rollback, payload-only update or delete/reinsert has zero delta.
          let delta = 0;
          for (const [id, before] of priorMembership) {
            const present = prepareSqliteRead(db, "SELECT 1 FROM token_miser_observations WHERE observation_id = ? AND thread_id = ?")
              .get(id, threadId);
            delta += Number(Boolean(present)) - Number(before);
          }
          observationCount += delta;
        }
        priorMembership.clear();
        return observationCount;
      },
      close: () => { closeMetadata(); closeObservations(); },
    };
  }

  readMetadataPage(after: TokenMiserObjectRecord | undefined, limit: number, threadId?: string): {
    entries: Metadata[];
    next?: TokenMiserObjectRecord;
  } {
    // Keep a thread's gates together so pricing and card reads can share
    // keys within a page. The existing index supplies the first two keys;
    // SQLite only sorts rows that tie on both.
    const rows = this.readMetadataPageRows(after, limit, threadId);
    const last = rows.at(-1);
    return {
      entries: rows.map(({ payload }) => JSON.parse(payload) as Metadata),
      // The indexed keys belong to the original insert. Use those keys even
      // when a newer payload supplies different values.
      next: last && rows.length === limit
        ? { threadId: last.thread_id, createdAt: last.created_at, objectId: last.object_id }
        : undefined,
    };
  }

  private readMetadataPageRows(after: TokenMiserObjectRecord | undefined, limit: number, threadId?: string): MetadataPageRow[] {
    const db = this.db;
    if (threadId !== undefined) {
      return (after === undefined
        ? prepareSqliteRead(db, `SELECT thread_id, created_at, object_id, payload
            FROM token_miser_objects INDEXED BY idx_token_miser_objects_thread
            WHERE thread_id = ? ORDER BY created_at, object_id LIMIT ?`).all(threadId, limit)
        : prepareSqliteRead(db, `SELECT thread_id, created_at, object_id, payload
            FROM token_miser_objects INDEXED BY idx_token_miser_objects_thread
            WHERE thread_id = ? AND (created_at, object_id) > (?, ?)
            ORDER BY created_at, object_id LIMIT ?`).all(threadId, after.createdAt, after.objectId, limit)) as MetadataPageRow[];
    }
    return (after === undefined
      ? prepareSqliteRead(db, `SELECT thread_id, created_at, object_id, payload
          FROM token_miser_objects INDEXED BY idx_token_miser_objects_thread
          ORDER BY thread_id, created_at, object_id LIMIT ?`).all(limit)
      : prepareSqliteRead(db, `SELECT thread_id, created_at, object_id, payload
          FROM token_miser_objects INDEXED BY idx_token_miser_objects_thread
          WHERE (thread_id, created_at, object_id) > (?, ?, ?)
          ORDER BY thread_id, created_at, object_id LIMIT ?`)
          .all(after.threadId, after.createdAt, after.objectId, limit)) as MetadataPageRow[];
  }

  readOpenReplayPage(threadId: string, afterId: string | undefined, limit: number): TokenMiserObjectRecord[] {
    // Replay membership and compaction follow the current payload. The stable
    // object ID still advances the page cursor after a peer reassigns a gate.
    return prepareSqliteRead(this.db, `SELECT object_id AS objectId, json_extract(payload, '$.threadId') AS threadId,
        json_extract(payload, '$.createdAt') AS createdAt
      FROM token_miser_objects INDEXED BY idx_token_miser_open_replay
      WHERE json_extract(payload, '$.threadId') = ? AND object_id > ? AND ` + OPEN_REPLAY_GATE + " ORDER BY object_id LIMIT ?").all(threadId, afterId ?? "", limit) as TokenMiserObjectRecord[];
  }

  writeMetadata(metadata: Metadata): void {
    this.db.prepare(`INSERT INTO token_miser_objects (object_id, thread_id, created_at, payload)
      VALUES (?, ?, ?, ?) ON CONFLICT(object_id) DO UPDATE SET payload = excluded.payload
      WHERE token_miser_objects.payload != excluded.payload`).run(
      metadata.objectId, metadata.threadId, metadata.createdAt, JSON.stringify(metadata),
    );
  }

  removeMetadata(objectId: string): void {
    this.db.prepare("DELETE FROM token_miser_objects WHERE object_id = ?").run(objectId);
  }

  recordObservation(observation: Observation): void {
    this.db.prepare(`INSERT INTO token_miser_observations (observation_id, thread_id, created_at, payload)
      VALUES (?, ?, ?, ?) ON CONFLICT(observation_id) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at
      WHERE token_miser_observations.payload != excluded.payload`).run(
      observation.observationId, observation.threadId, observation.createdAt, JSON.stringify(observation),
    );
  }

  listObservations(threadId?: string): Observation[] {
    const rows = (threadId === undefined
      ? this.db.prepare("SELECT payload FROM token_miser_observations ORDER BY created_at").all()
      : this.db.prepare("SELECT payload FROM token_miser_observations WHERE thread_id = ? ORDER BY created_at").all(threadId)
    ) as Array<{ payload: string }>;
    return rows.map(({ payload }) => JSON.parse(payload) as Observation);
  }

  isArchived(threadKey: string): boolean {
    return (this.db.prepare("SELECT archived FROM token_miser_retention WHERE thread_key = ?")
      .get(threadKey) as { archived: number } | undefined)?.archived === 1;
  }

  readRetentionGeneration(threadKey: string): string {
    return (this.db.prepare("SELECT generation FROM token_miser_retention WHERE thread_key = ?")
      .get(threadKey) as { generation: string } | undefined)?.generation ?? "";
  }

  restoreThread(threadKey: string): void {
    // An explicit restore wins even if a peer has yet to import the legacy
    // archive marker. Imports only insert retention keys that are missing.
    this.db.prepare(`INSERT INTO token_miser_retention (thread_key, generation, archived) VALUES (?, '', 0)
      ON CONFLICT(thread_key) DO UPDATE SET archived = 0 WHERE token_miser_retention.archived = 1`).run(threadKey);
  }

  archiveThread(threadKey: string, generation: string): void {
    this.db.prepare(`INSERT INTO token_miser_retention (thread_key, generation, archived)
      VALUES (?, ?, 1) ON CONFLICT(thread_key) DO UPDATE SET generation = excluded.generation, archived = 1
      WHERE token_miser_retention.archived = 0`).run(threadKey, generation);
  }

  hasLegacyMigration(migrationKey: string): boolean {
    return Boolean(prepareSqliteRead(this.db, "SELECT value FROM meta WHERE key = ?").get(migrationKey));
  }

  importLegacyRecords({ metadata, observations, retention }: {
    metadata: Metadata[];
    observations: Observation[];
    retention: TokenMiserRetentionRecord[];
  }): void {
    this.db.transaction(() => {
      const object = this.db.prepare("INSERT OR IGNORE INTO token_miser_objects (object_id, thread_id, created_at, payload) VALUES (?, ?, ?, ?)");
      const observation = this.db.prepare("INSERT OR IGNORE INTO token_miser_observations (observation_id, thread_id, created_at, payload) VALUES (?, ?, ?, ?)");
      const marker = this.db.prepare("INSERT OR IGNORE INTO token_miser_retention (thread_key, generation, archived) VALUES (?, ?, ?)");
      for (const entry of metadata) object.run(entry.objectId, entry.threadId, entry.createdAt, JSON.stringify(entry));
      for (const entry of observations) observation.run(entry.observationId, entry.threadId, entry.createdAt, JSON.stringify(entry));
      // An archive marker wins when a legacy directory also has a generation.
      for (const entry of retention.sort((a, b) => b.archived - a.archived)) marker.run(entry.key, entry.generation, entry.archived);
    }).immediate();
  }

  completeLegacyMigration(migrationKey: string): void {
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, 'complete')").run(migrationKey);
  }

  runExclusive<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }
}
