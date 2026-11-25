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
// start a GFM table, and quoted, list, heading, or indented-code lines are
// left alone, and a line whose code span holds a pipe never counts, because
// GFM would split that span across cells.

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
    const fenceLine = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceLine) {
      const sequence = fenceLine[1] ?? "";
      const marker = sequence[0] as "`" | "~";
      if (!fence) {
        fence = { marker, length: sequence.length };
      } else if (
        marker === fence.marker
        && sequence.length >= fence.length
        && (fenceLine[2] ?? "").trim() === ""
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

    // An existing GFM table keeps every row until the next blank line.
    if (line.includes("|") && isDelimiterRow(lines[index + 1] ?? "")) {
      while (index < lines.length && (lines[index] ?? "").trim() !== "") {
        output.push(lines[index] ?? "");
        index += 1;
      }
      continue;
    }

    const header = inferablePipeRow(line);
    if (!header) {
      output.push(line);
      index += 1;
      continue;
    }

    // A line followed by a delimiter row starts a real table, so the run ends
    // before it and the existing-table branch takes it next.
    let end = index + 1;
    while (
      end < lines.length
      && inferablePipeRow(lines[end] ?? "")?.cells.length === header.cells.length
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
    const carriageReturn = line.endsWith("\r") ? "\r" : "";
    output.push(
      line,
      `| ${header.cells.map(() => "---").join(" | ")} |${carriageReturn}`,
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

function inferablePipeRow(line: string): PipeRow | undefined {
  if (
    /^(?: {4}|\s*\t)/.test(line)
    || /^\s*(?:>|#|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$))/.test(line)
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

function isDelimiterRow(line: string): boolean {
  const row = splitPipeRow(line);
  return Boolean(
    row
    && row.cells.length >= 1
    && row.cells.every((cell) => /^:?-+:?$/.test(cell)),
  );
}

// Splits a line on unescaped pipes the way a GFM table row would. Returns
// undefined when the line has no separating pipe, or when a code span holds a
// pipe (GFM still splits there, so the cells would not match the author's).
function splitPipeRow(line: string): PipeRow | undefined {
  const trimmed = line.trim();
  const cells: string[] = [];
  let cell = "";
  let pipes = 0;
  let index = 0;

  while (index < trimmed.length) {
    const character = trimmed[index] ?? "";
    if (character === "\\" && index + 1 < trimmed.length) {
      cell += trimmed.slice(index, index + 2);
      index += 2;
      continue;
    }

    if (character === "`") {
      const run = /^`+/.exec(trimmed.slice(index))?.[0] ?? "`";
      const close = findClosingBacktickRun(trimmed, index + run.length, run.length);
      if (close === -1) {
        cell += run;
        index += run.length;
        continue;
      }
      const span = trimmed.slice(index, close + run.length);
      if (span.includes("|")) {
        return undefined;
      }
      cell += span;
      index = close + run.length;
      continue;
    }

    if (character === "|") {
      cells.push(cell);
      cell = "";
      pipes += 1;
      index += 1;
      continue;
    }

    cell += character;
    index += 1;
  }
  cells.push(cell);

  if (pipes === 0) {
    return undefined;
  }

  const leadingPipe = trimmed.startsWith("|");
  const trailingPipe = pipes > (leadingPipe ? 1 : 0) && cell === "" && trimmed.endsWith("|");
  if (leadingPipe) {
    cells.shift();
  }
  if (trailingPipe) {
    cells.pop();
  }

  return {
    cells: cells.map((value) => value.trim()),
    outerPipe: leadingPipe || trailingPipe,
  };
}

function findClosingBacktickRun(text: string, from: number, length: number): number {
  let index = from;
  while (index < text.length) {
    const run = /^`+/.exec(text.slice(index))?.[0];
    if (!run) {
      index += 1;
      continue;
    }
    if (run.length === length) {
      return index;
    }
    index += run.length;
  }
  return -1;
}
