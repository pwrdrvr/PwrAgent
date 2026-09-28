import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

export const STORAGE_HISTORY_DEFAULT = false;
export const STORAGE_MIN_BYTES = 100 * 1024 * 1024;
export const STORAGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const STORAGE_GRACE_MS = 7 * STORAGE_INTERVAL_MS;
export const STORAGE_MAINTENANCE_KEY = "storage_maintenance_v1";
export const STORAGE_RETENTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_storage_retention (
  backend TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  PRIMARY KEY (backend, thread_id)
);
`;
export type StorageMaintenanceRecord = {
  /** Explicit checkbox override; absence follows the application default. */
  historyEnabled?: boolean;
  attemptedAt?: number;
  completedAt?: number;
  ownerPid?: number;
};

export function readStorageMaintenance(db: Database.Database): StorageMaintenanceRecord {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(STORAGE_MAINTENANCE_KEY) as { value: string } | undefined;
  try {
    const value = row ? JSON.parse(row.value) : {};
    if (!value || typeof value !== "object") return {};
    return {
      historyEnabled: typeof value.historyEnabled === "boolean" ? value.historyEnabled : undefined,
      attemptedAt: Number.isFinite(value.attemptedAt) ? value.attemptedAt : undefined,
      completedAt: Number.isFinite(value.completedAt) ? value.completedAt : undefined,
      ownerPid: Number.isSafeInteger(value.ownerPid) ? value.ownerPid : undefined,
    };
  } catch { return {}; }
}

export function writeStorageMaintenance(db: Database.Database, state: StorageMaintenanceRecord): void {
  db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(STORAGE_MAINTENANCE_KEY, JSON.stringify(state));
}

export function storageHistoryPolicy(record: StorageMaintenanceRecord, defaultEnabled = STORAGE_HISTORY_DEFAULT) {
  const historyEnabled = record.historyEnabled ?? defaultEnabled;
  return {
    historyEnabled,
    automatic: record.historyEnabled !== undefined || record.attemptedAt !== undefined || historyEnabled,
  };
}

export function setStorageHistoryPreference(db: Database.Database, historyEnabled: boolean): void {
  const record = readStorageMaintenance(db);
  if (record.historyEnabled !== historyEnabled) writeStorageMaintenance(db, { ...record, historyEnabled });
}

export function storageProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function claimStorageMaintenance(db: Database.Database, now = Date.now(), ownerPid = process.pid): boolean {
  return db.transaction(() => {
    const record = readStorageMaintenance(db);
    if ((record.ownerPid && storageProcessAlive(record.ownerPid))
      || (record.attemptedAt !== undefined && now - record.attemptedAt < STORAGE_INTERVAL_MS)) return false;
    writeStorageMaintenance(db, { ...record, attemptedAt: now, ownerPid });
    return true;
  }).immediate();
}

export function compactStorage(db: Database.Database): number {
  db.pragma("auto_vacuum=INCREMENTAL");
  db.exec("VACUUM");
  const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
  if (checkpoint[0].busy !== 0) throw new Error("Storage compaction is waiting for another database reader");
  return (db.pragma("page_count", { simple: true }) as number) * (db.pragma("page_size", { simple: true }) as number);
}

export function fenceStorageRetention(db: Database.Database, identity: StorageThreadIdentity): void {
  if (identity.backend !== "codex") return;
  db.prepare(`INSERT INTO token_miser_retention(thread_key,generation,archived) VALUES (?,?,1)
    ON CONFLICT(thread_key) DO UPDATE SET generation=excluded.generation,archived=1
    WHERE token_miser_retention.archived=0`)
    .run(createHash("sha256").update(identity.threadId).digest("hex"), randomUUID());
}

export function storageMaintenanceDue(input: {
  existingDatabase: boolean; onboardingCompleted: boolean; bytes: number; attemptedAt?: number; now: number;
}): boolean {
  return input.existingDatabase && input.onboardingCompleted && input.bytes >= STORAGE_MIN_BYTES
    && (input.attemptedAt === undefined || input.now - input.attemptedAt >= STORAGE_INTERVAL_MS);
}

/** Only lifecycle events or positive provider observations may call this. */
export function observeStorageArchive(db: Database.Database, backend: string, threadId: string, archived: boolean, now = Date.now(), verifiedArchiveTime = false): void {
  if (archived) {
    if (verifiedArchiveTime) {
      db.prepare(`INSERT INTO thread_storage_retention(backend,thread_id,archived_at) VALUES (?,?,?)
        ON CONFLICT(backend,thread_id) DO UPDATE SET archived_at=excluded.archived_at
        WHERE excluded.archived_at > thread_storage_retention.archived_at`).run(backend, threadId, now);
    } else {
      db.prepare("INSERT OR IGNORE INTO thread_storage_retention(backend,thread_id,archived_at) VALUES (?,?,?)").run(backend, threadId, now);
    }
  } else {
    db.prepare("DELETE FROM thread_storage_retention WHERE backend=? AND thread_id=?").run(backend, threadId);
  }
}

export type StorageThreadIdentity = { backend: string; threadId: string; archivedAt?: number };

export function eligibleStorageThreads(db: Database.Database, archived: StorageThreadIdentity[], now: number): StorageThreadIdentity[] {
  const lookup = db.prepare("SELECT archived_at FROM thread_storage_retention WHERE backend=? AND thread_id=?");
  return archived.filter((identity) => {
    const row = lookup.get(identity.backend, identity.threadId) as { archived_at: number } | undefined;
    return row !== undefined && row.archived_at <= now - STORAGE_GRACE_MS;
  });
}

// Slice indexed candidates by rows and bytes. Keep oversized records intact.
// These explicit column lists must track schema changes; metadata is never deleted.
export function storageDetailStatements(db: Database.Database, identity: StorageThreadIdentity) {
  const operations = [
    {
      codexOnly: false,
      sql: `DELETE FROM thread_tool_invocation_alerts WHERE rowid IN (
        SELECT rowid FROM (
          SELECT rowid, SUM(bytes) OVER (ORDER BY rowid) AS total_bytes FROM (
            SELECT rowid, 192
              + COALESCE(length(CAST(alert_id AS BLOB)),0)
              + COALESCE(length(CAST(backend AS BLOB)),0)
              + COALESCE(length(CAST(thread_id AS BLOB)),0)
              + COALESCE(length(CAST(turn_id AS BLOB)),0)
              + COALESCE(length(CAST(kind AS BLOB)),0)
              + COALESCE(length(CAST(severity AS BLOB)),0)
              + COALESCE(length(CAST(tool_name AS BLOB)),0)
              + COALESCE(length(CAST(session_id AS BLOB)),0)
              + COALESCE(length(CAST(process_id AS BLOB)),0)
              + COALESCE(length(CAST(invocation_ids AS BLOB)),0)
              + COALESCE(length(CAST(worst_invocation_id AS BLOB)),0)
              + COALESCE(length(CAST(message AS BLOB)),0)
              + COALESCE(length(CAST(suggested_prompt AS BLOB)),0) AS bytes
            FROM thread_tool_invocation_alerts WHERE backend=? AND thread_id=? LIMIT ?
          ) WHERE bytes <= 262144
        ) WHERE total_bytes <= 262144
      )`,
    },
    {
      codexOnly: false,
      sql: `DELETE FROM thread_tool_invocations WHERE rowid IN (
        SELECT rowid FROM (
          SELECT rowid, SUM(bytes) OVER (ORDER BY rowid) AS total_bytes FROM (
            SELECT rowid, 192
              + COALESCE(length(CAST(invocation_id AS BLOB)),0)
              + COALESCE(length(CAST(finding_id AS BLOB)),0)
              + COALESCE(length(CAST(backend AS BLOB)),0)
              + COALESCE(length(CAST(thread_id AS BLOB)),0)
              + COALESCE(length(CAST(turn_id AS BLOB)),0)
              + COALESCE(length(CAST(item_id AS BLOB)),0)
              + COALESCE(length(CAST(tool_name AS BLOB)),0)
              + COALESCE(length(CAST(normalized_command AS BLOB)),0)
              + COALESCE(length(CAST(category AS BLOB)),0)
              + COALESCE(length(CAST(status AS BLOB)),0)
              + COALESCE(length(CAST(session_id AS BLOB)),0)
              + COALESCE(length(CAST(process_id AS BLOB)),0)
              + COALESCE(length(CAST(output_state AS BLOB)),0)
              + COALESCE(length(CAST(source AS BLOB)),0)
              + COALESCE(length(CAST(noisy_reason AS BLOB)),0)
              + COALESCE(length(CAST(suggested_prompt AS BLOB)),0) AS bytes
            FROM thread_tool_invocations WHERE backend=? AND thread_id=? LIMIT ?
          ) WHERE bytes <= 262144
        ) WHERE total_bytes <= 262144
      )`,
    },
    {
      codexOnly: false,
      sql: `DELETE FROM thread_tool_analysis WHERE rowid IN (
        SELECT rowid FROM (
          SELECT rowid, SUM(bytes) OVER (ORDER BY rowid) AS total_bytes FROM (
            SELECT rowid, 192
              + COALESCE(length(CAST(backend AS BLOB)),0)
              + COALESCE(length(CAST(thread_id AS BLOB)),0)
              + COALESCE(length(CAST(analyzer_version AS BLOB)),0)
              + COALESCE(length(CAST(completeness AS BLOB)),0)
              + COALESCE(length(CAST(scanned_through AS BLOB)),0)
              + COALESCE(length(CAST(explanation AS BLOB)),0) AS bytes
            FROM thread_tool_analysis WHERE backend=? AND thread_id=? LIMIT ?
          ) WHERE bytes <= 262144
        ) WHERE total_bytes <= 262144
      )`,
    },
    {
      codexOnly: true,
      sql: `DELETE FROM token_miser_objects WHERE rowid IN (
        SELECT rowid FROM (
          SELECT rowid, SUM(bytes) OVER (ORDER BY rowid) AS total_bytes FROM (
            SELECT rowid, 192
              + COALESCE(length(CAST(object_id AS BLOB)),0)
              + COALESCE(length(CAST(thread_id AS BLOB)),0)
              + COALESCE(length(CAST(payload AS BLOB)),0) AS bytes
            FROM token_miser_objects WHERE thread_id=? LIMIT ?
          ) WHERE bytes <= 262144
        ) WHERE total_bytes <= 262144
      )`,
    },
    {
      codexOnly: true,
      sql: `DELETE FROM token_miser_observations WHERE rowid IN (
        SELECT rowid FROM (
          SELECT rowid, SUM(bytes) OVER (ORDER BY rowid) AS total_bytes FROM (
            SELECT rowid, 192
              + COALESCE(length(CAST(observation_id AS BLOB)),0)
              + COALESCE(length(CAST(thread_id AS BLOB)),0)
              + COALESCE(length(CAST(payload AS BLOB)),0) AS bytes
            FROM token_miser_observations WHERE thread_id=? LIMIT ?
          ) WHERE bytes <= 262144
        ) WHERE total_bytes <= 262144
      )`,
    },
  ];
  return operations.filter((operation) => !operation.codexOnly || identity.backend === "codex").map((operation) => ({
    statement: db.prepare(operation.sql),
    parameters: (operation.codexOnly ? [identity.threadId, 128] : [identity.backend, identity.threadId, 128]) as Array<string | number>,
  }));
}
