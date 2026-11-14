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
 * `_meta.details` with the line numbers of each replacement. Gemini and Qwen
 * send no positions, but their `diff` content is the whole file, which
 * starts at line 1 (`acpDiffContentIsWholeFile`).
 */
export type AcpFileEdit = {
  path: string;
  verb: "Edited" | "Wrote";
  fileDiff?: AppServerThreadFileDiff;
};

const CONTEXT_LINES = 3;

/**
 * Whether an agent's ACP `diff` content holds the whole file before and after
 * the edit. The ACP shape is `{path, oldText, newText}` either way, with no
 * position, so the agent is the only evidence:
 *
 * - Gemini CLI 0.46 sends the file's `originalContent` and `newContent`, with
 *   `_meta.kind` of `add`, `modify` or `delete` on live updates.
 * - Qwen Code 0.26.9 sends the same, without `_meta`; a file too large to
 *   keep arrives as text content instead.
 * - Kimi Code 0.34 sends the edit's `old_string` and `new_string`, and Grok
 *   sends snippets positioned by `_meta.details`.
 */
export function acpDiffContentIsWholeFile(backendId: string): boolean {
  return backendId === "acp:gemini" || backendId === "acp:qwen";
}

export type ReadAcpFileEditOptions = {
  /** The agent sends whole files in `diff` content. */
  wholeFileDiffContent?: boolean;
};

export function readAcpFileEdit(
  record: Record<string, unknown>,
  options: ReadAcpFileEditOptions = {},
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
  const fileDiff = buildFileDiff(path, diffs, options);
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
 * labelled file row alone until the completing update supplies them. Two
 * cases need no position: a new file (`oldText: null`), and a whole file from
 * an agent that sends whole files, where the text starts at line 1.
 */
function buildFileDiff(
  path: string,
  diffs: AcpDiffContent[],
  options: ReadAcpFileEditOptions,
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
      hunks.push(...lineHunks([], splitLines(diff.newText), 1, 1));
    } else if (options.wholeFileDiffContent && diff.oldText !== undefined) {
      // Whole-file agents send `""` before a file they create.
      if (diff.oldText !== "") {
        created = false;
      }
      hunks.push(
        ...lineHunks(splitLines(diff.oldText), splitLines(diff.newText), 1, 1),
      );
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
    return lineHunks(
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
    return lineHunks(
      exactLines(`${oldBlock}${next}`),
      exactLines(`${newBlock}${next}`),
      replacement.oldLine,
      replacement.newLine,
    );
  }
  return lineHunks(
    splitLines(oldBlock),
    newJoinsNextLine ? exactLines(newBlock) : splitLines(newBlock),
    replacement.oldLine,
    replacement.newLine,
  );
}

type LineOp = { type: " " | "-" | "+"; line: string };

/**
 * The hunks between two runs of whole lines that start at the given line
 * numbers: a line diff with at most `CONTEXT_LINES` of context around each
 * change, and changes closer than twice that sharing one hunk.
 */
function lineHunks(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  newStart: number,
): Hunk[] {
  const ops = lineDiff(oldLines, newLines);
  const hunks: Hunk[] = [];
  let index = 0;
  // Old and new lines before `index`.
  let oldBefore = 0;
  let newBefore = 0;
  while (index < ops.length) {
    let firstChange = index;
    while (firstChange < ops.length && ops[firstChange]!.type === " ") {
      firstChange += 1;
    }
    if (firstChange === ops.length) {
      break;
    }
    // The hunk starts up to CONTEXT_LINES unchanged lines before the change.
    const from = Math.max(index, firstChange - CONTEXT_LINES);
    for (; index < from; index += 1) {
      oldBefore += 1;
      newBefore += 1;
    }
    // It runs on while the next change is within twice CONTEXT_LINES.
    let lastChange = firstChange;
    for (let at = firstChange + 1; at < ops.length; at += 1) {
      if (ops[at]!.type !== " ") {
        if (at - lastChange - 1 > 2 * CONTEXT_LINES) {
          break;
        }
        lastChange = at;
      }
    }
    const to = Math.min(ops.length, lastChange + 1 + CONTEXT_LINES);
    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let at = from; at < to; at += 1) {
      const op = ops[at]!;
      lines.push(`${op.type}${op.line}`);
      if (op.type !== "+") oldCount += 1;
      if (op.type !== "-") newCount += 1;
    }
    hunks.push({
      // Unified diff names the line before an empty side, so a pure insertion
      // after line N starts at N, and insertion into an empty file at 0.
      oldStart: oldStart + oldBefore - (oldCount === 0 ? 1 : 0),
      oldLines: oldCount,
      newStart: newStart + newBefore - (newCount === 0 ? 1 : 0),
      newLines: newCount,
      lines,
    });
    oldBefore += oldCount;
    newBefore += newCount;
    index = to;
  }
  return hunks;
}

/**
 * Comparisons a line diff may make before it settles for a coarser one. The
 * walk-back keeps about two entries per comparison, so this also bounds its
 * memory (~8 MB), and whole-file diffs are rebuilt on every replay.
 */
const LINE_DIFF_BUDGET = 1_000_000;

/**
 * A shortest line diff (Myers), with each run of changes written as its
 * removals then its additions. The lines both sides share at the start and
 * end are set aside first. Past `LINE_DIFF_BUDGET`, the lines between those
 * are all removed and added: still exact, only less precise.
 */
function lineDiff(oldLines: string[], newLines: string[]): LineOp[] {
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
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const middle =
    myersDiff(oldMiddle, newMiddle)
    ?? [
      ...oldMiddle.map((line): LineOp => ({ type: "-", line })),
      ...newMiddle.map((line): LineOp => ({ type: "+", line })),
    ];
  return [
    ...oldLines.slice(0, prefix).map((line): LineOp => ({ type: " ", line })),
    ...groupChanges(middle),
    ...oldLines.slice(oldLines.length - suffix).map((line): LineOp => ({ type: " ", line })),
  ];
}

/**
 * Myers' O(ND) shortest edit script, or undefined past the budget. Each
 * round's furthest-reaching x per diagonal is kept, across the diagonals
 * that round could use, so the path can be walked back from the end.
 */
function myersDiff(a: string[], b: string[]): LineOp[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let work = 0;
  let found = false;
  for (let d = 0; d <= max && !found; d += 1) {
    // Diagonals -(d + 1) to d + 1 of the previous round's furthest x.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
        ? v[offset + k + 1]!
        : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
        work += 1;
      }
      v[offset + k] = x;
      work += 1;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (work > LINE_DIFF_BUDGET) {
      return undefined;
    }
  }
  const ops: LineOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const previous = trace[d]!;
    const at = (k: number) => previous[k + d + 1]!;
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      ops.push({ type: " ", line: a[x]! });
    }
    if (d > 0) {
      if (x === previousX) {
        y -= 1;
        ops.push({ type: "+", line: b[y]! });
      } else {
        x -= 1;
        ops.push({ type: "-", line: a[x]! });
      }
    }
  }
  return ops.reverse();
}

/** Each run of changes as its removals, then its additions. */
function groupChanges(ops: LineOp[]): LineOp[] {
  const grouped: LineOp[] = [];
  let removed: LineOp[] = [];
  let added: LineOp[] = [];
  const flush = () => {
    grouped.push(...removed, ...added);
    removed = [];
    added = [];
  };
  for (const op of ops) {
    if (op.type === "-") {
      removed.push(op);
    } else if (op.type === "+") {
      added.push(op);
    } else {
      flush();
      grouped.push(op);
    }
  }
  flush();
  return grouped;
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
