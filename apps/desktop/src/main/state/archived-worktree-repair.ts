import type Database from "better-sqlite3";
import type { ArchivedWorktreeRepairReport } from "../app-server/backend-registry";
import { storageProcessAlive } from "./storage-maintenance";

export const ARCHIVED_WORKTREE_REPAIR_KEY = "archived_worktree_repair_v1";

type RepairRecord = { version?: 2 | 3 | 4; ownerPid?: number; completedAt?: number; attemptedAt?: number };
const REPAIR_VERSION = 4;

function readRecord(db: Database.Database): RepairRecord {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(ARCHIVED_WORKTREE_REPAIR_KEY) as { value: string } | undefined;
  if (!row) return {};
  const value: unknown = JSON.parse(row.value);
  if (!value || typeof value !== "object") throw new Error("Invalid archived worktree repair record.");
  const record = value as RepairRecord;
  if ((record.version !== undefined && record.version !== 2 && record.version !== 3 && record.version !== 4)
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

/** The version-4 pass retries checkouts left by the silent version-3 pass. Reuse the original claim key
 * so older and newer instances cannot run repairs in parallel.
 * One completed pass per profile, with a PID-owned atomic claim and no timer
 * writes. Interrupted discovery resumes on a later startup; individual skips
 * are recorded by the caller. Failed removals leave the pass retryable. */
export async function runOneTimeArchivedWorktreeRepair(options: {
  db: Database.Database;
  repair: () => Promise<ArchivedWorktreeRepairReport>;
  now?: () => number;
  processId?: number;
  processAlive?: (pid: number) => boolean;
  /** Re-audit on operator request, while still respecting a live claim. */
  force?: boolean;
}): Promise<ArchivedWorktreeRepairReport | undefined> {
  const { db } = options;
  const processId = options.processId ?? process.pid;
  const now = options.now ?? Date.now;
  const processAlive = options.processAlive ?? storageProcessAlive;
  const previous = readRecord(db);
  if (!options.force && previous.version === REPAIR_VERSION && previous.completedAt !== undefined) return undefined;
  const acquired = db.transaction(() => {
    const record = readRecord(db);
    if (record.ownerPid !== undefined && processAlive(record.ownerPid)) {
      if (options.force) throw new Error("Archived worktree cleanup is already running in another instance.");
      return false;
    }
    if (!options.force && record.version === REPAIR_VERSION && record.completedAt !== undefined) return false;
    writeRecord(db, { version: REPAIR_VERSION, ownerPid: processId, attemptedAt: now() });
    return true;
  }).immediate();
  if (!acquired) return undefined;
  try {
    const report = await options.repair();
    const failed = [...report.cleanup, ...report.containerCleanup].some((item) => item.error);
    writeRecord(db, { version: REPAIR_VERSION, attemptedAt: readRecord(db).attemptedAt,
      ...(failed ? {} : { completedAt: now() }) });
    return report;
  } catch (error) {
    writeRecord(db, { version: REPAIR_VERSION, attemptedAt: readRecord(db).attemptedAt });
    throw error;
  }
}
