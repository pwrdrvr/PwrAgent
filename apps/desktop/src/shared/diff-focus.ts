import type { FocusedDiffHunkSummary } from "@pwragnt/shared";

export const LOCAL_DIFF_CONTEXT_RADIUS = 1;
export const MIN_FOCUSED_DIFF_HUNK_COUNT = 4;
export const MIN_FOCUSED_DIFF_SMALL_HUNK_COUNT = 2;
export const MAX_FOCUSED_DIFF_SMALL_HUNK_LINES = 2;
export const MIN_FOCUSED_DIFF_CONTEXT_RATIO = 2;

export type DiffLineRow =
  | {
      kind: "added";
      hunkIndex: number;
      newNumber: number;
      text: string;
    }
  | {
      kind: "context";
      hunkIndex: number;
      newNumber: number;
      oldNumber: number;
      text: string;
    }
  | {
      kind: "removed";
      hunkIndex: number;
      oldNumber: number;
      text: string;
    };

export type DiffHunkHeaderRow = {
  kind: "hunk";
  hunkIndex: number;
  text: string;
};

export type DiffSeparatorRow = {
  kind: "separator";
  hunkIndex: number;
  count: number;
};

export type DiffViewRow = DiffHunkHeaderRow | DiffLineRow | DiffSeparatorRow;

export type ParsedDiffHunk = {
  index: number;
  header: string;
  rows: DiffLineRow[];
  addedLineCount: number;
  removedLineCount: number;
  changedLineCount: number;
  contextLineCount: number;
};

export type ParsedUnifiedDiff = {
  hunks: ParsedDiffHunk[];
  stats: {
    hunkCount: number;
    changedLineCount: number;
    contextLineCount: number;
    smallHunkCount: number;
  };
};

export type FocusedDiffEligibility = {
  eligible: boolean;
  hiddenContextLineCount: number;
  reason:
    | "eligible"
    | "insufficient_condensation"
    | "insufficient_context_ratio"
    | "insufficient_small_hunks"
    | "too_few_hunks";
};

export type DiffView = {
  rows: DiffViewRow[];
  hiddenContextLineCount: number;
  hiddenHunkCount: number;
  hasHiddenContent: boolean;
};

export function parseUnifiedDiff(patch: string): ParsedUnifiedDiff {
  const lines = patch.replace(/\r\n?/g, "\n").split("\n");
  const hunks: ParsedDiffHunk[] = [];
  let currentHunk: ParsedDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  const commitCurrentHunk = (): void => {
    if (!currentHunk) {
      return;
    }

    hunks.push(currentHunk);
    currentHunk = undefined;
  };

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      commitCurrentHunk();
      oldLine = Number.parseInt(hunkMatch[1], 10);
      newLine = Number.parseInt(hunkMatch[2], 10);
      currentHunk = {
        index: hunks.length,
        header: line,
        rows: [],
        addedLineCount: 0,
        removedLineCount: 0,
        changedLineCount: 0,
        contextLineCount: 0
      };
      continue;
    }

    if (
      !currentHunk ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("Index:") ||
      line.startsWith("====") ||
      line.startsWith("\\")
    ) {
      continue;
    }

    if (line.startsWith("-")) {
      currentHunk.rows.push({
        kind: "removed",
        hunkIndex: currentHunk.index,
        oldNumber: oldLine,
        text: line.slice(1)
      });
      currentHunk.removedLineCount += 1;
      currentHunk.changedLineCount += 1;
      oldLine += 1;
      continue;
    }

    if (line.startsWith("+")) {
      currentHunk.rows.push({
        kind: "added",
        hunkIndex: currentHunk.index,
        newNumber: newLine,
        text: line.slice(1)
      });
      currentHunk.addedLineCount += 1;
      currentHunk.changedLineCount += 1;
      newLine += 1;
      continue;
    }

    if (oldLine > 0 || newLine > 0 || line.length > 0) {
      currentHunk.rows.push({
        kind: "context",
        hunkIndex: currentHunk.index,
        oldNumber: oldLine,
        newNumber: newLine,
        text: line.startsWith(" ") ? line.slice(1) : line
      });
      currentHunk.contextLineCount += 1;
      oldLine += 1;
      newLine += 1;
    }
  }

  commitCurrentHunk();

  return {
    hunks,
    stats: {
      hunkCount: hunks.length,
      changedLineCount: hunks.reduce((sum, hunk) => sum + hunk.changedLineCount, 0),
      contextLineCount: hunks.reduce((sum, hunk) => sum + hunk.contextLineCount, 0),
      smallHunkCount: hunks.filter(
        (hunk) => hunk.changedLineCount <= MAX_FOCUSED_DIFF_SMALL_HUNK_LINES
      ).length
    }
  };
}

