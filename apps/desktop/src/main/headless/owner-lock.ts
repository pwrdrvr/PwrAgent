import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/** The lock itself: a SQLite file held under an exclusive OS lock. */
export const HEADLESS_OWNER_LOCK_DATABASE = "owner-lock.db";
/** The file older PwrAgent versions create exclusively. Kept so they refuse to start. */
export const HEADLESS_OWNER_LOCK_MARKER = "owner.lock";
const MARKER_LOCK_KIND = "sqlite-exclusive";
const RECORDED_HOLDER_LIMIT = 16;

export type HeadlessOwnerLock = {
  /**
   * Runtime instances that held this lock before. The OS releases the lock
   * only when its holder closes it or exits, so none of them is running.
   */
  previousInstanceIds: readonly string[];
  /** Persist this owner's runtime instance before it takes any profile lease. */
  record(instanceId: string): void;
  /** Remove the marker, then release the lock. Call after the owner has stopped. */
  release(): void;
};

/**
 * Take the profile's exclusive headless ownership.
 *
 * A PID file cannot do this inside a container: every owner runs as PID 1, so
 * the PID of a dead owner names the live one. The database stays locked for
 * this process's lifetime (`locking_mode = EXCLUSIVE`), and the kernel drops
 * that lock when the process dies, however it dies. A held lock therefore
 * proves a live owner, and a free one proves every earlier holder has exited.
 *
 * `owner.lock` is still written while the lock is held, and removed on a clean
 * stop, so an older version sharing the volume keeps refusing to start. A
 * marker without this version's lock kind may belong to such a version, live
 * or crashed, and is never taken over.
 */
export function acquireHeadlessOwnerLock(
  directory: string,
  options: { processId?: number } = {},
): HeadlessOwnerLock {
  const databasePath = path.join(directory, HEADLESS_OWNER_LOCK_DATABASE);
  const markerPath = path.join(directory, HEADLESS_OWNER_LOCK_MARKER);
  fs.closeSync(fs.openSync(databasePath, "a", 0o600));
  fs.chmodSync(databasePath, 0o600);
  const db = new Database(databasePath, { timeout: 0 });
  let released = false;
  const close = () => {
    if (released) return;
    released = true;
    db.close();
  };
  try {
    db.pragma("locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    close();
    if ((error as { code?: string }).code === "SQLITE_BUSY") {
      throw new Error(`Another headless owner is running for this profile (${databasePath} is locked). Stop it before starting Outpost.`, { cause: error });
    }
    throw error;
  }
  try {
    const marker = readMarker(markerPath);
    if (marker === "foreign") {
      throw new Error(`Headless owner lock already exists: ${markerPath}. An older PwrAgent wrote it; see README crash recovery and never remove a live owner's lock.`);
    }
    db.exec("CREATE TABLE IF NOT EXISTS holders (instance_id TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL)");
    const previousInstanceIds = db.prepare("SELECT instance_id FROM holders ORDER BY recorded_at DESC, rowid DESC").pluck().all() as string[];
    writeMarker(markerPath, options.processId ?? process.pid);
    return {
      previousInstanceIds,
      record(instanceId) {
        if (released) throw new Error("The headless owner lock was released.");
        // One commit per owner start. The exclusive locking mode keeps the
        // lock after this commit, until the connection closes.
        db.prepare("INSERT OR REPLACE INTO holders (instance_id, recorded_at) VALUES (?, ?)").run(instanceId, Date.now());
        db.prepare("DELETE FROM holders WHERE rowid NOT IN (SELECT rowid FROM holders ORDER BY recorded_at DESC, rowid DESC LIMIT ?)").run(RECORDED_HOLDER_LIMIT);
        db.exec("COMMIT");
      },
      release() {
        if (released) return;
        try { fs.rmSync(markerPath, { force: true }); }
        finally { close(); }
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}

function readMarker(markerPath: string): "absent" | "ours" | "foreign" {
  let text: string;
  try { text = fs.readFileSync(markerPath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as { lock?: unknown };
    return parsed.lock === MARKER_LOCK_KIND ? "ours" : "foreign";
  } catch {
    return "foreign";
  }
}

function writeMarker(markerPath: string, processId: number): void {
  // Atomic, so a crash mid-write never leaves a marker that reads as foreign.
  const temporaryPath = `${markerPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ pid: processId, lock: MARKER_LOCK_KIND })}\n`, { mode: 0o600 });
  fs.chmodSync(temporaryPath, 0o600);
  fs.renameSync(temporaryPath, markerPath);
}
