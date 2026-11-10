import { runGitCommand } from "./git-executable";
import { NOT_A_GIT_REPOSITORY, probeCurrentGitBranch } from "./git-head-branch";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isToolManagedWorktreePath,
  type AppServerThreadSummary,
  type LinkedDirectorySummary,
  type DetachThreadDirectoryToolArgs,
  type HandoffTaskWorkspaceMode,
  type ThreadOverlayState,
} from "@pwragent/shared";



/**
 * Resolve the live workspace CWD for thread-scoped commands.
 *
 * Worktree threads must run from LinkedDirectorySummary.worktreePath; Local
 * threads run from LinkedDirectorySummary.path. A handoff overlay projects the
 * committed workspace change immediately. The selected workspace remains
 * authoritative across provider-side synchronization so a later stale
 * provider snapshot cannot silently restore the pre-handoff workspace.
 */
export function resolveThreadWorkspaceCwd(
  thread: AppServerThreadSummary | undefined,
  overlayDirectories: AppServerThreadSummary["linkedDirectories"] = [],
): string | undefined {
  if (!thread) {
    return resolveLinkedDirectoryWorkspaceCwd(overlayDirectories);
  }

  const overlayHandoffDirectory = overlayDirectories.find(isHandoffDirectory);
  if (overlayHandoffDirectory) {
    return overlayHandoffDirectory.worktreePath ?? overlayHandoffDirectory.path;
  }

  const providerDirectories = thread.linkedDirectories.filter(
    (directory) =>
      !overlayDirectories.some((overlayDirectory) =>
        linkedDirectoriesHaveSameWorkspaceIdentity(directory, overlayDirectory),
      ),
  );

  return (
    resolveLinkedDirectoryWorkspaceCwd(providerDirectories) ??
    resolveLinkedDirectoryWorkspaceCwd(thread.linkedDirectories) ??
    resolveLinkedDirectoryWorkspaceCwd(overlayDirectories) ??
    thread.projectKey
  );
}

/** True when the thread's runtime cwd is one of its linked worktrees. */
export function threadWorkspaceIsWorktree(
  thread: AppServerThreadSummary | undefined,
  overlayDirectories: AppServerThreadSummary["linkedDirectories"] = [],
): boolean {
  const cwd = resolveThreadWorkspaceCwd(thread, overlayDirectories);
  if (!cwd) return false;
  const target = normalizeWorktreePathForComparison(cwd);
  return [...overlayDirectories, ...(thread?.linkedDirectories ?? [])].some((directory) =>
    directory.kind === "worktree"
    && normalizeWorktreePathForComparison(directory.worktreePath ?? directory.path) === target);
}

export function linkedDirectoriesHaveSameWorkspaceIdentity(
  left: LinkedDirectorySummary,
  right: LinkedDirectorySummary,
): boolean {
  if (left.id === right.id) {
    return true;
  }

  const leftPath = normalizeLinkedDirectoryIdentityPath(left.path);
  const rightPath = normalizeLinkedDirectoryIdentityPath(right.path);
  const leftWorktreePath = normalizeLinkedDirectoryIdentityPath(left.worktreePath);
  const rightWorktreePath = normalizeLinkedDirectoryIdentityPath(right.worktreePath);
  if (leftPath && rightPath && leftPath === rightPath) {
    return leftWorktreePath === rightWorktreePath;
  }

  return Boolean(
    leftWorktreePath &&
      rightWorktreePath &&
      leftWorktreePath === rightWorktreePath,
  );
}

export function normalizeLinkedDirectoryIdentityPath(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim();
  return normalized ? toDirectoryId(path.resolve(normalized)) : undefined;
}

export function resolveLinkedDirectoryWorkspaceCwd(
  linkedDirectories: AppServerThreadSummary["linkedDirectories"] = [],
): string | undefined {
  const handoffDirectory = linkedDirectories.find(isHandoffDirectory);
  if (handoffDirectory) {
    return handoffDirectory.worktreePath ?? handoffDirectory.path;
  }

  const directory =
    linkedDirectories.find((candidate) => candidate.kind === "worktree") ??
    linkedDirectories.find((candidate) => candidate.kind === "local") ??
    linkedDirectories[0];

  return directory?.worktreePath ?? directory?.path;
}

export function hasHandoffWorkspace(
  directories: AppServerThreadSummary["linkedDirectories"] = [],
): boolean {
  return directories.some(isHandoffDirectory);
}

