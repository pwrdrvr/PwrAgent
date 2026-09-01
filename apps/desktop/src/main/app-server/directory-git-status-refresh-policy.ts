import type { NavigationDirectorySummary } from "@pwragent/shared";

type DirectoryGitStatusCacheEntryLike = {
  directoryUpdatedAt?: number;
  fetchedAt: number;
};

/**
 * Directory status is navigation context, not an admission or correctness
 * gate. Five minutes keeps an untouched fleet calm while explicit focus and
 * mutation paths refresh the directories the operator is actually using.
 */
export const DIRECTORY_GIT_STATUS_CACHE_MAX_AGE_MS = 5 * 60_000;
export const DIRECTORY_GIT_STATUS_BACKGROUND_BATCH_SIZE = 4;

// Forced focus refreshes can arrive in rapid succession while the operator
// flips between threads in one repository. Collapse the post-completion gap;
// in-flight requests already coalesce separately.
export const DIRECTORY_GIT_STATUS_FORCE_COALESCE_WINDOW_MS = 3_000;

export function isFreshDirectoryGitStatusCacheEntry(
  entry: DirectoryGitStatusCacheEntryLike,
  now = Date.now(),
): boolean {
  return now - entry.fetchedAt < DIRECTORY_GIT_STATUS_CACHE_MAX_AGE_MS;
}

export function selectStaleDirectoryGitStatusKeys(params: {
  cache: Record<string, DirectoryGitStatusCacheEntryLike>;
  directories: NavigationDirectorySummary[];
  limit?: number;
  now?: number;
}): string[] {
  const now = params.now ?? Date.now();
  return params.directories
    .filter((directory) => {
      if (!directory.path?.trim()) {
        return false;
      }
      const cached = params.cache[directory.key];
      return !cached
        || !isFreshDirectoryGitStatusCacheEntry(cached, now)
        || (directory.latestUpdatedAt ?? 0) > (cached.directoryUpdatedAt ?? 0);
    })
    .sort((left, right) => (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0))
    .slice(0, params.limit ?? DIRECTORY_GIT_STATUS_BACKGROUND_BATCH_SIZE)
    .map((directory) => directory.key);
}
