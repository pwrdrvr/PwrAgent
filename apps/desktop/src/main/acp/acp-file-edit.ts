import type { AppServerThreadFileDiff } from "@pwragent/shared";
import { readAcpProviderTool } from "./acp-command-extraction.js";

/**
 * File edits made through an ACP tool call: the file, the verb, and, once the
 * agent reports where the edit landed, a unified diff the transcript can show.
 *
 * Grok's `search_replace` and `write` tools open with a bare `tool_call`
 * titled with the tool's internal name and carrying only `rawInput`. Later
 * updates add ACP `diff` content, and the completing update adds Grok's
 * `_meta.details` with the line numbers of each replacement.
 */
export type AcpFileEdit = {
  path: string;
  verb: "Edited" | "Wrote";
  fileDiff?: AppServerThreadFileDiff;
};

const MAX_DIFF_CHARS = 256 * 1024;
const CONTEXT_LINES = 3;

export function readAcpFileEdit(
  record: Record<string, unknown>,
): AcpFileEdit | undefined {
  const providerTool = readAcpProviderTool(record);
  const toolKind = providerTool?.kind ?? readString(record, "kind");
  const diffs = readDiffContent(record);
  if (toolKind !== "edit" && toolKind !== "write" && diffs.length === 0) {
    return undefined;
  }
  const rawInput = asRecord(record.rawInput) ?? {};
  const path =
    readString(rawInput, "file_path")
    ?? readString(rawInput, "path")
    ?? diffs[0]?.path
    ?? readFirstLocationPath(record);
  if (!path) {
    return undefined;
  }
  const verb =
    providerTool?.name === "write" || toolKind === "write" ? "Wrote" : "Edited";
  const fileDiff = buildFileDiff(path, diffs);
  return { path, verb, ...(fileDiff ? { fileDiff } : {}) };
}

type AcpDiffContent = {
  path?: string;
  oldText?: string | null;
  newText: string;
  replacements?: AcpReplacement[];
};

/** One replacement Grok applied, positioned in the file before and after. */
type AcpReplacement = {
  oldString: string;
  newString: string;
  oldLine: number;
  newLine: number;
  linePrefix: string;
  contextAfter: string;
};

function readDiffContent(record: Record<string, unknown>): AcpDiffContent[] {
  const content = record.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((item) => {
    const diff = asRecord(item);
    if (!diff || diff.type !== "diff" || typeof diff.newText !== "string") {
      return [];
    }
    const oldText =
      typeof diff.oldText === "string" || diff.oldText === null
        ? diff.oldText
        : undefined;
    const replacements = readReplacements(asRecord(diff._meta)?.details);
    return [{
      path: readString(diff, "path"),
      oldText,
      newText: diff.newText,
      ...(replacements ? { replacements } : {}),
    }];
  });
}

function readReplacements(value: unknown): AcpReplacement[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const replacements: AcpReplacement[] = [];
  for (const item of value) {
    const detail = asRecord(item);
    if (
      !detail
      || typeof detail.old_string !== "string"
      || typeof detail.new_string !== "string"
      || !isLineNumber(detail.old_line)
      || !isLineNumber(detail.new_line)
    ) {
      return undefined;
    }
    replacements.push({
      oldString: detail.old_string,
      newString: detail.new_string,
      oldLine: detail.old_line,
      newLine: detail.new_line,
      linePrefix: typeof detail.line_prefix === "string" ? detail.line_prefix : "",
      contextAfter:
        typeof detail.context_after === "string" ? detail.context_after : "",
    });
  }
  return replacements;
}

function isLineNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

/**
 * A diff is drawn only where the agent said where the edit landed. Without
 * positions, line numbers would be invented, so a replacement shows as the
 * labelled file row alone until the completing update supplies them. A new
 * file (`oldText: null`) is the one case that needs no position.
 */
