import type Database from "better-sqlite3";
import type { ArchivedWorktreeRepairReport } from "../app-server/backend-registry";
import { storageProcessAlive } from "./storage-maintenance";

export const ARCHIVED_WORKTREE_REPAIR_KEY = "archived_worktree_repair_v1";

type RepairRecord = { version?: 2 | 3; ownerPid?: number; completedAt?: number; attemptedAt?: number };

function readRecord(db: Database.Database): RepairRecord {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(ARCHIVED_WORKTREE_REPAIR_KEY) as { value: string } | undefined;
  if (!row) return {};
  const value: unknown = JSON.parse(row.value);
  if (!value || typeof value !== "object") throw new Error("Invalid archived worktree repair record.");
  const record = value as RepairRecord;
  if ((record.version !== undefined && record.version !== 2 && record.version !== 3)
    || (record.ownerPid !== undefined && (!Number.isSafeInteger(record.ownerPid) || record.ownerPid <= 0))
    || (record.attemptedAt !== undefined && !Number.isFinite(record.attemptedAt))
    || (record.completedAt !== undefined && !Number.isFinite(record.completedAt))) {
    throw new Error("Invalid archived worktree repair record.");
  }
  return record;
}

function writeRecord(db: Database.Database, record: RepairRecord): void {
  db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(ARCHIVED_WORKTREE_REPAIR_KEY, JSON.stringify(record));
}

/** The version-3 pass includes reloadable ACP checkouts. Reuse the original claim key
 * so older and newer instances cannot run repairs in parallel.
 * One completed pass per profile, with a PID-owned atomic claim and no timer
 * writes. Interrupted discovery resumes on a later startup; individual skips
 * and failures are recorded by the caller and do not create a retry loop. */
export async function runOneTimeArchivedWorktreeRepair(options: {
  db: Database.Database;
  repair: () => Promise<ArchivedWorktreeRepairReport>;
  now?: () => number;
  processId?: number;
  processAlive?: (pid: number) => boolean;
}): Promise<ArchivedWorktreeRepairReport | undefined> {
  const { db } = options;
  const processId = options.processId ?? process.pid;
  const now = options.now ?? Date.now;
  const processAlive = options.processAlive ?? storageProcessAlive;
  const previous = readRecord(db);
  if (previous.version === 3 && previous.completedAt !== undefined) return undefined;
  const acquired = db.transaction(() => {
    const record = readRecord(db);
    if ((record.version === 3 && record.completedAt !== undefined) || (record.ownerPid !== undefined && processAlive(record.ownerPid))) return false;
    writeRecord(db, { version: 3, ownerPid: processId, attemptedAt: now() });
    return true;
  }).immediate();
  if (!acquired) return undefined;
  try {
    const report = await options.repair();
    writeRecord(db, { version: 3, attemptedAt: readRecord(db).attemptedAt, completedAt: now() });
    return report;
  } catch (error) {
    writeRecord(db, { version: 3, attemptedAt: readRecord(db).attemptedAt });
    throw error;
  }
}
