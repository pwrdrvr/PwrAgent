import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AppServerBackendKind,
  WorktreeSnapshotSummary,
} from "@pwragnt/shared";

const execFileAsync = promisify(execFile);

type GitResult = {
  stdout: string;
  stderr: string;
};

type WorktreeInfo = {
  path: string;
  branch?: string;
  head?: string;
  detached: boolean;
};

type ArchiveWorktreeParams = {
  backend: AppServerBackendKind;
  threadId: string;
  worktreePath: string;
  repositoryPath?: string;
  now?: number;
};

type RestoreWorktreeParams = {
  backend: AppServerBackendKind;
  threadId: string;
  worktreePath: string;
  repositoryPath: string;
  snapshotRef: string;
  snapshotCommit: string;
  snapshot?: WorktreeSnapshotSummary;
  now?: number;
};

async function runGit(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<GitResult> {
  return await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    maxBuffer: 1024 * 1024 * 10,
  });
}

function trimGitOutput(value: string): string {
  return value.trim();
}

function snapshotIdForPath(worktreePath: string): string {
  return createHash("sha1")
    .update(path.resolve(worktreePath))
    .digest("hex");
}

function snapshotRefForBackend(
  backend: AppServerBackendKind,
  worktreePath: string,
): string {
  const namespace = backend === "codex" ? "codex" : "pwragnt";
  return `refs/${namespace}/snapshots/${snapshotIdForPath(worktreePath)}`;
}

function parseWorktreeList(output: string): WorktreeInfo[] {
  const entries: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> | undefined;

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      if (current?.path) {
        entries.push({
          path: current.path,
          branch: current.branch,
          head: current.head,
          detached: current.detached ?? false,
        });
      }
      current = undefined;
      continue;
    }

    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      if (current?.path) {
        entries.push({
          path: current.path,
          branch: current.branch,
          head: current.head,
          detached: current.detached ?? false,
        });
      }
      current = { path: value, detached: false };
    } else if (key === "HEAD") {
      current = { ...current, head: value };
    } else if (key === "branch") {
      current = { ...current, branch: value.replace(/^refs\/heads\//, "") };
    } else if (key === "detached") {
      current = { ...current, detached: true };
    }
  }

  if (current?.path) {
    entries.push({
      path: current.path,
      branch: current.branch,
      head: current.head,
      detached: current.detached ?? false,
    });
  }

  return entries;
}

function findWorktree(
  worktrees: WorktreeInfo[],
  worktreePath: string,
): WorktreeInfo | undefined {
  const resolvedPath = path.resolve(worktreePath);
  return worktrees.find((worktree) => path.resolve(worktree.path) === resolvedPath);
}

export class WorktreeArchiveService {
  async archive(params: ArchiveWorktreeParams): Promise<WorktreeSnapshotSummary> {
    const worktreePath = await realpath(path.resolve(params.worktreePath));
    const repositoryPath =
      params.repositoryPath
        ? await realpath(path.resolve(params.repositoryPath))
        : await this.readRepositoryPath(worktreePath);
    const worktrees = await this.listWorktrees(repositoryPath);
    const worktree = findWorktree(worktrees, worktreePath);

    if (!worktree) {
      throw new Error(`Worktree is not registered with Git: ${worktreePath}`);
    }
    if (path.resolve(repositoryPath) === worktreePath) {
      throw new Error("Refusing to archive the primary checkout as a worktree.");
    }

    const snapshotCommit = await this.createSnapshotCommit({
      backend: params.backend,
      threadId: params.threadId,
      worktree,
      worktreePath,
    });
    const snapshotRef = snapshotRefForBackend(params.backend, worktreePath);
    await runGit(repositoryPath, ["update-ref", snapshotRef, snapshotCommit]);
    await runGit(repositoryPath, ["worktree", "remove", "--force", worktreePath]);

    const archivedAt = params.now ?? Date.now();
    return {
      id: snapshotIdForPath(worktreePath),
      backend: params.backend,
      threadId: params.threadId,
      worktreePath,
      repositoryPath,
      snapshotRef,
      snapshotCommit,
      sourceBranch: worktree.branch,
      sourceHead: worktree.head,
      createdAt: archivedAt,
      archivedAt,
      state: "archived",
      ignoredFilesExcluded: true,
    };
  }

