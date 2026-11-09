import type {
  TokenMiserObjectRecord,
  TokenMiserObservationRecord,
  TokenMiserRetentionRecord,
  TokenMiserStorage,
} from "@pwragent/owner-core/token-miser-storage";
import type { StateDb } from "./state-db";

export class SqliteTokenMiserStorage<
  Metadata extends TokenMiserObjectRecord,
  Observation extends TokenMiserObservationRecord,
> implements TokenMiserStorage<Metadata, Observation> {
  constructor(private readonly stateDb: StateDb) {}

  private get db() { return this.stateDb.raw; }

  readMetadata(objectId: string, threadId?: string): Metadata | undefined {
    const row = (threadId === undefined
      ? this.db.prepare("SELECT payload FROM token_miser_objects WHERE object_id = ?").get(objectId)
      : this.db.prepare("SELECT payload FROM token_miser_objects WHERE object_id = ? AND thread_id = ?").get(objectId, threadId)
    ) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as Metadata : undefined;
  }

  listMetadata(threadId?: string): Metadata[] {
    const rows = (threadId === undefined
      ? this.db.prepare("SELECT payload FROM token_miser_objects ORDER BY created_at DESC").all()
      : this.db.prepare("SELECT payload FROM token_miser_objects WHERE thread_id = ? ORDER BY created_at DESC").all(threadId)
    ) as Array<{ payload: string }>;
    return rows.map(({ payload }) => JSON.parse(payload) as Metadata);
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
    this.db.prepare("UPDATE token_miser_retention SET archived = 0 WHERE thread_key = ? AND archived = 1")
      .run(threadKey);
  }

  archiveThread(threadKey: string, generation: string): void {
    this.db.prepare(`INSERT INTO token_miser_retention (thread_key, generation, archived)
      VALUES (?, ?, 1) ON CONFLICT(thread_key) DO UPDATE SET generation = excluded.generation, archived = 1
      WHERE token_miser_retention.archived = 0`).run(threadKey, generation);
  }

  hasLegacyMigration(migrationKey: string): boolean {
    return Boolean(this.db.prepare("SELECT value FROM meta WHERE key = ?").get(migrationKey));
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
