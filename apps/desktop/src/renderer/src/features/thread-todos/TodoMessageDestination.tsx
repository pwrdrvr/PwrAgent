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
import type { NavigationThreadSummary, ThreadTodo, ThreadTodoMessageTarget } from "@pwragent/shared";
import { SearchIcon } from "../../icons";
import { formatBackendLabel } from "../../lib/backend-label";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import { useThreadLinks, type ResolvedThreadLink } from "../../lib/thread-links";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import { JumpPaletteThreadRow } from "../navigation/JumpPaletteThreadRow";
import { useThreadJumpSearch, type ThreadJumpSearchApi } from "../navigation/useThreadJumpSearch";
import { ThreadChip } from "../thread-detail/ThreadChip";
import { useTodoDispatchContext } from "./TodoDispatchProvider";
import type { ThreadTodoLocalMachine } from "./thread-todos-view";
import { addressableTodoDestinations, type TodoDestinationCandidate } from "./todo-destination-addressing";
import {
  activeDestinationIndex,
  DESTINATION_CURSOR_START,
  pointDestinationCursor,
  settleDestinationCursor,
  stepDestinationCursor,
} from "./todo-destination-cursor";

const NO_THREADS: readonly NavigationThreadSummary[] = [];

/** Selecting a destination only prepares the proposal; Send remains a separate click. */
export function TodoMessageDestination(props: {
  todo: ThreadTodo;
  target?: ThreadTodoMessageTarget;
  localMachine?: ThreadTodoLocalMachine;
  disabled: boolean;
  onSelect: (target: ThreadTodoMessageTarget) => void;
}) {
  const { api } = useTodoDispatchContext();
  const [editing, setEditing] = useState(!props.target);
  // Only Change moves focus into the field. A card that opens without a
  // destination must not take focus from the composer.
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const changeRef = useRef<HTMLButtonElement>(null);
  const owner = props.todo.federationTarget?.instanceId;
  const target = props.target;
  const threadLinks = useThreadLinks();
  const searchAvailable = Boolean(api?.getNavigationQueryPage);
  // A target without its own owner lives on the card's machine.
  const targetInstanceId = target?.instanceId ?? owner;
  const resolved = target && threadLinks?.resolve({ backend: target.backend, threadId: target.threadId,
    ...(targetInstanceId ? { instanceId: targetInstanceId } : {}) });
  // The card's recorded label names the machine until navigation knows it.
  const targetLink: ResolvedThreadLink | undefined = resolved && target?.instanceLabel && !resolved.instanceLabel
    && resolved.instanceId ? { ...resolved, instanceLabel: target.instanceLabel } : resolved;
  return (
    <div className="todo-message-destination">
      <div className="todo-message-destination__heading">
        <span>To</span>
        <span className="todo-message-destination__target">
          {target && targetLink && threadLinks ? (
            <ThreadChip fallbackLabel={target.title ?? target.threadId} link={targetLink}
              onOpen={(link) => threadLinks.show(link)} />
          ) : target ? target.title ?? target.threadId : "Choose an existing thread"}
          {target ? (
            <small>
              {formatBackendLabel(target.backend)} · {target.instanceLabel ?? target.instanceId ?? "Card's machine"}
              {threadLinks ? null : <> · {target.threadId}</>}
            </small>
          ) : null}
        </span>
        {target && searchAvailable ? (
          <button ref={changeRef} type="button" className="button thread-todo-card__button" disabled={props.disabled}
            onClick={() => {
              setFocusOnOpen(!editing);
              setEditing(!editing);
            }}>{editing ? "Cancel" : "Change"}</button>
        ) : null}
      </div>
      {editing && !searchAvailable ? <p>Thread search is unavailable in this window.</p> : null}
      {editing && api && searchAvailable ? (
        <TodoDestinationPicker
          todo={props.todo}
          localMachine={props.localMachine}
          disabled={props.disabled}
          api={api}
          threads={threadLinks?.readLoadedThreads?.() ?? NO_THREADS}
          focusOnOpen={focusOnOpen}
          {...(target ? { onCancel: () => setEditing(false), triggerRef: changeRef } : {})}
          onPick={(next) => {
            props.onSelect(next);
            setEditing(false);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The jump palette's search (⌘K) inside the card: results as you type, the
 * palette's rows, and peers below "Other instances". Focus stays in the field;
 * the arrows steer the active row, Enter picks it, and Escape cancels the
 * change through the dismissable-layer stack.
 */
function TodoDestinationPicker(props: {
  todo: ThreadTodo;
  localMachine?: ThreadTodoLocalMachine;
  disabled: boolean;
  api: ThreadJumpSearchApi;
  threads: readonly NavigationThreadSummary[];
  focusOnOpen: boolean;
  /** Absent while the card has no destination to go back to. */
  onCancel?: () => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  onPick: (target: ThreadTodoMessageTarget) => void;
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

  const localRows = useMemo(
    () => addressableTodoDestinations(search.results, props.todo, props.localMachine),
    [search.results, props.todo, props.localMachine],
  );
  const remoteRows = useMemo(
    () => addressableTodoDestinations(search.remoteRows, props.todo, props.localMachine),
    [search.remoteRows, props.todo, props.localMachine],
  );
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

  // Escape cancels the change, or clears a field there is no change to cancel.
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

  const choose = (row: TodoDestinationCandidate | undefined): void => {
    if (row && !props.disabled) props.onPick(row.target);
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
    <div ref={surfaceRef} className="todo-destination-picker">
      <div className="todo-destination-picker__field">
        <SearchIcon size={14} aria-hidden />
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Find destination thread"
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
          className="todo-destination-picker__results"
          role="listbox"
          aria-label="Destination threads"
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
        <p className="todo-destination-picker__empty">
          {unaddressable ? "No other addressable threads found." : "No threads match"}
        </p>
      ) : null}
      <div className="todo-destination-picker__foot">
        <span>↑↓ move</span>
        <span>↵ choose</span>
        <span>{props.onCancel ? "esc cancel" : "esc clear"}</span>
        <span className="todo-destination-picker__foot-spacer" />
        {status ? <span className="todo-destination-picker__status" title={status}>{status}</span> : null}
      </div>
    </div>
  );
}
