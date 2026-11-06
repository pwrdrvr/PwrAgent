import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AppServerBackendKind,
  WorktreeSnapshotSummary,
} from "@pwragent/shared";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { runGitCommand } from "./git-executable";
import { withWorktreeTerminalsClosed } from "../terminal/worktree-terminals";
import { PerKeyAsyncLock } from "../util/per-key-async-lock";

type GitResult = {
  stdout: string;
  stderr: string;
};

type WorktreeInfo = {
  path: string;
  branch?: string;
  head?: string;
  detached: boolean;
  locked?: boolean;
};

/** "pwragent" snapshots a checkout no thread owns, from Thread maintenance. */
type SnapshotOwner = AppServerBackendKind | "pwragent";

type ArchiveWorktreeParams = {
  backend: SnapshotOwner;
  threadId: string;
  worktreePath: string;
  repositoryPath?: string;
  now?: number;
  /** One reviewed approval to snapshot past the service limit. Never lower. */
  maxSnapshotBytes?: number;
  /** Returns a synchronous admission check for the actual removal dispatch. */
  beforeRemove?: () => Promise<() => void>;
};

type HibernateWorktreeParams = {
  backend: AppServerBackendKind;
  threadId: string;
  worktreePath: string;
  repositoryPath?: string;
  now?: number;
  /** The snapshot may not be larger than this. Unlike archive's
   * maxSnapshotBytes, it only ever lowers the service limit. */
  capSnapshotBytes: number;
  /** Re-runs the hibernation checks and returns a synchronous assert. */
  beforeRemove: () => Promise<() => void>;
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
  /** Reattach the unchanged source branch and restore edits outside its HEAD. */
  restoreSourceCheckout?: boolean;
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
  maxSnapshotBytes?: number;
};

export const MAX_WORKTREE_SNAPSHOT_BYTES = 100 * 1024 * 1024;
const MAX_WORKTREE_SNAPSHOT_FILES = 10_000;

/** The checkout changed after its snapshot was written; it was kept. */
export class SnapshotTreeMismatchError extends Error {
  constructor(worktreePath: string) {
    super(`The checkout changed while its snapshot was written; it was kept: ${worktreePath}`);
    this.name = "SnapshotTreeMismatchError";
  }
}

export class MissingArchiveWorktreeError extends Error {
  constructor(worktreePath: string) {
    super(`Worktree directory no longer exists: ${worktreePath}`);
    this.name = "MissingArchiveWorktreeError";
  }
}

/** The checkout exists but its repository does not, so it cannot be
 * snapshotted. Archive cleanup keeps it; this is a skip, not a failure. */
export class MissingArchiveRepositoryError extends Error {
  constructor(readonly worktreePath: string, readonly repositoryPath: string) {
    super(`Repository no longer exists for worktree ${worktreePath}: ${repositoryPath}`);
    this.name = "MissingArchiveRepositoryError";
  }
}

/** The repository a linked worktree's `.git` file points at, when that
 * repository is gone. A main checkout (a `.git` directory) is never orphaned. */