export function overlayHasHandoffWorkspace(
  overlay: ThreadOverlayState | undefined,
): boolean {
  return Boolean(overlay?.extraLinkedDirectories.some(isHandoffDirectory));
}

export function isHandoffDirectory(directory: LinkedDirectorySummary): boolean {
  return (
    directory.id.startsWith("pwragent-handoff:") ||
    directory.id.startsWith("pwragnt-handoff:")  // legacy prefix from pre-rebrand data
  );
}

/**
 * Normalize a resolved path to forward slashes for use as a cross-platform
 * directory identifier. No-op on POSIX; on Windows turns `C:\Users\…` into
 * `C:/Users/…` so ids/keys read identically across hosts and match the
 * thread-directory-enricher's normalized identifiers.
 */
export function toDirectoryId(value: string): string {
  return value.replace(/\\/g, "/");
}

export function buildLocalLinkedDirectory(cwd: string | undefined): LinkedDirectorySummary[] {
  const normalized = cwd?.trim();
  if (!normalized) {
    return [];
  }
  const directoryPath = path.resolve(normalized);
  return [
    {
      id: toDirectoryId(directoryPath),
      kind: "local",
      label: path.basename(directoryPath) || directoryPath,
      path: toDirectoryId(directoryPath),
    },
  ];
}

export function buildWorktreeLinkedDirectory(params: {
  repositoryPath?: string;
  worktreePath?: string;
  label?: string;
}): LinkedDirectorySummary[] {
  const normalizedWorktreePath = params.worktreePath?.trim();
  if (!normalizedWorktreePath) {
    return [];
  }

  const worktreePath = path.resolve(normalizedWorktreePath);
  const repositoryPath = path.resolve(params.repositoryPath?.trim() || worktreePath);
  const label = params.label?.trim() || path.basename(repositoryPath) || repositoryPath;

  return [
    {
      id: toDirectoryId(repositoryPath),
      kind: "worktree",
      label,
      path: toDirectoryId(repositoryPath),
      worktreePath: toDirectoryId(worktreePath),
    },
  ];
}

export async function resolvePreparedRepositoryIdentityPath(params: {
  preparedPath?: string;
  requestedPath?: string;
}): Promise<string | undefined> {
  const preparedPath = params.preparedPath?.trim();
  const requestedPath = params.requestedPath?.trim();
  if (!preparedPath || !requestedPath) {
    return preparedPath || requestedPath || undefined;
  }

  const [preparedRealPath, requestedRealPath] = await Promise.all([
    realpath(preparedPath).catch(() => undefined),
    realpath(requestedPath).catch(() => undefined),
  ]);
  if (
    preparedRealPath
    && requestedRealPath
    && path.resolve(preparedRealPath) === path.resolve(requestedRealPath)
  ) {
    return requestedPath;
  }
  return preparedPath;
}

export function normalizeLinkedDirectoryPathForMatch(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim();
  return normalized ? toDirectoryId(path.resolve(normalized)) : undefined;
}

export function linkedDirectoriesShareWorktreeWorkspace(
  left: LinkedDirectorySummary,
  right: LinkedDirectorySummary,
): boolean {
  const normalizedLeft = normalizeLinkedDirectoryKind(left);
  const normalizedRight = normalizeLinkedDirectoryKind(right);
  if (normalizedLeft.kind !== "worktree" || normalizedRight.kind !== "worktree") {
    return false;
  }

  const leftWorktreePath = normalizeLinkedDirectoryPathForMatch(
    normalizedLeft.worktreePath,
  );
  const rightWorktreePath = normalizeLinkedDirectoryPathForMatch(
    normalizedRight.worktreePath,
  );
  return Boolean(
    leftWorktreePath
    && rightWorktreePath
    && leftWorktreePath === rightWorktreePath,
  );
}

export function linkedDirectoryMatchesDetachArgs(
  directory: LinkedDirectorySummary,
  args: DetachThreadDirectoryToolArgs,
): boolean {
  if (args.directoryId?.trim() && directory.id === args.directoryId.trim()) {
    return true;
  }
  const requestedPath = normalizeLinkedDirectoryPathForMatch(args.path);
  if (
    requestedPath &&
    normalizeLinkedDirectoryPathForMatch(directory.path) === requestedPath
  ) {
    return true;
  }
  const requestedWorktreePath = normalizeLinkedDirectoryPathForMatch(args.worktreePath);
  return Boolean(
    requestedWorktreePath &&
      normalizeLinkedDirectoryPathForMatch(directory.worktreePath) ===
        requestedWorktreePath,
  );
}

