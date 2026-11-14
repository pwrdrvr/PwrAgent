import { expect } from "vitest";

export type ParsedHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  body: string[];
};

/** The hunks of a unified diff, header lines skipped. */
export function parseHunks(diff: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  for (const line of diff.split("\n")) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/u.exec(line);
    if (header) {
      hunks.push({
        oldStart: Number(header[1]),
        oldCount: Number(header[2]),
        newStart: Number(header[3]),
        newCount: Number(header[4]),
        body: [],
      });
    } else if (line.startsWith("@@")) {
      throw new Error(`bad hunk header: ${line}`);
    } else {
      hunks.at(-1)?.body.push(line);
    }
  }
  return hunks;
}

/**
 * Applies a unified diff to the lines of a file, failing if any context or
 * removed line does not match what the file holds there.
 */
export function applyUnifiedDiff(oldLines: string[], diff: string): string[] {
  const result = [...oldLines];
  let offset = 0;
  for (const hunk of parseHunks(diff)) {
    const before = hunk.body.filter((line) => !line.startsWith("+")).map((line) => line.slice(1));
    const after = hunk.body.filter((line) => !line.startsWith("-")).map((line) => line.slice(1));
    expect(before).toHaveLength(hunk.oldCount);
    expect(after).toHaveLength(hunk.newCount);
    const at = (hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1) + offset;
    expect(result.slice(at, at + hunk.oldCount)).toEqual(before);
    result.splice(at, hunk.oldCount, ...after);
    offset += hunk.newCount - hunk.oldCount;
  }
  return result;
}

/** The lines of a file's text; a final newline ends the last line. */
export function fileLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/u, "").split("\n");
}
