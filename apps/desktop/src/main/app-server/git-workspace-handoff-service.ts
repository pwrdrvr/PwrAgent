import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AppServerBackendKind,
  DesktopWorktreeStorageLocation,
  HandoffThreadWorkspaceResponse,
  LinkedDirectorySummary,
  ThreadIdentifier,
  ThreadWorkspaceHandoffDirection,
  ThreadWorkspaceHandoffStrategy,
  ThreadWorkspaceHandoffStashSummary,
  WorktreeSnapshotSummary,
} from "@pwragent/shared";
import { DESKTOP_WORKTREE_STORAGE_DEFAULT } from "@pwragent/shared";
import { computeWorktreePath } from "./git-directory-service";
import { WorktreeArchiveService } from "./worktree-archive-service";

const execFileAsync = promisify(execFile);
const DETACHED_HEAD_LEAVE_LOCAL_BRANCH = "HEAD";

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
  strategy?: ThreadWorkspaceHandoffStrategy;
  repositoryPath?: string;
  sourcePath?: string;
  sourceBranch?: string;
  leaveLocalBranch?: string;
  newBranchName?: string;
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
  return await execFileAsync("git", args, {
    cwd,
    env: env ?? process.env,
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
    return params.direction === "local-to-worktree"
      ? await this.handoffLocalToWorktree(params)
      : await this.handoffWorktreeToLocal(params);
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
    });
    await runGit(
      context.sourcePath,
      leaveLocalDetached
        ? ["switch", "--detach", context.headSha]
        : ["switch", leaveLocalBranch],
      this.gitEnv,
    );

    await mkdir(path.dirname(targetPath), { recursive: true });
    await runGit(
      context.repositoryPath,
      ["worktree", "add", targetPath, context.branch],
      this.gitEnv,
    );
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
    });
    if (!sourceStash) {
      warnings.push("No dirty non-ignored changes were available to move.");
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    await runGit(
      context.repositoryPath,
      ["worktree", "add", "-b", newBranchName, targetPath, baseSha],
      this.gitEnv,
    );
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
    });
    if (!sourceStash) {
      warnings.push("No dirty non-ignored changes were available to move.");
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    await runGit(
      context.repositoryPath,
      ["worktree", "add", "--detach", targetPath, baseSha],
      this.gitEnv,
    );
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
