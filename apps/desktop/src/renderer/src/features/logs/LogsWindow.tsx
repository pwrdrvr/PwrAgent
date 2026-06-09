import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { AppLogEntry, AppLogSnapshot } from "../../../../shared/app-metadata";
import { CopyIcon } from "../../icons";
import { copyText } from "../../lib/copy-text";
import { useDesktopApi } from "../../lib/desktop-api";

const BOTTOM_THRESHOLD_PX = 32;
export const MAX_RENDERED_LOG_ENTRIES = 5000;
const DEFAULT_MINIMUM_LOG_LEVEL: LogLevelFilter = "info";
const LOG_LEVEL_FILTERS: Array<{ value: LogLevelFilter; label: string }> = [
  { value: "error", label: "Error" },
  { value: "warn", label: "Warning" },
  { value: "info", label: "Info" },
  { value: "debug", label: "Debug" },
];

type RenderedLogEntryBuffer = {
  slots: Array<AppLogEntry | undefined>;
  oldestEntryIndex: number;
  entryCount: number;
};

type LogLinePart = {
  text: string;
  matchIndex?: number;
  tone?: LogLinePartTone;
};

type RenderedLogLine = {
  level?: LogLevel;
  lineNumber: number;
  parts: LogLinePart[];
};

type LogLevel = "error" | "warn" | "info" | "debug" | "trace" | "verbose";
type LogLevelFilter = "error" | "warn" | "info" | "debug";

type LogLinePartTone =
  | "timestamp"
  | "level-debug"
  | "level-error"
  | "level-info"
  | "level-warn"
  | "scope";

