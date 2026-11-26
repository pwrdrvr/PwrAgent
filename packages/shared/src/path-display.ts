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

/** Abbreviate a POSIX home path while preserving native Windows syntax. */
export function abbreviateHomePath(value: string, homeDir?: string): string {
  const displayPath = formatFilesystemPath(value);
  if (!displayPath.startsWith("/") || !homeDir?.startsWith("/")) {
    return displayPath;
  }
  const home = homeDir.replace(/\/+$/, "");
  if (!home) return displayPath;
  if (displayPath === home) return "~";
  return displayPath.startsWith(`${home}/`) ? `~${displayPath.slice(home.length)}` : displayPath;
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

/**
 * Extract the raw destination from a single CommonMark inline link or image
 * slice (e.g. `[Run [1]](C:\work\shot(1).png)`), respecting nested brackets,
 * code spans in the label, angle-bracket destinations, and balanced
 * parentheses per CommonMark.
 */
export function extractInlineMarkdownDestination(source: string | undefined): string | undefined {
  if (!source) {
    return undefined;
  }
  const openBracket = source.startsWith("![") ? 1 : source.startsWith("[") ? 0 : -1;
  if (openBracket < 0) {
    return undefined;
  }

  let index = openBracket + 1;
  let bracketDepth = 1;
  let unmatchedBacktickLengths: Set<number> | undefined;
  while (index < source.length && bracketDepth > 0) {
    const ch = source[index];
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === "`") {
      let tickEnd = index;
      while (tickEnd < source.length && source[tickEnd] === "`") {
        tickEnd += 1;
      }
      const runLength = tickEnd - index;
      if (!unmatchedBacktickLengths?.has(runLength)) {
        // CommonMark code spans match an exact-length closing backtick run,
        // and backslashes inside a code span are literal.
        let search = tickEnd;
        let closedAt = -1;
        while (search < source.length) {
          const nextTick = source.indexOf("`", search);
          if (nextTick < 0) {
            break;
          }
          let closeEnd = nextTick;
          while (closeEnd < source.length && source[closeEnd] === "`") {
            closeEnd += 1;
          }
          if (closeEnd - nextTick === runLength) {
            closedAt = closeEnd;
            break;
          }
          search = closeEnd;
        }
        if (closedAt >= 0) {
          index = closedAt;
          continue;
        }
        unmatchedBacktickLengths ??= new Set();
        unmatchedBacktickLengths.add(runLength);
      }
      index = tickEnd;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
    } else if (ch === "]") {
      bracketDepth -= 1;
      if (bracketDepth === 0) {
        index += 1;
        break;
      }
    }
    index += 1;
  }

  if (bracketDepth !== 0 || source[index] !== "(") {
    return undefined;
  }
  index += 1;
  while (index < source.length && /\s/.test(source[index]!)) {
    index += 1;
  }
  if (index >= source.length) {
    return undefined;
  }

  if (source[index] === "<") {
    const destStart = index + 1;
    let cursor = destStart;
    while (cursor < source.length) {
      const ch = source[cursor];
      if (ch === "\r" || ch === "\n") {
        return undefined;
      }
      if (ch === ">") {
        return cursor > destStart ? source.slice(destStart, cursor) : undefined;
      }
      cursor += 1;
    }
    return undefined;
  }

  const destStart = index;
  let parenDepth = 0;
  let cursor = destStart;
  while (cursor < source.length) {
    const ch = source[cursor]!;
    if (/\s/.test(ch)) {
      break;
    }
    if (ch === "(") {
      parenDepth += 1;
    } else if (ch === ")") {
      if (parenDepth === 0) {
        break;
      }
      parenDepth -= 1;
    }
    cursor += 1;
  }
  return cursor > destStart ? source.slice(destStart, cursor) : undefined;
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  const normalized = isWindowsFilesystemPath(trimmed) ? trimmed.replace(/\\/g, "/") : trimmed;
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}
