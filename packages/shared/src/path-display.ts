type NormalizedDirectoryPath = {
  caseInsensitive: boolean;
  normalized: string;
  separator: "/" | "\\";
};

/**
 * Render filesystem paths in their owning platform's syntax. Protocol and
 * snapshot identifiers may use forward slashes on Windows; leave those ids
 * untouched and format only at the display boundary. Infer from the path,
 * not this machine's OS, because federation also displays remote paths.
 */
export function formatFilesystemPath(value: string): string {
  return isWindowsFilesystemPath(value) ? value.replace(/\//g, "\\") : value;
}

/**
 * Display an absolute path relative to the longest known directory that
 * contains it. Relative paths use the separator style of a known Windows
 * directory; absolute paths outside the known directories use native syntax.
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
  const valueIsWindowsPath = isWindowsFilesystemPath(trimmed);
  const roots = [...(directoryPaths ?? [])]
    .map((root): NormalizedDirectoryPath => ({
      caseInsensitive: valueIsWindowsPath || isWindowsFilesystemPath(root),
      normalized: normalizePath(root),
      separator: isWindowsFilesystemPath(root) ? "\\" : "/",
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

  return formatFilesystemPath(trimmed);
}

function formatSeparators(value: string, separator: "/" | "\\"): string {
  return separator === "\\" ? value.replace(/\//g, "\\") : value;
}

function isAbsolutePath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("/") || isWindowsFilesystemPath(trimmed);
}

/** Recognize drive-qualified and UNC paths, including normalized snapshots. */
export function isWindowsFilesystemPath(value: string): boolean {
  const trimmed = value.trim();
  return /^[a-z]:[\\/]/i.test(trimmed) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(trimmed);
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  const normalized = isWindowsFilesystemPath(trimmed) ? trimmed.replace(/\\/g, "/") : trimmed;
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}
