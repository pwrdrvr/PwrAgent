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
  federatedThreadIdentityKey,
  threadHasExactPrNumberMatch,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { SearchIcon } from "../../icons";
import { getDesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { threadMatchesQuery } from "../thread-search/thread-match";
import { AgentThreadChip } from "./AgentThreadChip";
import { InstanceChip } from "../federation/InstanceGlyph";

const MAX_RESULTS = 8;
const MAX_REMOTE_RESULTS = 8;
/** Remote querying waits for a typing pause; local filtering never does. */
const REMOTE_SEARCH_DEBOUNCE_MS = 200;

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
 * Quick-jump popup over the thread list (⌘K, or ⌘F while the sidebar is
 * focused). Local threads filter instantly from the in-memory thread set by
 * title, PR number, branch, and linked directory; connected federation peers
 * are queried asynchronously (debounced) and append below the local hits
 * with an instance chip. ↑/↓ move the active row across both sections,
 * Enter (or click) jumps, Escape closes.
 */
export function SidebarSearchPopup(props: SidebarSearchPopupProps): ReactElement {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [remoteResults, setRemoteResults] = useState<NavigationThreadSummary[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const remoteGenerationRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

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

  // A remote-viewer window already scopes to one peer; only the main window
  // fans ⌘K out across the federation.
  const remoteSearchAvailable =
    !readRendererFederationTarget()
    && typeof getDesktopApi()?.jumpSearchRemoteThreads === "function";

  useEffect(() => {
    const generation = remoteGenerationRef.current + 1;
    remoteGenerationRef.current = generation;
    if (!trimmed || !remoteSearchAvailable) {
      setRemoteResults([]);
      setRemoteLoading(false);
      return;
    }
    setRemoteLoading(true);
    const timer = setTimeout(() => {
      getDesktopApi()
        ?.jumpSearchRemoteThreads?.({ query: trimmed, limit: MAX_REMOTE_RESULTS })
        .then((response) => {
          if (remoteGenerationRef.current !== generation) {
            return;
          }
          setRemoteResults(response.results);
          setRemoteLoading(false);
        })
        .catch(() => {
          if (remoteGenerationRef.current !== generation) {
            return;
          }
          setRemoteResults([]);
          setRemoteLoading(false);
        });
    }, REMOTE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed, remoteSearchAvailable]);

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
      <li key={key} role="option" aria-selected={index === activeIndex}>
        <button
          type="button"
          className={`sidebar-search__result${
            index === activeIndex ? " is-active" : ""
          }`}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => jump(thread)}
        >
          <span className="sidebar-search__result-title">{thread.title}</span>
          {thread.agent || description || thread.federation ? (
            <span className="sidebar-search__result-meta">
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
              {description ? <span>{description}</span> : null}
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  const showRemoteSection =
    trimmed && remoteSearchAvailable && (remoteLoading || remoteRows.length > 0);
  const showEmpty =
    trimmed && results.length === 0 && remoteRows.length === 0 && !remoteLoading;

  return (
    <div className="sidebar-search" ref={rootRef} role="dialog" aria-label="Jump to thread">
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
      {trimmed && (results.length > 0 || showRemoteSection) ? (
        <ul className="sidebar-search__results" role="listbox">
          {results.map((thread, index) => renderRow(thread, index))}
          {showRemoteSection ? (
            <li
              aria-hidden="true"
              className="sidebar-search__section-divider"
              role="presentation"
            >
              Other instances
            </li>
          ) : null}
          {remoteRows.map((thread, index) =>
            renderRow(thread, results.length + index),
          )}
          {remoteLoading && remoteRows.length === 0 ? (
            <li
              aria-hidden="true"
              className="sidebar-search__loading"
              role="presentation"
            >
              Searching other instances…
            </li>
          ) : null}
        </ul>
      ) : showEmpty ? (
        <p className="sidebar-search__empty">No threads match</p>
      ) : null}
    </div>
  );
}

function describeThread(
  thread: NavigationThreadSummary,
  query: string,
): string {
  const parts: string[] = [];
  const pr = threadHasExactPrNumberMatch(thread, query)
    ? (thread.prs ?? []).find(
        (candidate) =>
          candidate.number === Number(query.trim().replace(/^#/, "")),
      )
    : (thread.prs ?? [])[0];
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
