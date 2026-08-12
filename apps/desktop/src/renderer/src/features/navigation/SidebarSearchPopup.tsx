import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { SearchIcon } from "../../icons";
import {
  parsePrNumberQuery,
  threadMatchesQuery,
} from "../thread-search/thread-match";

const MAX_RESULTS = 8;

type SidebarSearchPopupProps = {
  threads: readonly NavigationThreadSummary[];
  onJumpToThread: (thread: NavigationThreadSummary) => void;
  onClose: () => void;
};

/**
 * Quick-jump palette (⌘K, or ⌘F while the sidebar is focused). Filters the
 * in-memory local thread set by title, Agent metadata, PR number, branch, and
 * linked directory; ↑/↓ move the active row, Enter (or click) jumps, and
 * Escape closes.
 *
 * It renders through a PORTAL onto `document.body`, and that is load-bearing
 * twice over. `.sidebar` declares `container: sidebar / inline-size`, and an
 * element with a `container-type` is a containing block for fixed-position
 * descendants — a scrim left inside the rail would size itself to the sidebar
 * rather than the window, and the rail's `overflow: hidden` would clip it.
 * The portal also survives `⌘B`, which hides the sidebar with `display: none`,
 * so the palette does not need the sidebar revealed underneath it.
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
      .filter(
        (thread) =>
          threadMatchesQuery(thread, trimmed)
          || agentMetadataMatchesQuery(thread, trimmed),
      )
      .sort(
        (left, right) =>
          Number(threadHasExactPrNumberMatch(right, trimmed))
          - Number(threadHasExactPrNumberMatch(left, trimmed)),
      )
      .slice(0, MAX_RESULTS);
  }, [trimmed, props.threads]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    setActiveIndex((index) =>
      results.length === 0 ? 0 : Math.min(index, results.length - 1),
    );
  }, [results.length]);

  // Keyboard steering is the point of this surface, so the active row has to
  // stay on screen once the list scrolls past its own height.
  useEffect(() => {
    const row = listRef.current?.querySelector(".jump-palette__row.is-active");
    // jsdom has no layout and so no scrollIntoView; guard the same way the
    // selected-thread reveal does.
    if (typeof row?.scrollIntoView !== "function") {
      return;
    }
    row.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results.length]);

  const jump = (thread: NavigationThreadSummary): void => {
    props.onJumpToThread(thread);
    props.onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    // The palette is modal: the only tab stop inside it is the field (rows are
    // driven by aria-activedescendant), so Tab must not walk into the dimmed app.
    if (event.key === "Tab") {
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) =>
        results.length === 0 ? 0 : Math.min(index + 1, results.length - 1),
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const thread = results[activeIndex];
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
    return (
      <li
        key={buildThreadIdentityKey(thread.source, thread.id)}
        id={rowId(index)}
        role="option"
        aria-selected={index === activeIndex}
      >
        <button
          type="button"
          className={`jump-palette__row${
            index === activeIndex ? " is-active" : ""
          }`}
          // Focus stays in the field so typing never breaks; the active row is
          // published to assistive technology through aria-activedescendant.
          tabIndex={-1}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => jump(thread)}
        >
          <span className="jump-palette__row-title">{thread.title}</span>
          {thread.agent ? (
            <span
              className="jump-palette__row-agent"
              aria-label="Agent thread"
            >
              Agent
            </span>
          ) : null}
          {description.pr ? (
            <span className="jump-palette__row-pr">{description.pr}</span>
          ) : null}
          {description.branch ? (
            // Clipped from the LEFT (`direction: rtl` in CSS) so a long
            // `agent/…` prefix gives way and the disambiguating leaf survives.
            <span className="jump-palette__row-branch">
              {description.branch}
            </span>
          ) : null}
          {description.directory ? (
            <span className="jump-palette__row-repo">
              {description.directory}
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  const showEmpty = Boolean(trimmed) && results.length === 0;
  // The listbox is only in the DOM once it has rows, so `aria-controls` has to
  // come and go with it instead of leaving behind a dangling id reference.
  const listVisible = Boolean(trimmed) && results.length > 0;

  return createPortal(
    <div
      className="jump-palette"
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        // Scrim press only. A drag that starts inside the panel and releases
        // outside it must not count as a dismissal.
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
        // Keep keyboard handling on the dialog: pressing non-input chrome can
        // otherwise leave Escape, arrows, and Enter in a dead state.
        onKeyDown={handleKeyDown}
        // Suppress focus movement everywhere except the input itself. Click
        // still fires, so result rows remain directly clickable.
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
          </ul>
        ) : showEmpty ? (
          <p className="jump-palette__empty">No threads match</p>
        ) : null}
        <div className="jump-palette__foot">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
          <span className="jump-palette__foot-spacer" />
          {trimmed ? (
            <span className="jump-palette__foot-count">
              {results.length}
              {results.length === 1 ? " result" : " results"}
            </span>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function threadHasExactPrNumberMatch(
  thread: NavigationThreadSummary,
  query: string,
): boolean {
  const prNumber = parsePrNumberQuery(query);
  return (
    prNumber !== null
    && (thread.prs ?? []).some((candidate) => candidate.number === prNumber)
  );
}

function agentMetadataMatchesQuery(
  thread: NavigationThreadSummary,
  query: string,
): boolean {
  if (!thread.agent) {
    return false;
  }
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const haystack = [
    "agent",
    "agent thread",
    thread.agent.name,
    thread.agent.instructions,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

type ThreadDescription = {
  pr?: string;
  branch?: string;
  directory?: string;
};

function describeThread(
  thread: NavigationThreadSummary,
  query: string,
): ThreadDescription {
  const description: ThreadDescription = {};
  const exactPrNumber = parsePrNumberQuery(query);
  const exactPr = exactPrNumber !== null
    ? (thread.prs ?? []).find((candidate) => candidate.number === exactPrNumber)
    : undefined;
  const pr = exactPr ?? (thread.prs ?? [])[0];
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
