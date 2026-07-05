import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { SearchIcon } from "../../icons";
import { threadMatchesQuery } from "../thread-search/thread-match";

const MAX_RESULTS = 8;

type SidebarSearchPopupProps = {
  threads: readonly NavigationThreadSummary[];
  onJumpToThread: (thread: NavigationThreadSummary) => void;
  onClose: () => void;
};

/**
 * Quick-jump popup over the thread list (⌘F while the sidebar is focused).
 * Filters the in-memory thread set by title, PR number, branch, and linked
 * directory; ↑/↓ move the active row, Enter (or click) jumps, Escape closes.
 */
export function SidebarSearchPopup(
  props: SidebarSearchPopupProps,
): ReactElement {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    return props.threads
      .filter((thread) => threadMatchesQuery(thread, trimmed))
      .slice(0, MAX_RESULTS);
  }, [query, props.threads]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Dismiss when focus or a click lands outside the popup.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        props.onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [props]);

  const jump = (thread: NavigationThreadSummary): void => {
    props.onJumpToThread(thread);
    props.onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, results.length - 1));
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

  const trimmed = query.trim();
  return (
    <div
      className="sidebar-search"
      ref={rootRef}
      role="dialog"
      aria-label="Jump to thread"
    >
      <div className="sidebar-search__field">
        <span className="sidebar-search__icon" aria-hidden>
          <SearchIcon size={14} />
        </span>
        <input
          ref={inputRef}
          className="sidebar-search__input"
          aria-label="Jump to thread"
          placeholder="Jump to thread, PR #, branch…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      {trimmed ? (
        results.length > 0 ? (
          <ul className="sidebar-search__results" role="listbox">
            {results.map((thread, index) => (
              <li
                key={buildThreadIdentityKey(thread.source, thread.id)}
                role="option"
                aria-selected={index === activeIndex}
              >
                <button
                  type="button"
                  className={`sidebar-search__result${
                    index === activeIndex ? " is-active" : ""
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => jump(thread)}
                >
                  <span className="sidebar-search__result-title">
                    {thread.title}
                  </span>
                  {describeThread(thread) ? (
                    <span className="sidebar-search__result-meta">
                      {describeThread(thread)}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sidebar-search__empty">No threads match</p>
        )
      ) : null}
    </div>
  );
}

function describeThread(thread: NavigationThreadSummary): string {
  const parts: string[] = [];
  const pr = (thread.prs ?? [])[0];
  if (pr) {
    parts.push(`#${pr.number}`);
  }
  if (thread.gitBranch) {
    parts.push(thread.gitBranch);
  }
  const directory = (thread.linkedDirectories ?? [])[0];
  if (directory?.label) {
    parts.push(directory.label);
  }
  return parts.join(" · ");
}
