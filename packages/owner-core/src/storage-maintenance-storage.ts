export const STORAGE_HISTORY_DEFAULT = false;
export const STORAGE_MIN_BYTES = 100 * 1024 * 1024;
export const STORAGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type StorageMaintenanceRecord = {
  /** Explicit checkbox override; absence follows the application default. */
  historyEnabled?: boolean;
  attemptedAt?: number;
  completedAt?: number;
  ownerPid?: number;
};

export type StorageThreadIdentity = { backend: string; threadId: string; archivedAt?: number };

/** Main-process maintenance coordination; worker compaction stays host-owned. */
export interface StorageMaintenanceStorage {
  read(): StorageMaintenanceRecord;
  write(record: StorageMaintenanceRecord): void;
  setHistoryPreference(historyEnabled: boolean): void;
  readBytes(): number;
  listRunningProcessIds(): number[];
  observeArchive(backend: string, threadId: string, archived: boolean, now?: number): void;
}

export function storageHistoryPolicy(record: StorageMaintenanceRecord, defaultEnabled = STORAGE_HISTORY_DEFAULT) {
  const historyEnabled = record.historyEnabled ?? defaultEnabled;
  return {
    historyEnabled,
    automatic: record.historyEnabled !== undefined || record.attemptedAt !== undefined || historyEnabled,
  };
}

export function storageMaintenanceDue(input: {
  existingDatabase: boolean; onboardingCompleted: boolean; bytes: number; attemptedAt?: number; now: number;
}): boolean {
  return input.existingDatabase && input.onboardingCompleted && input.bytes >= STORAGE_MIN_BYTES
    && (input.attemptedAt === undefined || input.now - input.attemptedAt >= STORAGE_INTERVAL_MS);
}
