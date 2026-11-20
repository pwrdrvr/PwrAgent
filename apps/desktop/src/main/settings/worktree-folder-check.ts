import { stat } from "node:fs/promises";
import type { DesktopWorktreeFolderStatus } from "@pwragent/shared";

/** Long enough for a sleeping drive to spin up, short enough for Settings. */
export const WORKTREE_FOLDER_CHECK_TIMEOUT_MS = 3_000;

/**
 * Stats still running, by folder. A stat on a stale mount holds one of
 * libuv's few threadpool threads until it returns, so repeated checks (every
 * window focus) join the running stat instead of starting another; otherwise
 * they would take every thread and stall all async filesystem work.
 */
const runningStats = new Map<string, Promise<DesktopWorktreeFolderStatus>>();

/**
 * Checks the operator's worktree folder without blocking the main process.
 * A stat on a stale network mount can hang for a long time, so the answer is
 * `not-responding` once the timeout passes; the stat itself is left to finish
 * on its own.
 */
export async function checkWorktreeFolder(
  directory: string,
  options: {
    timeoutMs?: number;
    /** Test seam for a stat that never settles. */
    statDirectory?: (target: string) => Promise<{ isDirectory(): boolean }>;
  } = {},
): Promise<DesktopWorktreeFolderStatus> {
  const statDirectory = options.statDirectory ?? stat;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<DesktopWorktreeFolderStatus>((resolve) => {
    timer = setTimeout(() => resolve("not-responding"), options.timeoutMs ?? WORKTREE_FOLDER_CHECK_TIMEOUT_MS);
  });
  let checked = runningStats.get(directory);
  if (!checked) {
    checked = statDirectory(directory).then(
      (info): DesktopWorktreeFolderStatus => (info.isDirectory() ? "available" : "missing"),
      (): DesktopWorktreeFolderStatus => "missing",
    );
    runningStats.set(directory, checked);
    void checked.finally(() => runningStats.delete(directory));
  }
  try {
    return await Promise.race([checked, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