export function isLikelyToolManagedWorktreePath(projectKey: string | undefined): boolean {
  const normalized = projectKey?.trim();
  if (!normalized) {
    return false;
  }

  return isToolManagedWorktreePath(normalized) || /[\\/]\.worktrees[\\/]/.test(normalized);
}

export function hasCachedWorktreeDirectory(
  overlay: ThreadOverlayState | undefined,
  projectPath: string,
): boolean {
  const resolvedProjectPath = path.resolve(projectPath);
  return Boolean(
    overlay?.extraLinkedDirectories.some((directory) => {
      // directory.id is forward-slash normalized; re-resolve both sides so the
      // comparison is separator-agnostic across platforms.
      if (path.resolve(directory.id) !== resolvedProjectPath) {
        return false;
      }
      return Boolean(directory.worktreePath?.trim());
    }),
  );
}

export function hasEquivalentLinkedDirectory(
  overlay: ThreadOverlayState | undefined,
  directory: LinkedDirectorySummary,
): boolean {
  return Boolean(
    overlay?.extraLinkedDirectories.some((candidate) => {
      if (linkedDirectoriesShareWorktreeWorkspace(candidate, directory)) {
        return true;
      }
      if (candidate.id !== directory.id || candidate.kind !== directory.kind) {
        return false;
      }

      const candidatePath = path.resolve(candidate.path);
      const directoryPath = path.resolve(directory.path);
      const candidateWorktreePath = candidate.worktreePath?.trim()
        ? path.resolve(candidate.worktreePath)
        : undefined;
      const directoryWorktreePath = directory.worktreePath?.trim()
        ? path.resolve(directory.worktreePath)
        : undefined;

      return (
        candidatePath === directoryPath &&
        candidateWorktreePath === directoryWorktreePath
      );
    }),
  );
}

