import { useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import {
  filePreviewKindLabel,
  type FilePreviewKind,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  buildFilePreviewText,
  MAX_PREVIEW_TABLE_ROWS,
  parseDelimitedTable,
  type FilePreviewNotice,
  type FilePreviewTable,
} from "./file-preview-model";
import { TranscriptCopyButton } from "./TranscriptCopyButton";

type CodeKind = Exclude<FilePreviewKind, "markdown" | "csv" | "tsv">;

/** "JSON document", "Text document": names the preview dialog. */
export function filePreviewDocumentName(kind: FilePreviewKind): string {
  const label = filePreviewKindLabel(kind);
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} document`;
}

/** Copies the file as written, whatever the view shows. */
export function FilePreviewCopyButton(props: {
  content: string;
  desktopApi?: Pick<DesktopApi, "copyText" | "copyRichText">;
  kind: FilePreviewKind;
}) {
  const label = filePreviewKindLabel(props.kind);
  return (
    <TranscriptCopyButton
      className="file-preview__copy"
      desktopApi={props.desktopApi}
      label={`Copy ${label}`}
      copiedLabel={`Copied ${label}`}
      text={props.content}
    />
  );
}

/**
 * The body for every previewable kind except Markdown, which the callers
 * render with ThreadMarkdown so links and skills keep working.
 */
export function FilePreviewBody(props: {
  content: string;
  kind: Exclude<FilePreviewKind, "markdown">;
  targetLine?: number;
}) {
  if (props.kind === "csv" || props.kind === "tsv") {
    return (
      <DelimitedFilePreview
        content={props.content}
        kind={props.kind}
        targetLine={props.targetLine}
      />
    );
  }
  return <CodeFilePreview content={props.content} kind={props.kind} targetLine={props.targetLine} />;
}

function CodeFilePreview(props: {
  content: string;
  kind: CodeKind;
  notice?: FilePreviewNotice;
  targetLine?: number;
}) {
  const preview = useMemo(
    () => buildFilePreviewText(props.content, props.kind),
    [props.content, props.kind],
  );
  const codeRef = useRef<HTMLDivElement>(null);
  const lines = preview.lines;
  // A formatted file no longer has the editor's line numbers.
  const targetLine = !preview.formatted && lines && props.targetLine
    && props.targetLine >= 1 && props.targetLine <= lines.length
    ? props.targetLine
    : undefined;
  const errorLines = useMemo(() => new Set(preview.errorLines), [preview.errorLines]);
  const scrollLine = targetLine ?? preview.errorLines?.[0];

  useLayoutEffect(() => {
    if (!scrollLine) return;
    codeRef.current
      ?.querySelector(`[data-line="${scrollLine}"]`)
      ?.scrollIntoView?.({ block: "center" });
  }, [scrollLine, preview]);

  const notice = props.notice ?? preview.notice;
  const label = `${filePreviewKindLabel(props.kind).replace(/^text$/, "Text")} contents`;
  return (
    <div className="file-preview">
      {notice ? <FilePreviewNoticeLine notice={notice} /> : null}
      {lines ? (
        <div
          ref={codeRef}
          className="file-preview__code"
          role="region"
          aria-label={label}
          tabIndex={0}
          style={{ "--file-preview-digits": String(lines.length).length } as CSSProperties}
        >
          {lines.map((line, index) => {
            const number = index + 1;
            return (
              <div
                key={index}
                className="file-preview__line"
                data-line={number}
                data-state={number === targetLine ? "target"
                  : errorLines.has(number) ? "error" : undefined}
              >
                <span className="file-preview__text">
                  {line.map((token, tokenIndex) => token.kind ? (
                    <span key={tokenIndex} className={`file-preview__token--${token.kind}`}>
                      {token.text}
                    </span>
                  ) : token.text)}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <pre
          className="file-preview__plain"
          role="region"
          aria-label={label}
          tabIndex={0}
        >
          {preview.text}
        </pre>
      )}
    </div>
  );
}

function DelimitedFilePreview(props: {
  content: string;
  kind: "csv" | "tsv";
  targetLine?: number;
}) {
  const table = useMemo(
    () => parseDelimitedTable(props.content, props.kind === "csv" ? "," : "\t"),
    [props.content, props.kind],
  );
  if (!table) {
    return (
      <CodeFilePreview
        content={props.content}
        kind="text"
        targetLine={props.targetLine}
        notice={props.content.trim() ? {
          tone: "neutral",
          title: `Not readable as ${filePreviewKindLabel(props.kind)}. Showing the file as written.`,
        } : undefined}
      />
    );
  }
  return <DelimitedTable kind={props.kind} table={table} />;
}

function DelimitedTable(props: { kind: "csv" | "tsv"; table: FilePreviewTable }) {
  const { header, numericColumns, rows, totalRows } = props.table;
  return (
    <div className="file-preview">
      {totalRows > rows.length ? (
        <FilePreviewNoticeLine
          notice={{
            tone: "neutral",
            title: `Showing the first ${MAX_PREVIEW_TABLE_ROWS.toLocaleString()} of ${totalRows.toLocaleString()} rows.`,
          }}
        />
      ) : null}
      <div
        className="thread-markdown__table-scroll file-preview__table"
        role="region"
        aria-label={`${filePreviewKindLabel(props.kind)} contents`}
        tabIndex={0}
      >
        <table className="thread-markdown__table">
          <thead className="thread-markdown__thead">
            <tr className="thread-markdown__tr">
              {header.map((cell, column) => (
                <th
                  key={column}
                  className="thread-markdown__th"
                  data-numeric={numericColumns[column] ? "true" : undefined}
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="thread-markdown__tbody">
            {rows.map((row, index) => (
              <tr key={index} className="thread-markdown__tr">
                {row.map((cell, column) => (
                  <td
                    key={column}
                    className="thread-markdown__td"
                    data-numeric={numericColumns[column] ? "true" : undefined}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FilePreviewNoticeLine(props: { notice: FilePreviewNotice }) {
  return (
    <p className="file-preview__notice" data-tone={props.notice.tone} role="status">
      <span className="file-preview__notice-dot" aria-hidden="true" />
      <span>
        <strong>{props.notice.title}</strong>
        {props.notice.detail ? ` ${props.notice.detail}` : null}
      </span>
    </p>
  );
}
