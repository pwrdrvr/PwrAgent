type NormalizedDirectoryPath = {
  caseInsensitive: boolean;
  normalized: string;
  separator: "/" | "\\";
};

/**
 * Display an absolute path relative to the longest known directory that
 * contains it. Relative paths use the separator style of a known Windows
 * directory; absolute paths outside the known directories are unchanged.
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
      separator: isWindowsPath(root) ? "\\" : "/",
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
      return formatSeparators(
        normalizedValue.slice(relativeStart) || ".",
        root.separator,
      );
    }
  }

  if (!isAbsolutePath(trimmed)) {
    const windowsRoot = roots.find((root) => root.separator === "\\");
    if (windowsRoot) {
      return formatSeparators(trimmed, windowsRoot.separator);
    }
  }

  return trimmed;
}

function formatSeparators(value: string, separator: "/" | "\\"): string {
  return separator === "\\" ? value.replace(/\//g, "\\") : value;
}

function isAbsolutePath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("/") || isWindowsPath(trimmed);
}

function isWindowsPath(value: string): boolean {
  const trimmed = value.trim();
  return /^[a-z]:[\\/]/i.test(trimmed) || /^\\\\/.test(trimmed);
}

function normalizePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}
