type NormalizedDirectoryPath = {
  caseInsensitive: boolean;
  normalized: string;
};

/**
 * Display an absolute path relative to the longest known directory that
 * contains it. Paths outside the known directories are returned unchanged.
 */
export function formatPathRelativeToDirectories(
  value: string,
  directoryPaths: string[] | undefined,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const normalizedValue = normalizePath(trimmed);
  const valueIsWindowsPath = isWindowsPath(trimmed);
  const roots = [...(directoryPaths ?? [])]
    .map((root): NormalizedDirectoryPath => ({
      caseInsensitive: valueIsWindowsPath || isWindowsPath(root),
      normalized: normalizePath(root),
    }))
    .filter((root) => Boolean(root.normalized))
    .sort((left, right) => right.normalized.length - left.normalized.length);

  for (const root of roots) {
    const comparisonValue = root.caseInsensitive
      ? normalizedValue.toLowerCase()
      : normalizedValue;
    const comparisonRoot = root.caseInsensitive
      ? root.normalized.toLowerCase()
      : root.normalized;
    if (comparisonValue === comparisonRoot) {
      return ".";
    }
    const isContained = comparisonRoot === "/"
      ? comparisonValue.startsWith("/")
      : comparisonValue.startsWith(`${comparisonRoot}/`);
    if (isContained) {
      const relativeStart = comparisonRoot === "/" ? 1 : root.normalized.length + 1;
      return trimmed.slice(relativeStart) || ".";
    }
  }

  return trimmed;
}

function isWindowsPath(value: string): boolean {
  const trimmed = value.trim();
  return /^[a-z]:[\\/]/i.test(trimmed) || /^\\\\/.test(trimmed);
}

function normalizePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}
