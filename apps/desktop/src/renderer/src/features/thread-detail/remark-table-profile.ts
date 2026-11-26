import type { PinFirstColumnRecommendation } from "./table-sticky-model";

export type ColumnKind = "tag" | "label" | "prose";
export type { PinFirstColumnRecommendation };

type MdastNode = {
  type: string;
  value?: string;
  alt?: string;
  url?: string;
  children?: ReadonlyArray<MdastNode>;
  data?: { hProperties?: Record<string, unknown> };
};

type MdastTableCell = MdastNode & { type: "tableCell" };
type MdastTableRow = MdastNode & {
  type: "tableRow";
  children: ReadonlyArray<MdastTableCell>;
};
type MdastTable = MdastNode & {
  type: "table";
  children: ReadonlyArray<MdastTableRow>;
};

type RemarkPlugin = () => (tree: MdastNode) => void;

const TAG_MAX_WIDTH = 4;
const TAG_HEADER_MAX_WIDTH = 12;
const LABEL_MAX_WIDTH = 40;
const LABEL_MAX_WORDS = 4;

const PIN_MIN_COLUMNS = 3;
const PIN_MIN_DATA_ROWS = 2;
const PIN_MIN_NON_EMPTY_RATIO = 0.75;
const PIN_MIN_DOMINANT_RATIO = 0.75;
const PIN_MIN_UNIQUE_RATIO = 0.6;
const PIN_MAX_CELL_WIDTH = 72;
const PIN_MAX_AVG_WIDTH = 54;
const PIN_MAX_AVG_WORDS = 10;
const PIN_STRONG_PREFIX_MIN_WIDTH = 2;

export const remarkTableProfile: RemarkPlugin = () => (tree) => {
  forEachTable(tree, (table) => {
    const rows: ReadonlyArray<MdastTableRow> = table.children;
    const headerRow = rows[0];
    if (!headerRow) {
      return;
    }

    const dataRows: ReadonlyArray<MdastTableRow> = rows.slice(1);
    const columnCount = rows.reduce(
      (max, row) => Math.max(max, row.children.length),
      headerRow.children.length,
    );
    const kinds = computeColumnKinds(dataRows, headerRow, columnCount);
    const firstColumnDataCells = dataRows.map((row) => row.children[0]).filter(isCell);
    const pinRecommendation = classifyFirstColumnPin(
      firstColumnDataCells,
      columnCount,
      dataRows.length,
      kinds[0],
    );

    table.data ??= {};
    table.data.hProperties = {
      ...(table.data.hProperties ?? {}),
      "data-table-cols": String(columnCount),
      "data-table-rows": String(dataRows.length),
      ...(pinRecommendation !== "none"
        ? { "data-pin-first-col": pinRecommendation }
        : {}),
    };

    for (const row of rows) {
      row.children.forEach((cell, columnIndex) => {
        const kind = kinds[columnIndex];
        if (!kind) {
          return;
        }
        cell.data ??= {};
        const hProperties: Record<string, unknown> = {
          ...(cell.data.hProperties ?? {}),
          "data-col-kind": kind,
        };
        if (isMathOnlyCell(cell)) {
          hProperties["data-cell-math"] = "only";
        }
        cell.data.hProperties = hProperties;
      });
    }
  });
};

function forEachTable(node: MdastNode, visit: (table: MdastTable) => void): void {
  if (node.type === "table") {
    visit(node as MdastTable);
    return;
  }
  if (!node.children) {
    return;
  }
  for (const child of node.children) {
    forEachTable(child, visit);
  }
}

function computeColumnKinds(
  dataRows: readonly MdastTableRow[],
  headerRow: MdastTableRow,
  columnCount: number,
): ColumnKind[] {
  const kinds: ColumnKind[] = [];
  for (let column = 0; column < columnCount; column++) {
    const headerCell = headerRow.children[column];
    const dataCells = dataRows.map((row) => row.children[column]).filter(isCell);
    kinds.push(classifyColumn(dataCells, headerCell));
  }
  return kinds;
}

function isCell(cell: MdastTableCell | undefined): cell is MdastTableCell {
  return cell !== undefined;
}

type CellMathScan = "empty" | "math" | "other";

function isMathOnlyCell(cell: MdastNode): boolean {
  return scanCellMath(cell.children) === "math";
}

function scanCellMath(children: ReadonlyArray<MdastNode> | undefined): CellMathScan {
  if (!children || children.length === 0) {
    return "empty";
  }
  let sawMath = false;
  for (const child of children) {
    if (child.type === "inlineMath" || child.type === "math") {
      if (typeof child.value === "string" && child.value.trim() !== "") {
        sawMath = true;
      } else {
        return "other";
      }
      continue;
    }
    if (child.type === "text") {
      if (typeof child.value === "string" && child.value.trim() !== "") {
        return "other";
      }
      continue;
    }
    if (child.type === "break") {
      continue;
    }
    if (
      child.type === "emphasis"
      || child.type === "strong"
      || child.type === "delete"
    ) {
      const inner = scanCellMath(child.children);
      if (inner === "other") {
        return "other";
      }
      if (inner === "math") {
        sawMath = true;
      }
      continue;
    }
    return "other";
  }
  return sawMath ? "math" : "empty";
}

