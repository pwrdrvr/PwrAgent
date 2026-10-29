import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AppServerBackendKind,
  DesktopWorktreeStorageLocation,
  HandoffThreadWorkspaceResponse,
  LinkedDirectorySummary,
  ThreadIdentifier,
  ThreadWorkspaceHandoffDirection,
  ThreadWorkspaceHandoffStrategy,
  ThreadWorkspaceHandoffStashSummary,
} from "@pwragent/shared";
import { DESKTOP_WORKTREE_STORAGE_DEFAULT } from "@pwragent/shared";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import {
  computeWorktreePath,
  inspectGitWorkspace,
  releaseWorktreePathReservation,
} from "./git-directory-service";
import { WorktreeArchiveService } from "./worktree-archive-service";
import { runGitCommand } from "./git-executable";

const DETACHED_HEAD_LEAVE_LOCAL_BRANCH = "HEAD";

// Directory/worktree identifiers surfaced in the handoff response are returned
// as stable string keys. `path.resolve`/`computeWorktreePath` emit backslashes
// on Windows, so forward-slash these RETURNED identifier strings on all
// platforms (no-op on POSIX). This only touches the response object built at
// the very end of each handoff path — the native paths used for git/fs
// operations inside the handoff stay native.
function toForwardSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function toForwardSlashesOptional(
  value: string | undefined,
): string | undefined {
  return value === undefined ? undefined : toForwardSlashes(value);
}

async function releaseReservationAndRethrow(
  targetPath: string,
  error: unknown,
): Promise<never> {
  await releaseWorktreePathReservation(targetPath);
  throw error;
}

function normalizeHandoffResponseIdentifiers(
  response: HandoffThreadWorkspaceResponse,
): HandoffThreadWorkspaceResponse {
  return {
    ...response,
    repositoryPath: toForwardSlashes(response.repositoryPath),
    targetPath: toForwardSlashes(response.targetPath),
    linkedDirectory: {
      ...response.linkedDirectory,
      path: toForwardSlashes(response.linkedDirectory.path),
      worktreePath: toForwardSlashesOptional(
        response.linkedDirectory.worktreePath,
      ),
    },
    archivedSourceWorktree: response.archivedSourceWorktree
      ? {
          ...response.archivedSourceWorktree,
          worktreePath: toForwardSlashes(
            response.archivedSourceWorktree.worktreePath,
          ),
        }
      : response.archivedSourceWorktree,
  };
}

type GitResult = {
  stdout: string;
  stderr: string;
};

type WorktreeInfo = {
  path: string;
  branch?: string;
};

type HandoffParams = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  direction: ThreadWorkspaceHandoffDirection;
  targetPath?: string;
  strategy?: ThreadWorkspaceHandoffStrategy;
  repositoryPath?: string;
  sourcePath?: string;
  sourceWorkMode?: "local" | "worktree";
  workspacePaths?: string[];
  workspaceDirectories?: LinkedDirectorySummary[];
  sourceBranch?: string;
  leaveLocalBranch?: string;
  newBranchName?: string;
  /** Start the new worktree here and leave the source untouched. */
  baseRef?: string;
  /**
   * worktree-to-worktree only: leave the previous worktree on disk instead of
   * archiving it, because this thread does not own it.
   */
  keepSourceWorktree?: boolean;
  now?: number;
};

type HandoffContext = {
  backend: AppServerBackendKind;
  headSha: string;
  threadId: ThreadIdentifier;
  repositoryPath: string;
  sourcePath: string;
  branch: string;
  worktrees: WorktreeInfo[];
  now: number;
};

type StashOptions = {
  message: string;
  path: string;
  gitEnv?: NodeJS.ProcessEnv;
};

type WorkspaceHandoffServiceOptions = {
  worktreeArchiveService?: WorktreeArchiveService;
  gitEnv?: NodeJS.ProcessEnv;
  resolveWorktreeStorage?: () =>
    | DesktopWorktreeStorageLocation
    | Promise<DesktopWorktreeStorageLocation>;
  homeDir?: string;
};

async function runGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  return await runGitCommand(cwd, args, {
    env: buildPwrAgentChildProcessEnv(env ?? process.env),
    maxBuffer: 1024 * 1024 * 10,
  });
}

function trim(value: string): string {
  return value.trim();
}

function sanitizeBranchName(value: string): string {
  return value
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "");
}

function pathBaseName(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized;
}

