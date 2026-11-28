import Database from "better-sqlite3";
import { attachSqliteWriteMetrics, isSqliteWriteMetricsEnabled } from "./sqlite-write-metrics";

const COOLDOWN_MS = 15 * 60_000;
// Allow the bounded CLI preflight, command and termination to drain if the
// owner exits before recording completion.
const UNCLEAN_EXIT_GRACE_MS = 60_000;

/** A dedicated database keeps usage coordination independent of profile state. */
export async function withAntigravityUsageReservation<T>(
  path: string,
  now: () => number,
  admit: () => boolean,
  read: (markStarted: () => void) => Promise<T>,
): Promise<T | undefined> {
  const db = new Database(path, { timeout: 0 });
  try {
    let previousDeadline: number;
    let setDeadline: (at: number) => void;
    try {
      // The first write takes an exclusive file lock. In this mode SQLite
      // keeps it across commits until close, and the OS releases it on exit.
      db.pragma("locking_mode = EXCLUSIVE");
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = FULL");
      db.exec(`CREATE TABLE IF NOT EXISTS usage_reservation (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), next_at INTEGER NOT NULL
      )`);
      if (isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db, dbPath: path });
      previousDeadline = (db.prepare("SELECT next_at FROM usage_reservation").pluck().get() as number | undefined) ?? 0;
      if (now() < previousDeadline || !admit()) return undefined;
      const write = db.prepare(`INSERT INTO usage_reservation VALUES (1, ?)
        ON CONFLICT (singleton) DO UPDATE SET next_at = excluded.next_at
      `);
      setDeadline = (at) => { write.run(at); };
      setDeadline(now() + COOLDOWN_MS + UNCLEAN_EXIT_GRACE_MS);
    } catch (error) {
      if ((error as { code?: string }).code?.startsWith("SQLITE_BUSY")) return undefined;
      throw error;
    }

    let started = false;
    try {
      return await read(() => { started = true; });
    } finally {
      setDeadline(started ? now() + COOLDOWN_MS : previousDeadline);
    }
  } finally {
    db.close();
  }
}
