import { mkdir, readdir, realpath, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AppServerBackendKind,
  RecreateThreadWorktreeResponse,
  WorktreeRecoveryFailureReason,
  WorktreeRecoveryStep,
  WorktreeRecoveryStepId,
} from "@pwragent/shared/contracts/normalized-app-server";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { runGitCommand } from "./git-executable";
import { worktreeArchiveInternals } from "./worktree-archive-service";
import { addManagedWorktree, removeManagedWorktree } from "./managed-worktree";
import { isPwrAgentWorktreeLock } from "./worktree-volume-lock";

type RecordedWorktree = {
  path: string;
  branch?: string;
  locked: boolean;
  lockReason?: string;
};

export type RecreateWorktreeParams = {
  backend: AppServerBackendKind;
  threadId: string;
  repositoryPath: string;
  worktreePath: string;
  /** Branch to put back. Undefined, or `detached`, adds a detached HEAD. */
  branch?: string;
  /** The checkpoint PwrAgent recorded when it archived this worktree. */
  checkpoint?: { snapshotRef: string; snapshotCommit: string; sourceHead?: string };
  skipCheckpoint?: boolean;
  detached?: boolean;
  /** Refuse unless the branch still points here. A hibernated checkout comes
   * back only onto the commit it was saved on. */
  expectedHead?: string;
  /** With `detached`: explicitly choose the commit to check out. */
  startPoint?: string;
  /** Recreate from the best remaining commit when the saved ref or branch is gone. */
  fallbackMissingSources?: boolean;
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
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    if (code === "ENOTDIR") return "occupied";
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
      // Git prints forward slashes on Windows; keep paths native for messages.
      current = { path: path.resolve(line.slice("worktree ".length)), locked: false };
      records.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current && (line === "locked" || line.startsWith("locked "))) {
      current.locked = true;
      if (line.startsWith("locked ")) current.lockReason = line.slice("locked ".length);
    }
  }
  return records;
}