function parseWorktreeList(output: string): WorktreeInfo[] {
  const entries: WorktreeInfo[] = [];
  let current: WorktreeInfo | undefined;

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      if (current) {
        entries.push(current);
      }
      current = undefined;
      continue;
    }

    if (line.startsWith("worktree ")) {
      if (current) {
        entries.push(current);
      }
      current = {
        path: line.slice("worktree ".length).trim(),
      };
      continue;
    }

    if (current && line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}

function findWorktree(
  worktrees: WorktreeInfo[],
  targetPath: string,
): WorktreeInfo | undefined {
  const resolved = path.resolve(targetPath);
  return worktrees.find((worktree) => path.resolve(worktree.path) === resolved);
}

function ensureBranchNotCheckedOutElsewhere(params: {
  allowedPath: string;
  branch: string;
  worktrees: WorktreeInfo[];
}): void {
  const occupied = params.worktrees.find(
    (worktree) =>
      worktree.branch === params.branch &&
      path.resolve(worktree.path) !== path.resolve(params.allowedPath),
  );
  if (occupied) {
    throw new Error(
      `Branch ${params.branch} is already checked out at ${occupied.path}.`,
    );
  }
}

async function createNamedStashIfDirty(
  options: StashOptions,
): Promise<ThreadWorkspaceHandoffStashSummary | undefined> {
  const status = await getDirtyStatus(options.path, options.gitEnv);
  if (!status) {
    return undefined;
  }

  await runGit(
    options.path,
    ["stash", "push", "--include-untracked", "-m", options.message],
    options.gitEnv,
  );
  const ref = trim(
    (await runGit(options.path, ["rev-parse", "--verify", "stash@{0}"], options.gitEnv))
      .stdout,
  );

  return {
    ref,
    message: options.message,
    path: options.path,
    applied: false,
    dropped: false,
  };
}

async function getDirtyStatus(
  workspacePath: string,
  gitEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  return trim(
    (await runGit(
      workspacePath,
      ["status", "--porcelain", "--untracked-files=normal"],
      gitEnv,
    ))
      .stdout,
  );
}

async function assertLocalCleanForDestinationHandoff(
  repositoryPath: string,
  gitEnv?: NodeJS.ProcessEnv,
): Promise<void> {
  if (await getDirtyStatus(repositoryPath, gitEnv)) {
    throw new Error(
      "Local has dirty tracked or untracked changes. Commit, stash, or discard them before handing a worktree back to Local.",
    );
  }
}

async function dropStashByCommit(
  cwd: string,
  commit: string,
  gitEnv?: NodeJS.ProcessEnv,
): Promise<void> {
  const stashList = (
    await runGit(cwd, ["stash", "list", "--format=%H%x00%gd"], gitEnv)
  ).stdout.split("\n");
  const match = stashList.flatMap((line) => {
    const [sha, ref] = line.split("\0");
    return sha === commit && ref ? [ref] : [];
  })[0];

  if (!match) {
    return;
  }

  await runGit(cwd, ["stash", "drop", match], gitEnv);
}

async function validateBranchName(
  cwd: string,
  branch: string,
  gitEnv?: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await runGit(cwd, ["check-ref-format", "--branch", branch], gitEnv);
  } catch {
    throw new Error(`Invalid branch name: ${branch}`);
  }
}

async function branchExists(
  cwd: string,
  branch: string,
  gitEnv?: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    await runGit(
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      gitEnv,
    );
    return true;
  } catch {
    return false;
  }
}

async function applyVerifyAndDropStash(
  cwd: string,
  stash: ThreadWorkspaceHandoffStashSummary | undefined,
  gitEnv?: NodeJS.ProcessEnv,
): Promise<ThreadWorkspaceHandoffStashSummary | undefined> {
  if (!stash?.ref) {
    return stash;
  }

  await runGit(cwd, ["stash", "apply", stash.ref], gitEnv);
  await dropStashByCommit(cwd, stash.ref, gitEnv);

  return {
    ...stash,
    path: cwd,
    applied: true,
    dropped: true,
  };
}

export class GitWorkspaceHandoffService {
  private readonly worktreeArchiveService: WorktreeArchiveService;
  private readonly resolveStorage: () => Promise<DesktopWorktreeStorageLocation>;
  private readonly gitEnv?: NodeJS.ProcessEnv;
  private readonly homeDir: string | undefined;

