import type { AppServerThreadActivityEntry } from "@pwragent/shared";
import { formatPathRelativeToDirectories } from "@pwragent/shared";

/**
 * Rewrite absolute paths inside an activity label to directory-relative form.
 *
 * Backends disagree on how much of a path belongs in a tool label: Codex sends
 * a basename, while ACP agents forward the agent's own title verbatim, which
 * for Grok is the absolute path the model passed to the tool. The entry's
 * details carry the same path in `detail.path`, so the absolute spans in the
 * label can be located exactly instead of guessed at.
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
  const paths = pathDetails
    .map((detail) => ({
      absolutePath: detail.path,
      displayPath: formatPathRelativeToDirectories(detail.path, directoryPaths),
    }))
    .sort((left, right) => right.absolutePath.length - left.absolutePath.length);
  let displayText = "";
  let cursor = 0;

  while (cursor < text.length) {
    const matchingPath = paths.find(
      (path) =>
        text.startsWith(path.absolutePath, cursor)
        && hasPathTextBoundaries(text, cursor, path.absolutePath.length),
    );
    if (matchingPath) {
      displayText += matchingPath.displayPath;
      cursor += matchingPath.absolutePath.length;
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
