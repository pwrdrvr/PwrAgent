import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AppServerBackendKind,
  HandoffThreadWorkspaceResponse,
  LinkedDirectorySummary,
  ThreadIdentifier,
  ThreadWorkspaceHandoffDirection,
  ThreadWorkspaceHandoffStrategy,
  ThreadWorkspaceHandoffStashSummary,
  WorktreeSnapshotSummary,
} from "@pwragnt/shared";
import { WorktreeArchiveService } from "./worktree-archive-service";

const execFileAsync = promisify(execFile);

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
};

type WorkspaceHandoffServiceOptions = {
  worktreeArchiveService?: WorktreeArchiveService;
};

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return await execFileAsync("git", args, {
    cwd,
    env: process.env,
    maxBuffer: 1024 * 1024 * 10,
  });
}

function trim(value: string): string {
  return value.trim();
}

function sanitizeSegment(value: string): string {
  return value
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/\//g, "-")
    .replace(/^-+|-+$/g, "");
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
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
  const status = trim(
    (await runGit(options.path, ["status", "--porcelain", "--untracked-files=normal"]))
      .stdout,
  );
  if (!status) {
    return undefined;
  }

  await runGit(options.path, ["stash", "push", "--include-untracked", "-m", options.message]);
  const ref = trim(
    (await runGit(options.path, ["rev-parse", "--verify", "stash@{0}"])).stdout,
  );

  return {
    ref,
    message: options.message,
    path: options.path,
    applied: false,
    dropped: false,
  };
}

async function dropStashByCommit(cwd: string, commit: string): Promise<void> {
  const stashList = (
    await runGit(cwd, ["stash", "list", "--format=%H%x00%gd"])
  ).stdout.split("\n");
  const match = stashList.flatMap((line) => {
    const [sha, ref] = line.split("\0");
    return sha === commit && ref ? [ref] : [];
  })[0];

  if (!match) {
    return;
  }

  await runGit(cwd, ["stash", "drop", match]);
}

async function applyVerifyAndDropStash(
  cwd: string,
  stash: ThreadWorkspaceHandoffStashSummary | undefined,
): Promise<ThreadWorkspaceHandoffStashSummary | undefined> {
  if (!stash?.ref) {
    return stash;
  }

  await runGit(cwd, ["stash", "apply", stash.ref]);
  await dropStashByCommit(cwd, stash.ref);

  return {
    ...stash,
    path: cwd,
    applied: true,
    dropped: true,
  };
}

export class GitWorkspaceHandoffService {
  private readonly worktreeArchiveService: WorktreeArchiveService;