  constructor(options: WorkspaceHandoffServiceOptions = {}) {
    this.worktreeArchiveService =
      options.worktreeArchiveService ?? new WorktreeArchiveService();
    const resolveStorage = options.resolveWorktreeStorage;
    this.resolveStorage = async () =>
      (await resolveStorage?.()) ?? DESKTOP_WORKTREE_STORAGE_DEFAULT;
    this.gitEnv = options.gitEnv;
    this.homeDir = options.homeDir;
  }

  async handoff(params: HandoffParams): Promise<HandoffThreadWorkspaceResponse> {
    const response =
      params.baseRef?.trim()
        ? await this.handoffToFreshWorktree(params)
        : params.direction === "to-project"
        ? await this.handoffToProject(params)
        : params.direction === "local-to-worktree"
          ? await this.handoffLocalToWorktree(params)
          : params.direction === "worktree-to-worktree"
            ? await this.handoffWorktreeToNewWorktree(params)
            : await this.handoffWorktreeToLocal(params);
    return normalizeHandoffResponseIdentifiers(response);
  }

  private async handoffToProject(params: HandoffParams): Promise<HandoffThreadWorkspaceResponse> {
    if (!params.targetPath?.trim() || !path.isAbsolute(params.targetPath.trim())) {
      throw new Error("Move to Project requires an absolute destination directory.");
    }
    let targetPath = await realpath(params.targetPath.trim());
    if (!(await stat(targetPath)).isDirectory()) {
      throw new Error("Move to Project requires an existing directory.");
    }
    const inspection = await inspectGitWorkspace(targetPath, { env: this.gitEnv });
    if (inspection.kind !== "worktree") {
      throw new Error("Select a Git project checkout or worktree as the destination.");
    }
    const worktrees = parseWorktreeList(
      (await runGit(targetPath, ["worktree", "list", "--porcelain"], this.gitEnv)).stdout,
    );
    const repositoryPath = worktrees[0]?.path;
    if (!repositoryPath) {
      throw new Error("Cannot resolve the destination repository.");
    }
    const workspacePath = trim(
      (await runGit(targetPath, ["rev-parse", "--show-toplevel"], this.gitEnv)).stdout,
    );
    if (path.resolve(workspacePath) !== path.resolve(targetPath)) {
      throw new Error("Select the root of the destination checkout or worktree.");
    }
    let createdWorktree = false;
    if (path.resolve(repositoryPath) === path.resolve(targetPath)) {
      // A project root identifies the repository. Keep the conversation in
      // its already-linked worktree instead of silently switching to Local.
      const linkedPaths = await Promise.all((params.workspacePaths ?? [])
        .map((workspacePath) => realpath(workspacePath).catch(() => undefined)));
      const candidates = worktrees.filter((worktree) =>
        path.resolve(worktree.path) !== path.resolve(repositoryPath)
        && linkedPaths.some((linkedPath) => linkedPath && path.resolve(linkedPath) === path.resolve(worktree.path)),
      );
      if (candidates.length > 1) {
        throw new Error("This thread has multiple worktrees in the destination project. Select the worktree root to continue in.");
      }
      if (candidates[0]) {
        targetPath = candidates[0].path;
      } else if (params.sourceWorkMode === "worktree") {
        targetPath = await computeWorktreePath({
          backend: params.backend, repoRoot: repositoryPath,
          storage: await this.resolveStorage(), homeDir: this.homeDir, timestamp: params.now,
        });
        try {
          await runGit(repositoryPath, ["worktree", "add", "--detach", targetPath, "HEAD"], this.gitEnv);
        } catch (error) {
          await releaseReservationAndRethrow(targetPath, error);
        }
        createdWorktree = true;
      }
    }
    const isWorktree = path.resolve(repositoryPath) !== path.resolve(targetPath);
    const knownDirectories = isWorktree && !createdWorktree
      ? await Promise.all((params.workspaceDirectories ?? [])
          .filter((directory) => directory.kind === "worktree")
          .map(async (directory) => ({
            path: await realpath(directory.worktreePath ?? directory.path).catch(() => undefined),
            ownership: directory.worktreeOwnership,
          })))
      : [];
    const targetDirectories = knownDirectories.filter((directory) =>
      directory.path && path.resolve(directory.path) === path.resolve(targetPath),
    );
    const threadOwnsWorktree = createdWorktree
      || (targetDirectories.length > 0 && targetDirectories.every((directory) => directory.ownership !== "external"));
    const branch = createdWorktree ? "HEAD" : targetPath === workspacePath
      ? inspection.branch
      : trim((await runGit(targetPath, ["rev-parse", "--abbrev-ref", "HEAD"], this.gitEnv)).stdout);
    return {
      backend: params.backend,
      threadId: params.threadId,
      direction: "to-project",
      workMode: isWorktree ? "worktree" : "local",
      branch,
      repositoryPath,
      targetPath,
      linkedDirectory: {
        id: `pwragent-handoff:${params.backend}:${params.threadId}`,
        label: pathBaseName(repositoryPath),
        path: repositoryPath,
        kind: isWorktree ? "worktree" : "local",
        ...(isWorktree ? {
          worktreePath: targetPath,
          ...(!threadOwnsWorktree ? { worktreeOwnership: "external" as const } : {}),
        } : {}),
      },
      warnings: [],
      completedAt: params.now ?? Date.now(),
    };
  }

