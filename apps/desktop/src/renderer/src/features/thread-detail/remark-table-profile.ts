export type ColumnKind = "tag" | "label" | "prose";

type MdastNode = {
  type: string;
  value?: string;
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

const TAG_MAX_CHARS = 4;
const LABEL_MAX_CHARS = 40;
const LABEL_MAX_WORDS = 4;

export const remarkTableProfile: RemarkPlugin = () => (tree) => {
  forEachTable(tree, (table) => {
    const rows: ReadonlyArray<MdastTableRow> = table.children;
    const headerRow = rows[0];
    if (!headerRow) {
      return;
    }

    const dataRows: ReadonlyArray<MdastTableRow> = rows.slice(1);
    const columnCount = headerRow.children.length;
    const kinds = computeColumnKinds(dataRows, headerRow, columnCount);

    for (const row of rows) {
      row.children.forEach((cell, columnIndex) => {
        const kind = kinds[columnIndex];
        if (!kind) {
          return;
        }
        cell.data ??= {};
        cell.data.hProperties = {
          ...(cell.data.hProperties ?? {}),
          "data-col-kind": kind,
        };
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
    const sampleCells: MdastTableCell[] = dataRows.length > 0
      ? dataRows.map((row) => row.children[column]).filter(isCell)
      : [headerRow.children[column]].filter(isCell);

    kinds.push(classifyColumn(sampleCells));
  }
  return kinds;
}

function isCell(cell: MdastTableCell | undefined): cell is MdastTableCell {
  return cell !== undefined;
}

function classifyColumn(cells: readonly MdastTableCell[]): ColumnKind {
  if (cells.length === 0) {
    return "label";
  }

  let maxChars = 0;
  let maxWordsAtMaxChars = 0;
  for (const cell of cells) {
    const text = collectCellText(cell);
    if (text.length > maxChars) {
      maxChars = text.length;
      maxWordsAtMaxChars = countWords(text);
    }
  }

  if (maxChars <= TAG_MAX_CHARS) {
    return "tag";
  }
  if (maxChars <= LABEL_MAX_CHARS && maxWordsAtMaxChars <= LABEL_MAX_WORDS) {
    return "label";
  }
  return "prose";
}

function collectCellText(node: MdastNode): string {
  if (typeof node.value === "string") {
    return node.value;
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
