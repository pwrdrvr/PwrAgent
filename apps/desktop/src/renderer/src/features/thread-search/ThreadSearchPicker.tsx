import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { SearchIcon } from "../../icons";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import { JumpPaletteThreadRow } from "../navigation/JumpPaletteThreadRow";
import { useThreadJumpSearch, type ThreadJumpSearchApi } from "../navigation/useThreadJumpSearch";
import {
  activeDestinationIndex,
  DESTINATION_CURSOR_START,
  pointDestinationCursor,
  settleDestinationCursor,
  stepDestinationCursor,
} from "./thread-search-cursor";

/** A search row the caller can choose, with what choosing it records. */
export type ThreadSearchCandidate<T> = {
  thread: NavigationThreadSummary;
  target: T;
};

/**
 * The jump palette's search (⌘K) inline: results as you type, the palette's
 * rows, and peers below "Other instances". Focus stays in the field; the
 * arrows steer the active row, Enter picks it, and Escape cancels through the
 * dismissable-layer stack, so it never also closes a dialog behind it.
 *
 * `toCandidates` drops the rows the caller cannot address and must keep its
 * identity between renders.
 */
export function ThreadSearchPicker<T>(props: {
  toCandidates: (threads: readonly NavigationThreadSummary[]) => ThreadSearchCandidate<T>[];
  disabled: boolean;
  api: ThreadJumpSearchApi;
  threads: readonly NavigationThreadSummary[];
  focusOnOpen: boolean;
  fieldLabel: string;
  listLabel: string;
  /** Absent while there is nothing to go back to. */
  onCancel?: () => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  /** Start a new search after each pick, for pickers that add several rows. */
  clearOnPick?: boolean;
  onPick: (target: T, thread: NavigationThreadSummary) => void;
}) {
  const [query, setQuery] = useState("");
  // Rows are replaced as searches answer; the cursor keeps the operator's row.
  const [cursor, setCursor] = useState(DESTINATION_CURSOR_START);
  // Chromium re-runs hover when rows appear under a still pointer. Only a
  // move to new coordinates is the operator pointing at a row.
  const lastPointer = useRef<{ x: number; y: number } | undefined>(undefined);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const idPrefix = useId();
  const listId = `${idPrefix}-results`;
  const rowId = (index: number): string => `${idPrefix}-row-${index}`;
  const search = useThreadJumpSearch({ query, threads: props.threads, desktopApi: props.api });
  const { toCandidates } = props;

  const localRows = useMemo(() => toCandidates(search.results), [search.results, toCandidates]);
  const remoteRows = useMemo(() => toCandidates(search.remoteRows), [search.remoteRows, toCandidates]);
  const rows = useMemo(() => [...localRows, ...remoteRows], [localRows, remoteRows]);
  const rowKeys = useMemo(() => rows.map((row) => threadSummaryIdentityKey(row.thread)), [rows]);
  // Read from the rows on screen, so the active row always exists.
  const activeIndex = activeDestinationIndex(cursor, rowKeys);

  useEffect(() => {
    if (props.focusOnOpen) inputRef.current?.focus();
  }, [props.focusOnOpen]);

  // Later rows start from where the highlight is now.
  useEffect(() => {
    setCursor((current) => settleDestinationCursor(current, rowKeys));
  }, [rowKeys]);

  const changeQuery = (next: string): void => {
    setQuery(next);
    setCursor(DESTINATION_CURSOR_START);
  };

  useEffect(() => {
    const row = listRef.current?.querySelector(".jump-palette__row.is-active");
    // jsdom has no layout and so no scrollIntoView.
    if (typeof row?.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  }, [activeIndex, rows.length]);

  // Escape cancels, or clears a field there is nothing to cancel back to.
  useDismissableLayer({
    open: Boolean(props.onCancel) || query !== "",
    onDismiss: () => props.onCancel ? props.onCancel() : changeQuery(""),
    surfaceRef,
    ...(props.triggerRef ? { triggerRef: props.triggerRef } : {}),
  });

  const pointAtRow = (event: ReactMouseEvent<HTMLButtonElement>, index: number): void => {
    const previous = lastPointer.current;
    lastPointer.current = { x: event.clientX, y: event.clientY };
    if (!previous || (previous.x === event.clientX && previous.y === event.clientY)) return;
    if (index !== activeIndex) setCursor(pointDestinationCursor(rowKeys, index));
  };

  const choose = (row: ThreadSearchCandidate<T> | undefined): void => {
    if (!row || props.disabled) return;
    props.onPick(row.target, row.thread);
    if (props.clearOnPick) changeQuery("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // The arrows wrap, so the bottom row is one ArrowUp away from the top.
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setCursor(stepDestinationCursor(cursor, rowKeys, event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(rows[activeIndex]);
    }
  };

  const trimmed = query.trim();
  const ownerSearch = search.ownerSearch;
  const remote = search.remote;
  const searching = remote.loading || ownerSearch.loading || (!trimmed && search.recentThreads.loading);
  const listVisible = rows.length > 0;
  const unaddressable = search.results.length + search.remoteRows.length > 0;
  const status = !trimmed && search.recentThreads.state?.error ? "Recent threads unavailable"
    : ownerSearch.error ? ownerSearch.error
    : searching ? `${!trimmed ? "Loading recent threads…" : remote.loading ? "Searching peers…" : "Searching threads…"}${
      remote.totalPeerCount > 0 ? ` ${remote.completedPeerCount}/${remote.totalPeerCount}` : ""}`
    : remote.notes.length ? "Some instances could not be searched"
    : trimmed ? `${rows.length} ${rows.length === 1 ? "result" : "results"}`
    : "";

  return (
    <div ref={surfaceRef} className="thread-search-picker">
      <div className="thread-search-picker__field">
        <SearchIcon size={14} aria-hidden />
        <input
          ref={inputRef}
          role="combobox"
          aria-label={props.fieldLabel}
          aria-expanded={listVisible}
          aria-autocomplete="list"
          aria-controls={listVisible ? listId : undefined}
          aria-activedescendant={listVisible ? rowId(activeIndex) : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Thread title, PR #, or branch"
          value={query}
          disabled={props.disabled}
          onChange={(event) => changeQuery(event.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      {listVisible ? (
        <ul
          ref={listRef}
          id={listId}
          className="thread-search-picker__results"
          role="listbox"
          aria-label={props.listLabel}
          // Keep the caret in the field; click still picks the row.
          onMouseDown={(event) => event.preventDefault()}
        >
          {localRows.map((row, index) => (
            <JumpPaletteThreadRow
              key={threadSummaryIdentityKey(row.thread)}
              thread={row.thread}
              id={rowId(index)}
              active={index === activeIndex}
              query={search.jumpText}
              onPoint={(event) => pointAtRow(event, index)}
              onChoose={() => choose(row)}
              onOpenPullRequest={(url) => window.open(url, "_blank", "noopener,noreferrer")}
            />
          ))}
          {remoteRows.length > 0 ? (
            <li aria-hidden="true" className="jump-palette__section-divider" role="presentation">
              Other instances
            </li>
          ) : null}
          {remoteRows.map((row, index) => (
            <JumpPaletteThreadRow
              key={threadSummaryIdentityKey(row.thread)}
              thread={row.thread}
              id={rowId(localRows.length + index)}
              active={localRows.length + index === activeIndex}
              query={search.jumpText}
              onPoint={(event) => pointAtRow(event, localRows.length + index)}
              onChoose={() => choose(row)}
              onOpenPullRequest={(url) => window.open(url, "_blank", "noopener,noreferrer")}
            />
          ))}
        </ul>
      ) : trimmed && !searching ? (
        <p className="thread-search-picker__empty">
          {unaddressable ? "No other addressable threads found." : "No threads match"}
        </p>
      ) : null}
      <div className="thread-search-picker__foot">
        <span>↑↓ move</span>
        <span>↵ choose</span>
        <span>{props.onCancel ? "esc cancel" : "esc clear"}</span>
        <span className="thread-search-picker__foot-spacer" />
        {status ? <span className="thread-search-picker__status" title={status}>{status}</span> : null}
      </div>
    </div>
  );
}
