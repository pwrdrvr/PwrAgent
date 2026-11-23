import type { AppServerThreadSummary, LinkedDirectorySummary } from "@pwragent/shared/contracts/normalized-app-server";

function normalizeGitOriginUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const sshMatch = trimmed.match(/^git@([^:]+):(.+)$/i);
  const candidate = sshMatch
    ? `${sshMatch[1]}/${sshMatch[2]}`
    : trimmed.replace(/^[a-z]+:\/\//i, "");

  const normalized = candidate
    .replace(/\.git$/i, "")
    .replace(/^ssh\//i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();

  return normalized || undefined;
}

export function hydrateMissingLinkedDirectoriesFromSiblingRepos<T extends AppServerThreadSummary>(threads: T[]): T[] {
  const donorDirectoriesByOrigin = new Map<string, LinkedDirectorySummary[]>();

  for (const thread of threads) {
    if (thread.source !== "codex" || thread.linkedDirectories.length === 0) {
      continue;
    }

    const normalizedOrigin = normalizeGitOriginUrl(thread.gitOriginUrl);
    if (!normalizedOrigin || donorDirectoriesByOrigin.has(normalizedOrigin)) {
      continue;
    }

    const rootDirectories = thread.linkedDirectories.filter(
      (directory) => !directory.worktreePath
    );
    donorDirectoriesByOrigin.set(
      normalizedOrigin,
      rootDirectories.length > 0 ? rootDirectories : thread.linkedDirectories
    );
  }

  return threads.map((thread) => {
    if (thread.source !== "codex" || thread.linkedDirectories.length > 0) {
      return thread;
    }

    const normalizedOrigin = normalizeGitOriginUrl(thread.gitOriginUrl);
    if (!normalizedOrigin) {
      return thread;
    }

    const donorDirectories = donorDirectoriesByOrigin.get(normalizedOrigin);
    if (!donorDirectories || donorDirectories.length === 0) {
      return thread;
    }

    const linkedDirectories = donorDirectories.map((directory) => {
      if (!thread.projectKey || thread.projectKey === directory.path) {
        return directory;
      }

      return {
        ...directory,
        worktreePath: thread.projectKey,
        kind: "worktree" as const,
      };
    });

    return {
      ...thread,
      linkedDirectories,
    };
  });
}