export function LogsWindow() {
  const desktopApi = useDesktopApi();
  const logViewportRef = useRef<HTMLDivElement | null>(null);
  const activeMatchRef = useRef<HTMLElement | null>(null);
  const followingRef = useRef(true);
  const confirmedDebugCollectionRef = useRef(false);
  const desiredDebugCollectionRef = useRef(false);
  const debugCollectionSyncInFlightRef = useRef(false);
  const syncDebugCollectionRef = useRef<() => void>(() => undefined);
  const entryBufferRef = useRef(createRenderedLogEntryBuffer());
  const copyResetTimerRef = useRef<number | undefined>(undefined);
  const [renderVersion, setRenderVersion] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [logFilePath, setLogFilePath] = useState<string | undefined>();
  const [copiedLogFilePath, setCopiedLogFilePath] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [following, setFollowing] = useState(true);
  const [minimumLevel, setMinimumLevel] = useState<LogLevelFilter>(
    DEFAULT_MINIMUM_LOG_LEVEL,
  );
  const [debugCollectionEnabled, setDebugCollectionEnabled] = useState(false);

  const setFollowingMode = useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowing(value);
  }, []);

  const applySnapshot = useCallback((value: AppLogSnapshot) => {
    entryBufferRef.current = createRenderedLogEntryBuffer(value.entries);
    setRenderVersion((version) => version + 1);
    setLogFilePath(value.logFilePath);
    confirmedDebugCollectionRef.current = value.debugCollectionEnabled;
    setDebugCollectionEnabled(value.debugCollectionEnabled);
    setTruncated(value.truncated || value.entries.length > MAX_RENDERED_LOG_ENTRIES);
    setError(undefined);
  }, []);

  const syncDebugCollection = useCallback(() => {
    const setter = desktopApi?.setAppLogDebugCollectionEnabled;
    if (!setter || debugCollectionSyncInFlightRef.current) {
      return;
    }

    const desiredDebugCollectionEnabled = desiredDebugCollectionRef.current;
    if (
      confirmedDebugCollectionRef.current === desiredDebugCollectionEnabled
    ) {
      return;
    }

    debugCollectionSyncInFlightRef.current = true;
    let requestFailed = false;
    setLoading(true);
    void setter(desiredDebugCollectionEnabled)
      .then((snapshot) => {
        applySnapshot(snapshot);
      })
      .catch((err: unknown) => {
        requestFailed = true;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        debugCollectionSyncInFlightRef.current = false;
        setLoading(false);
        if (!requestFailed) {
          syncDebugCollectionRef.current();
        }
      });
  }, [applySnapshot, desktopApi]);

  useEffect(() => {
    syncDebugCollectionRef.current = syncDebugCollection;
  }, [syncDebugCollection]);

  useEffect(() => {
    document.title = "Logs";
  }, []);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const loadSnapshot = useCallback(async () => {
    const reader = desktopApi?.readAppLogSnapshot;
    if (!reader) {
      return;
    }

    setLoading(true);
    try {
      const value = await reader();
      applySnapshot(value);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [applySnapshot, desktopApi]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    followingRef.current = following;
  }, [following]);

  useEffect(() => {
    if (!desktopApi?.onAppLogEntry) {
      return;
    }
    return desktopApi.onAppLogEntry((entry) => {
      if (!followingRef.current) {
        return;
      }
      const droppedEntry = appendRenderedLogEntry(entryBufferRef.current, entry);
      if (droppedEntry) {
        setTruncated(true);
      }
      setRenderVersion((version) => version + 1);
    });
  }, [desktopApi]);

  useEffect(() => {
    const handleSelectionChange = (): void => {
      const viewport = logViewportRef.current;
      if (viewport && selectionTouchesElement(viewport)) {
        setFollowingMode(false);
      }
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [setFollowingMode]);

  useEffect(() => {
    if (!following) {
      return;
    }
    const element = logViewportRef.current;
    if (!element) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [following, renderVersion]);

  const rendered = useMemo(() => {
    const entries = orderedRenderedLogEntries(entryBufferRef.current);
    const visibleEntries = entries.filter((entry) =>
      shouldShowLogEntry(entry, minimumLevel),
    );
    return buildRenderedLogLines(
      visibleEntries.map((entry) => entry.line).join("\n"),
      query,
    );
  }, [minimumLevel, query, renderVersion]);

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

  const jumpToEnd = useCallback(() => {
    setFollowingMode(true);
    const element = logViewportRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
    void loadSnapshot();
  }, [loadSnapshot, setFollowingMode]);

  const handleScroll = useCallback(() => {
    const element = logViewportRef.current;
    if (!element) {
      return;
    }
    if (selectionTouchesElement(element)) {
      setFollowingMode(false);
      return;
    }
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    const shouldFollow = distanceFromBottom <= BOTTOM_THRESHOLD_PX;
    if (shouldFollow && !followingRef.current) {
      setFollowingMode(true);
      void loadSnapshot();
      return;
    }
    setFollowingMode(shouldFollow);
  }, [loadSnapshot, setFollowingMode]);

  const pauseFollowingForInteraction = useCallback(() => {
    setFollowingMode(false);
  }, [setFollowingMode]);

  const goToMatch = useCallback(
    (direction: -1 | 1) => {
      if (rendered.matchCount === 0) {
        return;
      }
      setFollowingMode(false);
      setActiveMatchIndex(
        (current) =>
          (current + direction + rendered.matchCount) % rendered.matchCount,
      );
    },
    [rendered.matchCount, setFollowingMode],
  );

  const handleSearchChange = useCallback((value: string) => {
    setQuery(value);
    if (value.trim()) {
      setFollowingMode(false);
    }
  }, [setFollowingMode]);

  const handleMinimumLevelChange = useCallback(
    (value: LogLevelFilter) => {
      setMinimumLevel(value);
      const nextDebugCollectionEnabled = value === "debug";
      if (desiredDebugCollectionRef.current === nextDebugCollectionEnabled) {
        return;
      }

      desiredDebugCollectionRef.current = nextDebugCollectionEnabled;
      syncDebugCollection();
    },
    [syncDebugCollection],
  );

  const handleCopyLogFilePath = useCallback(() => {
    if (!logFilePath) {
      return;
    }
    void copyText(logFilePath, desktopApi)
      .then(() => {
        if (copyResetTimerRef.current) {
          window.clearTimeout(copyResetTimerRef.current);
        }
        setCopiedLogFilePath(true);
        copyResetTimerRef.current = window.setTimeout(() => {
          setCopiedLogFilePath(false);
          copyResetTimerRef.current = undefined;
        }, 1400);
      })
      .catch((copyError: unknown) => {
        console.error("Failed to copy log file path", copyError);
      });
  }, [desktopApi, logFilePath]);

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
            <div
              aria-label="Minimum log level"
              className="log-window__level-filter"
              role="group"
            >
              {LOG_LEVEL_FILTERS.map((option) => (
                <button
                  key={option.value}
                  aria-pressed={minimumLevel === option.value}
                  className="log-window__level-option"
                  data-debug-collection={
                    option.value === "debug" && !debugCollectionEnabled
                      ? "off"
                      : undefined
                  }
                  type="button"
                  onClick={() => handleMinimumLevelChange(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
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
          </div>

          {logFilePath ? (
            <div className="log-window__file" aria-label="Log file path">
              <span className="log-window__file-label">File</span>
              <code className="log-window__file-path" title={logFilePath}>
                {logFilePath}
              </code>
              <button
                className="log-window__file-copy"
                type="button"
                data-copied={copiedLogFilePath ? "true" : undefined}
                aria-label={
                  copiedLogFilePath ? "Copied log file path" : "Copy log file path"
                }
                title={
                  copiedLogFilePath ? "Copied log file path" : "Copy log file path"
                }
                onClick={handleCopyLogFilePath}
              >
                <CopyIcon size={13} aria-hidden="true" />
                <span>{copiedLogFilePath ? "Copied" : "Copy"}</span>
              </button>
            </div>
          ) : null}

          <div className="log-window__status">
            <span className="log-window__status-text">
              {following
                ? "Live app log stream"
                : "Paused app log stream"}
            </span>
            {truncated ? (
              <span className="log-window__status-note">Showing tail</span>
            ) : null}
            {debugCollectionEnabled ? (
              <span className="log-window__status-note">Debug collection on</span>
            ) : null}
          </div>

          {error ? (
            <p className="document-window__error" role="alert">
              Could not load logs: {error}
            </p>
          ) : null}

          <div
            ref={logViewportRef}
            aria-label="Log viewport"
            className="log-window__viewport"
            onPointerDown={pauseFollowingForInteraction}
            onScroll={handleScroll}
          >
            {rendered.lines.length > 0 ? (
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

export function appendRenderedLogEntry(
  buffer: RenderedLogEntryBuffer,
  entry: AppLogEntry,
): boolean {
  if (buffer.entryCount < MAX_RENDERED_LOG_ENTRIES) {
    const writeIndex =
      (buffer.oldestEntryIndex + buffer.entryCount) % buffer.slots.length;
    buffer.slots[writeIndex] = entry;
    buffer.entryCount += 1;
    return false;
  }

  buffer.slots[buffer.oldestEntryIndex] = entry;
  buffer.oldestEntryIndex = (buffer.oldestEntryIndex + 1) % buffer.slots.length;
  return true;
}

export function createRenderedLogEntryBuffer(
  entries: AppLogEntry[] = [],
): RenderedLogEntryBuffer {
  const buffer: RenderedLogEntryBuffer = {
    slots: new Array<AppLogEntry | undefined>(MAX_RENDERED_LOG_ENTRIES),
    oldestEntryIndex: 0,
    entryCount: 0,
  };
  for (const entry of entries.slice(-MAX_RENDERED_LOG_ENTRIES)) {
    appendRenderedLogEntry(buffer, entry);
  }
  return buffer;
}

export function orderedRenderedLogEntries(
  buffer: RenderedLogEntryBuffer,
): AppLogEntry[] {
  const ordered: AppLogEntry[] = [];
  for (let offset = 0; offset < buffer.entryCount; offset += 1) {
    const entry =
      buffer.slots[(buffer.oldestEntryIndex + offset) % buffer.slots.length];
    if (entry) {
      ordered.push(entry);
    }
  }
  return ordered;
}

function shouldShowLogEntry(entry: AppLogEntry, minimumLevel: LogLevelFilter): boolean {
  const level = normalizeLogLevel(entry.level);
  if (!level) {
    return minimumLevel === "debug" || minimumLevel === "info";
  }
  return severityForLogLevel(level) <= severityForLogLevel(minimumLevel);
}

function LogLine(props: {
  activeMatchIndex: number;
  activeMatchRef: MutableRefObject<HTMLElement | null>;
  line: RenderedLogLine;
}) {
  const levelClass = props.line.level
    ? ` log-window__line--${props.line.level}`
    : "";
  return (
    <span className={`log-window__line${levelClass}`}>
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
    return (
      <span key={params.key} className={classNameForLinePart(params.part)}>
        {params.part.text}
      </span>
    );
  }

  const active = params.part.matchIndex === params.activeMatchIndex;
  const className = [
    "log-window__match",
    active ? "log-window__match--active" : undefined,
    classNameForLinePart(params.part),
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <mark
      key={params.key}
      ref={active ? params.activeMatchRef : undefined}
      className={className}
    >
      {params.part.text}
    </mark>
  );
}

function classNameForLinePart(part: LogLinePart): string | undefined {
  return part.tone ? `log-window__part log-window__part--${part.tone}` : undefined;
}

function selectionTouchesElement(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.toString().length === 0) {
    return false;
  }

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  return Boolean(
    (anchorNode && element.contains(anchorNode)) ||
      (focusNode && element.contains(focusNode)),
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
    const renderedLine = renderLogLine(line, normalizedQuery, matchCount);
    matchCount += renderedLine.matchCount;
    return {
      level: renderedLine.level,
      lineNumber: index + 1,
      parts: renderedLine.parts,
    };
  });

  return { lines, matchCount };
}

function renderLogLine(
  line: string,
  normalizedQuery: string,
  startMatchIndex: number,
): { level?: LogLevel; matchCount: number; parts: LogLinePart[] } {
  const tokens = tokenizeLogLine(line);
  let nextMatchIndex = startMatchIndex;
  const parts: LogLinePart[] = [];
  for (const token of tokens.parts) {
    const tokenParts = normalizedQuery
      ? splitLineMatches(token.text, normalizedQuery, nextMatchIndex, token.tone)
      : [token];
    parts.push(...tokenParts);
    nextMatchIndex += tokenParts.filter((part) => part.matchIndex !== undefined).length;
  }

  return {
    level: tokens.level,
    matchCount: nextMatchIndex - startMatchIndex,
    parts,
  };
}

export function tokenizeLogLine(line: string): {
  level?: LogLevel;
  parts: LogLinePart[];
} {
  const match = line.match(/^(\[[^\]]+\])(\s+)(\[[^\]]+\])(\s+)(\([^)]+\))(\s*)(.*)$/);
  if (!match) {
    return { parts: [{ text: line }] };
  }

  const level = normalizeLogLevel(match[3]);
  const levelTone = toneForLogLevel(level);
  return {
    level,
    parts: [
      { text: match[1], tone: "timestamp" },
      { text: match[2] },
      { text: match[3], tone: levelTone },
      { text: match[4] },
      { text: match[5], tone: "scope" },
      { text: match[6] },
      { text: match[7] },
    ],
  };
}

function normalizeLogLevel(levelToken: string): LogLevel | undefined {
  const value = levelToken.replace(/[[\]\s]/g, "").toLowerCase();
  if (
    value === "error" ||
    value === "warn" ||
    value === "info" ||
    value === "debug" ||
    value === "trace" ||
    value === "verbose"
  ) {
    return value;
  }
  return undefined;
}

function severityForLogLevel(level: LogLevel): number {
  if (level === "error") return 0;
  if (level === "warn") return 1;
  if (level === "info") return 2;
  return 3;
}

function toneForLogLevel(level: LogLevel | undefined): LogLinePartTone | undefined {
  if (level === "error") return "level-error";
  if (level === "warn") return "level-warn";
  if (level === "info") return "level-info";
  if (level === "debug" || level === "trace" || level === "verbose") {
    return "level-debug";
  }
  return undefined;
}

function splitLineMatches(
  line: string,
  normalizedQuery: string,
  startMatchIndex: number,
  tone?: LogLinePartTone,
): LogLinePart[] {
  const lowerLine = line.toLowerCase();
  const parts: LogLinePart[] = [];
  let cursor = 0;
  let matchIndex = startMatchIndex;

  while (cursor < line.length) {
    const foundAt = lowerLine.indexOf(normalizedQuery, cursor);
    if (foundAt === -1) {
      parts.push({ text: line.slice(cursor), tone });
      break;
    }
    if (foundAt > cursor) {
      parts.push({ text: line.slice(cursor, foundAt), tone });
    }
    const end = foundAt + normalizedQuery.length;
    parts.push({
      text: line.slice(foundAt, end),
      matchIndex,
      tone,
    });
    matchIndex += 1;
    cursor = end;
  }

  return parts.length > 0 ? parts : [{ text: line, tone }];
}
