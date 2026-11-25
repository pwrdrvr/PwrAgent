// Agents often send a table as pipe-separated lines and leave out GFM's
// delimiter row (`| --- | --- |`). remark-gfm then renders every pipe as text,
// one line per row. When three or more consecutive lines split into the same
// number of cells, this inserts the missing delimiter row, plus a blank line on
// each side so the paragraphs around the block stay out of it, and the lines
// render as the table their author meant.
//
// A guess has to stay rare, so a line only counts when every cell has text and
// it has at least three cells, or it opens or closes with a pipe. That keeps a
// few unfenced `cmd | grep x` lines as text. Fenced code, lines that already
// start a GFM table, and quoted, list, or indented-code lines are left alone,
// and a line whose code span holds a pipe never counts, because GFM would split
// that span across cells. A row must share the header's indentation, and the
// delimiter row copies it, so a table nested in a list item stays there. A
// header that opens with a `#` column is escaped so it doesn't become a heading.

const MIN_INFERRED_TABLE_LINES = 3;
const MIN_BARE_CELLS = 3;

type FenceState = { marker: "`" | "~"; length: number };

type PipeRow = { cells: string[]; outerPipe: boolean };

export function inferPipeTables(markdown: string): string {
  if (!markdown.includes("|")) {
    return markdown;
  }

  const lines = markdown.split("\n");
  const output: string[] = [];
  let fence: FenceState | undefined;
  let changed = false;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fenceLine = parseFenceLine(line);
    if (fenceLine) {
      if (!fence) {
        fence = { marker: fenceLine.marker, length: fenceLine.length };
      } else if (
        fenceLine.marker === fence.marker
        && fenceLine.length >= fence.length
        && fenceLine.info.trim() === ""
      ) {
        fence = undefined;
      }
      output.push(line);
      index += 1;
      continue;
    }

    if (fence) {
      output.push(line);
      index += 1;
      continue;
    }

    // An existing GFM table keeps its rows until the next blank line. A code
    // fence also ends it, and goes back to the loop so its contents stay
    // fenced.
    if (line.includes("|") && isDelimiterRow(lines[index + 1] ?? "")) {
      output.push(line);
      index += 1;
      while (
        index < lines.length
        && (lines[index] ?? "").trim() !== ""
        && !parseFenceLine(lines[index] ?? "")
      ) {
        output.push(lines[index] ?? "");
        index += 1;
      }
      continue;
    }

    const header = inferablePipeRow(line, "header");
    if (!header) {
      output.push(line);
      index += 1;
      continue;
    }

    // A line followed by a delimiter row starts a real table, so the run ends
    // before it and the existing-table branch takes it next. Every row keeps
    // the header's indentation: GFM never continues a table on a lazy line,
    // so a row that drifts out of a list item would end the table.
    const indent = leadingSpaces(line);
    let end = index + 1;
    while (
      end < lines.length
      && leadingSpaces(lines[end] ?? "") === indent
      && inferablePipeRow(lines[end] ?? "", "row")?.cells.length === header.cells.length
      && !isDelimiterRow(lines[end + 1] ?? "")
    ) {
      end += 1;
    }

    if (end - index < MIN_INFERRED_TABLE_LINES) {
      output.push(...lines.slice(index, end));
      index = end;
      continue;
    }

    if (output.length > 0 && (output[output.length - 1] ?? "").trim() !== "") {
      output.push("");
    }
    // A `#` column header would otherwise make the line an ATX heading.
    const headerLine = isAtxHeading(line) ? line.replace("#", "\\#") : line;
    const carriageReturn = line.endsWith("\r") ? "\r" : "";
    output.push(
      headerLine,
      `${indent}| ${header.cells.map(() => "---").join(" | ")} |${carriageReturn}`,
      ...lines.slice(index + 1, end),
    );
    if (end < lines.length && (lines[end] ?? "").trim() !== "") {
      output.push("");
    }
    changed = true;
    index = end;
  }

  return changed ? output.join("\n") : markdown;
}

// A header line may start with a `#` column (it is escaped on output); a body
// row may not, because GFM ends a table at a heading.
function inferablePipeRow(line: string, position: "header" | "row"): PipeRow | undefined {
  if (
    !line.includes("|")
    || /^(?: {4}|\s*\t)/.test(line)
    || /^\s*(?:>|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$))/.test(line)
    || (position === "row" && isAtxHeading(line))
  ) {
    return undefined;
  }

  const row = splitPipeRow(line);
  if (
    !row
    || row.cells.length < 2
    || row.cells.some((cell) => cell === "")
    || (row.cells.length < MIN_BARE_CELLS && !row.outerPipe)
    || row.cells.every((cell) => /^:?-+:?$/.test(cell))
  ) {
    return undefined;
  }

  return row;
}