export function buildDiffView(
  parsed: ParsedUnifiedDiff,
  options?: {
    hiddenHunkIndices?: Iterable<number>;
    mode?: "condensed" | "full";
    contextRadius?: number;
  }
): DiffView {
  const hiddenHunkIndices = new Set(options?.hiddenHunkIndices ?? []);
  const mode = options?.mode ?? "full";
  const contextRadius = options?.contextRadius ?? LOCAL_DIFF_CONTEXT_RADIUS;
  const rows: DiffViewRow[] = [];
  let hiddenContextLineCount = 0;

  for (const hunk of parsed.hunks) {
    if (hiddenHunkIndices.has(hunk.index)) {
      continue;
    }

    rows.push({
      kind: "hunk",
      hunkIndex: hunk.index,
      text: hunk.header
    });

    if (mode === "full") {
      rows.push(...hunk.rows);
      continue;
    }

    const condensed = condenseHunkRows(hunk.rows, contextRadius);
    hiddenContextLineCount += condensed.hiddenContextLineCount;
    rows.push(...condensed.rows);
  }

  return {
    rows,
    hiddenContextLineCount,
    hiddenHunkCount: hiddenHunkIndices.size,
    hasHiddenContent: hiddenContextLineCount > 0 || hiddenHunkIndices.size > 0
  };
}

export function getFocusedDiffEligibility(
  parsed: ParsedUnifiedDiff
): FocusedDiffEligibility {
  const condensedView = buildDiffView(parsed, { mode: "condensed" });

  if (parsed.stats.hunkCount < MIN_FOCUSED_DIFF_HUNK_COUNT) {
    return {
      eligible: false,
      hiddenContextLineCount: condensedView.hiddenContextLineCount,
      reason: "too_few_hunks"
    };
  }

  if (parsed.stats.smallHunkCount < MIN_FOCUSED_DIFF_SMALL_HUNK_COUNT) {
    return {
      eligible: false,
      hiddenContextLineCount: condensedView.hiddenContextLineCount,
      reason: "insufficient_small_hunks"
    };
  }

  if (condensedView.hiddenContextLineCount === 0) {
    return {
      eligible: false,
      hiddenContextLineCount: 0,
      reason: "insufficient_condensation"
    };
  }

  const contextRatio =
    parsed.stats.changedLineCount === 0
      ? Number.POSITIVE_INFINITY
      : parsed.stats.contextLineCount / parsed.stats.changedLineCount;

  if (contextRatio < MIN_FOCUSED_DIFF_CONTEXT_RATIO) {
    return {
      eligible: false,
      hiddenContextLineCount: condensedView.hiddenContextLineCount,
      reason: "insufficient_context_ratio"
    };
  }

  return {
    eligible: true,
    hiddenContextLineCount: condensedView.hiddenContextLineCount,
    reason: "eligible"
  };
}

export function summarizeHunksForFocus(
  parsed: ParsedUnifiedDiff,
  contextPreviewLimit = 2
): FocusedDiffHunkSummary[] {
  return parsed.hunks.map((hunk) => {
    const addedLines = hunk.rows
      .filter((row): row is Extract<DiffLineRow, { kind: "added" }> => row.kind === "added")
      .map((row) => row.text);
    const removedLines = hunk.rows
      .filter((row): row is Extract<DiffLineRow, { kind: "removed" }> => row.kind === "removed")
      .map((row) => row.text);

    const leadingContext = collectLeadingContext(hunk.rows).slice(-contextPreviewLimit);
    const trailingContext = collectTrailingContext(hunk.rows).slice(0, contextPreviewLimit);

    return {
      index: hunk.index,
      header: hunk.header,
      addedLines,
      removedLines,
      contextBefore: leadingContext,
      contextAfter: trailingContext,
      changedLineCount: hunk.changedLineCount,
      contextLineCount: hunk.contextLineCount
    };
  });
}

function condenseHunkRows(
  rows: DiffLineRow[],
  contextRadius: number
): { rows: Array<DiffLineRow | DiffSeparatorRow>; hiddenContextLineCount: number } {
  const condensed: Array<DiffLineRow | DiffSeparatorRow> = [];
  let contextBuffer: Extract<DiffLineRow, { kind: "context" }>[] = [];
  let hiddenContextLineCount = 0;

  const flushContext = () => {
    if (contextBuffer.length === 0) {
      return;
    }

    if (contextBuffer.length <= contextRadius * 2) {
      condensed.push(...contextBuffer);
      contextBuffer = [];
      return;
    }

    condensed.push(...contextBuffer.slice(0, contextRadius));
    const hiddenCount = contextBuffer.length - contextRadius * 2;
    hiddenContextLineCount += hiddenCount;
    condensed.push({
      kind: "separator",
      hunkIndex: contextBuffer[0]?.hunkIndex ?? 0,
      count: hiddenCount
    });
    condensed.push(...contextBuffer.slice(-contextRadius));
    contextBuffer = [];
  };

  for (const row of rows) {
    if (row.kind === "context") {
      contextBuffer.push(row);
      continue;
    }

    flushContext();
    condensed.push(row);
  }

  flushContext();

  return {
    rows: condensed,
    hiddenContextLineCount
  };
}

function collectLeadingContext(rows: DiffLineRow[]): string[] {
  const output: string[] = [];

  for (const row of rows) {
    if (row.kind !== "context") {
      break;
    }
    output.push(row.text);
  }

  return output;
}

function collectTrailingContext(rows: DiffLineRow[]): string[] {
  const output: string[] = [];

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind !== "context") {
      break;
    }
    output.unshift(row.text);
  }

  return output;
}
