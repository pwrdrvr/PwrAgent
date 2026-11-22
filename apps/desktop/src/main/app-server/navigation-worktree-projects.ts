import path from "node:path";
import type { DirectoryOverlayState, NavigationDirectoryGitStatus, NavigationDirectorySummary, NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { applyNavigationDirectoryOverlay, canonicalizeNavigationPath } from "@pwragent/shared/directory-navigation";
import { navigationDirectoryRepositoryRevision, type NavigationQueryIndex } from "@pwragent/owner-core/navigation-query-projection";
import { resolveWorktreeRepositoryDirectory } from "../git-info/worktree-store";
import { reconcileWindowsDirectoryAliases } from "./navigation-windows-directory-aliases";

const PROJECT_PROBE_BATCH_SIZE = 16;

type WorktreeProjectOptions = {
  signal?: AbortSignal;
  directoryOverlays?: Record<string, DirectoryOverlayState>;
  gitStatusByKey?: Record<string, { gitStatus?: NavigationDirectoryGitStatus } | undefined>;
};
type WorktreeProjects = Pick<NavigationQueryIndex, "directories" | "worktreeProjectAliases" | "worktreeRepositorySources">;

export async function resolveNavigationWorktreeProjects(
  directories: NavigationDirectorySummary[],
  options: WorktreeProjectOptions & { threads: readonly NavigationThreadSummary[] },
): Promise<WorktreeProjects & Pick<NavigationQueryIndex, "directoryCaseAliases">> {
  const projects = await resolveGitWorktreeProjects(directories, options);
  const reconciled = await reconcileWindowsDirectoryAliases(projects.directories, options.threads, options.signal);
  if (!reconciled.directoryCaseAliases) return projects;

  const worktreeProjectAliases = { ...projects.worktreeProjectAliases };
  const worktreeRepositorySources = { ...projects.worktreeRepositorySources };
  for (const [preferred, aliases] of Object.entries(reconciled.directoryCaseAliases)) {
    for (const alias of aliases) {
      const worktrees = worktreeProjectAliases[alias];
      if (worktrees) {
        worktreeProjectAliases[preferred] = [...(worktreeProjectAliases[preferred] ?? []), ...worktrees];
        delete worktreeProjectAliases[alias];
      }
      delete worktreeRepositorySources[alias];
    }
  }
  return { ...reconciled, worktreeProjectAliases, worktreeRepositorySources };
}

/**
 * Older registrations and provider rows can name a worktree as a project.
 * Project membership follows Git ownership. Keep workspace paths and saved
 * launchpads intact, and use the primary checkout's launchpad for new work.
 */
async function resolveGitWorktreeProjects(
  directories: NavigationDirectorySummary[],
  options: WorktreeProjectOptions,
): Promise<WorktreeProjects> {
  const { signal } = options;
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
  let repositorySources: NavigationQueryIndex["worktreeRepositorySources"];
  for (const project of projects.values()) {
    for (const checkout of project.checkoutPaths ?? []) groupedProjectKeys.set(checkout, project.key);
  }
  for (const worktree of candidates) {
    const parentPath = worktreeParents.get(worktree.key);
    if (!parentPath) continue;
    const key = groupedProjectKeys.get(parentPath) ?? `directory:${parentPath}`;
    const existing = projects.get(key);
    // Hidden draft and settings records are still addressable by composer
    // history, but only a registration or a thread can create a project row.
    if (!existing && !worktree.threadKeys.length && worktree.launchpad?.registeredAt == null) continue;
    const keys = aliases.get(key);
    if (keys) keys.push(worktree.key);
    else aliases.set(key, [worktree.key]);
    const parent: NavigationDirectorySummary = existing ?? {
      key, kind: "directory", path: parentPath, label: path.posix.basename(parentPath) || parentPath,
      threadKeys: [], needsAttentionCount: 0,
      gitStatus: options.gitStatusByKey?.[key]?.gitStatus,
      repositoryKey: worktree.gitStatus?.originRepository ?? worktree.repositoryKey,
      repositoryKeys: worktree.gitStatus?.remoteRepositories ?? worktree.repositoryKeys,
    };
    if (!existing) {
      applyNavigationDirectoryOverlay(parent, options.directoryOverlays?.[key]);
      repositorySources ??= {};
      repositorySources[key] = { key: worktree.key, repositoryRevision: navigationDirectoryRepositoryRevision(worktree.gitStatus) };
    }
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
    ...(repositorySources ? { worktreeRepositorySources: repositorySources } : {}),
  };
}
