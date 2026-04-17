import { useMemo, useState } from "react";
import type { AppServerThreadActivityDetail } from "@pwragnt/shared";

type TranscriptDiffProps = {
  detail: AppServerThreadActivityDetail;
};

type DiffRow =
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
      kind: "hunk";
      text: string;
    }
  | {
      kind: "removed";
      oldNumber: number;
      text: string;
    }
  | {
      kind: "separator";
      count: number;
    };

const CONTEXT_RADIUS = 1;

export function TranscriptDiff(props: TranscriptDiffProps) {
  const [isZoomedIn, setIsZoomedIn] = useState(false);
  const diff = props.detail.fileDiff;
  const rows = useMemo(() => parsePatch(diff?.diff ?? ""), [diff?.diff]);
  const visibleRows = useMemo(
    () => (isZoomedIn ? rows : condenseRows(rows)),
    [isZoomedIn, rows]
  );

  if (!diff || rows.length === 0) {
    return null;
  }

  return (
    <div className="transcript-diff">
      {props.detail.path ? (
        <p className="transcript-diff__path" title={props.detail.path}>
          {props.detail.path}
        </p>
      ) : null}

      <div className="transcript-diff__toolbar">
        <div className="transcript-diff__stats" aria-label="Diff summary">
          <span className="transcript-diff__stat transcript-diff__stat--removed">
            -{diff.removals}
          </span>
          <span className="transcript-diff__stat transcript-diff__stat--added">
            +{diff.additions}
          </span>
        </div>
        <button
          type="button"
          className="button button--ghost transcript-diff__toggle"
          onClick={() => {
            setIsZoomedIn((current) => !current);
          }}
        >
          {isZoomedIn ? "Zoom out" : "Zoom in"}
        </button>
      </div>

      <div className="transcript-diff__rows" role="table" aria-label={`${props.detail.label} diff`}>
        {visibleRows.map((row, index) => {
          if (row.kind === "separator") {
            return (
              <div
                key={`separator-${index}`}
                className="transcript-diff__separator"
                role="row"
              >
                {row.count} unmodified line{row.count === 1 ? "" : "s"} skipped
              </div>
            );
          }

          if (row.kind === "hunk") {
            return (
              <div key={`hunk-${index}`} className="transcript-diff__hunk" role="row">
                {row.text}
              </div>
            );
          }

          const oldNumber = row.kind === "added" ? undefined : row.oldNumber;
          const newNumber = row.kind === "removed" ? undefined : row.newNumber;

          return (
            <div
              key={`${row.kind}-${oldNumber ?? "na"}-${newNumber ?? "na"}-${index}`}
              className={`transcript-diff__row transcript-diff__row--${row.kind}`}
              role="row"
            >
              <span className="transcript-diff__line-number">
                {formatLineNumber(oldNumber)}
              </span>
              <span className="transcript-diff__line-number">
                {formatLineNumber(newNumber)}
              </span>
              <span className="transcript-diff__symbol" aria-hidden="true">
                {row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "}
              </span>
              <code className="transcript-diff__text">{row.text || " "}</code>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function parsePatch(patch: string): DiffRow[] {
  const lines = patch.replace(/\r\n?/g, "\n").split("\n");
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1], 10);
      newLine = Number.parseInt(hunkMatch[2], 10);
      rows.push({ kind: "hunk", text: line });
      continue;
    }

    if (
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
        text: line.slice(1)
      });
      oldLine += 1;
      continue;
    }

    if (line.startsWith("+")) {
      rows.push({
        kind: "added",
        newNumber: newLine,
        text: line.slice(1)
      });
      newLine += 1;
      continue;
    }

    if (oldLine > 0 || newLine > 0 || line.length > 0) {
      rows.push({
        kind: "context",
        oldNumber: oldLine,
        newNumber: newLine,
        text: line.startsWith(" ") ? line.slice(1) : line
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  return rows;
}

function condenseRows(rows: DiffRow[]): DiffRow[] {
  const condensed: DiffRow[] = [];
  let contextBuffer: Extract<DiffRow, { kind: "context" }>[] = [];

  const flushContext = () => {
    if (contextBuffer.length === 0) {
      return;
    }

    if (contextBuffer.length <= CONTEXT_RADIUS * 2) {
      condensed.push(...contextBuffer);
      contextBuffer = [];
      return;
    }

    condensed.push(...contextBuffer.slice(0, CONTEXT_RADIUS));
    condensed.push({
      kind: "separator",
      count: contextBuffer.length - CONTEXT_RADIUS * 2
    });
    condensed.push(...contextBuffer.slice(-CONTEXT_RADIUS));
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
  return condensed;
}

function formatLineNumber(value: number | undefined): string {
  if (typeof value !== "number") {
    return "";
  }
  return String(value);
}
