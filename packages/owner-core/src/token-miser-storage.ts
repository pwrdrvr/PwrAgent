export type TokenMiserObjectRecord = {
  objectId: string;
  threadId: string;
  createdAt: number;
};

export type TokenMiserObservationRecord = {
  observationId: string;
  threadId: string;
  createdAt: number;
};

export type TokenMiserRetentionRecord = {
  key: string;
  generation: string;
  archived: number;
};

/** Durable accounting; original outputs and replay buffers stay with the service. */
export interface TokenMiserStorage<
  Metadata extends TokenMiserObjectRecord,
  Observation extends TokenMiserObservationRecord,
> {
  readMetadata(objectId: string, threadId?: string): Metadata | undefined;
  listMetadata(threadId?: string): Metadata[];
  writeMetadata(metadata: Metadata): void;
  removeMetadata(objectId: string): void;
  recordObservation(observation: Observation): void;
  listObservations(threadId?: string): Observation[];
  isArchived(threadKey: string): boolean;
  readRetentionGeneration(threadKey: string): string;
  restoreThread(threadKey: string): void;
  archiveThread(threadKey: string, generation: string): void;
  hasLegacyMigration(migrationKey: string): boolean;
  importLegacyRecords(records: {
    metadata: Metadata[];
    observations: Observation[];
    retention: TokenMiserRetentionRecord[];
  }): void;
  completeLegacyMigration(migrationKey: string): void;
  /** Run synchronous read/modify/write work under one cross-connection write lock. */
  runExclusive<T>(operation: () => T): T;
}
