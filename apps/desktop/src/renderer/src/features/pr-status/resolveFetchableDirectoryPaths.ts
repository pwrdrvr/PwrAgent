import type { LinkedDirectorySummary } from "@pwragent/shared";

/**
 * Pick the cwd to ask `gh` about for each linked directory. Worktree
 * paths are preferred (those are where the branch actually exists
 * checked out); fall back to local paths when no worktree path is
 * recorded. Mirror of the main-side helper in `pr-detection.ts` —
 * kept duplicated to avoid a renderer→main import.
 */
export function resolveFetchableDirectoryPaths(
  linkedDirectories: LinkedDirectorySummary[],
): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const directory of linkedDirectories) {
    const candidate =
      directory.kind === "worktree"
        ? directory.worktreePath ?? directory.path
        : directory.path;
    if (!candidate) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    dirs.push(candidate);
  }
  return dirs;
}
