import { lstat } from "node:fs/promises";
import path from "node:path";
import { runGitCommand } from "./git-executable";
import { inspectMaintenanceWorkspace } from "./thread-maintenance-workspace";
import { WORKSPACE_KEEP_REASONS } from "./thread-archive-sweeper";

export const HIBERNATION_WORKSPACE_KEEP_REASONS = {
  missing: "Checkout missing",
  notGit: "Not a Git checkout",
  primary: "Main checkout",
  overLimit: "Changes over the snapshot limit",
  submodule: "Submodule changes",
  operation: "Git operation in progress",
  stash: "Stashed changes",
  locked: "Locked worktree",
  unretained: WORKSPACE_KEEP_REASONS.unretained,
} as const;

/** Marker files and folders Git keeps in a worktree's own git directory
 * while a multi-step command waits for the operator. */
const IN_PROGRESS_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
] as const;

export type HibernationWorkspaceInspection =
  | { keep: string }
  | { keep?: undefined; files: number; bytes: number; removedOutput?: string[] };

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Stash entries are shared by every worktree of a repository. One belongs
 * to this checkout when its message names the branch, or, detached, when it
 * was made on this HEAD. */
export function stashBelongsToCheckout(entry: { firstParent?: string; subject: string }, checkout: { branch?: string; head: string }): boolean {
  if (checkout.branch && (entry.subject.startsWith(`On ${checkout.branch}:`) || entry.subject.startsWith(`WIP on ${checkout.branch}:`))) return true;
  return entry.firstParent === checkout.head;
}

/**
 * Checks 1 to 4 of hibernation, plus the worktree lock from check 5, for one
 * checkout. Any reason to keep it wins; otherwise the size of the snapshot.
 * Ignored files are excluded from the recovery snapshot and removed with the
 * checkout; their presence does not prevent hibernation.
 */
export async function inspectHibernationWorkspace(
  cwd: string,
  options: { signal: AbortSignal; limitBytes: number; removeRebuildableOutput: boolean },
): Promise<HibernationWorkspaceInspection> {
  const inspected = await inspectMaintenanceWorkspace(cwd, {
    signal: options.signal,
    limitBytes: options.limitBytes,
    rebuildableOutputIsClean: true,
  });
  if (inspected.keep !== undefined) return { keep: inspected.keep };
  const workspace = inspected.workspace;
  if (workspace.kind === "missing") return { keep: HIBERNATION_WORKSPACE_KEEP_REASONS.missing };
  if (workspace.kind === "notGit") return { keep: HIBERNATION_WORKSPACE_KEEP_REASONS.notGit };
  if (workspace.kind === "inPlace") return { keep: HIBERNATION_WORKSPACE_KEEP_REASONS.primary };
  if (workspace.kind === "overLimit") return { keep: HIBERNATION_WORKSPACE_KEEP_REASONS.overLimit };

  const git = async (args: string[]) => (await runGitCommand(cwd, args, { signal: options.signal, timeout: 15_000 })).stdout;
  // A submodule with untracked or modified content reports no path to the
  // superproject's diff. Porcelain v2 names it with an S field.
  const status = await git(["status", "--porcelain=v2", "--ignore-submodules=none", "--untracked-files=no"]);
  for (const line of status.split("\n")) {
    const fields = line.split(" ");
    if ((fields[0] === "1" || fields[0] === "2") && fields[2]?.startsWith("S") && fields[2] !== "S...") {
      return { keep: HIBERNATION_WORKSPACE_KEEP_REASONS.submodule };
    }
  }
  const gitDirectory = (await git(["rev-parse", "--absolute-git-dir"])).trim();
  for (const marker of IN_PROGRESS_MARKERS) {
    if (await exists(path.join(gitDirectory, marker))) return { keep: HIBERNATION_WORKSPACE_KEEP_REASONS.operation };
  }
  if (await exists(path.join(gitDirectory, "locked"))) return { keep: HIBERNATION_WORKSPACE_KEEP_REASONS.locked };
  const head = (await git(["rev-parse", "--verify", "HEAD"])).trim();
  let branch: string | undefined;
  try {
    branch = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim() || undefined;
  } catch (error) {
    // symbolic-ref exits 1 for a detached HEAD; anything else fails closed.
    if ((error as { code?: number }).code !== 1) throw error;
  }
  const stashes = await git(["stash", "list", "--format=%H%x00%P%x00%gs"]);
  for (const line of stashes.split("\n").filter(Boolean)) {
    const [, parents = "", subject = ""] = line.split("\0");
    if (stashBelongsToCheckout({ firstParent: parents.split(" ")[0], subject }, { branch, head })) {
      return { keep: HIBERNATION_WORKSPACE_KEEP_REASONS.stash };
    }
  }
  const removedOutput = workspace.rebuildableOutput?.length ? { removedOutput: workspace.rebuildableOutput } : {};
  return workspace.kind === "clean"
    ? { files: 0, bytes: 0, ...removedOutput }
    : { files: workspace.files, bytes: workspace.bytes, ...removedOutput };
}