function buildFileDiff(
  path: string,
  diffs: AcpDiffContent[],
): AppServerThreadFileDiff | undefined {
  const hunks: Hunk[] = [];
  let created = diffs.length > 0;
  for (const diff of diffs) {
    if (diff.replacements) {
      created = false;
      hunks.push(...diff.replacements.flatMap(replacementHunk));
    } else if (diff.oldText === null) {
      hunks.push(...lineHunk([], splitLines(diff.newText), 0, 1));
    } else {
      return undefined;
    }
  }
  if (hunks.length === 0) {
    return undefined;
  }
  const name = path.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "").replace(/^\/+/, "");
  let additions = 0;
  let removals = 0;
  const body: string[] = [];
  for (const hunk of hunks) {
    body.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
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
  if (diff.length > MAX_DIFF_CHARS) {
    return {
      kind,
      diff: "",
      additions,
      removals,
      omittedReason: "This diff is too large to show.",
      originalLength: diff.length,
    };
  }
  return { kind, diff, additions, removals };
}

/**
 * A replacement can start and end mid-line. `line_prefix` is the text before
 * it on its first line and `context_after` starts right after it, so the
 * whole lines it touched are the prefix, the string, and the rest of its last
 * line.
 */
function replacementHunk(replacement: AcpReplacement): Hunk[] {
  const tail = replacement.contextAfter.split("\n")[0] ?? "";
  const oldBlock = `${replacement.linePrefix}${replacement.oldString}${tail}`;
  const newBlock = `${replacement.linePrefix}${replacement.newString}${tail}`;
  // Short of the end of the file, the block runs from the start of its first
  // line to the end of its last, so every piece between newlines is a line,
  // an empty one included. At the end of the file (no context after it), a
  // final newline ends the last line rather than starting another.
  const blockLines = replacement.contextAfter === ""
    ? splitLines
    : (block: string) => block.replace(/\r\n?/g, "\n").split("\n");
  return lineHunk(
    blockLines(oldBlock),
    blockLines(newBlock),
    replacement.oldLine,
    replacement.newLine,
  );
}

/**
 * One hunk from two runs of whole lines that start at the given line numbers.
 * Lines both runs share at the start and end become context, at most
 * `CONTEXT_LINES` on each side; everything between is removed and added.
 */
function lineHunk(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  newStart: number,
): Hunk[] {
  let prefix = 0;
  while (
    prefix < oldLines.length
    && prefix < newLines.length
    && oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  if (removed.length === 0 && added.length === 0) {
    return [];
  }
  const before = oldLines.slice(Math.max(0, prefix - CONTEXT_LINES), prefix);
  const after = oldLines.slice(
    oldLines.length - suffix,
    oldLines.length - suffix + CONTEXT_LINES,
  );
  const skipped = prefix - before.length;
  const oldCount = before.length + removed.length + after.length;
  const newCount = before.length + added.length + after.length;
  return [{
    // Unified diff names the line before an empty side, so a pure insertion
    // at line N starts at N - 1, and insertion into an empty file at 0.
    oldStart: oldCount === 0 ? Math.max(0, oldStart + skipped - 1) : oldStart + skipped,
    oldLines: oldCount,
    newStart: newCount === 0 ? Math.max(0, newStart + skipped - 1) : newStart + skipped,
    newLines: newCount,
    lines: [
      ...before.map((line) => ` ${line}`),
      ...removed.map((line) => `-${line}`),
      ...added.map((line) => `+${line}`),
      ...after.map((line) => ` ${line}`),
    ],
  }];
}

/** The lines of a file's text; a final newline ends the last line. */
function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized === "") {
    return [];
  }
  return normalized.replace(/\n$/, "").split("\n");
}

function readFirstLocationPath(record: Record<string, unknown>): string | undefined {
  const locations = record.locations;
  if (!Array.isArray(locations)) {
    return undefined;
  }
  for (const location of locations) {
    const path = asRecord(location)?.path;
    if (typeof path === "string" && path.trim()) {
      return path;
    }
  }
  return undefined;
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