export async function missingWorktreeRepository(worktreePath: string): Promise<string | undefined> {
  let pointer: string;
  try {
    pointer = await readFile(path.join(worktreePath, ".git"), "utf8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) return undefined;
  const gitDirectory = path.resolve(worktreePath, match[1]!.trim());
  // A linked worktree's gitdir is <common git dir>/worktrees/<name>. A pruned
  // entry under a live repository is not this case and still fails loudly.
  const commonDirectory = path.basename(path.dirname(gitDirectory)) === "worktrees"
    ? path.dirname(path.dirname(gitDirectory))
    : gitDirectory;
  try {
    await stat(commonDirectory);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.basename(commonDirectory) === ".git" ? path.dirname(commonDirectory) : commonDirectory;
  }
}

async function runGit(
  cwd: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    ownProcessTree?: boolean;
    beforeSpawn?: () => void;
  } = {},
): Promise<GitResult> {
  const env = buildPwrAgentChildProcessEnv(process.env, options.env);
  return await runGitCommand(cwd, args, { ...options, env });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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
  backend: SnapshotOwner,
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
          locked: current.locked,
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
          locked: current.locked,
        });
      }
      current = { path: value, detached: false };
    } else if (key === "HEAD") {
      current = { ...current, head: value };
    } else if (key === "branch") {
      current = { ...current, branch: value.replace(/^refs\/heads\//, "") };
    } else if (key === "detached") {
      current = { ...current, detached: true };
    } else if (key === "locked") {
      current = { ...current, locked: true };
    }
  }

  if (current?.path) {
    entries.push({
      path: current.path,
      branch: current.branch,
      head: current.head,
      detached: current.detached ?? false,
      locked: current.locked,
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

async function checkArchiveRegistration(params: {
  worktreePath: string;
  gitDirectory: string;
  commonDirectory: string;
  removing?: boolean;
}): Promise<void> {
  const { worktreePath, gitDirectory, commonDirectory } = params;
  const unregistered = () => new Error(`Worktree is ${params.removing ? "no longer" : "not"} registered with Git: ${worktreePath}`);
  try {
    // A linked checkout and its one admin entry must point at each other in
    // the expected repository. Never enumerate sibling admin entries here.
    const gitFile = path.join(worktreePath, ".git");
    const contents = await readFile(gitFile, "utf8");
    const target = /^gitdir: (.+?)[\r\n]*$/.exec(contents)?.[1];
    if (!target || path.dirname(gitDirectory) !== await realpath(path.join(commonDirectory, "worktrees"))) throw unregistered();
    const registeredFile = (await readFile(path.join(gitDirectory, "gitdir"), "utf8")).trim();
    const registeredCommon = (await readFile(path.join(gitDirectory, "commondir"), "utf8")).trim();
    const backlink = path.resolve(gitDirectory, registeredFile);
    if (await realpath(path.resolve(worktreePath, target)) !== gitDirectory
      // Resolve the owning checkout, preserving a valid final .git symlink.
      // Resolving that symlink would also hide a backlink to another checkout.
      || path.basename(backlink) !== ".git"
      || await realpath(path.dirname(backlink)) !== worktreePath
      || await realpath(path.resolve(gitDirectory, registeredCommon)) !== commonDirectory) {
      throw unregistered();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT"
      || (error as NodeJS.ErrnoException).code === "ENOTDIR") throw unregistered();
    throw error;
  }
  try {
    await lstat(path.join(gitDirectory, "locked"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to archive a locked worktree: ${worktreePath}`);
}

async function unlinkWindowsWorktreeLinks(worktreePath: string, assertRemoval?: () => void): Promise<void> {
  const directories = [worktreePath];
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index]!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        // Git for Windows aborts recursive removal on a dangling junction.
        // pnpm's .pnpm directory sorts before its links, so Git itself can
        // make those links dangling halfway through deletion. Unlink links
        // first; never traverse their targets (which may be outside checkout).
        assertRemoval?.();
        await unlink(entryPath);
      } else if (entry.isDirectory()) {
        directories.push(entryPath);
      }
    }
  }
}

export class WorktreeArchiveService {
  private readonly repositoryRemovals = new PerKeyAsyncLock();
  private readonly gitEnv?: NodeJS.ProcessEnv;
  private readonly maxSnapshotBytes: number;

  constructor(options: WorktreeArchiveServiceOptions = {}) {
    this.gitEnv = options.gitEnv;
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? MAX_WORKTREE_SNAPSHOT_BYTES;
  }

  async archive(params: ArchiveWorktreeParams & { backend: AppServerBackendKind }): Promise<WorktreeSnapshotSummary> {
    return { ...await this.snapshotAndRemove(params), backend: params.backend };
  }

  /** Snapshot and remove a checkout no thread owns. The snapshot goes under
   * refs/pwragent/snapshots/, like every non-Codex archive. */
  async archiveUnreferenced(params: { worktreePath: string }): Promise<{ snapshotRef: string; repositoryPath: string }> {
    const { snapshotRef, repositoryPath } = await this.snapshotAndRemove({
      backend: "pwragent", threadId: "unreferenced", worktreePath: params.worktreePath,
    });
    return { snapshotRef, repositoryPath };
  }

  /**
   * Snapshot and remove an idle thread's checkout, keeping the thread. The
   * snapshot is capped, and its tree must still equal the checkout's
   * `add -A` tree once the checks have run again; otherwise the checkout is
   * kept and the snapshot ref goes back to what it was.
   */
  async hibernate(params: HibernateWorktreeParams): Promise<WorktreeSnapshotSummary> {
    const removed = await this.snapshotAndRemove({
      backend: params.backend,
      threadId: params.threadId,
      worktreePath: params.worktreePath,
      repositoryPath: params.repositoryPath,
      now: params.now,
      beforeRemove: params.beforeRemove,
    }, {
      capSnapshotBytes: params.capSnapshotBytes,
      verifyTree: async (worktreePath) => await this.readCheckoutTree(worktreePath),
    });
    const { archivedAt, ...rest } = removed;
    return { ...rest, backend: params.backend, state: "hibernated", hibernatedAt: archivedAt };
  }

  /** The tree `git add -A` would stage, from a throwaway index. */
  async readCheckoutTree(worktreePath: string): Promise<string> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-worktree-tree-"));
    try {
      const env = { GIT_INDEX_FILE: path.join(tempDir, "index") };
      await this.runGit(worktreePath, ["read-tree", "HEAD"], { env });
      await this.runGit(worktreePath, ["add", "-A", "--", "."], { env });
      return trimGitOutput((await this.runGit(worktreePath, ["write-tree"], { env })).stdout);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  }

  private async snapshotAndRemove(
    params: ArchiveWorktreeParams,
    hibernation?: { capSnapshotBytes: number; verifyTree: (worktreePath: string) => Promise<string> },
  ): Promise<Omit<WorktreeSnapshotSummary, "backend">> {
    let worktreePath: string;
    try {
      worktreePath = await realpath(path.resolve(params.worktreePath));
    } catch (error) {
      // A missing target or repository before snapshot preparation is a
      // routine skip. Later filesystem failures remain errors.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new MissingArchiveWorktreeError(params.worktreePath);
      }
      throw error;
    }
    // A checkout whose repository is gone cannot be snapshotted or removed
    // through Git. Report it as kept, never as a failure.
    const missingRepository = await missingWorktreeRepository(worktreePath);
    if (missingRepository) throw new MissingArchiveRepositoryError(params.worktreePath, missingRepository);
    let repositoryAnchor = worktreePath;
    if (params.repositoryPath) {
      try {
        repositoryAnchor = await realpath(path.resolve(params.repositoryPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new MissingArchiveRepositoryError(params.worktreePath, params.repositoryPath);
        }
        throw error;
      }
    }
    const commonDirectory = await realpath(trimGitOutput((await this.runGit(repositoryAnchor, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ])).stdout));
    const gitDirectory = await realpath(trimGitOutput((await this.runGit(worktreePath, [
      "rev-parse", "--absolute-git-dir",
    ])).stdout));
    if (gitDirectory === commonDirectory) {
      throw new Error("Refusing to archive the primary checkout as a worktree.");
    }
    await checkArchiveRegistration({ worktreePath, gitDirectory, commonDirectory });
    // Git's primary worktree is the common directory with a trailing /.git
    // removed, or the common directory itself for a bare/separate Git dir.
    const repositoryPath = path.basename(commonDirectory) === ".git" ? path.dirname(commonDirectory) : commonDirectory;
    const head = trimGitOutput((await this.runGit(worktreePath, ["rev-parse", "--verify", "HEAD"])).stdout);
    let branch: string | undefined;
    try {
      branch = trimGitOutput((await this.runGit(worktreePath, ["symbolic-ref", "--quiet", "HEAD"])).stdout).replace(/^refs\/heads\//, "");
    } catch (error) {
      // symbolic-ref exits 1 for a detached HEAD. Other Git failures must keep
      // the checkout rather than silently changing its saved source identity.
      if ((error as { code?: number }).code !== 1) throw error;
    }
    const worktree: WorktreeInfo = { path: worktreePath, head, branch, detached: !branch };

    const snapshotCommit = await this.createSnapshotCommit({
      backend: params.backend,
      threadId: params.threadId,
      worktree,
      worktreePath,
      maxSnapshotBytes: params.maxSnapshotBytes,
      capSnapshotBytes: hibernation?.capSnapshotBytes,
    });
    const snapshotRef = snapshotRefForBackend(params.backend, worktreePath);
    const previousRef = hibernation ? await this.readRef(repositoryPath, snapshotRef) : undefined;
    await this.runGit(repositoryPath, ["update-ref", snapshotRef, snapshotCommit]);
    let removalStarted = false;
    let assertRemoval: (() => void) | undefined;
    try {
      assertRemoval = await params.beforeRemove?.();
      assertRemoval?.();
      if (hibernation) {
        // Check 6: the work about to be removed is exactly what was saved.
        const snapshotTree = trimGitOutput((await this.runGit(repositoryPath, ["rev-parse", `${snapshotCommit}^{tree}`])).stdout);
        if (await hibernation.verifyTree(worktreePath) !== snapshotTree) throw new SnapshotTreeMismatchError(worktreePath);
        assertRemoval?.();
      }
    } catch (error) {
      // Nothing was removed. Put back the snapshot an earlier archive or
      // hibernation left under this per-path ref.
      if (hibernation) await this.resetRef(repositoryPath, snapshotRef, snapshotCommit, previousRef).catch(() => {});
      throw error;
    }
    try {
      await this.removeCheckout({ worktreePath, gitDirectory, commonDirectory, repositoryPath, head, assertRemoval,
        onRemovalStarted: () => { removalStarted = true; } });
    } catch (error) {
      if (!hibernation) throw error;
      if (!removalStarted) {
        await this.resetRef(repositoryPath, snapshotRef, snapshotCommit, previousRef).catch(() => {});
        throw error;
      }
      // A removal that stopped partway (Windows can hold files open) may have
      // already deleted work. Keep the checkout only while it is intact;
      // otherwise record the snapshot so the missing-checkout card can
      // recover from it.
      const intact = await pathExists(worktreePath)
        && await hibernation.verifyTree(worktreePath).then(
          async (tree) => tree === trimGitOutput((await this.runGit(repositoryPath, ["rev-parse", `${snapshotCommit}^{tree}`])).stdout),
          () => false,
        );
      if (intact) {
        await this.resetRef(repositoryPath, snapshotRef, snapshotCommit, previousRef).catch(() => {});
        throw error;
      }
      const archivedAt = params.now ?? Date.now();
      return {
        id: snapshotIdForPath(worktreePath), threadId: params.threadId, worktreePath, repositoryPath,
        snapshotRef, snapshotCommit, sourceBranch: worktree.branch, sourceHead: worktree.head,
        createdAt: archivedAt, archivedAt, state: "archived", ignoredFilesExcluded: true,
        unavailableReason: `The checkout was only partly removed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const archivedAt = params.now ?? Date.now();
    return {
      id: snapshotIdForPath(worktreePath),
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

  private async removeCheckout(params: {
    worktreePath: string;
    gitDirectory: string;
    commonDirectory: string;
    repositoryPath: string;
    head: string;
    assertRemoval?: () => void;
    onRemovalStarted: () => void;
  }): Promise<void> {
    const { worktreePath, gitDirectory, commonDirectory, repositoryPath, head, assertRemoval } = params;
    await this.repositoryRemovals.run(commonDirectory, async () => await withWorktreeTerminalsClosed(worktreePath, async () => {
      // Removal admission and terminal teardown can await other work. Recheck
      // Git's lock protection before modifying even ignored link entries.
      await checkArchiveRegistration({ worktreePath, gitDirectory, commonDirectory, removing: true });
      if (trimGitOutput((await this.runGit(worktreePath, ["rev-parse", "--verify", "HEAD"])).stdout) !== head) {
        throw new Error("Worktree HEAD changed during snapshot preparation; the worktree was kept.");
      }
      assertRemoval?.();
      if (process.platform === "win32") {
        params.onRemovalStarted();
        await unlinkWindowsWorktreeLinks(worktreePath, assertRemoval);
      }
      assertRemoval?.();
      await this.runGit(
        repositoryPath,
        ["worktree", "remove", "--force", worktreePath],
        // Git for Windows can hand work to another git.exe after the launcher
        // exits. Own that complete process tree atomically and do not report the
        // archive complete until the Job's active-process count reaches zero.
        { ownProcessTree: true, beforeSpawn: () => { assertRemoval?.(); params.onRemovalStarted(); } },
      );
    }, assertRemoval));
  }

  private async readRef(repositoryPath: string, ref: string): Promise<string | undefined> {
    const result = await this.runGit(repositoryPath, ["for-each-ref", "--format=%(objectname)", ref]);
    return trimGitOutput(result.stdout) || undefined;
  }

  /** Compare-and-swap the ref from `current` back to `previous`, or delete it. */
  private async resetRef(repositoryPath: string, ref: string, current: string, previous: string | undefined): Promise<void> {
    await this.runGit(repositoryPath, previous ? ["update-ref", ref, previous, current] : ["update-ref", "-d", ref, current]);
  }

  async deleteSnapshot(snapshot: WorktreeSnapshotSummary): Promise<void> {
    if (!/^refs\/(?:codex|pwragent)\/snapshots\//.test(snapshot.snapshotRef)) {
      // Branch-backed restore fallbacks and provider-owned refs are retained.
      return;
    }
    // A removed repository no longer contains any refs to release. Other
    // filesystem or Git failures retain metadata for a later cleanup attempt.
    try { await stat(snapshot.repositoryPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const result = await this.runGit(snapshot.repositoryPath, [
      "for-each-ref", "--format=%(refname) %(objectname)", snapshot.snapshotRef,
    ]);
    const retainedCommit = result.stdout.split("\n")
      .find((line) => line.startsWith(`${snapshot.snapshotRef} `))?.slice(snapshot.snapshotRef.length + 1).trim();
    if (!retainedCommit || retainedCommit !== snapshot.snapshotCommit) return;
    // Compare-and-delete protects a newer snapshot written under the same ref.
    await this.runGit(snapshot.repositoryPath, ["update-ref", "-d", snapshot.snapshotRef, snapshot.snapshotCommit]);
  }

  async restore(params: RestoreWorktreeParams): Promise<WorktreeSnapshotSummary> {
    const worktreePath = path.resolve(params.worktreePath);
    const repositoryPath = path.resolve(params.repositoryPath);
    const { commit: restoreCommit, fallbackReason } =
      await this.resolveRestoreCommit(params);

    await mkdir(path.dirname(worktreePath), { recursive: true });
    let sourceBranch: string | undefined;
    const sourceHead = params.restoreSourceCheckout ? params.snapshot?.sourceHead : undefined;
    let branchReason: string | undefined;
    if (sourceHead && params.snapshot?.sourceBranch) {
      const branch = params.snapshot.sourceBranch;
      const worktrees = await this.listWorktrees(repositoryPath);
      try {
        const branchHead = trimGitOutput((await this.runGit(repositoryPath, ["rev-parse", `refs/heads/${branch}^{commit}`])).stdout);
        if (branchHead === sourceHead && !worktrees.some((worktree) => worktree.branch === branch)) sourceBranch = branch;
        else branchReason = "The original branch moved or is in use; restored its saved HEAD detached.";
      } catch {
        branchReason = "The original branch is unavailable; restored its saved HEAD detached.";
      }
    }
    await this.runGit(repositoryPath, sourceBranch
      ? ["worktree", "add", worktreePath, sourceBranch]
      : ["worktree", "add", "--detach", worktreePath, sourceHead ?? restoreCommit],
    { ownProcessTree: params.restoreSourceCheckout });
    if (sourceHead && sourceHead !== restoreCommit) {
      // Populate the saved file tree, then return the index to the original
      // HEAD. Dirty and non-ignored untracked files remain working-tree edits;
      // the source branch and its unpublished commits are never advanced.
      await this.runGit(worktreePath, ["read-tree", "--reset", "-u", restoreCommit], { ownProcessTree: true });
      await this.runGit(worktreePath, ["read-tree", sourceHead], { ownProcessTree: true });
    }

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
      restoredCheckoutIdentity: await this.readRestoredCheckoutIdentity(worktreePath),
      unavailableReason: [fallbackReason, branchReason].filter(Boolean).join(" ") || undefined,
    };
  }

  private async readRestoredCheckoutIdentity(worktreePath: string): Promise<NonNullable<WorktreeSnapshotSummary["restoredCheckoutIdentity"]>> {
    const directory = await stat(worktreePath, { bigint: true });
    if (!directory.isDirectory()) throw new Error("Restored worktree path is not a directory.");
    const gitDirectory = await realpath(trimGitOutput((await this.runGit(worktreePath, ["rev-parse", "--absolute-git-dir"])).stdout));
    return { device: String(directory.dev), inode: String(directory.ino), birthtimeNs: String(directory.birthtimeNs), gitDirectory };
  }

  /** A durable successful restore is reusable only while its physical checkout
   * and Git registration still match. Do not overwrite subsequent shared edits. */
  async isRestoredCheckout(snapshot: WorktreeSnapshotSummary): Promise<boolean> {
    const saved = snapshot.restoredCheckoutIdentity;
    if (!saved || saved.inode === "0") return false;
    try {
      const actual = await this.readRestoredCheckoutIdentity(snapshot.worktreePath);
      if (actual.device !== saved.device || actual.inode !== saved.inode
        || actual.birthtimeNs !== saved.birthtimeNs || actual.gitDirectory !== saved.gitDirectory) return false;
      return Boolean(findWorktree(await this.listWorktrees(snapshot.repositoryPath), await realpath(snapshot.worktreePath)));
    } catch { return false; }
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
    maxSnapshotBytes?: number;
    capSnapshotBytes?: number;
    backend: SnapshotOwner;
    threadId: string;
    worktree: WorktreeInfo;
    worktreePath: string;
  }): Promise<string> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-worktree-index-"));
    const indexPath = path.join(tempDir, "index");

    try {
      const env = { GIT_INDEX_FILE: indexPath };
      const source = params.worktree.head ?? "HEAD";
      await this.runGit(params.worktreePath, ["read-tree", source], { env });
      // Measure exactly what this fresh index will stage, before git add writes
      // blobs. The live index can hide edits with assume-unchanged or skip-worktree
      // flags that are absent here. Committed and ignored content is excluded.
      const changed = await this.runGit(params.worktreePath, ["diff", "--name-only", "-z", source, "--", "."], { env });
      const untracked = await this.runGit(params.worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"], { env });
      const files = new Set(`${changed.stdout}${untracked.stdout}`.split("\0").filter(Boolean));
      // A clean checkout needs only a recovery pin to its existing HEAD. Do
      // not manufacture an empty-change commit (or a branch) for the archive.
      if (files.size === 0 && params.worktree.head) return params.worktree.head;
      if (files.size > MAX_WORKTREE_SNAPSHOT_FILES) {
        throw new Error(`Snapshot file limit exceeded (${MAX_WORKTREE_SNAPSHOT_FILES}); the worktree was kept.`);
      }
      // A reviewed approval may raise the limit; hibernation's own setting
      // may only lower it.
      const limit = Math.min(
        Math.max(this.maxSnapshotBytes, params.maxSnapshotBytes ?? 0),
        params.capSnapshotBytes ?? Number.POSITIVE_INFINITY,
      );
      let bytes = 0;
      for (const file of files) {
        try {
          const info = await lstat(path.join(params.worktreePath, file));
          // Do not follow links into dependencies or unrelated directories.
          if (info.isFile() || info.isSymbolicLink()) bytes += info.size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (bytes > limit) {
          throw new Error(`Snapshot size limit exceeded (${limit} bytes); the worktree was kept.`);
        }
      }
      await this.runGit(params.worktreePath, ["add", "-A", "--", "."], { env });
      const tree = trimGitOutput(
        (await this.runGit(params.worktreePath, ["write-tree"], { env })).stdout,
      );
      if (params.worktree.head && tree === trimGitOutput((await this.runGit(params.worktreePath, ["rev-parse", `${params.worktree.head}^{tree}`])).stdout)) {
        return params.worktree.head;
      }
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

  private async listWorktrees(repositoryPath: string): Promise<WorktreeInfo[]> {
    const output = await this.runGit(repositoryPath, ["worktree", "list", "--porcelain"]);
    return parseWorktreeList(output.stdout);
  }

  private async runGit(
    cwd: string,
    args: string[],
    options: {
      env?: NodeJS.ProcessEnv;
      ownProcessTree?: boolean;
      beforeSpawn?: () => void;
    } = {},
  ): Promise<GitResult> {
    return await runGit(cwd, args, {
      env: {
        ...this.gitEnv,
        ...options.env,
      },
      ownProcessTree: options.ownProcessTree,
      beforeSpawn: options.beforeSpawn,
    });
  }
}

export const worktreeArchiveInternals = {
  parseWorktreeList,
  snapshotIdForPath,
  snapshotRefForBackend,
};
