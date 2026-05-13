import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { AppLogSnapshot } from "../../../../shared/app-metadata";
import { useDesktopApi } from "../../lib/desktop-api";

const POLL_INTERVAL_MS = 1000;
const BOTTOM_THRESHOLD_PX = 32;

type LogLinePart = {
  text: string;
  matchIndex?: number;
};

type RenderedLogLine = {
  lineNumber: number;
  parts: LogLinePart[];
};

export function LogsWindow() {
  const desktopApi = useDesktopApi();
  const logViewportRef = useRef<HTMLDivElement | null>(null);
  const activeMatchRef = useRef<HTMLElement | null>(null);
  const [snapshot, setSnapshot] = useState<AppLogSnapshot | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    document.title = "Logs";
  }, []);

  const loadSnapshot = useCallback(async () => {
    const reader = desktopApi?.readAppLogSnapshot;
    if (!reader) {
      return;
    }

    setLoading(true);
    try {
      const value = await reader();
      setSnapshot(value);
      setError(undefined);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [desktopApi]);

  useEffect(() => {
    void loadSnapshot();
    const interval = window.setInterval(() => {
      void loadSnapshot();
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [loadSnapshot]);

  useEffect(() => {
    if (!following) {
      return;
    }
    const element = logViewportRef.current;
    if (!element) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [following, snapshot?.content]);

  const rendered = useMemo(() => {
    return buildRenderedLogLines(snapshot?.content ?? "", query);
  }, [query, snapshot?.content]);

  useEffect(() => {
    setActiveMatchIndex(0);
  }, [query]);

  useEffect(() => {
    if (activeMatchIndex >= rendered.matchCount) {
      setActiveMatchIndex(Math.max(0, rendered.matchCount - 1));
    }
  }, [activeMatchIndex, rendered.matchCount]);

  useEffect(() => {
    activeMatchRef.current?.scrollIntoView({
      block: "center",
      inline: "nearest",
    });
  }, [activeMatchIndex]);

  const copyPath = useCallback(() => {
    if (!snapshot?.path) {
      return;
    }
    void desktopApi?.copyText?.(snapshot.path);
  }, [desktopApi, snapshot?.path]);

  const jumpToEnd = useCallback(() => {
    setFollowing(true);
    const element = logViewportRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, []);

  const handleScroll = useCallback(() => {
    const element = logViewportRef.current;
    if (!element) {
      return;
    }
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    setFollowing(distanceFromBottom <= BOTTOM_THRESHOLD_PX);
  }, []);

  const goToMatch = useCallback(
    (direction: -1 | 1) => {
      if (rendered.matchCount === 0) {
        return;
      }
      setFollowing(false);
      setActiveMatchIndex(
        (current) =>
          (current + direction + rendered.matchCount) % rendered.matchCount,
      );
    },
    [rendered.matchCount],
  );

  const handleSearchChange = useCallback((value: string) => {
    setQuery(value);
    if (value.trim()) {
      setFollowing(false);
    }
  }, []);

  const activeMatchLabel =
    rendered.matchCount > 0 ? `${activeMatchIndex + 1} / ${rendered.matchCount}` : "0";

  return (
    <div className="document-window document-window--logs">
      <section aria-label="PwrAgent logs" className="activity-screen">
        <header className="activity-titlebar">
          <p className="activity-titlebar__brand">
            Pwr<span className="activity-titlebar__brand-accent">Agent</span>
          </p>
          <div className="activity-titlebar__breadcrumb">
            <span className="activity-titlebar__eyebrow">Help</span>
            <span aria-hidden="true" className="activity-titlebar__separator">
              ›
            </span>
            <span className="activity-titlebar__current">Logs</span>
          </div>
          <div className="activity-titlebar__spacer" />
        </header>

        <main className="log-window__content">
          <div className="log-window__toolbar" aria-label="Log controls">
            <label className="log-window__search">
              <span className="log-window__search-label">Search</span>
              <input
                aria-label="Search logs"
                value={query}
                onChange={(event) => handleSearchChange(event.target.value)}
                placeholder="Find in logs"
                spellCheck={false}
              />
            </label>
            <span className="log-window__match-count" aria-live="polite">
              {activeMatchLabel}
            </span>
            <button
              className="log-window__button"
              disabled={rendered.matchCount === 0}
              type="button"
              onClick={() => goToMatch(-1)}
            >
              Prev
            </button>
            <button
              className="log-window__button"
              disabled={rendered.matchCount === 0}
              type="button"
              onClick={() => goToMatch(1)}
            >
              Next
            </button>
            <button
              aria-pressed={following}
              className="log-window__button"
              type="button"
              onClick={jumpToEnd}
            >
              Follow
            </button>
            <button
              className="log-window__button"
              disabled={loading || !desktopApi?.readAppLogSnapshot}
              type="button"
              onClick={() => void loadSnapshot()}
            >
              Refresh
            </button>
          </div>

          <div className="log-window__status">
            <span className="log-window__status-text">
              {snapshot?.path ?? snapshot?.unavailableReason ?? "Log file pending"}
            </span>
            {snapshot?.path ? (
              <button
                className="log-window__link-button"
                type="button"
                onClick={copyPath}
              >
                Copy path
              </button>
            ) : null}
            {snapshot?.truncated ? (
              <span className="log-window__status-note">Showing tail</span>
            ) : null}
          </div>

          {error ? (
            <p className="document-window__error" role="alert">
              Could not load logs: {error}
            </p>
          ) : null}

          <div
            ref={logViewportRef}
            className="log-window__viewport"
            onScroll={handleScroll}
          >
            {snapshot?.unavailableReason ? (
              <p className="document-window__empty">{snapshot.unavailableReason}</p>
            ) : rendered.lines.length > 0 ? (
              <pre className="log-window__lines" aria-label="Log output">
                {rendered.lines.map((line) => (
                  <LogLine
                    key={line.lineNumber}
                    activeMatchIndex={activeMatchIndex}
                    line={line}
                    activeMatchRef={activeMatchRef}
                  />
                ))}
              </pre>
            ) : (
              <p className="document-window__empty">
                {loading ? "Loading..." : "No log output yet."}
              </p>
            )}
          </div>
        </main>
      </section>
    </div>
  );
}

function LogLine(props: {
  activeMatchIndex: number;
  activeMatchRef: MutableRefObject<HTMLElement | null>;
  line: RenderedLogLine;
}) {
  return (
    <span className="log-window__line">
      <span className="log-window__line-number">{props.line.lineNumber}</span>
      <span className="log-window__line-text">
        {props.line.parts.map((part, index) =>
          renderLogLinePart({
            activeMatchIndex: props.activeMatchIndex,
            activeMatchRef: props.activeMatchRef,
            key: `${props.line.lineNumber}-${index}`,
            part,
          }),
        )}
      </span>
      {"\n"}
    </span>
  );
}

function renderLogLinePart(params: {
  activeMatchIndex: number;
  activeMatchRef: MutableRefObject<HTMLElement | null>;
  key: string;
  part: LogLinePart;
}): ReactNode {
  if (params.part.matchIndex === undefined) {
    return <span key={params.key}>{params.part.text}</span>;
  }

  const active = params.part.matchIndex === params.activeMatchIndex;
  return (
    <mark
      key={params.key}
      ref={active ? params.activeMatchRef : undefined}
      className={active ? "log-window__match log-window__match--active" : "log-window__match"}
    >
      {params.part.text}
    </mark>
  );
}

export function buildRenderedLogLines(
  content: string,
  query: string,
): { lines: RenderedLogLine[]; matchCount: number } {
  const normalizedQuery = query.trim().toLowerCase();
  let matchCount = 0;
  const sourceLines = content.length > 0 ? content.split(/\r?\n/) : [];
  const lines = sourceLines.map((line, index) => {
    const parts = normalizedQuery
      ? splitLineMatches(line, normalizedQuery, matchCount)
      : [{ text: line }];
    matchCount += parts.filter((part) => part.matchIndex !== undefined).length;
    return {
      lineNumber: index + 1,
      parts,
    };
  });

  return { lines, matchCount };
}

function splitLineMatches(
  line: string,
  normalizedQuery: string,
  startMatchIndex: number,
): LogLinePart[] {
  const lowerLine = line.toLowerCase();
  const parts: LogLinePart[] = [];
  let cursor = 0;
  let matchIndex = startMatchIndex;

  while (cursor < line.length) {
    const foundAt = lowerLine.indexOf(normalizedQuery, cursor);
    if (foundAt === -1) {
      parts.push({ text: line.slice(cursor) });
      break;
    }
    if (foundAt > cursor) {
      parts.push({ text: line.slice(cursor, foundAt) });
    }
    const end = foundAt + normalizedQuery.length;
    parts.push({
      text: line.slice(foundAt, end),
      matchIndex,
    });
    matchIndex += 1;
    cursor = end;
  }

  return parts.length > 0 ? parts : [{ text: line }];
}
