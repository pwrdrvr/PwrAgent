import path from "node:path";
import type { AppServerThreadFileDiff } from "@pwragent/shared";
import { isPathWithin } from "./path-within";

/** Larger diffs keep their counts, not their text. */
export const MAX_FILE_DIFF_CHARS = 256 * 1024;

/** One hunk of a unified diff; `lines` carry their ` `, `-` or `+` marker. */
export type UnifiedDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: readonly string[];
};

/**
 * The name a diff header gives an edited file: relative to the thread's
 * workspace when the file is inside it, else the absolute path without its
 * leading slash or drive. Every backend names its edits through this, so the
 * same file reads the same in every row. The row's own `path` stays absolute;
 * nothing opens a file by this name.
 */
export function unifiedDiffFileName(filePath: string, cwd?: string): string {
  const name =
    cwd && path.isAbsolute(filePath) && isPathWithin(cwd, filePath)
      ? path.relative(cwd, filePath)
      : filePath;
  return name.split(path.sep).join("/").replace(/^[A-Za-z]:/, "").replace(/^\/+/, "");
}

/**
 * The unified diff of one file's edit, as a transcript row shows it: a
 * three-line header, then the hunks. A new file diffs from /dev/null.
 */
export function renderUnifiedFileDiff(params: {
  name: string;
  created: boolean;
  hunks: readonly UnifiedDiffHunk[];
}): { diff: string; fileDiff: AppServerThreadFileDiff } {
  const { name, created } = params;
  let additions = 0;
  let removals = 0;
  const body: string[] = [];
  for (const hunk of params.hunks) {
    body.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) removals += 1;
      body.push(line);
    }
  }
  const diff = [
    `diff --git a/${name} b/${name}`,
    created ? "--- /dev/null" : `--- a/${name}`,
    `+++ b/${name}`,
    ...body,
  ].join("\n");
  const kind = created ? "add" : "update";
  if (diff.length > MAX_FILE_DIFF_CHARS) {
    return {
      diff: "",
      fileDiff: {
        kind,
        diff: "",
        additions,
        removals,
        omittedReason: "This diff is too large to show.",
        originalLength: diff.length,
      },
    };
  }
  return { diff, fileDiff: { kind, diff, additions, removals } };
}
