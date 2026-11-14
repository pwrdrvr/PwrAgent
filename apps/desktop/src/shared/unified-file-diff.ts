import type { AppServerThreadFileDiff } from "@pwragent/shared";

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