function classifyCells(cells: readonly MdastTableCell[]): ColumnKind {
  if (cells.length === 0) {
    return "label";
  }

  let maxWidth = 0;
  let maxWords = 0;
  for (const cell of cells) {
    const text = collectCellText(cell);
    const width = measureVisualWidth(text);
    const words = countWords(text);
    if (width > maxWidth) {
      maxWidth = width;
    }
    if (words > maxWords) {
      maxWords = words;
    }
  }

  if (maxWidth <= TAG_MAX_WIDTH) {
    return "tag";
  }
  if (maxWidth <= LABEL_MAX_WIDTH && maxWords <= LABEL_MAX_WORDS) {
    return "label";
  }
  return "prose";
}

function classifyColumn(
  dataCells: readonly MdastTableCell[],
  headerCell: MdastTableCell | undefined,
): ColumnKind {
  if (dataCells.length === 0) {
    return headerCell ? classifyCells([headerCell]) : "label";
  }

  const bodyKind = classifyCells(dataCells);
  if (!headerCell || bodyKind === "prose") {
    return bodyKind;
  }

  const headerText = collectCellText(headerCell);
  const headerWidth = measureVisualWidth(headerText);
  const headerWords = countWords(headerText);

  if (headerWidth > LABEL_MAX_WIDTH || headerWords > LABEL_MAX_WORDS) {
    return "prose";
  }

  if (bodyKind === "tag") {
    return headerWidth <= TAG_HEADER_MAX_WIDTH && headerWords <= 1
      ? "tag"
      : "label";
  }

  return "label";
}