export function pathContainsOrEquals(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

export function buildCachedWorktreeDirectory(
  thread: AppServerThreadSummary,
): LinkedDirectorySummary | undefined {
  const projectKey = thread.projectKey?.trim();
  if (!projectKey) {
    return undefined;
  }

  const projectPath = path.resolve(projectKey);
  const directory = thread.linkedDirectories.find((candidate) => {
    const worktreePath = candidate.worktreePath?.trim();
    if (!worktreePath) {
      return false;
    }
    return pathContainsOrEquals(path.resolve(worktreePath), projectPath);
  });
  if (!directory) {
    return undefined;
  }

  const repositoryPath = path.resolve(directory.path);
  const worktreePath = path.resolve(directory.worktreePath!);
  if (repositoryPath === projectPath) {
    return undefined;
  }

  return {
    ...directory,
    id: toDirectoryId(projectPath),
    kind: "worktree",
    label: directory.label || path.basename(repositoryPath) || repositoryPath,
    path: toDirectoryId(repositoryPath),
    worktreePath: toDirectoryId(worktreePath),
  };
}

export function buildCachedDirectoryRelationship(
  thread: AppServerThreadSummary,
): LinkedDirectorySummary | undefined {
  const worktreeDirectory = buildCachedWorktreeDirectory(thread);
  if (worktreeDirectory) {
    return worktreeDirectory;
  }

  const projectKey = thread.projectKey?.trim();
  if (!projectKey) {
    return undefined;
  }

  if (isLikelyToolManagedWorktreePath(projectKey)) {
    return undefined;
  }

  const projectPath = path.resolve(projectKey);
  const localDirectory = thread.linkedDirectories.find((candidate) => {
    if (candidate.worktreePath?.trim()) {
      return false;
    }
    return path.resolve(candidate.path) === projectPath;
  });
  if (!localDirectory) {
    return undefined;
  }

  return {
    ...localDirectory,
    id: toDirectoryId(projectPath),
    kind: "local",
    label: localDirectory.label || path.basename(projectPath) || projectPath,
    path: toDirectoryId(projectPath),
    worktreePath: undefined,
  };
}

export function shouldRepairCachedDirectoryRelationship(params: {
  directory: LinkedDirectorySummary;
  overlay: ThreadOverlayState | undefined;
}): boolean {
  // The handoff overlay is both the authoritative workspace selection and the
  // durable retry marker. Keep it after Codex acknowledges the target: native
  // review can later restore the thread's original CWD in provider metadata,
  // and replacing this marker would let that stale snapshot win permanently.
  if (overlayHasHandoffWorkspace(params.overlay)) {
    return false;
  }

  if (hasEquivalentLinkedDirectory(params.overlay, params.directory)) {
    return false;
  }

  if (params.directory.kind === "worktree") {
    // An attached sibling from the same repository does not cache the primary
    // cwd's relationship. Repair the primary without replacing that sibling.
    return true;
  }

  return Boolean(
    params.overlay?.extraLinkedDirectories.some((candidate) => {
      if (candidate.id === params.directory.id) {
        return true;
      }
      if (isHandoffDirectory(candidate)) {
        return false;
      }

      return path.resolve(candidate.path) === path.resolve(params.directory.path);
    }),
  );
}

export function normalizeLinkedDirectoryKind(
  directory: LinkedDirectorySummary,
): LinkedDirectorySummary {
  if (
    directory.kind === "local" &&
    (directory.worktreePath?.trim() || isToolManagedWorktreePath(directory.path))
  ) {
    const worktreePath = directory.worktreePath?.trim() || directory.path;
    return {
      ...directory,
      kind: "worktree",
      worktreePath,
    };
  }

  return directory;
}

export function linkedDirectoryIdentityKey(directory: LinkedDirectorySummary): string {
  const normalized = normalizeLinkedDirectoryKind(directory);
  const repositoryPath = path.resolve(normalized.path);
  const worktreePath = normalized.worktreePath?.trim()
    ? path.resolve(normalized.worktreePath)
    : "";
  return `${normalized.kind}:${repositoryPath}:${worktreePath}`;
}

export function dedupeLinkedDirectoriesByNormalizedIdentity(
  directories: LinkedDirectorySummary[],
): LinkedDirectorySummary[] {
  const seen = new Set<string>();
  const deduped: LinkedDirectorySummary[] = [];
  for (const directory of directories) {
    const key = linkedDirectoryIdentityKey(directory);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(directory);
  }
  return deduped;
}

export function pendingStartedThreadMatchesFilter(
  thread: AppServerThreadSummary,
  filter: string | undefined,
): boolean {
  const normalized = filter?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return [
    thread.id,
    thread.title,
    thread.summary,
    thread.projectKey,
    ...thread.linkedDirectories.flatMap((directory) => [
      directory.label,
      directory.path,
      directory.worktreePath,
    ]),
  ]
    .filter(Boolean)
    .some((value) => value!.toLowerCase().includes(normalized));
}

export function pendingStartedThreadWorkspaceMatches(
  thread: AppServerThreadSummary,
  pendingThread: AppServerThreadSummary,
): boolean {
  const workspaceCwd = resolveThreadWorkspaceCwd(thread)?.trim();
  const pendingWorkspaceCwd = resolveThreadWorkspaceCwd(pendingThread)?.trim();
  if (!pendingWorkspaceCwd) {
    return true;
  }
  if (!workspaceCwd) {
    return false;
  }
  if (path.resolve(workspaceCwd) !== path.resolve(pendingWorkspaceCwd)) {
    return false;
  }

  if (pendingThread.linkedDirectories.length === 0) {
    return true;
  }
  const pendingDirectoryKeys = new Set(
    pendingThread.linkedDirectories.map(linkedDirectoryIdentityKey),
  );
  return thread.linkedDirectories.some((directory) =>
    pendingDirectoryKeys.has(linkedDirectoryIdentityKey(directory))
    || pendingThread.linkedDirectories.some((pendingDirectory) =>
      linkedDirectoriesShareWorktreeWorkspace(directory, pendingDirectory),
    ),
  );
}

export function retainPendingStartedThreadWorkspace(
  thread: AppServerThreadSummary,
  pendingThread: AppServerThreadSummary,
): AppServerThreadSummary {
  return {
    ...thread,
    projectKey: pendingThread.projectKey,
    linkedDirectories: pendingThread.linkedDirectories,
    gitBranch: pendingThread.gitBranch,
    codexEnvironmentRuntime:
      pendingThread.codexEnvironmentRuntime ?? thread.codexEnvironmentRuntime,
  };
}

export function resolveExpectedThreadBranch(params: {
  overlay?: ThreadOverlayState;
  thread?: Pick<AppServerThreadSummary, "gitBranch">;
}): string | undefined {
  const overlayBranch = params.overlay?.gitBranch?.trim();
  if (overlayBranch) {
    return overlayBranch;
  }

  const overlayObservedBranch = params.overlay?.observedGitBranch?.trim();
  if (
    overlayObservedBranch &&
    hasHandoffWorkspace(params.overlay?.extraLinkedDirectories)
  ) {
    return overlayObservedBranch;
  }

  return params.thread?.gitBranch?.trim() || undefined;
}

export function shouldUseObservedBranchForDetachedHandoff(params: {
  providerOwnsBranchMetadata?: boolean;
  branch?: string;
  observedBranch?: string;
  overlay?: ThreadOverlayState;
}): boolean {
  const branch = params.branch?.trim();
  const observedBranch = params.observedBranch?.trim();
  return Boolean(
    branch === "HEAD" &&
      observedBranch &&
      observedBranch !== "HEAD" &&
      (params.providerOwnsBranchMetadata === false
        || hasHandoffWorkspace(params.overlay?.extraLinkedDirectories)),
  );
}

export function resolveBranchDriftExpectedBranch(params: {
  providerOwnsBranchMetadata?: boolean;
  observedBranch?: string;
  overlay?: ThreadOverlayState;
  requestedExpectedBranch?: string;
  thread?: Pick<AppServerThreadSummary, "gitBranch">;
}): { expectedBranch?: string; repairedDetachedHandoffBranch: boolean } {
  const overlayBranch = params.overlay?.gitBranch?.trim();
  if (
    shouldUseObservedBranchForDetachedHandoff({
      providerOwnsBranchMetadata: params.providerOwnsBranchMetadata,
      branch: overlayBranch,
      observedBranch: params.observedBranch,
      overlay: params.overlay,
    })
  ) {
    return {
      expectedBranch: params.observedBranch,
      repairedDetachedHandoffBranch: true,
    };
  }
  if (overlayBranch) {
    return {
      expectedBranch: overlayBranch,
      repairedDetachedHandoffBranch: false,
    };
  }

  const requestedBranch = params.requestedExpectedBranch?.trim();
  if (
    shouldUseObservedBranchForDetachedHandoff({
      providerOwnsBranchMetadata: params.providerOwnsBranchMetadata,
      branch: requestedBranch,
      observedBranch: params.observedBranch,
      overlay: params.overlay,
    })
  ) {
    return {
      expectedBranch: params.observedBranch,
      repairedDetachedHandoffBranch: true,
    };
  }
  if (requestedBranch) {
    return {
      expectedBranch: requestedBranch,
      repairedDetachedHandoffBranch: false,
    };
  }

  const fallbackBranch = resolveExpectedThreadBranch({
    overlay: params.overlay,
    thread: params.thread,
  }) ?? (params.providerOwnsBranchMetadata === false
    ? params.overlay?.observedGitBranch?.trim()
    : undefined);
  if (
    shouldUseObservedBranchForDetachedHandoff({
      providerOwnsBranchMetadata: params.providerOwnsBranchMetadata,
      branch: fallbackBranch,
      observedBranch: params.observedBranch,
      overlay: params.overlay,
    })
  ) {
    return {
      expectedBranch: params.observedBranch,
      repairedDetachedHandoffBranch: true,
    };
  }

  return {
    expectedBranch: fallbackBranch,
    repairedDetachedHandoffBranch: false,
  };
}

export async function readCurrentGitBranch(sourcePath: string, signal?: AbortSignal): Promise<string | undefined> {
  const head = await probeCurrentGitBranch(sourcePath, signal);
  signal?.throwIfAborted();
  // Git would find no repository either. Skip its launch: on Windows that is
  // PowerShell plus Git, at thread start and before every turn end.
  if (head === NOT_A_GIT_REPOSITORY) return undefined;
  if (head) return head.branch;
  // Git for Windows can hand off to a descendant that still holds the
  // workspace open. Wait for the owned tree before allowing its removal.
  const result = await runGitCommand(sourcePath, ["rev-parse", "--abbrev-ref", "HEAD"], {
    ownProcessTree: true,
    signal,
  });
  const branch = result.stdout.trim();
  return branch || undefined;
}

export function normalizeHandoffTaskCwd(cwd: string | undefined): string | undefined {
  const trimmed = cwd?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function sameResolvedPath(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left?.trim() || !right?.trim()) {
    return false;
  }
  return path.resolve(left) === path.resolve(right);
}

export function shouldInheritHandoffCodexEnvironmentRuntime(params: {
  callerCwd?: string;
  callerProjectBoundary?: string;
  requestedCwd?: string;
  requestedProjectBoundary?: string;
  workspaceMode: HandoffTaskWorkspaceMode;
}): boolean {
  if (params.workspaceMode === "none") {
    return false;
  }
  return (
    !params.requestedCwd
    || sameResolvedPath(params.requestedCwd, params.callerCwd)
    || (
      Boolean(params.callerProjectBoundary)
      && Boolean(params.requestedProjectBoundary)
      && sameResolvedPath(
        params.callerProjectBoundary,
        params.requestedProjectBoundary,
      )
    )
  );
}

export function sameHandoffProjectBoundary(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left?.trim() || !right?.trim()) {
    return true;
  }
  return sameResolvedPath(left, right);
}

