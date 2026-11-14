import type { AppServerThreadFileDiff } from "@pwragent/shared";
import {
  renderUnifiedFileDiff,
  type UnifiedDiffHunk,
} from "../../shared/unified-file-diff.js";
import {
  readAcpProviderTool,
  readFirstLocationPath,
} from "./acp-command-extraction.js";

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

type Hunk = UnifiedDiffHunk;

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
  // One row is one file. Content naming another file would be drawn under
  // this file's header, so such a call shows no diff.
  if (diffs.length === 0 || diffs.some((diff) => diff.path && diff.path !== path)) {
    return undefined;
  }
  const hunks: Hunk[] = [];
  let created = true;
  for (const diff of diffs) {
    if (diff.replacements) {
      created &&= diff.replacements.every(isWholeFileCreation);
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
  return renderUnifiedFileDiff({ name, created, hunks }).fileDiff;
}

/**
 * Grok reports a write to a new file as one replacement of nothing, at line
 * 1, with no text before or after it.
 */
function isWholeFileCreation(replacement: AcpReplacement): boolean {
  return replacement.oldString === ""
    && replacement.oldLine === 1
    && replacement.linePrefix === ""
    && replacement.contextAfter === "";
}

/**
 * The whole lines a replacement touched, before and after.
 *
 * `line_prefix` is the text before the match on its first line. Grok's
 * `context_after` is the whole lines after the line the match ends on, not
 * the text right after the match: replacing `node-version: 24.x` on line 39
 * reports line 40 (`cache-electron: "true"`) as its context. Every edit in the
 * captured rollouts that could still be checked against its file ended at the
 * end of a line or right after a newline, so the rest of the last line is
 * taken to be empty.
 */
function replacementHunk(replacement: AcpReplacement): Hunk[] {
  const oldBlock = `${replacement.linePrefix}${replacement.oldString}`;
  const newBlock = `${replacement.linePrefix}${replacement.newString}`;
  const endsAtLineStart = oldBlock === "" || oldBlock.endsWith("\n");
  if (!endsAtLineStart) {
    // The match ends at the end of a line, so the last piece of each block
    // is a line, even when the replacement leaves it empty.
    return lineHunk(
      exactLines(oldBlock),
      exactLines(newBlock),
      replacement.oldLine,
      replacement.newLine,
    );
  }
  const newJoinsNextLine = newBlock !== "" && !newBlock.endsWith("\n");
  if (newJoinsNextLine && replacement.contextAfter !== "") {
    // The match ended at the start of a line and the replacement does not,
    // so its last line runs into the line after the match.
    const next = replacement.contextAfter.split("\n")[0] ?? "";
    return lineHunk(
      exactLines(`${oldBlock}${next}`),
      exactLines(`${newBlock}${next}`),
      replacement.oldLine,
      replacement.newLine,
    );
  }
  return lineHunk(
    splitLines(oldBlock),
    newJoinsNextLine ? exactLines(newBlock) : splitLines(newBlock),
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

/** Every piece between newlines, a trailing empty one included. */
function exactLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
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