function collectCellText(node: MdastNode): string {
  if (typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "image") {
    return `![${node.alt ?? ""}](${node.url ?? ""})`;
  }
  if (!node.children) {
    return "";
  }
  let buffer = "";
  for (const child of node.children) {
    buffer += collectCellText(child);
  }
  return buffer;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

function measureVisualWidth(text: string): number {
  let width = 0;
  let afterZwj = false;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0x200d) {
      afterZwj = true;
      continue;
    }
    if (isZeroWidthCodePoint(codePoint)) {
      continue;
    }
    if (afterZwj) {
      afterZwj = false;
      continue;
    }
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100
    && (
      codePoint <= 0x115f
      || codePoint === 0x2329
      || codePoint === 0x232a
      || (codePoint >= 0x2e80 && codePoint <= 0x303e)
      || (codePoint >= 0x3040 && codePoint <= 0xa4cf)
      || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
      || (codePoint >= 0xf900 && codePoint <= 0xfaff)
      || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
      || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
      || (codePoint >= 0xff00 && codePoint <= 0xff60)
      || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
      || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
      || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}

/**
 * Classifies whether column 0 behaves like a row-title / row-key column that
 * should auto-pin during horizontal scroll ("auto"), offer manual pinning
 * ("eligible"), or skip pinning ("none").
 */
export function classifyFirstColumnPin(
  firstColumnDataCells: readonly MdastTableCell[],
  columnCount: number,
  totalDataRows: number,
  col0Kind: ColumnKind | undefined,
): PinFirstColumnRecommendation {
  if (columnCount < PIN_MIN_COLUMNS || totalDataRows < PIN_MIN_DATA_ROWS) {
    return "none";
  }

  let nonEmptyCount = 0;
  let boldCount = 0;
  let structuredKeyCount = 0;
  let numericOrOrdinalCount = 0;
  let maxWidth = 0;
  let totalWidth = 0;
  let totalWords = 0;
  let hasMultiSentenceProse = false;
  const uniqueNormalized = new Set<string>();

  for (const cell of firstColumnDataCells) {
    const text = collectCellText(cell).trim();
    if (!text) {
      continue;
    }
    nonEmptyCount += 1;
    uniqueNormalized.add(text.toLowerCase());

    const width = measureVisualWidth(text);
    const words = countWords(text);
    if (width > maxWidth) {
      maxWidth = width;
    }
    totalWidth += width;
    totalWords += words;

    if (words > 12 && /[.!?]\s+\S/.test(text)) {
      hasMultiSentenceProse = true;
    }
    if (isBoldRowTitleCell(cell)) {
      boldCount += 1;
    }
    if (isStructuredKeyCell(cell)) {
      structuredKeyCount += 1;
    }
    if (isNumericOrOrdinalText(text)) {
      numericOrOrdinalCount += 1;
    }
  }

  if (nonEmptyCount < PIN_MIN_DATA_ROWS) {
    return "none";
  }

  const nonEmptyRatio = nonEmptyCount / totalDataRows;
  if (nonEmptyRatio < PIN_MIN_NON_EMPTY_RATIO) {
    return "eligible";
  }

  const averageWidth = totalWidth / nonEmptyCount;
  const averageWords = totalWords / nonEmptyCount;
  if (
    hasMultiSentenceProse
    || maxWidth > PIN_MAX_CELL_WIDTH
    || averageWidth > PIN_MAX_AVG_WIDTH
    || averageWords > PIN_MAX_AVG_WORDS
  ) {
    return "eligible";
  }

  const uniqueRatio = uniqueNormalized.size / nonEmptyCount;
  if (
    uniqueNormalized.size < PIN_MIN_DATA_ROWS
    || (nonEmptyCount >= 3 && uniqueRatio < PIN_MIN_UNIQUE_RATIO)
  ) {
    return "eligible";
  }

  // Pure numeric / ordinal index columns (`1, 2, 3`, `#1`, `$12`, `99%`) stay
  // manually pinnable rather than auto-pinned.
  if (numericOrOrdinalCount / nonEmptyCount >= PIN_MIN_DOMINANT_RATIO) {
    return "eligible";
  }

  const boldRatio = boldCount / nonEmptyCount;
  if (boldRatio >= PIN_MIN_DOMINANT_RATIO) {
    return "auto";
  }

  const structuredKeyRatio = structuredKeyCount / nonEmptyCount;
  if (structuredKeyRatio >= PIN_MIN_DOMINANT_RATIO) {
    return "auto";
  }

  if (col0Kind === "label") {
    return "auto";
  }

  return "eligible";
}

/**
 * Classifies plain string column-0 values (e.g. CSV/TSV previews that have no
 * Markdown AST formatting) using the same row-key uniqueness and compactness
 * guards.
 */
export function classifyPlainFirstColumnPin(
  firstColumnValues: readonly string[],
  columnCount: number,
  isNumericColumn: boolean,
): PinFirstColumnRecommendation {
  if (columnCount < PIN_MIN_COLUMNS || firstColumnValues.length < PIN_MIN_DATA_ROWS) {
    return "none";
  }
  let nonEmptyCount = 0;
  let maxWidth = 0;
  let maxWords = 0;
  const uniqueNormalized = new Set<string>();
  for (const raw of firstColumnValues) {
    const text = raw.trim();
    if (!text) {
      continue;
    }
    nonEmptyCount += 1;
    uniqueNormalized.add(text.toLowerCase());
    const width = measureVisualWidth(text);
    const words = countWords(text);
    if (width > maxWidth) {
      maxWidth = width;
    }
    if (words > maxWords) {
      maxWords = words;
    }
  }
  if (nonEmptyCount < PIN_MIN_DATA_ROWS) {
    return "none";
  }
  if (isNumericColumn) {
    return "eligible";
  }
  const nonEmptyRatio = nonEmptyCount / firstColumnValues.length;
  const uniqueRatio = uniqueNormalized.size / nonEmptyCount;
  if (
    nonEmptyRatio >= PIN_MIN_NON_EMPTY_RATIO
    && uniqueNormalized.size >= PIN_MIN_DATA_ROWS
    && (nonEmptyCount < 3 || uniqueRatio >= PIN_MIN_UNIQUE_RATIO)
    && maxWidth <= LABEL_MAX_WIDTH
    && maxWords <= LABEL_MAX_WORDS
  ) {
    return "auto";
  }
  return "eligible";
}

function isBoldRowTitleCell(cell: MdastNode): boolean {
  const meaningful = meaningfulChildren(cell.children);
  if (meaningful.length === 0) {
    return false;
  }
  if (meaningful.every((child) => child.type === "strong")) {
    return true;
  }
  const first = meaningful[0];
  if (first?.type === "strong") {
    return measureVisualWidth(collectCellText(first).trim()) >= PIN_STRONG_PREFIX_MIN_WIDTH;
  }
  return false;
}

function isStructuredKeyCell(cell: MdastNode): boolean {
  const meaningful = meaningfulChildren(cell.children);
  if (meaningful.length === 0) {
    return false;
  }
  return meaningful.every(
    (child) =>
      child.type === "strong"
      || child.type === "inlineCode"
      || child.type === "link"
      || child.type === "emphasis",
  );
}

function meaningfulChildren(
  children: ReadonlyArray<MdastNode> | undefined,
): MdastNode[] {
  if (!children) {
    return [];
  }
  const result: MdastNode[] = [];
  for (const child of children) {
    if (child.type === "text" && (child.value ?? "").trim() === "") {
      continue;
    }
    if (child.type === "break") {
      continue;
    }
    result.push(child);
  }
  return result;
}

function isNumericOrOrdinalText(text: string): boolean {
  return /^(?:#\s*)?[+-]?(?:\$|€|£|¥)?\d[\d,._]*(?:%|x|ms|s|kb|mb|gb)?\.?$/i.test(text);
}