export function linkedDirectoryMatchesCwd(
  directory: LinkedDirectorySummary,
  cwd: string,
): boolean {
  const resolvedCwd = path.resolve(cwd);
  return (
    path.resolve(directory.worktreePath ?? directory.path) === resolvedCwd ||
    path.resolve(directory.path) === resolvedCwd
  );
}

export function directoryContainsPath(
  directoryPath: string | undefined,
  targetPath: string,
): boolean {
  if (!directoryPath?.trim()) {
    return false;
  }
  const relative = path.relative(path.resolve(directoryPath), targetPath);
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export const HANDOFF_CWD_TRUST_QUESTION_ID = "trust_directory";
export const HANDOFF_CWD_TRUST_APPROVE_LABEL = "Trust directory (Recommended)";

export function linkedDirectoryActiveWorkspaceCoversCwd(
  directory: LinkedDirectorySummary,
  cwd: string,
): boolean {
  const resolvedCwd = path.resolve(cwd);
  const activeDirectoryPath =
    directory.kind === "worktree" ? directory.worktreePath : directory.path;
  return directoryContainsPath(activeDirectoryPath, resolvedCwd);
}

export function linkedDirectoriesActiveWorkspaceCoversCwd(params: {
  cwd: string;
  overlay?: ThreadOverlayState;
  thread?: Pick<AppServerThreadSummary, "linkedDirectories">;
}): boolean {
  return [
    ...(params.overlay?.extraLinkedDirectories ?? []),
    ...(params.thread?.linkedDirectories ?? []),
  ].some((directory) =>
    linkedDirectoryActiveWorkspaceCoversCwd(directory, params.cwd),
  );
}

export function linkedDirectoryWorktreePath(
  directory: LinkedDirectorySummary,
): string | undefined {
  const explicitWorktreePath = directory.worktreePath?.trim();
  if (explicitWorktreePath) {
    return explicitWorktreePath;
  }

  if (directory.kind === "worktree") {
    return directory.path;
  }

  if (directory.kind === "local" && isLikelyToolManagedWorktreePath(directory.path)) {
    return directory.path;
  }

  return undefined;
}

export function normalizeWorktreePathForComparison(worktreePath: string): string {
  return path.normalize(worktreePath.trim());
}

/**
 * Archive cleanup's view of a thread's directories: its workspace links plus
 * the worktrees it left on disk with a fresh-start move. Those are still the
 * thread's own, so archive checkpoints and removes them like any other.
 */
export function withRetainedWorktrees(
  directories: LinkedDirectorySummary[],
  overlay: ThreadOverlayState | undefined,
): LinkedDirectorySummary[] {
  const retained = overlay?.retainedWorktrees ?? [];
  if (retained.length === 0) return directories;
  const linked = new Set(directories.flatMap((directory) => {
    const worktreePath = linkedDirectoryWorktreePath(directory);
    return worktreePath ? [normalizeWorktreePathForComparison(worktreePath)] : [];
  }));
  return [...directories, ...retained.filter((directory) => {
    const worktreePath = linkedDirectoryWorktreePath(directory);
    return worktreePath && !linked.has(normalizeWorktreePathForComparison(worktreePath));
  })];
}

/**
 * Match the forward-slashed directory identifiers
 * `resolveWorktreeRepositoryDirectory` returns, so a Windows repo keys the same
 * whether we resolved it through a worktree link or straight from its own path.
 */
export function toForwardSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}