// A backtick fence's info string can't hold a backtick, so a line such as
// "```pnpm test``` passed" is inline code, not a fence.
function parseFenceLine(line: string): { marker: "`" | "~"; length: number; info: string } | undefined {
  const match = /^ {0,3}(?:(`{3,})([^`]*)|(~{3,})(.*))$/.exec(line);
  if (!match) {
    return undefined;
  }
  const sequence = match[1] ?? match[3] ?? "";
  return {
    marker: sequence.startsWith("`") ? "`" : "~",
    length: sequence.length,
    info: match[2] ?? match[4] ?? "",
  };
}

function isAtxHeading(line: string): boolean {
  return /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line);
}

function leadingSpaces(line: string): string {
  return /^ */.exec(line)?.[0] ?? "";
}

function isDelimiterRow(line: string): boolean {
  const row = splitPipeRow(line);
  return Boolean(
    row
    && row.cells.length >= 1
    && row.cells.every((cell) => /^:?-+:?$/.test(cell)),
  );
}

const BACKSLASH = 0x5c;
const BACKTICK = 0x60;
const PIPE = 0x7c;

// Splits a line on unescaped pipes the way a GFM table row would. Returns
// undefined when the line has no separating pipe, or when a code span holds a
// pipe (GFM still splits there, so the cells would not match the author's).
//
// One pass over the line: a code span's closing run comes from a table of
// backtick runs built once per line, and each cell is a slice between two
// separators, so a long line costs time in proportion to its length.
function splitPipeRow(line: string): PipeRow | undefined {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return undefined;
  }

  const separators: number[] = [];
  let runsByLength: Map<number, number[]> | undefined;
  let index = 0;
  while (index < trimmed.length) {
    const code = trimmed.charCodeAt(index);
    if (code === BACKSLASH && index + 1 < trimmed.length) {
      index += 2;
      continue;
    }

    if (code === BACKTICK) {
      let runEnd = index + 1;
      while (runEnd < trimmed.length && trimmed.charCodeAt(runEnd) === BACKTICK) {
        runEnd += 1;
      }
      runsByLength ??= backtickRunsByLength(trimmed);
      const close = firstAtOrAfter(runsByLength.get(runEnd - index), runEnd);
      if (close === undefined) {
        index = runEnd;
        continue;
      }
      if (trimmed.slice(runEnd, close).includes("|")) {
        return undefined;
      }
      index = close + (runEnd - index);
      continue;
    }

    if (code === PIPE) {
      separators.push(index);
    }
    index += 1;
  }

  if (separators.length === 0) {
    return undefined;
  }

  const leadingPipe = separators[0] === 0;
  const trailingPipe = separators.length > (leadingPipe ? 1 : 0)
    && separators[separators.length - 1] === trimmed.length - 1;
  const cells: string[] = [];
  let cellStart = 0;
  for (const separator of separators) {
    cells.push(trimmed.slice(cellStart, separator).trim());
    cellStart = separator + 1;
  }
  cells.push(trimmed.slice(cellStart).trim());
  if (leadingPipe) {
    cells.shift();
  }
  if (trailingPipe) {
    cells.pop();
  }

  return { cells, outerPipe: leadingPipe || trailingPipe };
}

// Start offsets of every maximal backtick run, grouped by run length and in
// ascending order. A code span closes at the next run of exactly its length.
function backtickRunsByLength(text: string): Map<number, number[]> {
  const runs = new Map<number, number[]>();
  let index = text.indexOf("`");
  while (index !== -1) {
    let end = index + 1;
    while (end < text.length && text.charCodeAt(end) === BACKTICK) {
      end += 1;
    }
    const starts = runs.get(end - index);
    if (starts) {
      starts.push(index);
    } else {
      runs.set(end - index, [index]);
    }
    index = text.indexOf("`", end);
  }
  return runs;
}

function firstAtOrAfter(starts: number[] | undefined, position: number): number | undefined {
  if (!starts) {
    return undefined;
  }
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((starts[middle] ?? 0) < position) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return starts[low];
}
