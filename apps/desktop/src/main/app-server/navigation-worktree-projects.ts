import path from "node:path";
import type { NavigationDirectorySummary } from "@pwragent/shared/contracts/navigation";
import { canonicalizeNavigationPath } from "@pwragent/shared/directory-navigation";
import type { NavigationQueryIndex } from "@pwragent/owner-core/navigation-query-projection";
import { resolveWorktreeRepositoryDirectory } from "../git-info/worktree-store";

const PROJECT_PROBE_BATCH_SIZE = 16;

/**
 * Older registrations and provider rows can name a worktree as a project.
 * Project membership follows Git ownership. Keep workspace paths and saved
 * launchpads intact, and use the primary checkout's launchpad for new work.
 */
export async function resolveNavigationWorktreeProjects(
  directories: NavigationDirectorySummary[],
  signal?: AbortSignal,
): Promise<Pick<NavigationQueryIndex, "directories" | "worktreeProjectAliases">> {
  const candidates = directories.filter((directory) => directory.kind === "directory"
    && !directory.localAvailability && directory.path && path.isAbsolute(directory.path));
  const worktreeParents = new Map<string, string>();
  for (let start = 0; start < candidates.length; start += PROJECT_PROBE_BATCH_SIZE) {
    signal?.throwIfAborted();
    await Promise.all(candidates.slice(start, start + PROJECT_PROBE_BATCH_SIZE).map(async (directory) => {
      const owner = await resolveWorktreeRepositoryDirectory(directory.path!, { rootOnly: true });
      if (owner && owner.path !== canonicalizeNavigationPath(directory.path!)) {
        worktreeParents.set(directory.key, owner.path);
      }
    }));
  }
  signal?.throwIfAborted();
  if (!worktreeParents.size) return { directories };

  const projects = new Map(directories.filter((directory) => !worktreeParents.has(directory.key))
    .map((directory) => [directory.key, directory]));
  const groupedProjectKeys = new Map<string, string>();
  const aliases = new Map<string, string[]>();
  for (const project of projects.values()) {
    for (const checkout of project.checkoutPaths ?? []) groupedProjectKeys.set(checkout, project.key);
  }
  for (const worktree of candidates) {
    const parentPath = worktreeParents.get(worktree.key);
    if (!parentPath) continue;
    const key = groupedProjectKeys.get(parentPath) ?? `directory:${parentPath}`;
    if (worktree.launchpad) {
      const keys = aliases.get(key);
      if (keys) keys.push(worktree.key);
      else aliases.set(key, [worktree.key]);
    }
    const parent: NavigationDirectorySummary = projects.get(key) ?? {
      key, kind: "directory", path: parentPath, label: path.posix.basename(parentPath) || parentPath,
      threadKeys: [], needsAttentionCount: 0,
      repositoryKey: worktree.gitStatus?.originRepository ?? worktree.repositoryKey,
      repositoryKeys: worktree.gitStatus?.remoteRepositories ?? worktree.repositoryKeys,
    };
    projects.set(key, {
      ...parent,
      threadKeys: [...new Set([...parent.threadKeys, ...worktree.threadKeys])],
      needsAttentionCount: parent.needsAttentionCount + worktree.needsAttentionCount,
      latestUpdatedAt: Math.max(parent.latestUpdatedAt ?? 0, worktree.latestUpdatedAt ?? 0),
    });
  }
  return {
    directories: [...projects.values()].sort((left, right) => left.label.localeCompare(right.label)),
    ...(aliases.size ? { worktreeProjectAliases: Object.fromEntries(aliases) } : {}),
  };
}
