import { accessSync, constants, mkdtempSync, rmSync, statfsSync } from "node:fs";
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

/** `f_type` that `statfs` reports for tmpfs on Linux. */
const TMPFS_MAGIC = 0x01021994;
/** Free space below which RAM is not worth risking. Docker gives 64 MB. */
const MIN_RAM_ROOT_FREE_BYTES = 1024 * 1024 * 1024;
const LINUX_RAM_ROOT = "/dev/shm";

let tempStateDbRoot: string | undefined;

/**
 * Where temporary database files go: Linux's RAM-backed `/dev/shm` when it is
 * a roomy tmpfs, else the OS temp dir.
 *
 * SQLite fsyncs a file database on journal switches, checkpoints and closes:
 * 16 to 20 times in one open-and-reopen test. On a disk, each fsync can also
 * wait for writeback of other processes' dirty pages. Measured on Sandboxer
 * (8 vCPUs) with 4 Vitest runs and a concurrent buffered writer, fsync took
 * 559 ms at the median and up to 2.8 s. Two reopen tests then took up to 18 s
 * and failed their 5 s timeout in 28 of 48 runs. Tmpfs keeps files, WAL,
 * second connections and reopen, but its fsync returns at once. No test here
 * asserts durability across power loss.
 *
 * macOS and Windows have no such mount and keep the OS temp dir.
 */
function resolveTempStateDbRoot(): string {
  if (tempStateDbRoot !== undefined) return tempStateDbRoot;
  tempStateDbRoot = os.tmpdir();
  if (process.platform === "linux") {
    try {
      const stats = statfsSync(LINUX_RAM_ROOT);
      if (
        stats.type === TMPFS_MAGIC
        && stats.bavail * stats.bsize >= MIN_RAM_ROOT_FREE_BYTES
      ) {
        accessSync(LINUX_RAM_ROOT, constants.W_OK);
        tempStateDbRoot = LINUX_RAM_ROOT;
      }
    } catch {
      // Missing or unwritable: the OS temp dir is the fallback.
    }
  }
  return tempStateDbRoot;
}

export function createTempStateDb(prefix: string): {
  dbPath: string;
  tempDir: string;
} {
  const tempDir = mkdtempSync(path.join(resolveTempStateDbRoot(), prefix));
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