  async restore(params: RestoreWorktreeParams): Promise<WorktreeSnapshotSummary> {
    const worktreePath = path.resolve(params.worktreePath);
    const repositoryPath = path.resolve(params.repositoryPath);
    const snapshotCommit = trimGitOutput(
      (await runGit(repositoryPath, ["rev-parse", `${params.snapshotRef}^{commit}`]))
        .stdout,
    );

    if (snapshotCommit !== params.snapshotCommit) {
      throw new Error(
        `Snapshot ref ${params.snapshotRef} points at ${snapshotCommit}, expected ${params.snapshotCommit}.`,
      );
    }

    await mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repositoryPath, [
      "worktree",
      "add",
      "--detach",
      worktreePath,
      snapshotCommit,
    ]);

    const restoredAt = params.now ?? Date.now();
    return {
      ...(params.snapshot ?? {
        id: snapshotIdForPath(worktreePath),
        backend: params.backend,
        threadId: params.threadId,
        worktreePath,
        repositoryPath,
        snapshotRef: params.snapshotRef,
        snapshotCommit,
        createdAt: restoredAt,
        ignoredFilesExcluded: true,
      }),
      backend: params.backend,
      threadId: params.threadId,
      worktreePath,
      repositoryPath,
      snapshotRef: params.snapshotRef,
      snapshotCommit,
      restoredAt,
      state: "restored",
      unavailableReason: undefined,
    };
  }

  private async createSnapshotCommit(params: {
    backend: AppServerBackendKind;
    threadId: string;
    worktree: WorktreeInfo;
    worktreePath: string;
  }): Promise<string> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-worktree-index-"));
    const indexPath = path.join(tempDir, "index");

    try {
      const env = { GIT_INDEX_FILE: indexPath };
      await runGit(params.worktreePath, ["read-tree", "HEAD"], { env });
      await runGit(params.worktreePath, ["add", "-A", "--", "."], { env });
      const tree = trimGitOutput(
        (await runGit(params.worktreePath, ["write-tree"], { env })).stdout,
      );
      const message = [
        `Snapshot worktree for ${params.backend}:${params.threadId}`,
        "",
        `Worktree: ${params.worktreePath}`,
        params.worktree.branch ? `Branch: ${params.worktree.branch}` : undefined,
        params.worktree.head ? `Source HEAD: ${params.worktree.head}` : undefined,
      ].filter(Boolean).join("\n");
      const commitArgs = ["commit-tree", tree, "-m", message];
      if (params.worktree.head) {
        commitArgs.push("-p", params.worktree.head);
      }
      const commitEnv = {
        ...env,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "PwrAgnt",
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "pwragnt@example.invalid",
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "PwrAgnt",
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "pwragnt@example.invalid",
      };

      return trimGitOutput(
        (await runGit(params.worktreePath, commitArgs, { env: commitEnv })).stdout,
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  }

  private async readRepositoryPath(worktreePath: string): Promise<string> {
    const output = await runGit(worktreePath, ["worktree", "list", "--porcelain"]);
    const worktrees = parseWorktreeList(output.stdout);
    const primary = worktrees[0]?.path;
    if (!primary) {
      throw new Error(`Unable to resolve repository root for ${worktreePath}.`);
    }
    return primary;
  }

  private async listWorktrees(repositoryPath: string): Promise<WorktreeInfo[]> {
    const output = await runGit(repositoryPath, ["worktree", "list", "--porcelain"]);
    return parseWorktreeList(output.stdout);
  }
}

export const worktreeArchiveInternals = {
  parseWorktreeList,
  snapshotIdForPath,
  snapshotRefForBackend,
};
