import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  threadHasExactPrNumberMatch,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { SearchIcon } from "../../icons";
import { getDesktopApi } from "../../lib/desktop-api";
import { useNavigationOwnerSearch } from "../../lib/useNavigationOwnerSearch";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import {
  FEDERATED_THREAD_SEARCH_LIMIT,
  useFederatedThreadSearch,
} from "../../lib/useFederatedThreadSearch";
import { threadMatchesQuery } from "../thread-search/thread-match";
import { AgentThreadChip } from "./AgentThreadChip";
import { InstanceChip } from "../federation/InstanceGlyph";
import { PrChip } from "../pr-status/PrChip";

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
  /**
   * What picking a result does here, for the dialog's accessible name and
   * the field's own label. The Star Map opens the same palette to fly its
   * camera to a card rather than to scroll a list, and "Jump to thread"
   * would describe an action that surface does not have.
   */
  label?: string;
  placeholder?: string;
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
  const label = props.label ?? "Jump to thread";
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
  const ownerSearch = useNavigationOwnerSearch({ query: trimmed, desktopApi: getDesktopApi() });

  const results = useMemo(() => {
    if (!trimmed) {
      return [];
    }
    const immediate = props.threads
      .filter((thread) => threadMatchesQuery(thread, trimmed))
      .sort(
        (left, right) =>
          Number(threadHasExactPrNumberMatch(right, trimmed))
          - Number(threadHasExactPrNumberMatch(left, trimmed)),
      )
      .slice(0, MAX_RESULTS);
    const ownerKeys = new Set(ownerSearch.rows.map(threadSummaryIdentityKey));
    return [...ownerSearch.rows, ...immediate.filter((thread) => !ownerKeys.has(threadSummaryIdentityKey(thread)))].slice(0, MAX_RESULTS);
  }, [trimmed, props.threads, ownerSearch.rows]);

  const {
    available: remoteSearchAvailable,
    completedPeerCount: remoteCompletedPeerCount,
    loading: remoteLoading,
    notes: remoteNotes,
    results: remoteResults,
    totalPeerCount: remoteTotalPeerCount,
  } = useFederatedThreadSearch({
    query: trimmed,
    limit: FEDERATED_THREAD_SEARCH_LIMIT,
    search: getDesktopApi()?.jumpSearchRemoteThreads,
  });

  // A remote thread already pinned into the local list surfaces as a local
  // hit; don't show it twice.
  const remoteRows = useMemo(() => {
    const localKeys = new Set(
      results.map((thread) =>
        threadSummaryIdentityKey(thread),
      ),
    );
    return remoteResults.filter(
      (thread) => !localKeys.has(threadSummaryIdentityKey(thread)),
    );
  }, [remoteResults, results]);

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

  const openPullRequest = (url: string): void => {
    window.open(url, "_blank", "noopener,noreferrer");
    props.onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const target = event.target instanceof HTMLElement
        ? event.target
        : undefined;
      const targetRow = target?.closest<HTMLElement>('[role="option"]');
      const activeRow = listRef.current?.querySelector<HTMLElement>(
        '[role="option"][aria-selected="true"]',
      );
      const row = targetRow ?? activeRow;
      const chips = Array.from(
        row?.querySelectorAll<HTMLElement>("[data-pr-chip]") ?? [],
      );

      // The field owns listbox steering through aria-activedescendant. Tab
      // temporarily enters the active row's PR actions; once the row's chips
      // are exhausted, focus returns to the field instead of escaping the
      // modal into the dimmed app.
      if (target === inputRef.current) {
        const chip = event.shiftKey ? chips.at(-1) : chips[0];
        (chip ?? inputRef.current)?.focus();
        return;
      }

      const chipIndex = target ? chips.indexOf(target) : -1;
      const nextIndex = chipIndex + (event.shiftKey ? -1 : 1);
      const nextChip = chipIndex >= 0 ? chips[nextIndex] : undefined;
      (nextChip ?? inputRef.current)?.focus();
      return;
    }
    // Arrow and Enter steer the aria-activedescendant list only while the
    // field owns focus. A focused PR chip handles its own activation keys.
    if (
      event.target !== inputRef.current
      && document.activeElement !== inputRef.current
    ) {
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
    const description = describeThread(thread);
    const prs = orderPullRequestsForQuery(thread, trimmed);
    const exactPrQuery = threadHasExactPrNumberMatch(thread, trimmed)
      ? String(Number(trimmed.replace(/^#/, "")))
      : "";
    const prStripResetKey = `${exactPrQuery}|${prs
      .map((pr) => pr.url)
      .join("|")}`;
    const key = threadSummaryIdentityKey(thread);
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
          {prs.length > 0 ? (
            <PullRequestStrip
              prs={prs}
              resetKey={prStripResetKey}
              onOpen={openPullRequest}
            />
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
    Boolean(trimmed) && remoteSearchAvailable && remoteRows.length > 0;
  const showEmpty =
    Boolean(trimmed)
    && results.length === 0
    && remoteRows.length === 0
    && !remoteLoading;
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
        aria-label={label}
        // Bound on the panel, not the field: pressing any non-focusable chrome
        // in here (the footer legend, the padding around the input) moves focus
        // to <body> in Chromium, and a handler on the input alone would leave
        // the palette in a dead state where Escape, ↑↓, and typing all do
        // nothing. Keydown bubbles from the field either way.
        onKeyDown={handleKeyDown}
        // And keep the caret there in the first place. Suppressing the default
        // focus move on every press but the field's own costs nothing — click
        // still fires, so rows activate normally — and means no press inside
        // the palette can strand the keyboard.
        onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
          if (event.target === inputRef.current) {
            return;
          }
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <div className="jump-palette__field">
          <span className="jump-palette__icon" aria-hidden>
            <SearchIcon size={16} />
          </span>
          <input
            ref={inputRef}
            className="jump-palette__input"
            aria-label={label}
            aria-controls={listVisible ? listId : undefined}
            aria-activedescendant={
              listVisible ? rowId(activeIndex) : undefined
            }
            autoComplete="off"
            spellCheck={false}
            placeholder={props.placeholder ?? `${label}, PR #, branch, repo…`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
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
          {ownerSearch.error ? <span className="jump-palette__foot-remote" title={ownerSearch.error} role="status">
            {ownerSearch.error}
          </span> : null}
          {remoteLoading || ownerSearch.loading ? (
            <span className="jump-palette__foot-remote">
              {remoteLoading ? "Searching other instances…" : "Searching threads…"}
              {remoteTotalPeerCount > 0
                ? ` ${remoteCompletedPeerCount}/${remoteTotalPeerCount}`
                : ""}
            </span>
          ) : remoteNotes.length ? (
            <span className="jump-palette__foot-remote" title={remoteNotes.join("\n")} role="status">
              Some instances could not be searched
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
  branch?: string;
  directory?: string;
};

function PullRequestStrip(props: {
  prs: NonNullable<NavigationThreadSummary["prs"]>;
  resetKey: string;
  onOpen: (url: string) => void;
}): ReactElement {
  const stripRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (stripRef.current) {
      stripRef.current.scrollLeft = 0;
    }
  }, [props.resetKey]);

  return (
    <span
      ref={stripRef}
      className="jump-palette__row-prs"
      data-overflow={props.prs.length > 2 ? "true" : undefined}
      aria-label="Pull requests"
      onWheel={scrollPullRequestsHorizontally}
    >
      {props.prs.map((pr) => (
        <PrChip
          key={pr.url}
          pr={pr}
          showRepoPrefix={false}
          onOpen={props.onOpen}
        />
      ))}
    </span>
  );
}

function orderPullRequestsForQuery(
  thread: NavigationThreadSummary,
  query: string,
): NonNullable<NavigationThreadSummary["prs"]> {
  const prs = thread.prs ?? [];
  if (!threadHasExactPrNumberMatch(thread, query)) {
    return prs;
  }
  const number = Number(query.trim().replace(/^#/, ""));
  return [
    ...prs.filter((pr) => pr.number === number),
    ...prs.filter((pr) => pr.number !== number),
  ];
}

function scrollPullRequestsHorizontally(
  event: ReactWheelEvent<HTMLSpanElement>,
): void {
  const strip = event.currentTarget;
  const delta = event.deltaX || event.deltaY;
  if (delta === 0 || strip.scrollWidth <= strip.clientWidth) {
    return;
  }
  const maxScrollLeft = strip.scrollWidth - strip.clientWidth;
  const nextScrollLeft = Math.max(
    0,
    Math.min(maxScrollLeft, strip.scrollLeft + delta),
  );
  if (nextScrollLeft === strip.scrollLeft) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  strip.scrollLeft = nextScrollLeft;
}

function describeThread(
  thread: NavigationThreadSummary,
): ThreadDescription {
  const description: ThreadDescription = {};
  if (thread.gitBranch) {
    description.branch = thread.gitBranch;
  }
  const directory = (thread.linkedDirectories ?? [])[0];
  if (directory?.label) {
    description.directory = directory.label;
  }
  return description;
}
