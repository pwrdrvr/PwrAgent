import { mkdir, readdir, realpath, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AppServerBackendKind,
  RecreateThreadWorktreeResponse,
  WorktreeRecoveryFailureReason,
  WorktreeRecoveryStep,
  WorktreeRecoveryStepId,
} from "@pwragent/shared";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { runGitCommand } from "./git-executable";
import { worktreeArchiveInternals } from "./worktree-archive-service";

type RecordedWorktree = {
  path: string;
  branch?: string;
  locked: boolean;
};

export type RecreateWorktreeParams = {
  backend: AppServerBackendKind;
  threadId: string;
  repositoryPath: string;
  worktreePath: string;
  /** Branch to put back. Undefined, or `detached`, adds a detached HEAD. */
  branch?: string;
  /** The checkpoint PwrAgent recorded when it archived this worktree. */
  checkpoint?: { snapshotRef: string; snapshotCommit: string };
  skipCheckpoint?: boolean;
  detached?: boolean;
  now?: number;
};

const STEP_ORDER: WorktreeRecoveryStepId[] = [
  "check-path",
  "find-checkpoint",
  "clear-record",
  "add-worktree",
  "apply-checkpoint",
];

class RecoveryRefusal extends Error {
  constructor(
    readonly reason: WorktreeRecoveryFailureReason,
    readonly step: WorktreeRecoveryStepId | undefined,
    message: string,
    readonly extra: { branchCheckedOutAt?: string } = {},
  ) {
    super(message);
  }
}