/**
 * Puts a deleted worktree back where a thread recorded it, and releases
 * Git's record of a worktree a thread is leaving. Preflight checks run before
 * the first write, and a clean checkpoint is verified again after checkout.
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
    let detached = params.detached === true || !params.branch;
    const warnings: string[] = [];

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

      const ownPath = await comparablePath(worktreePath);
      const checkpoint = params.skipCheckpoint
        ? undefined
        : await this.resolveCheckpoint(repositoryPath, new Set([worktreePath, ownPath]), params);
      if (params.fallbackMissingSources && params.checkpoint && !checkpoint && !params.skipCheckpoint) {
        warnings.push("The saved checkpoint is unavailable. Its uncommitted changes could not be recovered.");
      }
      mark(
        "find-checkpoint",
        checkpoint ? "done" : "skipped",
        checkpoint ? undefined : params.skipCheckpoint ? "Skipped on request." : "No checkpoint was saved.",
      );
      const cleanCommit = checkpoint && checkpoint.base === checkpoint.commit ? checkpoint.commit : undefined;

      const recorded = await this.listRecords(repositoryPath);
      const ownRecord = (await Promise.all(recorded.map(async (record) => ({
        record, same: (await comparablePath(record.path)) === ownPath,
      })))).find((candidate) => candidate.same)?.record;
      // PwrAgent's own drive lock is cleared below, with the other writes,
      // and only while the drive is attached; a refusal changes nothing.
      const ownLock = ownRecord !== undefined && isPwrAgentWorktreeLock(ownRecord);
      if (ownLock && !await this.driveAttached(worktreePath)) {
        throw new RecoveryRefusal(
          "record-locked",
          "clear-record",
          `The drive that holds ${worktreePath} is not connected. Connect it and try again.`,
        );
      }
      if (ownRecord?.locked && !ownLock) {
        throw new RecoveryRefusal(
          "record-locked",
          "clear-record",
          `Git has a lock on this folder's record. Run git worktree unlock "${worktreePath}" in the main checkout, then try again.`,
        );
      }

      let startPoint: string;
      const branch = params.branch;
      const tip = branch && !detached ? await this.resolveCommit(repositoryPath, `refs/heads/${branch}`) : undefined;
      const elsewhere = tip ? recorded.find((record) => record !== ownRecord && record.branch === branch) : undefined;
      if (!detached && !tip) {
        if (!params.fallbackMissingSources) {
          throw new RecoveryRefusal("branch-missing", "add-worktree", `The branch ${branch} no longer exists.`);
        }
        detached = true;
      }
      if (elsewhere && params.fallbackMissingSources && !params.expectedHead) detached = true;
      if (detached) {
        const start = params.startPoint && params.fallbackMissingSources
          ? await this.resolveCommit(repositoryPath, params.startPoint)
          : params.startPoint;
        const available = start
          ?? checkpoint?.base
          ?? (params.fallbackMissingSources && params.checkpoint?.sourceHead
            ? await this.resolveCommit(repositoryPath, params.checkpoint.sourceHead) : undefined)
          ?? tip
          ?? (branch && params.detached ? await this.resolveCommit(repositoryPath, `refs/heads/${branch}`) : undefined);
        startPoint = available ?? await this.resolveCommit(repositoryPath, "HEAD") ?? "HEAD";
        if (!available && params.fallbackMissingSources) {
          warnings.push("Recreated the worktree detached at the main checkout's current commit.");
        }
      } else {
        if (params.expectedHead && tip !== params.expectedHead) {
          throw new RecoveryRefusal(
            "branch-moved",
            "add-worktree",
            `${branch} moved since its checkout was hibernated. The saved changes are kept in ${checkpoint?.ref ?? "a snapshot"}.`,
          );
        }
        if (cleanCommit && tip !== cleanCommit) {
          await this.assertCleanCheckpointInHistory(repositoryPath, cleanCommit, tip!, branch!);
        }
        if (elsewhere) {
          throw new RecoveryRefusal(
            "branch-checked-out",
            "add-worktree",
            `${branch} is checked out in ${elsewhere.path}. A branch can be checked out in one folder at a time.`,
            { branchCheckedOutAt: elsewhere.path },
          );
        }
        startPoint = branch!;
      }

      // Writes start here. An empty folder at the path would keep Git from
      // clearing its record; rmdir refuses anything that is not empty.
      if (occupancy === "empty-dir") {
        await rmdir(worktreePath);
      }
      if (ownRecord) {
        // The folder may be gone, so the lock comes from Git's record.
        await removeManagedWorktree({
          worktreePath: ownRecord.path, lock: ownRecord, git: (args) => this.git(repositoryPath, args),
        });
        mark("clear-record", "done");
      } else {
        mark("clear-record", "skipped", "Git had no record of the folder.");
      }
      await mkdir(path.dirname(worktreePath), { recursive: true });
      await addManagedWorktree({
        repoRoot: repositoryPath,
        worktreePath,
        addArgs: detached ? ["--detach", worktreePath, startPoint] : [worktreePath, startPoint],
        git: (args) => this.git(repositoryPath, args),
      });
      if (cleanCommit && !detached) {
        try {
          // A branch can move between preflight and Git's worktree add.
          await this.assertCleanCheckpointInHistory(worktreePath, cleanCommit, "HEAD", startPoint);
        } catch (error) {
          // Let Git refuse removal if anything has already edited the new checkout.
          await removeManagedWorktree({ worktreePath, git: (args) => this.git(repositoryPath, args) });
          throw error;
        }
      }
      mark("add-worktree", "done");

      let checkpointResult: Extract<RecreateThreadWorktreeResponse, { status: "recreated" }>["checkpoint"];
      if (checkpoint) {
        const applied = checkpoint.base === checkpoint.commit
          ? { restored: true, changedFileCount: 0 }
          : await this.applyCheckpoint(worktreePath, checkpoint.commit);
        if (applied.restored) {
          mark("apply-checkpoint", "done");
        } else if (params.fallbackMissingSources) {
          // A usable checkpoint must come back before an automatic send.
          // Git refuses removal if the new checkout has been edited.
          await removeManagedWorktree({ worktreePath, git: (args) => this.git(repositoryPath, args) });
          throw new Error("The saved changes did not apply to the restored checkout. They are kept in its snapshot.");
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
      // PwrAgent's own lock is cleared only while its drive is attached.
      if (record.locked && !(isPwrAgentWorktreeLock(record) && await this.driveAttached(params.worktreePath))) {
        throw new Error(`Git has a lock on the record of ${params.worktreePath}.`);
      }
      // Without --force, Git removes only a record whose folder is gone.
      await removeManagedWorktree({
        worktreePath: record.path, lock: record, git: (args) => this.git(params.repositoryPath, args),
      });
      return true;
    }
    return false;
  }

  private async resolveCheckpoint(
    repositoryPath: string,
    worktreePaths: ReadonlySet<string>,
    params: RecreateWorktreeParams,
  ): Promise<{ ref: string; commit: string; base: string } | undefined> {
    if (params.checkpoint) {
      const refCommit = await this.resolveCommit(repositoryPath, params.checkpoint.snapshotRef);
      const { snapshotCommit, snapshotRef } = params.checkpoint;
      const refMatches = refCommit === snapshotCommit;
      const commit = refMatches ? refCommit : params.fallbackMissingSources
        ? await this.resolveCommit(repositoryPath, snapshotCommit) : undefined;
      if (commit !== snapshotCommit) {
        if (params.fallbackMissingSources) return undefined;
        throw new RecoveryRefusal(
          "checkpoint-missing",
          "find-checkpoint",
          "The checkpoint saved when this worktree was archived is gone, so its uncommitted changes cannot come back.",
        );
      }
      // Clean snapshots pin the saved HEAD itself. Dirty snapshots add a
      // commit on top of it. Older records may only have the snapshot commit.
      const base = params.checkpoint.sourceHead ?? await this.inferCheckpointBase(repositoryPath, commit, worktreePaths);
      return { ref: refMatches ? snapshotRef : commit, commit, base };
    }
    // A checkpoint written by an archive whose record was lost is still
    // found by the deterministic ref the archive names after the path.
    for (const candidate of worktreePaths) {
      const ref = worktreeArchiveInternals.snapshotRefForBackend(params.backend, candidate);
      const commit = await this.resolveCommit(repositoryPath, ref);
      if (commit) {
        return { ref, commit, base: await this.inferCheckpointBase(repositoryPath, commit, worktreePaths) };
      }
    }
    return undefined;
  }

  private async inferCheckpointBase(repositoryPath: string, commit: string, worktreePaths: ReadonlySet<string>): Promise<string> {
    // The archive writes paths as UTF-8. Read the commit without log recoding.
    const { stdout } = await this.git(repositoryPath, ["cat-file", "commit", commit]);
    const messageStart = stdout.indexOf("\n\n");
    if (messageStart === -1) return commit;
    const parents = stdout.slice(0, messageStart).split("\n").filter((line) => line.startsWith("parent "));
    if (parents.length !== 1) return commit;
    const parent = parents[0]!.slice("parent ".length);
    const message = stdout.slice(messageStart + 2).trimEnd();
    const subjectEnd = message.indexOf("\n");
    const subjectPrefix = worktreeArchiveInternals.snapshotCommitSubjectPrefix;
    if (subjectEnd === -1 || !message.startsWith(subjectPrefix)) return commit;
    if (!message.slice(subjectPrefix.length, subjectEnd).includes(":")) return commit;

    // A synthetic snapshot names this checkout and its single parent. Keep
    // the pinned commit intact when those fields do not identify saved edits.
    const body = message.slice(subjectEnd + 1);
    for (const worktreePath of worktreePaths) {
      const worktreeLine = `Worktree: ${worktreePath}\n`;
      if (!body.startsWith(worktreeLine)) continue;
      const details = body.slice(worktreeLine.length);
      const source = details.startsWith("Branch: ") ? details.slice(details.indexOf("\n") + 1) : details;
      if (source === `Source HEAD: ${parent}`) return parent;
    }
    return commit;
  }

  private async assertCleanCheckpointInHistory(cwd: string, commit: string, tip: string, branch: string): Promise<void> {
    try {
      await this.git(cwd, ["merge-base", "--is-ancestor", commit, tip]);
    } catch (error) {
      if ((error as { code?: number }).code !== 1) throw error;
      throw new RecoveryRefusal("branch-moved", "add-worktree", `The branch ${branch} no longer contains the saved commit.`);
    }
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

  /**
   * A missing folder under a lock PwrAgent set is usually an unplugged drive.
   * PwrAgent's lock may be cleared only when the folder's `<hash>` container
   * still exists, which shows the drive is attached and the checkout is gone.
   */
  private async driveAttached(worktreePath: string): Promise<boolean> {
    return await pathKind(path.dirname(worktreePath)) !== "missing";
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
