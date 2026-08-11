import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import {
  buildThreadIdentityKey,
  federatedThreadIdentityKey,
  threadHasExactPrNumberMatch,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { SearchIcon } from "../../icons";
import { getDesktopApi } from "../../lib/desktop-api";
import {
  FEDERATED_THREAD_SEARCH_LIMIT,
  useFederatedThreadSearch,
} from "../../lib/useFederatedThreadSearch";
import { threadMatchesQuery } from "../thread-search/thread-match";
import { AgentThreadChip } from "./AgentThreadChip";
import { InstanceChip } from "../federation/InstanceGlyph";

const MAX_RESULTS = 8;

type SidebarSearchPopupProps = {
  threads: readonly NavigationThreadSummary[];
  onJumpToThread: (thread: NavigationThreadSummary) => void;
  /**
   * Selecting a result owned by another instance. Falls back to
   * `onJumpToThread` when not provided.
   */
  onJumpToRemoteThread?: (thread: NavigationThreadSummary) => void;
  onClose: () => void;
};

/**
 * Quick-jump palette (⌘K, or ⌘F while the sidebar is focused). Local threads
 * filter instantly from the in-memory thread set by title, PR number, branch,
 * and linked directory; connected federation peers are queried asynchronously
 * (debounced) and append below the local hits with an instance chip. ↑/↓ move
 * the active row across both sections, Enter (or click) jumps, Escape closes.
 *
 * It renders through a PORTAL onto `document.body`, and that is load-bearing
 * twice over. `.sidebar` declares `container: sidebar / inline-size`, and an
 * element with a `container-type` is a containing block for fixed-position
 * descendants — a scrim left inside the rail would size itself to the ~300px
 * sidebar rather than the window, and the rail's `overflow: hidden` would clip
 * it besides. The portal also survives `⌘B`, which hides the sidebar with
 * `display: none` while leaving this component mounted, so the palette no
 * longer needs the sidebar revealed underneath it to be visible at all.
 */
export function SidebarSearchPopup(props: SidebarSearchPopupProps): ReactElement {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const idPrefix = useId();
  const listId = `${idPrefix}-results`;
  const rowId = (index: number): string => `${idPrefix}-row-${index}`;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = query.trim();

  const results = useMemo(() => {
    if (!trimmed) {
      return [];
    }
    return props.threads
      .filter((thread) => threadMatchesQuery(thread, trimmed))
      .sort(
        (left, right) =>
          Number(threadHasExactPrNumberMatch(right, trimmed))
          - Number(threadHasExactPrNumberMatch(left, trimmed)),
      )
      .slice(0, MAX_RESULTS);
  }, [trimmed, props.threads]);

  const {
    available: remoteSearchAvailable,
    loading: remoteLoading,
    results: remoteResults,
  } = useFederatedThreadSearch({
    query: trimmed,
    limit: FEDERATED_THREAD_SEARCH_LIMIT,
    search: getDesktopApi()?.jumpSearchRemoteThreads,
  });

  // A remote thread already pinned into the local list surfaces as a local
  // hit; don't show it twice.
  const remoteRows = useMemo(() => {
    const localKeys = new Set(
      props.threads.map((thread) =>
        buildThreadIdentityKey(thread.source, thread.id),
      ),
    );
    return remoteResults.filter(
      (thread) => !localKeys.has(buildThreadIdentityKey(thread.source, thread.id)),
    );
  }, [remoteResults, props.threads]);

  const combinedRows = useMemo(
    () => [...results, ...remoteRows],
    [results, remoteRows],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    setActiveIndex((index) =>
      combinedRows.length === 0
        ? 0
        : Math.min(index, combinedRows.length - 1),
    );
  }, [combinedRows.length]);

  // Keyboard steering is the point of this surface, so the active row has to
  // stay on screen once the list scrolls past its own height.
  useEffect(() => {
    const row = listRef.current?.querySelector(".jump-palette__row.is-active");
    // jsdom has no layout and so no scrollIntoView; guard the same way
    // ThreadRow's reveal effect does.
    if (typeof row?.scrollIntoView !== "function") {
      return;
    }
    row.scrollIntoView({ block: "nearest" });
  }, [activeIndex, combinedRows.length]);

  const jump = (thread: NavigationThreadSummary): void => {
    const remote = Boolean(thread.federation);
    if (remote && props.onJumpToRemoteThread) {
      props.onJumpToRemoteThread(thread);
    } else {
      props.onJumpToThread(thread);
    }
    props.onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    // The palette is modal: the only tab stop inside it is this field (rows are
    // driven by aria-activedescendant, not focus), so Tab must not walk out
    // into the dimmed app behind the scrim.
    if (event.key === "Tab") {
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, combinedRows.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const thread = combinedRows[activeIndex];
      if (thread) {
        jump(thread);
      }
    }
  };

  const renderRow = (
    thread: NavigationThreadSummary,
    index: number,
  ): ReactElement => {
    const description = describeThread(thread, trimmed);
    const key = thread.federation
      ? federatedThreadIdentityKey(thread.federation.ref)
      : buildThreadIdentityKey(thread.source, thread.id);
    return (
      <li
        key={key}
        id={rowId(index)}
        role="option"
        aria-selected={index === activeIndex}
      >
        <button
          type="button"
          className={`jump-palette__row${
            index === activeIndex ? " is-active" : ""
          }`}
          // Not a tab stop: focus stays in the field so typing never breaks,
          // and the active row is published via aria-activedescendant.
          tabIndex={-1}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => jump(thread)}
        >
          <span className="jump-palette__row-title">{thread.title}</span>
          {thread.federation ? (
            <InstanceChip
              icon={thread.federation.celestialIcon}
              instanceId={
                thread.federation.ref.target.scope === "remote"
                  ? thread.federation.ref.target.instanceId
                  : ""
              }
              label={thread.federation.instanceLabel}
            />
          ) : null}
          {thread.agent ? <AgentThreadChip /> : null}
          {description.pr ? (
            <span className="jump-palette__row-pr">{description.pr}</span>
          ) : null}
          {description.branch ? (
            // Clipped from the LEFT (`direction: rtl` in CSS) so a long
            // `agent/…` prefix gives way and the disambiguating leaf survives.
            <span className="jump-palette__row-branch">{description.branch}</span>
          ) : null}
          {description.directory ? (
            <span className="jump-palette__row-repo">{description.directory}</span>
          ) : null}
        </button>
      </li>
    );
  };

  // The divider only earns its place once there are rows under it. In-flight
  // peer latency is the footer's job now, so a loading state no longer leaves
  // a section header standing over nothing.
  const showRemoteSection =
    trimmed && remoteSearchAvailable && remoteRows.length > 0;
  const showEmpty =
    trimmed && results.length === 0 && remoteRows.length === 0 && !remoteLoading;
  // The listbox is only in the DOM once it has rows, so `aria-controls` has to
  // come and go with it — a dangling idref is an invalid attribute value, not
  // a harmless one.
  const listVisible = Boolean(trimmed) && (results.length > 0 || showRemoteSection);

  return createPortal(
    <div
      className="jump-palette"
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        // Scrim press only. A drag that starts inside the panel and releases
        // out here must not count as a dismissal.
        if (event.target === event.currentTarget) {
          props.onClose();
        }
      }}
    >
      <div
        className="jump-palette__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Jump to thread"
      >
        <div className="jump-palette__field">
          <span className="jump-palette__icon" aria-hidden>
            <SearchIcon size={16} />
          </span>
          <input
            ref={inputRef}
            className="jump-palette__input"
            aria-label="Jump to thread"
            aria-controls={listVisible ? listId : undefined}
            aria-activedescendant={
              listVisible ? rowId(activeIndex) : undefined
            }
            autoComplete="off"
            spellCheck={false}
            placeholder="Jump to thread, PR #, branch, repo…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <span className="jump-palette__esc" aria-hidden>
            esc
          </span>
        </div>
        {listVisible ? (
          <ul
            className="jump-palette__results"
            id={listId}
            ref={listRef}
            role="listbox"
            aria-label="Threads"
          >
            {results.map((thread, index) => renderRow(thread, index))}
            {showRemoteSection ? (
              <li
                aria-hidden="true"
                className="jump-palette__section-divider"
                role="presentation"
              >
                Other instances
              </li>
            ) : null}
            {remoteRows.map((thread, index) =>
              renderRow(thread, results.length + index),
            )}
          </ul>
        ) : showEmpty ? (
          <p className="jump-palette__empty">No threads match</p>
        ) : null}
        <div className="jump-palette__foot">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
          <span className="jump-palette__foot-spacer" />
          {/* Peer latency lives in the footer rather than as a list row: a
              status line that grows and vanishes between keystrokes would push
              results under the operator's cursor mid-selection. */}
          {remoteLoading ? (
            <span className="jump-palette__foot-remote">
              Searching other instances…
            </span>
          ) : null}
          {trimmed ? (
            <span className="jump-palette__foot-count">
              {combinedRows.length}
              {combinedRows.length === 1 ? " result" : " results"}
            </span>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

type ThreadDescription = {
  /** Rendered with its `#`, e.g. `#1483`. */
  pr?: string;
  branch?: string;
  directory?: string;
};

function describeThread(
  thread: NavigationThreadSummary,
  query: string,
): ThreadDescription {
  const description: ThreadDescription = {};
  const pr = threadHasExactPrNumberMatch(thread, query)
    ? (thread.prs ?? []).find(
        (candidate) =>
          candidate.number === Number(query.trim().replace(/^#/, "")),
      )
    : (thread.prs ?? [])[0];
  if (pr) {
    description.pr = `#${pr.number}`;
  }
  if (thread.gitBranch) {
    description.branch = thread.gitBranch;
  }
  const directory = (thread.linkedDirectories ?? [])[0];
  if (directory?.label) {
    description.directory = directory.label;
  }
  return description;
}