  private async buildContext(params: HandoffParams): Promise<HandoffContext> {
    const rawSourcePath = params.sourcePath ?? params.repositoryPath;
    if (!rawSourcePath?.trim()) {
      throw new Error("Workspace handoff requires a source path.");
    }
    const sourcePath = await realpath(path.resolve(rawSourcePath));
    const repositoryPath = await realpath(
      path.resolve(
        params.repositoryPath ??
          trim(
            (await runGit(
              sourcePath,
              ["rev-parse", "--show-toplevel"],
              this.gitEnv,
            )).stdout,
          ),
      ),
    );
    const worktrees = parseWorktreeList(
      (await runGit(repositoryPath, ["worktree", "list", "--porcelain"], this.gitEnv))
        .stdout,
    );
    const observedBranch = sanitizeBranchName(
      trim(
        (await runGit(
          sourcePath,
          ["rev-parse", "--abbrev-ref", "HEAD"],
          this.gitEnv,
        )).stdout,
      ),
    );
    const branch =
      observedBranch === "HEAD"
        ? "HEAD"
        : sanitizeBranchName(params.sourceBranch ?? "") || observedBranch;
    const headSha = trim(
      (await runGit(
        sourcePath,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        this.gitEnv,
      )).stdout,
    );

    if (!branch) {
      throw new Error("Workspace handoff requires a named source branch.");
    }

    if (!findWorktree(worktrees, sourcePath)) {
      throw new Error(`Source workspace is not registered with Git: ${sourcePath}`);
    }

    return {
      backend: params.backend,
      headSha,
      threadId: params.threadId,
      repositoryPath,
      sourcePath,
      branch,
      worktrees,
      now: params.now ?? Date.now(),
    };
  }

  private async handoffLocalToWorktree(
    params: HandoffParams,
  ): Promise<HandoffThreadWorkspaceResponse> {
    const context = await this.buildContext(params);
    if (path.resolve(context.repositoryPath) !== path.resolve(context.sourcePath)) {
      throw new Error("Local-to-worktree handoff must start from the local checkout.");
    }

    const strategy = params.strategy ?? "move-branch";
    if (strategy === "detached-changes") {
      return await this.handoffLocalChangesToDetachedWorktree(params, context);
    }
    if (strategy === "new-branch") {
      return await this.handoffLocalChangesToNewBranchWorktree(params, context);
    }

    if (context.branch === "HEAD") {
      throw new Error("Local-to-worktree handoff requires a named source branch.");
    }

    ensureBranchNotCheckedOutElsewhere({
      allowedPath: context.sourcePath,
      branch: context.branch,
      worktrees: context.worktrees,
    });

    const rawLeaveLocalBranch = params.leaveLocalBranch?.trim() ?? "";
    const leaveLocalDetached = rawLeaveLocalBranch === DETACHED_HEAD_LEAVE_LOCAL_BRANCH;
    const leaveLocalBranch = leaveLocalDetached
      ? DETACHED_HEAD_LEAVE_LOCAL_BRANCH
      : sanitizeBranchName(rawLeaveLocalBranch);
    if (!leaveLocalBranch) {
      throw new Error("Choose a branch to leave in Local before handoff.");
    }
    if (!leaveLocalDetached && leaveLocalBranch === context.branch) {
      throw new Error("Local cannot be left on the same branch being moved.");
    }

    const storage = await this.resolveStorage();
    const targetPath = await computeWorktreePath({
      backend: context.backend,
      repoRoot: context.repositoryPath,
      storage,
      homeDir: this.homeDir,
      timestamp: context.now,
    });

    const warnings = ["Ignored files are not preserved by workspace handoff."];
    if (leaveLocalDetached) {
      warnings.push("Local was left on a detached HEAD at the moved branch commit.");
    }
    const sourceStash = await createNamedStashIfDirty({
      gitEnv: this.gitEnv,
      path: context.sourcePath,
      message: this.buildStashMessage(context, "source"),
    }).catch((error) => releaseReservationAndRethrow(targetPath, error));
    await runGit(
      context.sourcePath,
      leaveLocalDetached
        ? ["switch", "--detach", context.headSha]
        : ["switch", leaveLocalBranch],
      this.gitEnv,
    ).catch((error) => releaseReservationAndRethrow(targetPath, error));
    await mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await runGit(
        context.repositoryPath,
        ["worktree", "add", targetPath, context.branch],
        this.gitEnv,
      );
    } catch (error) {
      await releaseWorktreePathReservation(targetPath);
      throw error;
    }
    const appliedSourceStash = await applyVerifyAndDropStash(
      targetPath,
      sourceStash,
      this.gitEnv,
    );

