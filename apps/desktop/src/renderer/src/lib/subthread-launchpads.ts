import type { NavigationThreadSummary } from "@pwragent/shared";
import { SUBTHREAD_LAUNCHPAD_KEY_PREFIX } from "@pwragent/shared";

export type ThreadWorkspaceMode = "local" | "same-worktree" | "new-worktree" | "new-workspace";

export function getThreadPrimaryDirectory(thread: NavigationThreadSummary) {
  return thread.linkedDirectories.find((directory) =>
    (directory.worktreePath ?? directory.path) === thread.projectKey,
  ) ?? thread.linkedDirectories[0];
}

export function buildSubthreadLaunchpadKey(
  parent: Pick<NavigationThreadSummary, "id" | "source">,
  mode: ThreadWorkspaceMode,
): string {
  return `${SUBTHREAD_LAUNCHPAD_KEY_PREFIX}${encodeURIComponent(parent.source)}:${encodeURIComponent(parent.id)}:${mode}`;
}

export function getSubthreadLaunchpadMode(
  directoryKey: string,
): ThreadWorkspaceMode | undefined {
  const parts = directoryKey.split(":");
  if (parts.length !== 4 || parts[0] !== "subthread") {
    return undefined;
  }

  const mode = parts[3];
  if (mode === "local" || mode === "same-worktree" || mode === "new-worktree" || mode === "new-workspace") {
    return mode;
  }
  return undefined;
}

export function getParentThreadIdFromSubthreadLaunchpadKey(
  directoryKey: string,
): string | undefined {
  const parts = directoryKey.split(":");
  if (parts.length !== 4 || parts[0] !== "subthread") {
    return undefined;
  }
  try {
    return decodeURIComponent(parts[2]!);
  } catch {
    return undefined;
  }
}

export function isSameWorktreeSubthreadLaunchpad(directoryKey: string): boolean {
  return getSubthreadLaunchpadMode(directoryKey) === "same-worktree";
}
