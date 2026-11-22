type DiffLineRow =
  | {
      kind: "added";
      newNumber: number;
      text: string;
    }
  | {
      kind: "context";
      newNumber: number;
      oldNumber: number;
      text: string;
    }
  | {
      kind: "removed";
      oldNumber: number;
      text: string;
    };

type DiffHunkHeaderRow = {
  kind: "hunk";
  text: string;
};

type DiffRow = DiffHunkHeaderRow | DiffLineRow;

export function parseUnifiedDiff(patch: string): DiffRow[] {
  const lines = patch.replace(/\r\n?/g, "\n").split("\n");
  const rows: DiffRow[] = [];
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1], 10);
      newLine = Number.parseInt(hunkMatch[2], 10);
      inHunk = true;
      rows.push({ kind: "hunk", text: line });
      continue;
    }

    if (
      !inHunk ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("Index:") ||
      line.startsWith("====") ||
      line.startsWith("\\")
    ) {
      continue;
    }

    if (line.startsWith("-")) {
      rows.push({
        kind: "removed",
        oldNumber: oldLine,
        text: line.slice(1),
      });
      oldLine += 1;
      continue;
    }

    if (line.startsWith("+")) {
      rows.push({
        kind: "added",
        newNumber: newLine,
        text: line.slice(1),
      });
      newLine += 1;
      continue;
    }

    if (oldLine > 0 || newLine > 0 || line.length > 0) {
      rows.push({
        kind: "context",
        oldNumber: oldLine,
        newNumber: newLine,
        text: line.startsWith(" ") ? line.slice(1) : line,
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  return rows;
}