    const linkedDirectory = this.buildLinkedDirectory({
      context,
      kind: "worktree",
      targetPath,
    });

    return {
      backend: context.backend,
      threadId: context.threadId,
      direction: "local-to-worktree",
      strategy: "move-branch",
      workMode: "worktree",
      branch: context.branch,
      repositoryPath: context.repositoryPath,
      targetPath,
      linkedDirectory,
      sourceStash: appliedSourceStash,
      warnings,
      completedAt: context.now,
    };
  }

  private async handoffLocalChangesToNewBranchWorktree(
    params: HandoffParams,
    context: HandoffContext,
  ): Promise<HandoffThreadWorkspaceResponse> {
    const baseSha = context.headSha;
    const newBranchName = (params.newBranchName ?? "").trim();
    if (!newBranchName) {
      throw new Error("Choose a new branch name for handoff.");
    }
    if (newBranchName === context.branch) {
      throw new Error("New branch name must differ from the current branch.");
    }
    await validateBranchName(context.repositoryPath, newBranchName, this.gitEnv);
    if (await branchExists(context.repositoryPath, newBranchName, this.gitEnv)) {
      throw new Error(`Branch ${newBranchName} already exists.`);
    }

    const storage = await this.resolveStorage();
    const targetPath = await computeWorktreePath({
      backend: context.backend,
      repoRoot: context.repositoryPath,
      storage,
      homeDir: this.homeDir,
      timestamp: context.now,
    });

    const warnings = [
      "Ignored files are not preserved by workspace handoff.",
      `The new worktree starts from ${context.branch} at the current commit.`,
    ];
    const sourceStash = await createNamedStashIfDirty({
      gitEnv: this.gitEnv,
      path: context.sourcePath,
      message: this.buildStashMessage(context, "source"),
    }).catch((error) => releaseReservationAndRethrow(targetPath, error));
    if (!sourceStash) {
      warnings.push("No dirty non-ignored changes were available to move.");
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await runGit(
        context.repositoryPath,
        ["worktree", "add", "-b", newBranchName, targetPath, baseSha],
        this.gitEnv,
      );
    } catch (error) {
      await releaseWorktreePathReservation(targetPath);
      throw error;
    }
    const appliedSourceStash = await applyVerifyAndDropStash(
      targetPath,
      sourceStash,
      this.gitEnv,
    );

    const linkedDirectory = this.buildLinkedDirectory({
      context,
      kind: "worktree",
      targetPath,
    });

    return {
      backend: context.backend,
      threadId: context.threadId,
      direction: params.direction,
      strategy: "new-branch",
      workMode: "worktree",
      branch: newBranchName,
      baseSha,
      repositoryPath: context.repositoryPath,
      targetPath,
      linkedDirectory,
      sourceStash: appliedSourceStash,
      warnings,
      completedAt: context.now,
    };
  }

  private async handoffLocalChangesToDetachedWorktree(
    params: HandoffParams,
    context: HandoffContext,
  ): Promise<HandoffThreadWorkspaceResponse> {
    const baseSha = context.headSha;
    const storage = await this.resolveStorage();
    const targetPath = await computeWorktreePath({
      backend: context.backend,
      repoRoot: context.repositoryPath,
      storage,
      homeDir: this.homeDir,
      timestamp: context.now,
    });

    const warnings = [
      "Ignored files are not preserved by workspace handoff.",
      "The new worktree starts detached at the current branch tip.",
    ];
    const sourceStash = await createNamedStashIfDirty({
      gitEnv: this.gitEnv,
      path: context.sourcePath,
      message: this.buildStashMessage(context, "source"),
    }).catch((error) => releaseReservationAndRethrow(targetPath, error));
    if (!sourceStash) {
      warnings.push("No dirty non-ignored changes were available to move.");
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await runGit(
        context.repositoryPath,
        ["worktree", "add", "--detach", targetPath, baseSha],
        this.gitEnv,
      );
    } catch (error) {
      await releaseWorktreePathReservation(targetPath);
      throw error;
    }
    const appliedSourceStash = await applyVerifyAndDropStash(
      targetPath,
      sourceStash,
      this.gitEnv,
    );

    const linkedDirectory = this.buildLinkedDirectory({
      context,
      kind: "worktree",
      targetPath,
    });

    return {
      backend: context.backend,
      threadId: context.threadId,
      direction: params.direction,
      strategy: "detached-changes",
      workMode: "worktree",
      baseSha,
      repositoryPath: context.repositoryPath,
      targetPath,
      linkedDirectory,
      sourceStash: appliedSourceStash,
      warnings,
      completedAt: context.now,
    };
  }

  /**
   * Moves the thread from its worktree into a new one. Dirty non-ignored
   * changes travel with it, as they do from Local. The previous worktree is
   * archived with a checkpoint unless the thread does not own it.
   */
  private async handoffWorktreeToNewWorktree(
    params: HandoffParams,
  ): Promise<HandoffThreadWorkspaceResponse> {
    const context = await this.buildContext(params);
    if (path.resolve(context.repositoryPath) === path.resolve(context.sourcePath)) {
      throw new Error("Worktree-to-worktree handoff must start from a worktree.");
    }
    const strategy = params.strategy ?? "detached-changes";
    const moved = strategy === "new-branch"
      ? await this.handoffLocalChangesToNewBranchWorktree(params, context)
      : strategy === "detached-changes"
        ? await this.handoffLocalChangesToDetachedWorktree(params, context)
        : await this.moveWorktreeBranchToNewWorktree(context);
    if (params.keepSourceWorktree) {
      return {
        ...moved,
        warnings: [...moved.warnings, "The previous worktree was created outside PwrAgent, so it was left on disk."],
      };
    }
    // The thread already moved. A failed archive leaves the old worktree in
    // place; it must not undo the move.
    try {
      const archivedSourceWorktree = await this.worktreeArchiveService.archive({
        backend: context.backend,
        threadId: context.threadId,
        repositoryPath: context.repositoryPath,
        worktreePath: context.sourcePath,
        now: context.now,
      });
      return { ...moved, archivedSourceWorktree };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ...moved,
        warnings: [...moved.warnings, `The previous worktree was left on disk: ${detail}`],
      };
    }
  }

  /**
   * Starts a new worktree at `baseRef` and moves only the thread. The source
   * checkout or worktree keeps its branch and its uncommitted changes, and
   * nothing is archived now: they may belong to someone else. The registry
   * keeps a source worktree the thread owns tracked until thread archive.
   */
  private async handoffToFreshWorktree(
    params: HandoffParams,
  ): Promise<HandoffThreadWorkspaceResponse> {
    if (params.direction !== "local-to-worktree" && params.direction !== "worktree-to-worktree") {
      throw new Error("A base branch applies only to a handoff into a new worktree.");
    }
    const strategy = params.strategy ?? "detached-changes";
    if (strategy === "move-branch") {
      throw new Error("Moving the current branch cannot start from a base branch. Choose a detached or new-branch handoff.");
    }
    const context = await this.buildContext(params);
    const fromWorktree = path.resolve(context.repositoryPath) !== path.resolve(context.sourcePath);
    if (fromWorktree !== (params.direction === "worktree-to-worktree")) {
      throw new Error(fromWorktree
        ? "Local-to-worktree handoff must start from the local checkout."
        : "Worktree-to-worktree handoff must start from a worktree.");
    }
    const baseRef = params.baseRef!.trim();
    let baseSha: string;
    try {
      baseSha = trim((await runGit(
        context.repositoryPath,
        ["rev-parse", "--verify", "--quiet", "--end-of-options", `${baseRef}^{commit}`],
        this.gitEnv,
      )).stdout);
    } catch {
      throw new Error(`Base branch ${baseRef} was not found in this repository.`);
    }
    if (!baseSha) throw new Error(`Base branch ${baseRef} was not found in this repository.`);
    const newBranchName = strategy === "new-branch" ? (params.newBranchName ?? "").trim() : "";
    if (strategy === "new-branch") {
      if (!newBranchName) throw new Error("Choose a new branch name for handoff.");
      await validateBranchName(context.repositoryPath, newBranchName, this.gitEnv);
      if (await branchExists(context.repositoryPath, newBranchName, this.gitEnv)) {
        throw new Error(`Branch ${newBranchName} already exists.`);
      }
    }

    const targetPath = await computeWorktreePath({
      backend: context.backend,
      repoRoot: context.repositoryPath,
      storage: await this.resolveStorage(),
      homeDir: this.homeDir,
      timestamp: context.now,
    });
    const sourceDirty = await getDirtyStatus(context.sourcePath, this.gitEnv)
      .catch((error) => releaseReservationAndRethrow(targetPath, error));
    await mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await runGit(
        context.repositoryPath,
        newBranchName
          ? ["worktree", "add", "-b", newBranchName, targetPath, baseSha]
          : ["worktree", "add", "--detach", targetPath, baseSha],
        this.gitEnv,
      );
    } catch (error) {
      await releaseWorktreePathReservation(targetPath);
      throw error;
    }

    return {
      backend: context.backend,
      threadId: context.threadId,
      direction: params.direction,
      strategy,
      workMode: "worktree",
      ...(newBranchName ? { branch: newBranchName } : {}),
      baseSha,
      repositoryPath: context.repositoryPath,
      targetPath,
      linkedDirectory: this.buildLinkedDirectory({ context, kind: "worktree", targetPath }),
      warnings: [
        `The new worktree starts at ${baseRef}.`,
        ...(sourceDirty ? [`Uncommitted changes stayed in ${context.sourcePath}.`] : []),
        ...(!fromWorktree ? []
          : params.keepSourceWorktree
            ? ["The previous worktree was created outside PwrAgent, so it was left on disk."]
            // Claude and ACP thread archive keeps every worktree.
            : context.backend !== "codex"
              ? ["The previous worktree stays on disk."]
              : ["The previous worktree stays on disk. Archiving this thread checkpoints and removes it."]),
      ],
      completedAt: context.now,
    };
  }

  /** Checks the worktree's branch out in a new worktree and detaches the old one. */
  private async moveWorktreeBranchToNewWorktree(
    context: HandoffContext,
  ): Promise<HandoffThreadWorkspaceResponse> {
    if (context.branch === "HEAD") {
      throw new Error("Moving the branch requires a named branch. Choose a detached or new-branch handoff instead.");
    }
    ensureBranchNotCheckedOutElsewhere({
      allowedPath: context.sourcePath,
      branch: context.branch,
      worktrees: context.worktrees,
    });
    const targetPath = await computeWorktreePath({
      backend: context.backend,
      repoRoot: context.repositoryPath,
      storage: await this.resolveStorage(),
      homeDir: this.homeDir,
      timestamp: context.now,
    });
    const sourceStash = await createNamedStashIfDirty({
      gitEnv: this.gitEnv,
      path: context.sourcePath,
      message: this.buildStashMessage(context, "source"),
    }).catch((error) => releaseReservationAndRethrow(targetPath, error));
    // Free the branch so the new worktree can check it out.
    await runGit(context.sourcePath, ["switch", "--detach"], this.gitEnv)
      .catch((error) => releaseReservationAndRethrow(targetPath, error));
    await mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await runGit(
        context.repositoryPath,
        ["worktree", "add", targetPath, context.branch],
        this.gitEnv,
      );
    } catch (error) {
      await releaseWorktreePathReservation(targetPath);
      throw error;
    }
    const appliedSourceStash = await applyVerifyAndDropStash(
      targetPath,
      sourceStash,
      this.gitEnv,
    );
    return {
      backend: context.backend,
      threadId: context.threadId,
      direction: "worktree-to-worktree",
      strategy: "move-branch",
      workMode: "worktree",
      branch: context.branch,
      repositoryPath: context.repositoryPath,
      targetPath,
      linkedDirectory: this.buildLinkedDirectory({
        context,
        kind: "worktree",
        targetPath,
      }),
      sourceStash: appliedSourceStash,
      warnings: ["Ignored files are not preserved by workspace handoff."],
      completedAt: context.now,
    };
  }

  private async handoffWorktreeToLocal(
    params: HandoffParams,
  ): Promise<HandoffThreadWorkspaceResponse> {
    const context = await this.buildContext(params);
    if (path.resolve(context.repositoryPath) === path.resolve(context.sourcePath)) {
      throw new Error("Worktree-to-local handoff must start from a worktree.");
    }

    if (context.branch === "HEAD") {
      return await this.handoffDetachedWorktreeToLocal(context);
    }

    ensureBranchNotCheckedOutElsewhere({
      allowedPath: context.sourcePath,
      branch: context.branch,
      worktrees: context.worktrees,
    });

    const warnings = ["Ignored files are not preserved by workspace handoff."];
    await assertLocalCleanForDestinationHandoff(context.repositoryPath, this.gitEnv);
    const sourceStash = await createNamedStashIfDirty({
      gitEnv: this.gitEnv,
      path: context.sourcePath,
      message: this.buildStashMessage(context, "source"),
    });

    await runGit(context.sourcePath, ["switch", "--detach"], this.gitEnv);
    await runGit(context.repositoryPath, ["switch", context.branch], this.gitEnv);
    const appliedSourceStash = await applyVerifyAndDropStash(
      context.repositoryPath,
      sourceStash,
      this.gitEnv,
    );
    const archivedSourceWorktree = await this.worktreeArchiveService.archive({
      backend: context.backend,
      threadId: context.threadId,
      repositoryPath: context.repositoryPath,
      worktreePath: context.sourcePath,
      now: context.now,
    });

    const linkedDirectory = this.buildLinkedDirectory({
      context,
      kind: "local",
      targetPath: context.repositoryPath,
    });

    return {
      backend: context.backend,
      threadId: context.threadId,
      direction: "worktree-to-local",
      strategy: "move-branch",
      workMode: "local",
      branch: context.branch,
      repositoryPath: context.repositoryPath,
      targetPath: context.repositoryPath,
      linkedDirectory,
      archivedSourceWorktree,
      sourceStash: appliedSourceStash,
      warnings,
      completedAt: context.now,
    };
  }

  private async handoffDetachedWorktreeToLocal(
    context: HandoffContext,
  ): Promise<HandoffThreadWorkspaceResponse> {
    const warnings = [
      "Ignored files are not preserved by workspace handoff.",
      "Local will be left on a detached HEAD at the moved worktree commit.",
    ];
    await assertLocalCleanForDestinationHandoff(context.repositoryPath, this.gitEnv);
    const sourceStash = await createNamedStashIfDirty({
      gitEnv: this.gitEnv,
      path: context.sourcePath,
      message: this.buildStashMessage(context, "source"),
    });

    await runGit(
      context.repositoryPath,
      ["switch", "--detach", context.headSha],
      this.gitEnv,
    );
    const appliedSourceStash = await applyVerifyAndDropStash(
      context.repositoryPath,
      sourceStash,
      this.gitEnv,
    );
    const archivedSourceWorktree = await this.worktreeArchiveService.archive({
      backend: context.backend,
      threadId: context.threadId,
      repositoryPath: context.repositoryPath,
      worktreePath: context.sourcePath,
      now: context.now,
    });

    const linkedDirectory = this.buildLinkedDirectory({
      context,
      kind: "local",
      targetPath: context.repositoryPath,
    });

    return {
      backend: context.backend,
      threadId: context.threadId,
      direction: "worktree-to-local",
      strategy: "detached-changes",
      workMode: "local",
      baseSha: context.headSha,
      repositoryPath: context.repositoryPath,
      targetPath: context.repositoryPath,
      linkedDirectory,
      archivedSourceWorktree,
      sourceStash: appliedSourceStash,
      warnings,
      completedAt: context.now,
    };
  }

  private buildStashMessage(
    context: HandoffContext,
    kind: "source" | "destination",
  ): string {
    return [
      "pwragent handoff",
      kind,
      `${context.backend}:${context.threadId}`,
      context.branch,
      String(context.now),
    ].join(" ");
  }

  private buildLinkedDirectory(params: {
    context: HandoffContext;
    kind: LinkedDirectorySummary["kind"];
    targetPath: string;
  }): LinkedDirectorySummary {
    return {
      id: `pwragent-handoff:${params.context.backend}:${params.context.threadId}`,
      kind: params.kind,
      label: pathBaseName(params.context.repositoryPath),
      path: params.context.repositoryPath,
      worktreePath: params.kind === "worktree" ? params.targetPath : undefined,
    };
  }
}
