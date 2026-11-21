import type { LinkedDirectorySummary } from "@pwragent/shared/contracts/normalized-app-server";
import { normalizeLinkedDirectoryPathForMatch } from "./linked-directory-identity";

/**
 * Every directory a thread works in: its project, each linked worktree, and
 * each linked local directory, including the ones attached after the provider
 * created the thread (`extra`, from the overlay).
 */
export function threadWorkspacePaths(
  thread: { projectKey?: string; linkedDirectories: readonly LinkedDirectorySummary[] },
  extra: readonly LinkedDirectorySummary[] = [],
): string[] {
  const paths = new Set<string>();
  if (thread.projectKey?.trim()) paths.add(thread.projectKey.trim());
  for (const directory of [...thread.linkedDirectories, ...extra]) {
    const workspacePath = directory.worktreePath?.trim()
      || (directory.kind === "local" ? directory.path.trim() : "");
    if (workspacePath) paths.add(workspacePath);
  }
  return [...paths];
}

/**
 * The thread's own spelling of `requested`, or undefined when the thread
 * does not work there. Callers run Git in the returned path, never in the
 * string they were handed.
 */
export function matchThreadWorkspacePath(
  paths: readonly string[],
  requested: string | undefined,
): string | undefined {
  const wanted = normalizeLinkedDirectoryPathForMatch(requested);
  if (!wanted) return undefined;
  return paths.find((candidate) => normalizeLinkedDirectoryPathForMatch(candidate) === wanted);
}
