import {
  createContext,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  PinIcon,
  SearchIcon,
  WrapIcon,
} from "../../icons";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";
import { useModalDialog } from "../../lib/useModalDialog";
import { renderMarkdownToClipboardHtml } from "./markdown-clipboard-html";
import {
  canOfferColumnPin,
  serializeTableCellsToCsv,
  type PinFirstColumnRecommendation,
} from "./table-sticky-model";
import { TranscriptCopyButton } from "./TranscriptCopyButton";

const CSV_COPIED_MS = 1400;

export type TableViewerConfig = {
  allowPopout: boolean;
  pinnedFirstColumn?: boolean;
  rowFilterQuery: string;
  stickyHeader: "native" | "scroll-ancestor" | "none";
};

export const TableViewerConfigContext = createContext<
  TableViewerConfig | undefined
>(undefined);

export type TableDocumentTarget = {
  columnCount?: number;
  initialPinnedFirstColumn: boolean;
  markdown: string;
  pinRecommendation: PinFirstColumnRecommendation;
  rowCount?: number;
  title?: string;
};

export function TableDocumentModal(props: {
  desktopApi?: Pick<DesktopApi, "copyText" | "copyRichText">;
  onClose: () => void;
  renderTable: (config: TableViewerConfig) => ReactNode;
  target: TableDocumentTarget;
}) {
  const contentRef = useModalDialog({ onClose: props.onClose });
  const bodyRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  const [filterQuery, setFilterQuery] = useState("");
  const deferredFilterQuery = useDeferredValue(filterQuery);
  const [pinnedFirstColumn, setPinnedFirstColumn] = useState(
    props.target.initialPinnedFirstColumn,
  );
  const [wideColumns, setWideColumns] = useState(false);
  const [rowCounts, setRowCounts] = useState<{
    matched: number;
    total: number;
  }>(() => ({
    matched: props.target.rowCount ?? 0,
    total: props.target.rowCount ?? 0,
  }));
  const [csvCopied, setCsvCopied] = useState(false);
  const csvTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (csvTimerRef.current !== undefined) {
        window.clearTimeout(csvTimerRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const table = bodyRef.current?.querySelector("table");
    if (!table) {
      return;
    }
    const bodyRows = table.querySelectorAll("tbody > tr");
    const total = bodyRows.length;
    let matched = 0;
    bodyRows.forEach((row) => {
      if (!(row instanceof HTMLElement) || !row.hidden) {
        matched += 1;
      }
    });
    setRowCounts((current) =>
      current.matched === matched && current.total === total
        ? current
        : { matched, total },
    );
  }, [deferredFilterQuery, props.target.markdown]);

  const handleCopyCsv = useCallback(() => {
    const table = bodyRef.current?.querySelector("table");
    if (!table) {
      return;
    }
    const rows: string[][] = [];
    const headerRow = table.querySelector("thead > tr");
    if (headerRow) {
      rows.push(extractRowCellTexts(headerRow));
    }
    table.querySelectorAll("tbody > tr").forEach((row) => {
      if (row instanceof HTMLElement && row.hidden) {
        return;
      }
      rows.push(extractRowCellTexts(row));
    });
    const csv = serializeTableCellsToCsv(rows);
    void copyText(csv, props.desktopApi)
      .then(() => {
        if (csvTimerRef.current !== undefined) {
          window.clearTimeout(csvTimerRef.current);
        }
        setCsvCopied(true);
        csvTimerRef.current = window.setTimeout(() => {
          setCsvCopied(false);
          csvTimerRef.current = undefined;
        }, CSV_COPIED_MS);
      })
      .catch((error: unknown) => {
        console.error("Failed to copy table CSV", error);
      });
  }, [props.desktopApi]);

  const canPin = canOfferColumnPin(props.target.pinRecommendation);
  const title = props.target.title || "Table viewer";
  const hasFilter = deferredFilterQuery.trim().length > 0;
  const colLabel = props.target.columnCount
    ? `${props.target.columnCount} ${props.target.columnCount === 1 ? "col" : "cols"}`
    : undefined;
  const rowLabel = rowCounts.total > 0
    ? hasFilter
      ? `${rowCounts.matched} / ${rowCounts.total} rows`
      : `${rowCounts.total} ${rowCounts.total === 1 ? "row" : "rows"}`
    : undefined;
  const metaText = [colLabel, rowLabel].filter(Boolean).join(" · ");

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="markdown-document-modal table-viewer-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Table viewer: ${title}`}
      onClick={props.onClose}
    >
      <div
        ref={contentRef}
        className={[
          "markdown-document-modal__content",
          "table-viewer-modal__content",
          wideColumns ? "table-viewer-modal__content--wide-columns" : undefined,
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="file-viewer-header table-viewer-modal__header">
          <span className="file-viewer-header__kind" aria-hidden="true">
            TABLE
          </span>
          <h2
            className="file-viewer-header__name tooltip-target"
            data-tooltip={title}
          >
            {title}
          </h2>
          {metaText ? (
            <span className="table-viewer-modal__meta" aria-live="polite">
              {metaText}
            </span>
          ) : null}
          <span className="file-viewer-header__spring" />
          <div className="table-viewer-modal__controls">
            <label className="table-viewer-modal__search">
              <SearchIcon
                className="table-viewer-modal__search-icon"
                size={13}
                aria-hidden="true"
              />
              <input
                ref={filterInputRef}
                type="text"
                className="table-viewer-modal__search-input"
                aria-label="Filter table rows"
                placeholder="Filter rows…"
                value={filterQuery}
                onChange={(event) => setFilterQuery(event.target.value)}
              />
              {filterQuery ? (
                <button
                  type="button"
                  className="table-viewer-modal__search-clear"
                  aria-label="Clear filter"
                  onClick={() => {
                    setFilterQuery("");
                    filterInputRef.current?.focus();
                  }}
                >
                  <CloseIcon size={12} aria-hidden="true" />
                </button>
              ) : null}
            </label>
            {canPin ? (
              <button
                type="button"
                className="table-viewer-modal__toggle tooltip-target"
                aria-pressed={pinnedFirstColumn}
                aria-label={pinnedFirstColumn ? "Unpin first column" : "Pin first column"}
                data-tooltip={pinnedFirstColumn ? "Unpin first column" : "Pin first column"}
                onClick={() => setPinnedFirstColumn((current) => !current)}
              >
                <PinIcon size={13} aria-hidden="true" />
                <span>Pin col 1</span>
              </button>
            ) : null}
            <button
              type="button"
              className="table-viewer-modal__toggle tooltip-target"
              aria-pressed={wideColumns}
              aria-label={wideColumns ? "Standard column widths" : "Widen columns"}
              data-tooltip={wideColumns ? "Use standard column widths" : "Widen columns for reading"}
              onClick={() => setWideColumns((current) => !current)}
            >
              <WrapIcon size={13} aria-hidden="true" />
              <span>Wide</span>
            </button>
          </div>
          <div className="file-viewer-header__actions">
            <TranscriptCopyButton
              className="file-preview__copy"
              copiedLabel="Copied Markdown table"
              desktopApi={props.desktopApi}
              html={() => renderMarkdownToClipboardHtml(props.target.markdown)}
              label="Copy Markdown table"
              text={props.target.markdown}
            />
            <button
              type="button"
              className="table-viewer-modal__csv-button tooltip-target"
              aria-label={csvCopied ? "Copied CSV" : "Copy CSV"}
              data-copied={csvCopied ? "true" : undefined}
              data-tooltip={csvCopied ? "Copied CSV" : "Copy visible rows as CSV"}
              onClick={handleCopyCsv}
            >
              {csvCopied ? (
                <CheckIcon size={13} aria-hidden="true" />
              ) : (
                <CopyIcon size={13} aria-hidden="true" />
              )}
              <span>CSV</span>
            </button>
            <button
              type="button"
              className="markdown-document-modal__icon-button"
              aria-label="Close"
              title="Close"
              onClick={props.onClose}
            >
              <CloseIcon size={18} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div ref={bodyRef} className="table-viewer-modal__body">
          {props.renderTable({
            allowPopout: false,
            pinnedFirstColumn,
            rowFilterQuery: deferredFilterQuery,
            stickyHeader: "native",
          })}
          {hasFilter && rowCounts.total > 0 && rowCounts.matched === 0 ? (
            <div className="table-viewer-modal__empty" role="status">
              <p>No rows match “{deferredFilterQuery.trim()}”.</p>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  setFilterQuery("");
                  filterInputRef.current?.focus();
                }}
              >
                Show all rows
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function extractRowCellTexts(row: Element): string[] {
  const cells: string[] = [];
  for (const child of Array.from(row.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "th" || tag === "td") {
      cells.push((child.textContent ?? "").replace(/\s+/g, " ").trim());
    }
  }
  return cells;
}
