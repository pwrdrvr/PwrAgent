import type { AppServerThreadActivityEntry } from "@pwragent/shared/contracts/normalized-app-server";
import {
  formatPathRelativeToDirectories,
  isWindowsFilesystemPath,
} from "@pwragent/shared/path-display";

/**
 * Rewrite absolute paths inside an activity label to directory-relative form.
 *
 * Backends disagree on how much of a path belongs in a tool label: Codex sends
 * a basename, while ACP agents forward the agent's own title verbatim, which
 * for Grok is the absolute path the model passed to the tool and for
 * Antigravity can omit the leading `/` on POSIX paths. The entry's details
 * carry the canonical path in `detail.path`, so the matching spans in the
 * label can be located directly instead of guessed at.
 */
export function formatActivityText(
  text: string,
  details: AppServerThreadActivityEntry["details"],
  directoryPaths: string[] | undefined,
): string {
  const pathDetails = details.filter(
    (detail): detail is typeof detail & { path: string } => Boolean(detail.path),
  );
  // Most entries — commands, searches, plan updates — carry no path at all.
  // Work phase labels run this over every tool entry of a turn on each
  // transcript rebuild, so those entries should not pay for the scan below.
  if (pathDetails.length === 0) {
    return text;
  }
  const candidateMap = new Map<string, string>();
  for (const detail of pathDetails) {
    const absolutePath = detail.path;
    const displayPath = formatPathRelativeToDirectories(absolutePath, directoryPaths);
    if (!candidateMap.has(absolutePath)) {
      candidateMap.set(absolutePath, displayPath);
    }
    if (absolutePath.startsWith("/") && displayPath !== absolutePath) {
      const withoutLeadingSlash = absolutePath.replace(/^\/+/, "");
      if (
        withoutLeadingSlash.includes("/")
        && withoutLeadingSlash !== displayPath
        && !candidateMap.has(withoutLeadingSlash)
      ) {
        candidateMap.set(withoutLeadingSlash, displayPath);
      }
    }
    if (isWindowsFilesystemPath(absolutePath)) {
      for (const variant of [
        absolutePath.replace(/\\/g, "/"),
        absolutePath.replace(/\//g, "\\"),
      ]) {
        if (variant !== absolutePath && !candidateMap.has(variant)) {
          candidateMap.set(variant, displayPath);
        }
      }
    }
  }
  const paths = [...candidateMap.entries()]
    .map(([matchPath, displayPath]) => ({ matchPath, displayPath }))
    .sort((left, right) => right.matchPath.length - left.matchPath.length);
  let displayText = "";
  let cursor = 0;

  while (cursor < text.length) {
    const matchingPath = paths.find(
      (path) =>
        text.startsWith(path.matchPath, cursor)
        && hasPathTextBoundaries(text, cursor, path.matchPath.length),
    );
    if (matchingPath) {
      displayText += matchingPath.displayPath;
      cursor += matchingPath.matchPath.length;
      continue;
    }
    displayText += text[cursor];
    cursor += 1;
  }

  return displayText;
}

function hasPathTextBoundaries(
  text: string,
  start: number,
  length: number,
): boolean {
  const before = text[start - 1];
  const after = text[start + length];
  return isPathTextBoundary(before, "before") && isPathTextBoundary(after, "after");
}

function isPathTextBoundary(
  character: string | undefined,
  position: "before" | "after",
): boolean {
  if (character === undefined || /[\s`'"()[\]{}<>,;:!?=|]/.test(character)) {
    return true;
  }
  return position === "after" && (character === "/" || character === "\\");
}