async function pathKind(target: string): Promise<"missing" | "empty-dir" | "occupied"> {
  try {
    const info = await stat(target);
    if (!info.isDirectory()) return "occupied";
    return (await readdir(target)).length === 0 ? "empty-dir" : "occupied";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/**
 * Git records a worktree by its real path, and a deleted folder has none to
 * resolve. Resolve the nearest ancestor that still exists instead, so
 * `/var/...` and `/private/var/...` name the same record on macOS.
 */
async function comparablePath(target: string): Promise<string> {
  const resolved = path.resolve(target);
  const tail: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      return path.join(await realpath(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function parseRecords(output: string): RecordedWorktree[] {
  const records: RecordedWorktree[] = [];
  let current: RecordedWorktree | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), locked: false };
      records.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current && (line === "locked" || line.startsWith("locked "))) {
      current.locked = true;
    }
  }
  return records;
}

/**
 * Puts a deleted worktree back where a thread recorded it, and releases
 * Git's record of a worktree a thread is leaving. Every check runs before the
 * first write, so a refusal leaves the repository as it found it.
 */
export class WorktreeRecoveryService {
  constructor(private readonly options: { gitEnv?: NodeJS.ProcessEnv } = {}) {}

  async recreate(params: RecreateWorktreeParams): Promise<RecreateThreadWorktreeResponse> {
    const worktreePath = path.resolve(params.worktreePath);
    const steps = new Map<WorktreeRecoveryStepId, WorktreeRecoveryStep>();
    const mark = (id: WorktreeRecoveryStepId, status: WorktreeRecoveryStep["status"], detail?: string) => {
      steps.set(id, { id, status, ...(detail ? { detail } : {}) });
    };
    const orderedSteps = () => STEP_ORDER.map((id) => steps.get(id) ?? { id, status: "skipped" as const });
    const detached = params.detached === true || !params.branch;

    try {
      if (await pathKind(params.repositoryPath) === "missing") {
        throw new RecoveryRefusal("repository-missing", undefined, `The main checkout is gone too: ${params.repositoryPath}`);
      }
      const repositoryPath = await realpath(params.repositoryPath);

      const occupancy = await pathKind(worktreePath);
      if (occupancy === "occupied") {
        throw new RecoveryRefusal(
          "path-occupied",
          "check-path",
          "Something now exists at the worktree's path. PwrAgent will not write into a folder it did not create.",
        );
      }
      mark("check-path", "done");

      const checkpoint = params.skipCheckpoint
        ? undefined
        : await this.resolveCheckpoint(repositoryPath, worktreePath, params);
      mark(
        "find-checkpoint",
        checkpoint ? "done" : "skipped",
        checkpoint ? undefined : params.skipCheckpoint ? "Skipped on request." : "No checkpoint was saved.",
      );

      const ownPath = await comparablePath(worktreePath);
      const recorded = await this.listRecords(repositoryPath);
      const ownRecord = (await Promise.all(recorded.map(async (record) => ({
        record, same: (await comparablePath(record.path)) === ownPath,
      })))).find((candidate) => candidate.same)?.record;
      if (ownRecord?.locked) {
        throw new RecoveryRefusal(
          "record-locked",
          "clear-record",
          `Git has a lock on this folder's record. Run git worktree unlock "${worktreePath}" in the main checkout, then try again.`,
        );
      }

      let startPoint: string;
      if (detached) {
        startPoint = checkpoint?.parent
          ?? (params.branch ? await this.resolveCommit(repositoryPath, `refs/heads/${params.branch}`) : undefined)
          ?? await this.resolveCommit(repositoryPath, "HEAD")
          ?? "HEAD";
      } else {
        const branch = params.branch!;
        if (!(await this.resolveCommit(repositoryPath, `refs/heads/${branch}`))) {
          throw new RecoveryRefusal("branch-missing", "add-worktree", `The branch ${branch} no longer exists.`);
        }
        const elsewhere = recorded.find((record) => record !== ownRecord && record.branch === branch);
        if (elsewhere) {
          throw new RecoveryRefusal(
            "branch-checked-out",
            "add-worktree",
            `${branch} is checked out in ${elsewhere.path}. A branch can be checked out in one folder at a time.`,
            { branchCheckedOutAt: elsewhere.path },
          );
        }
        startPoint = branch;
      }

      // Writes start here. An empty folder at the path would keep Git from
      // clearing its record; rmdir refuses anything that is not empty.
      if (occupancy === "empty-dir") {
        await rmdir(worktreePath);
      }
      if (ownRecord) {
        await this.git(repositoryPath, ["worktree", "remove", ownRecord.path]);
        mark("clear-record", "done");
      } else {
        mark("clear-record", "skipped", "Git had no record of the folder.");
      }
      await mkdir(path.dirname(worktreePath), { recursive: true });
      await this.git(repositoryPath, detached
        ? ["worktree", "add", "--detach", worktreePath, startPoint]
        : ["worktree", "add", worktreePath, startPoint]);
      mark("add-worktree", "done");

      const warnings: string[] = [];
      let checkpointResult: Extract<RecreateThreadWorktreeResponse, { status: "recreated" }>["checkpoint"];
      if (checkpoint) {
        const applied = await this.applyCheckpoint(worktreePath, checkpoint.commit);
        if (applied.restored) {
          mark("apply-checkpoint", "done");
        } else {
          mark("apply-checkpoint", "failed", "The branch moved on and the checkpoint conflicts.");
          warnings.push(
            `The checkpoint did not apply cleanly, so nothing was applied. It is kept at ${checkpoint.commit.slice(0, 7)} (${checkpoint.ref}).`,
          );
        }
        checkpointResult = {
          snapshotCommit: checkpoint.commit,
          restored: applied.restored,
          ...(applied.restored ? { changedFileCount: applied.changedFileCount } : {}),
        };
      }

      return {
        status: "recreated",
        backend: params.backend,
        threadId: params.threadId,
        worktreePath,
        ...(detached ? {} : { branch: params.branch }),
        steps: orderedSteps(),
        ...(checkpointResult ? { checkpoint: checkpointResult } : {}),
        warnings,
        completedAt: params.now ?? Date.now(),
      };
    } catch (error) {
      if (!(error instanceof RecoveryRefusal)) throw error;
      if (error.step) mark(error.step, "failed", error.message);
      return {
        status: "failed",
        backend: params.backend,
        threadId: params.threadId,
        worktreePath,
        reason: error.reason,
        message: error.message,
        steps: orderedSteps(),
        ...(params.branch ? { branch: params.branch } : {}),
        ...error.extra,
      };
    }
  }

  /**
   * Clears Git's record of a deleted worktree folder, which otherwise keeps
   * its branch checked out. Returns false when Git had no record of it.
   * Only this one path is touched; never a repository-wide prune.
   */
  async releaseMissingWorktree(params: { repositoryPath: string; worktreePath: string }): Promise<boolean> {
    if (await pathKind(params.worktreePath) !== "missing") {
      throw new Error(`The worktree folder still exists: ${params.worktreePath}`);
    }
    const ownPath = await comparablePath(params.worktreePath);
    for (const record of await this.listRecords(params.repositoryPath)) {
      if ((await comparablePath(record.path)) !== ownPath) continue;
      if (record.locked) {
        throw new Error(`Git has a lock on the record of ${params.worktreePath}.`);
      }
      // Without --force, Git removes only a record whose folder is gone.
      await this.git(params.repositoryPath, ["worktree", "remove", record.path]);
      return true;
    }
    return false;
  }

  private async resolveCheckpoint(
    repositoryPath: string,
    worktreePath: string,
    params: RecreateWorktreeParams,
  ): Promise<{ ref: string; commit: string; parent?: string } | undefined> {
    if (params.checkpoint) {
      const commit = await this.resolveCommit(repositoryPath, params.checkpoint.snapshotRef);
      if (commit !== params.checkpoint.snapshotCommit) {
        throw new RecoveryRefusal(
          "checkpoint-missing",
          "find-checkpoint",
          "The checkpoint saved when this worktree was archived is gone, so its uncommitted changes cannot come back.",
        );
      }
      return { ref: params.checkpoint.snapshotRef, commit, parent: await this.resolveCommit(repositoryPath, `${commit}^1`) };
    }
    // A checkpoint written by an archive whose record was lost is still
    // found by the deterministic ref the archive names after the path.
    for (const candidate of new Set([worktreePath, await comparablePath(worktreePath)])) {
      const ref = worktreeArchiveInternals.snapshotRefForBackend(params.backend, candidate);
      const commit = await this.resolveCommit(repositoryPath, ref);
      if (commit) {
        return { ref, commit, parent: await this.resolveCommit(repositoryPath, `${commit}^1`) };
      }
    }
    return undefined;
  }

  private async applyCheckpoint(
    worktreePath: string,
    commit: string,
  ): Promise<{ restored: boolean; changedFileCount?: number }> {
    const tree = await this.resolveCommit(worktreePath, `${commit}^{tree}`);
    const parentTree = await this.resolveCommit(worktreePath, `${commit}^1^{tree}`);
    if (tree && tree === parentTree) {
      return { restored: true, changedFileCount: 0 };
    }
    try {
      await this.git(worktreePath, ["cherry-pick", "--no-commit", commit]);
    } catch {
      await this.git(worktreePath, ["cherry-pick", "--abort"]).catch(async () => {
        await this.git(worktreePath, ["reset", "--hard", "-q", "HEAD"]);
      });
      return { restored: false };
    }
    // The checkpoint held uncommitted work; leave it uncommitted and unstaged.
    await this.git(worktreePath, ["reset", "-q"]);
    const status = (await this.git(worktreePath, ["status", "--porcelain", "--untracked-files=all"])).stdout;
    return { restored: true, changedFileCount: status.split("\n").filter(Boolean).length };
  }

  private async listRecords(repositoryPath: string): Promise<RecordedWorktree[]> {
    return parseRecords((await this.git(repositoryPath, ["worktree", "list", "--porcelain"])).stdout);
  }

  private async resolveCommit(cwd: string, revision: string): Promise<string | undefined> {
    try {
      return (await this.git(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{object}`])).stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return await runGitCommand(cwd, args, {
      env: buildPwrAgentChildProcessEnv(process.env, this.options.gitEnv),
    });
  }
}
