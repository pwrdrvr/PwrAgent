import { stat } from "node:fs/promises";
import path from "node:path";
import type {
  AppServerThreadSummary,
  LinkedDirectorySummary,
  ThreadMissingWorkspace,
} from "@pwragent/shared";

export type MissingThreadWorkspaceProbe = {
  pathExists: (target: string) => Promise<boolean>;
  readBranch: (repositoryPath: string) => Promise<string | undefined>;
};

async function defaultPathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Anything but a confirmed absence is not evidence the folder is gone.
    return true;
  }
}

function namedBranch(value: string | undefined): string | undefined {
  const branch = value?.trim();
  return branch && branch !== "HEAD" ? branch : undefined;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

/** The worktree the thread works in, as the composer's workspace menu sees it. */
export function primaryThreadWorktree(
  thread: Pick<AppServerThreadSummary, "linkedDirectories">,
): (LinkedDirectorySummary & { worktreePath: string }) | undefined {
  const directory = thread.linkedDirectories.find((candidate) => candidate.kind === "worktree");
  return directory?.worktreePath ? { ...directory, worktreePath: directory.worktreePath } : undefined;
}

/**
 * Describes a thread whose recorded worktree folder no longer exists, or
 * returns undefined. One `stat` for the common case; the main checkout's
 * branch is read only once the folder is known to be gone.
 */
export async function detectMissingThreadWorkspace(
  thread: Pick<
    AppServerThreadSummary,
    "linkedDirectories" | "gitBranch" | "observedGitBranch" | "worktreeSnapshots" | "archivedAt"
  >,
  probe: Partial<MissingThreadWorkspaceProbe> = {},
): Promise<ThreadMissingWorkspace | undefined> {
  // Archiving a thread archives its worktree too, and Restore brings it back.
  if (thread.archivedAt !== undefined) return undefined;
  const directory = primaryThreadWorktree(thread);
  if (!directory) return undefined;
  const pathExists = probe.pathExists ?? defaultPathExists;
  if (await pathExists(directory.worktreePath)) return undefined;

  const repositoryAvailable = await pathExists(directory.path);
  const snapshot = [...(thread.worktreeSnapshots ?? [])]
    .filter((candidate) =>
      samePath(candidate.worktreePath, directory.worktreePath)
      && (candidate.state === "archived" || candidate.state === "present"))
    .sort((left, right) => (right.archivedAt ?? right.createdAt) - (left.archivedAt ?? left.createdAt))[0];
  const branch = namedBranch(snapshot?.sourceBranch)
    ?? namedBranch(directory.gitBranch)
    ?? namedBranch(thread.gitBranch)
    ?? namedBranch(thread.observedGitBranch);
  const mainCheckoutBranch = repositoryAvailable && probe.readBranch
    ? await probe.readBranch(directory.path).catch(() => undefined)
    : undefined;

  return {
    worktreePath: directory.worktreePath,
    repositoryPath: directory.path,
    repositoryAvailable,
    ...(branch ? { branch } : {}),
    ...(mainCheckoutBranch ? { mainCheckoutBranch } : {}),
    ...(snapshot
      ? {
          checkpoint: {
            snapshotRef: snapshot.snapshotRef,
            snapshotCommit: snapshot.snapshotCommit,
            ...(snapshot.archivedAt !== undefined ? { archivedAt: snapshot.archivedAt } : {}),
          },
        }
      : {}),
  };
}
