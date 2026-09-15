import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateDb } from "../state/state-db";

/**
 * A private database that never touches the filesystem — the default for a
 * suite whose database is created, used and discarded inside one test.
 *
 * Use `createTempStateDb` instead when the test needs a real file. A
 * `:memory:` database is private to its one connection and disappears on
 * close, so these four cases are silently wrong against it — they keep
 * passing while asserting nothing:
 *
 * - **Reopening a path.** A second `:memory:` open is a second empty
 *   database, not the one just closed, so a persistence or migration
 *   assertion holds vacuously.
 * - **A second connection.** Cross-connection visibility, `data_version`
 *   change detection and `busy_timeout` contention cannot happen.
 * - **File semantics.** `journal_mode = WAL` silently stays `memory`, and
 *   VACUUM, `auto_vacuum` and file-size assertions have no file to act on.
 * - **Write budgets.** `attachSqliteWriteMetrics` resolves no WAL path for
 *   `:memory:`, so `expectSqliteWriteBudget` records `observedWalBytes: 0`
 *   and the MB/day figure the budget exists to carry is lost.
 */
export function openInMemoryStateDb(options?: {
  profileName?: string;
}): StateDb {
  return StateDb.open(":memory:", options);
}

export function createTempStateDb(prefix: string): {
  dbPath: string;
  tempDir: string;
} {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dbPath: path.join(tempDir, "state.db"),
    tempDir,
  };
}

export function removeTempStateDbDir(tempDir: string): void {
  rmSync(tempDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