  constructor(options: WorkspaceHandoffServiceOptions = {}) {
    this.worktreeArchiveService =
      options.worktreeArchiveService ?? new WorktreeArchiveService();
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
          trim((await runGit(sourcePath, ["rev-parse", "--show-toplevel"])).stdout),
      ),
    );
    const worktrees = parseWorktreeList(
      (await runGit(repositoryPath, ["worktree", "list", "--porcelain"])).stdout,
    );
    const observedBranch = sanitizeBranchName(
      trim((await runGit(sourcePath, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout),
    );
    const branch =
      observedBranch === "HEAD"
        ? "HEAD"
        : sanitizeBranchName(params.sourceBranch ?? "") || observedBranch;
    const headSha = trim(
      (await runGit(sourcePath, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout,
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
    if (context.branch === "HEAD") {
      throw new Error("Local-to-worktree handoff requires a named source branch.");
    }

    const strategy = params.strategy ?? "move-branch";
    if (strategy === "detached-changes") {
      return await this.handoffLocalChangesToDetachedWorktree(params, context);
    }

    ensureBranchNotCheckedOutElsewhere({
      allowedPath: context.sourcePath,
      branch: context.branch,
      worktrees: context.worktrees,
    });

    const leaveLocalBranch = sanitizeBranchName(params.leaveLocalBranch ?? "");
    if (!leaveLocalBranch) {
      throw new Error("Choose a branch to leave in Local before handoff.");
    }
    if (leaveLocalBranch && leaveLocalBranch === context.branch) {
      throw new Error("Local cannot be left on the same branch being moved.");
    }

    const targetPath = this.buildTargetWorktreePath({
      repositoryPath: context.repositoryPath,
      branch: context.branch,
      now: context.now,
    });
    if (await pathExists(targetPath)) {
      throw new Error(`Target worktree path already exists: ${targetPath}`);
    }

    const warnings = ["Ignored files are not preserved by workspace handoff."];
    const sourceStash = await createNamedStashIfDirty({
      path: context.sourcePath,
      message: this.buildStashMessage(context, "source"),
    });
    await runGit(context.sourcePath, ["switch", leaveLocalBranch]);

    await mkdir(path.dirname(targetPath), { recursive: true });
    await runGit(context.repositoryPath, ["worktree", "add", targetPath, context.branch]);
    const appliedSourceStash = await applyVerifyAndDropStash(targetPath, sourceStash);

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

  private async handoffLocalChangesToDetachedWorktree(
    params: HandoffParams,
    context: HandoffContext,
  ): Promise<HandoffThreadWorkspaceResponse> {
    const baseSha = context.headSha;
    const targetPath = this.buildTargetWorktreePath({
      repositoryPath: context.repositoryPath,
      branch: `${context.branch}-detached`,
      now: context.now,
    });
    if (await pathExists(targetPath)) {
      throw new Error(`Target worktree path already exists: ${targetPath}`);
    }

    const warnings = [
      "Ignored files are not preserved by workspace handoff.",
      "The new worktree starts detached at the current branch tip.",
    ];
    const sourceStash = await createNamedStashIfDirty({
      path: context.sourcePath,
      message: this.buildStashMessage(context, "source"),
    });
    if (!sourceStash) {
      warnings.push("No dirty non-ignored changes were available to move.");
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    await runGit(context.repositoryPath, ["worktree", "add", "--detach", targetPath, baseSha]);
    const appliedSourceStash = await applyVerifyAndDropStash(targetPath, sourceStash);

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
    const sourceStash = await createNamedStashIfDirty({
      path: context.sourcePath,
      message: this.buildStashMessage(context, "source"),
    });
    const destinationStash = await createNamedStashIfDirty({
      path: context.repositoryPath,
      message: this.buildStashMessage(context, "destination"),
    });
    if (destinationStash) {
      warnings.push(
        "Local had dirty changes; they were saved in a separate stash and not applied to the moved branch.",
      );
    }

    await runGit(context.sourcePath, ["switch", "--detach"]);
    await runGit(context.repositoryPath, ["switch", context.branch]);
    const appliedSourceStash = await applyVerifyAndDropStash(
      context.repositoryPath,
      sourceStash,
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
      destinationStash,
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
    const sourceStash = await createNamedStashIfDirty({
      path: context.sourcePath,
      message: this.buildStashMessage(context, "source"),
    });
    const destinationStash = await createNamedStashIfDirty({
      path: context.repositoryPath,
      message: this.buildStashMessage(context, "destination"),
    });
    if (destinationStash) {
      warnings.push(
        "Local had dirty changes; they were saved in a separate stash and not applied to the moved detached HEAD.",
      );
    }

    await runGit(context.repositoryPath, ["switch", "--detach", context.headSha]);
    const appliedSourceStash = await applyVerifyAndDropStash(
      context.repositoryPath,
      sourceStash,
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
      destinationStash,
      warnings,
      completedAt: context.now,
    };
  }

  private buildTargetWorktreePath(params: {
    repositoryPath: string;
    branch: string;
    now: number;
  }): string {
    const repoName = sanitizeSegment(pathBaseName(params.repositoryPath).toLowerCase()) || "repo";
    const branchName = sanitizeSegment(params.branch) || "branch";
    return path.join(
      params.repositoryPath,
      ".worktrees",
      `${repoName}-${branchName}-${params.now.toString(36)}`,
    );
  }

  private buildStashMessage(
    context: HandoffContext,
    kind: "source" | "destination",
  ): string {
    return [
      "pwragnt handoff",
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
      id: `pwragnt-handoff:${params.context.backend}:${params.context.threadId}`,
      kind: params.kind,
      label: pathBaseName(params.context.repositoryPath),
      path: params.context.repositoryPath,
      worktreePath: params.kind === "worktree" ? params.targetPath : undefined,
    };
  }
}
