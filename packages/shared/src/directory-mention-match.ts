import type { NavigationDirectorySummary } from "./contracts/navigation";
import { abbreviateHomePath, isWindowsFilesystemPath } from "./path-display";

type DirectoryMentionCandidate = Pick<NavigationDirectorySummary, "kind" | "label" | "path" | "latestUpdatedAt">;

export function isReferenceableDirectory(
  directory: Pick<DirectoryMentionCandidate, "kind" | "path">,
): directory is { kind: "directory" | "workspace"; path: string } {
  return directory.kind !== "unlinked" && Boolean(directory.path);
}

/** Rank exact names, name prefixes, then substring matches. Break ties by recency. */
export function rankDirectoryMentionMatches<T extends DirectoryMentionCandidate>(
  directories: readonly T[],
  query: string,
  homeDir?: string,
): T[] {
  const needle = query.trim().toLowerCase();
  const matchAbbreviatedPath = needle.includes("~");
  const matches = directories.flatMap((directory) => {
    if (!isReferenceableDirectory(directory)) return [];
    if (!needle) return [{ directory, rank: 0 }];
    const label = directory.label.toLowerCase();
    if (label === needle) return [{ directory, rank: 2 }];
    if (label.startsWith(needle)) return [{ directory, rank: 1 }];
    const path = directory.path.toLowerCase();
    const windowsPath = isWindowsFilesystemPath(path);
    const pathMatches = windowsPath
      ? path.replace(/\\/g, "/").includes(needle.replace(/\\/g, "/"))
      : path.includes(needle)
        || (matchAbbreviatedPath && abbreviateHomePath(directory.path, homeDir).toLowerCase().includes(needle));
    return label.includes(needle) || pathMatches ? [{ directory, rank: 0 }] : [];
  });
  return matches.sort((left, right) => right.rank - left.rank
    || (right.directory.latestUpdatedAt ?? 0) - (left.directory.latestUpdatedAt ?? 0))
    .map(({ directory }) => directory);
}
