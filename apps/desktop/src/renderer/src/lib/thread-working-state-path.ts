import type { NavigationThreadSummary } from "@pwragent/shared";

/** Mirrors the main-process working-state owner-path resolution contract. */
export function resolveThreadWorkingStatePath(
  thread: Pick<NavigationThreadSummary, "projectKey" | "linkedDirectories">,
): string | undefined {
  const projectKey = thread.projectKey?.trim();
  if (projectKey) {
    return projectKey;
  }

  for (const directory of thread.linkedDirectories) {
    const worktreePath = directory.worktreePath?.trim();
    if (worktreePath) {
      return worktreePath;
    }
  }

  for (const directory of thread.linkedDirectories) {
    if (directory.kind !== "local") {
      continue;
    }
    const directoryPath = directory.path.trim();
    if (directoryPath) {
      return directoryPath;
    }
  }

  return undefined;
}
