export type ColumnKind = "tag" | "label" | "prose";

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
