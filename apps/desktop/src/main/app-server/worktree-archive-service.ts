import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AppServerBackendKind,
  WorktreeSnapshotSummary,
} from "@pwragent/shared";

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
  allowDetachedFallback?: boolean;
  now?: number;
};

type RestoreDetachedWorktreeParams = {
  backend: AppServerBackendKind;
  threadId: string;
  worktreePath: string;
  repositoryPath: string;
  restoreRef?: string;
  now?: number;
};

type WorktreeArchiveServiceOptions = {
  gitEnv?: NodeJS.ProcessEnv;
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
  const namespace = backend === "codex" ? "codex" : "pwragent";
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
  private readonly gitEnv?: NodeJS.ProcessEnv;

  constructor(options: WorktreeArchiveServiceOptions = {}) {
    this.gitEnv = options.gitEnv;
  }

  async archive(params: ArchiveWorktreeParams): Promise<WorktreeSnapshotSummary> {
    const worktreePath = await realpath(path.resolve(params.worktreePath));
    const worktreeListPath = params.repositoryPath
      ? await realpath(path.resolve(params.repositoryPath))
      : worktreePath;
    const worktrees = await this.listWorktrees(worktreeListPath);
    const repositoryPath = await this.resolvePrimaryRepositoryPath({
      worktreeListPath,
      worktrees,
    });
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
    await this.runGit(repositoryPath, ["update-ref", snapshotRef, snapshotCommit]);
    await this.runGit(repositoryPath, ["worktree", "remove", "--force", worktreePath]);

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
    const { commit: restoreCommit, fallbackReason } =
      await this.resolveRestoreCommit(params);

    await mkdir(path.dirname(worktreePath), { recursive: true });
    await this.runGit(repositoryPath, [
      "worktree",
      "add",
      "--detach",
      worktreePath,
      restoreCommit,
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
        snapshotCommit: restoreCommit,
        createdAt: restoredAt,
        ignoredFilesExcluded: true,
      }),
      backend: params.backend,
      threadId: params.threadId,
      worktreePath,
      repositoryPath,
      snapshotRef: params.snapshotRef,
      snapshotCommit: restoreCommit,
      restoredAt,
      state: "restored",
      unavailableReason: fallbackReason,
    };
  }

  async restoreDetached(
    params: RestoreDetachedWorktreeParams,
  ): Promise<WorktreeSnapshotSummary> {
    const worktreePath = path.resolve(params.worktreePath);
    const repositoryPath = path.resolve(params.repositoryPath);
    const restoreRef = params.restoreRef?.trim() || "HEAD";
    const snapshotCommit = trimGitOutput(
      (await this.runGit(repositoryPath, ["rev-parse", `${restoreRef}^{commit}`]))
        .stdout,
    );

    await mkdir(path.dirname(worktreePath), { recursive: true });
    await this.runGit(repositoryPath, [
      "worktree",
      "add",
      "--detach",
      worktreePath,
      snapshotCommit,
    ]);

    const restoredAt = params.now ?? Date.now();
    return {
      id: snapshotIdForPath(worktreePath),
      backend: params.backend,
      threadId: params.threadId,
      worktreePath,
      repositoryPath,
      snapshotRef: restoreRef,
      snapshotCommit,
      sourceBranch: restoreRef === "HEAD" ? undefined : restoreRef,
      createdAt: restoredAt,
      restoredAt,
      state: "restored",
      ignoredFilesExcluded: true,
      unavailableReason:
        "Restored detached worktree from repository state because no archived snapshot was available.",
    };
  }

  private async resolveRestoreCommit(
    params: RestoreWorktreeParams,
  ): Promise<{ commit: string; fallbackReason?: string }> {
    try {
      const snapshotCommit = trimGitOutput(
        (await this.runGit(params.repositoryPath, [
          "rev-parse",
          `${params.snapshotRef}^{commit}`,
        ]))
          .stdout,
      );

      if (snapshotCommit === params.snapshotCommit) {
        return { commit: snapshotCommit };
      }

      const mismatch = `Snapshot ref ${params.snapshotRef} points at ${snapshotCommit}, expected ${params.snapshotCommit}.`;
      if (!params.allowDetachedFallback) {
        throw new Error(mismatch);
      }
      return await this.resolveDetachedFallbackCommit(params, mismatch);
    } catch (error) {
      if (!params.allowDetachedFallback) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      return await this.resolveDetachedFallbackCommit(params, reason);
    }
  }

  private async resolveDetachedFallbackCommit(
    params: RestoreWorktreeParams,
    reason: string,
  ): Promise<{ commit: string; fallbackReason: string }> {
    const fallbackCandidates = [
      {
        label: "retained snapshot commit",
        value: params.snapshotCommit,
      },
      {
        label: "source HEAD",
        value: params.snapshot?.sourceHead,
      },
      {
        label: "repository HEAD",
        value: "HEAD",
      },
    ];

    for (const candidate of fallbackCandidates) {
      if (!candidate.value) {
        continue;
      }

      try {
        const commit = trimGitOutput(
          (await this.runGit(params.repositoryPath, [
            "rev-parse",
            `${candidate.value}^{commit}`,
          ])).stdout,
        );
        return {
          commit,
          fallbackReason: `${reason} Restored detached worktree from ${candidate.label}.`,
        };
      } catch {
        // Try the next retained identity before giving up.
      }
    }

    throw new Error(`${reason} No detached fallback commit is available.`);
  }

  private async createSnapshotCommit(params: {
    backend: AppServerBackendKind;
    threadId: string;
    worktree: WorktreeInfo;
    worktreePath: string;
  }): Promise<string> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-worktree-index-"));
    const indexPath = path.join(tempDir, "index");

    try {
      const env = { GIT_INDEX_FILE: indexPath };
      await this.runGit(params.worktreePath, ["read-tree", "HEAD"], { env });
      await this.runGit(params.worktreePath, ["add", "-A", "--", "."], { env });
      const tree = trimGitOutput(
        (await this.runGit(params.worktreePath, ["write-tree"], { env })).stdout,
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
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "PwrAgent",
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "pwragent@example.invalid",
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "PwrAgent",
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "pwragent@example.invalid",
      };

      return trimGitOutput(
        (await this.runGit(params.worktreePath, commitArgs, { env: commitEnv }))
          .stdout,
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  }

  private async resolvePrimaryRepositoryPath(params: {
    worktreeListPath: string;
    worktrees: WorktreeInfo[];
  }): Promise<string> {
    const primary = params.worktrees[0]?.path;
    if (!primary) {
      throw new Error(`Unable to resolve repository root for ${params.worktreeListPath}.`);
    }

    return await realpath(path.resolve(primary));
  }

  private async listWorktrees(repositoryPath: string): Promise<WorktreeInfo[]> {
    const output = await this.runGit(repositoryPath, ["worktree", "list", "--porcelain"]);
    return parseWorktreeList(output.stdout);
  }

  private async runGit(
    cwd: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv } = {},
  ): Promise<GitResult> {
    return await runGit(cwd, args, {
      env: {
        ...this.gitEnv,
        ...options.env,
      },
    });
  }
}

export const worktreeArchiveInternals = {
  parseWorktreeList,
  snapshotIdForPath,
  snapshotRefForBackend,
};
