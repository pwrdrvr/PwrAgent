import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopWorktreeFolderStatus } from "@pwragent/shared/contracts/settings";

/**
 * Written into the worktree folder before its first worktree. Worktrees go
 * straight into the folder, so a folder that already holds other files is
 * refused unless it carries this marker: its subfolders would otherwise look
 * like PwrAgent worktrees to maintenance.
 */
export const WORKTREE_FOLDER_MARKER = ".pwragent-worktrees";

/** Whether the folder is PwrAgent's: marked, or holding nothing but hidden entries. */
export function isWorktreeFolderUsable(entries: readonly string[]): boolean {
  return entries.includes(WORKTREE_FOLDER_MARKER) || entries.every((entry) => entry.startsWith("."));
}

/** Marks the folder as PwrAgent's. Call only after the check said `available`. */
export async function markWorktreeFolder(directory: string): Promise<void> {
  await writeFile(
    path.join(directory, WORKTREE_FOLDER_MARKER),
    "PwrAgent keeps its worktrees in this folder.\n",
    { flag: "wx" },
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}

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
    readDirectory?: (target: string) => Promise<string[]>;
  } = {},
): Promise<DesktopWorktreeFolderStatus> {
  const statDirectory = options.statDirectory ?? stat;
  const readDirectory = options.readDirectory ?? readdir;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<DesktopWorktreeFolderStatus>((resolve) => {
    timer = setTimeout(() => resolve("not-responding"), options.timeoutMs ?? WORKTREE_FOLDER_CHECK_TIMEOUT_MS);
  });
  let checked = runningStats.get(directory);
  if (!checked) {
    checked = statDirectory(directory).then(
      async (info): Promise<DesktopWorktreeFolderStatus> => {
        if (!info.isDirectory()) return "missing";
        return isWorktreeFolderUsable(await readDirectory(directory)) ? "available" : "in-use";
      },
    ).catch((): DesktopWorktreeFolderStatus => "missing");
    runningStats.set(directory, checked);
    void checked.finally(() => runningStats.delete(directory));
  }
  try {
    return await Promise.race([checked, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
