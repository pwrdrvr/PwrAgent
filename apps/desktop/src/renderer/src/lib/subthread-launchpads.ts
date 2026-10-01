import type { NavigationDirectoryGitStatus, NavigationThreadSummary } from "@pwragent/shared";
import { isSubthreadLaunchpadKey, SUBTHREAD_LAUNCHPAD_KEY_PREFIX } from "@pwragent/shared";
import type { ProjectIdentity } from "./federation-project-match";

export type ThreadWorkspaceMode = "local" | "same-worktree" | "new-worktree" | "new-workspace";

/** Where a sub-thread in a new workspace or worktree starts. */
export type SubthreadMachine = {
  /** Peer instance to start on; undefined is this machine. */
  instanceId?: string;
  /**
   * The branch the menu showed a new worktree there would start from. The
   * launch refuses rather than quietly basing it on another branch.
   */
  baseBranch?: string;
};

export function getThreadPrimaryDirectory(thread: NavigationThreadSummary) {
  return thread.linkedDirectories.find((directory) =>
    (directory.worktreePath ?? directory.path) === thread.projectKey,
  ) ?? thread.linkedDirectories[0];
}

/** The thread's branch by name; a detached `HEAD` names none. */
export function getThreadNamedBranch(
  thread: Pick<NavigationThreadSummary, "gitBranch" | "observedGitBranch">,
): string | undefined {
  if (thread.observedGitBranch && thread.observedGitBranch !== "HEAD") {
    return thread.observedGitBranch;
  }
  return thread.gitBranch && thread.gitBranch !== "HEAD"
    ? thread.gitBranch
    : undefined;
}

/**
 * The project a thread's primary workspace belongs to, as another machine
 * would recognize it: the viewer's directory row for that checkout when it
 * has one (it carries the origin), otherwise the linked directory itself
 * with the thread's own origin.
 */
export function getSubthreadProjectIdentity(
  thread: NavigationThreadSummary,
  directories: readonly (ProjectIdentity & { key: string })[],
): ProjectIdentity | undefined {
  const primary = getThreadPrimaryDirectory(thread);
  if (!primary) {
    return undefined;
  }
  // A sub-thread launchpad row can carry the parent's path; it is a
  // composer, not the project.
  const row = directories.find((directory) =>
    directory.kind === "directory"
    && !isSubthreadLaunchpadKey(directory.key)
    && (directory.key === primary.id || directory.path === primary.path));
  const repositoryKey = row?.repositoryKey ?? thread.primaryGitRepository;
  return {
    kind: "directory",
    label: row?.label ?? primary.label,
    path: row?.path ?? primary.path,
    ...(repositoryKey ? { repositoryKey } : {}),
  };
}

export type SubthreadWorktreeBase =
  | { available: true; baseBranch: string }
  | { available: false; reason: string };

/**
 * The branch a new worktree for a sub-thread starts from on another machine.
 *
 * The parent's branch may exist only where the parent runs, so it is used
 * only when the other checkout is known to have it; otherwise the worktree
 * starts from that checkout's current branch, and the menu says so. A
 * checkout with no branch to name offers no worktree at all.
 */
export function pickSubthreadWorktreeBase(
  parentBranch: string | undefined,
  gitStatus: Pick<
    NavigationDirectoryGitStatus,
    | "currentBranch"
    | "defaultBranch"
    | "branches"
    | "baseBranches"
    | "worktreeCreationAvailable"
    | "worktreeCreationUnavailableReason"
  > | undefined,
): SubthreadWorktreeBase {
  if (gitStatus?.worktreeCreationAvailable === false) {
    return {
      available: false,
      reason: gitStatus.worktreeCreationUnavailableReason ?? "No worktrees",
    };
  }
  const currentBranch =
    gitStatus?.currentBranch && gitStatus.currentBranch !== "HEAD"
      ? gitStatus.currentBranch
      : undefined;
  const known = [
    currentBranch,
    gitStatus?.defaultBranch,
    ...gitStatus?.branches ?? [],
    ...gitStatus?.baseBranches ?? [],
  ];
  if (parentBranch && known.includes(parentBranch)) {
    return { available: true, baseBranch: parentBranch };
  }
  const fallback = currentBranch ?? gitStatus?.defaultBranch;
  return fallback
    ? { available: true, baseBranch: fallback }
    : { available: false, reason: "No branch" };
}

/**
 * `subthread:<source>:<parent>:<mode>`, plus `:<machine>` for a launchpad on
 * a machine other than the parent's owner. Each machine gets its own
 * launchpad, so picking a second machine for the same parent cannot replace
 * the first one's composer and strand its launchpad on that machine.
 */
export function buildSubthreadLaunchpadKey(
  parent: Pick<NavigationThreadSummary, "id" | "source">,
  mode: ThreadWorkspaceMode,
  machineInstanceId?: string,
): string {
  const key = `${SUBTHREAD_LAUNCHPAD_KEY_PREFIX}${encodeURIComponent(parent.source)}:${encodeURIComponent(parent.id)}:${mode}`;
  return machineInstanceId ? `${key}:${encodeURIComponent(machineInstanceId)}` : key;
}

function decodeKeyPart(part: string | undefined): string | undefined {
  if (part === undefined) return undefined;
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}

function parseSubthreadLaunchpadKey(directoryKey: string):
  | { parentId?: string; mode: ThreadWorkspaceMode; machineInstanceId?: string }
  | undefined {
  const parts = directoryKey.split(":");
  if ((parts.length !== 4 && parts.length !== 5) || parts[0] !== "subthread") {
    return undefined;
  }
  const mode = parts[3];
  if (mode !== "local" && mode !== "same-worktree" && mode !== "new-worktree" && mode !== "new-workspace") {
    return undefined;
  }
  const parentId = decodeKeyPart(parts[2]);
  const machineInstanceId = decodeKeyPart(parts[4]);
  return {
    mode,
    ...(parentId !== undefined ? { parentId } : {}),
    ...(machineInstanceId !== undefined ? { machineInstanceId } : {}),
  };
}

export function getSubthreadLaunchpadMode(
  directoryKey: string,
): ThreadWorkspaceMode | undefined {
  return parseSubthreadLaunchpadKey(directoryKey)?.mode;
}

export function getParentThreadIdFromSubthreadLaunchpadKey(
  directoryKey: string,
): string | undefined {
  return parseSubthreadLaunchpadKey(directoryKey)?.parentId;
}

export function isSameWorktreeSubthreadLaunchpad(directoryKey: string): boolean {
  return getSubthreadLaunchpadMode(directoryKey) === "same-worktree";
}
