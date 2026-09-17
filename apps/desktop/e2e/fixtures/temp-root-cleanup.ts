// Removing a fixture's temp root on Windows, past the handle release that
// follows a process exit.
//
// Every fixture here builds a disposable root under `os.tmpdir()` and deletes
// it in teardown. Three of them (`electron-app`, `federation-gateway`,
// `branch-drift-fixture`) put a SQLite database inside it, and the profile
// database runs in WAL mode, so the tree carries `state.db` plus its `-wal`
// and `-shm` siblings. Those are the files a teardown loses on Windows.
//
// This is NOT a retry standing in for an ownership fix. Each caller completes
// its own ownership work first -- `electron-app` closes the Playwright-owned
// tree and sweeps detached profile children, `federation-gateway` stops its
// server and closes its `StateDb`. What is left over is the OS: Windows frees
// a handle asynchronously with respect to the exit that released it, and
// Defender routinely opens a transient handle on a file that was just
// written. No amount of process ownership makes either synchronous.
//
// The first attempt is deliberately unretried so that the retry cannot hide a
// regression in that ownership work. A tree that deletes cleanly -- the
// overwhelming majority -- takes that path and pays nothing. Anything else
// warns before retrying, so a teardown that has started needing the retry on
// every test is visible in the run log instead of being silently absorbed.
import { rm } from "node:fs/promises";

/**
 * The errno set `fs.rm` itself retries, and therefore the only set worth
 * retrying here. Node ignores `maxRetries` unless `recursive` is true, which
 * every caller passes.
 */
const RETRYABLE_REMOVAL_CODES = new Set([
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "ENOTEMPTY",
  "EPERM",
]);

/**
 * Node waits `retries * retryDelay` before each attempt, so these bound the
 * retry at 50+100+...+400 = 1.8s. `electron-app`'s
 * `ELECTRON_TEARDOWN_TIMEOUT_MS` is the tightest ceiling any caller has, and
 * its own derivation leaves ~6s over the worst-case close; keep this inside
 * that headroom or move both together.
 */
export const TEMP_ROOT_REMOVAL_MAX_RETRIES = 8;
export const TEMP_ROOT_REMOVAL_RETRY_DELAY_MS = 50;

export type RemoveTempRootOptions = {
  /** Injected by the test; defaults to the harness's own warning channel. */
  warn?: (message: string) => void;
};

export async function removeTempRoot(
  root: string,
  options: RemoveTempRootOptions = {},
): Promise<void> {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  try {
    await rm(root, { force: true, recursive: true });
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === undefined || !RETRYABLE_REMOVAL_CODES.has(code)) {
      throw error;
    }
    warn(
      `[pwragent-e2e-teardown] ${code} removing ${root};`
      + ` retrying up to ${TEMP_ROOT_REMOVAL_MAX_RETRIES} times`,
    );
  }
  // `force` keeps the retry idempotent: the first attempt may already have
  // removed part of the tree, and the entries it did remove must not turn
  // into ENOENT here.
  await rm(root, {
    force: true,
    maxRetries: TEMP_ROOT_REMOVAL_MAX_RETRIES,
    recursive: true,
    retryDelay: TEMP_ROOT_REMOVAL_RETRY_DELAY_MS,
  });
}
