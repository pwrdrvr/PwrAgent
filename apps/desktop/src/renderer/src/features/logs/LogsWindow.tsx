import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  DESKTOP_LOGS_CONTEXT_LINE_OPTIONS,
  type DesktopLogsContextLines,
  type DesktopLogsStoredLevel,
} from "@pwragent/shared";
import type { AppLogEntry, AppLogSnapshot } from "../../../../shared/app-metadata";
import { buildTroubleshootingDiagnosticsInfo } from "../../../../shared/local-diagnostics-info";
import { Select, type SelectOption } from "../../components/Select";
import {
  BookmarkIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  CopyIcon,
  FolderIcon,
  SearchIcon,
  WrapIcon,
} from "../../icons";
import { copyText, copyTextAsCodeBlock } from "../../lib/copy-text";
import { useDesktopApi } from "../../lib/desktop-api";
import {
  buildInstanceReferenceMarkdown,
  listInstanceReferences,
} from "../../lib/instance-references";
import { BrandLockup } from "../chrome/BrandLockup";
import {
  addLogSearchToken,
  appendRenderedLogEntry,
  buildLogCopyText,
  buildLogDisplayRows,
  countLogLevels,
  createRenderedLogEntryBuffer,
  displayedLogEntries,
  extractTypedLogSearchToken,
  formatLogCount,
  hasLogSearchCriteria,
  highlightLogLineParts,
  logSearchTokenLabel,
  normalizeLogLevel,
  orderedRenderedLogEntries,
  selectedLogEntries,
  shouldShowLogEntry,
  tokenizedLogEntry,
  MAX_RENDERED_LOG_ENTRIES,
  type LogLevelFilter,
  type LogLineSelection,
  type LogMark,
  type LogSearch,
  type LogSearchToken,
  type LogSearchTokenKind,
} from "./log-view-model";
import { useLogsViewerPreferences } from "./useLogsViewerPreferences";

export {
  MAX_RENDERED_LOG_ENTRIES,
  appendRenderedLogEntry,
  createRenderedLogEntryBuffer,
  orderedRenderedLogEntries,
  tokenizeLogLine,
} from "./log-view-model";

const BOTTOM_THRESHOLD_PX = 32;
const COPIED_BUTTON_MS = 2000;
const COPIED_FLASH_MS = 900;
const STORED_LEVEL_FILTERS: Array<{ value: DesktopLogsStoredLevel; label: string }> = [
  { value: "error", label: "Error" },
  { value: "warn", label: "Warning" },
  { value: "info", label: "Info" },
];
const CONTEXT_OPTIONS: SelectOption<string>[] = DESKTOP_LOGS_CONTEXT_LINE_OPTIONS.map(
  (lines) => ({
    value: String(lines),
    label: lines === 0 ? "No context" : `Context ±${lines}`,
  }),
);
const EMPTY_SEARCH: LogSearch = { text: "", tokens: [] };

// The log file path is also injected at window-creation time via the preload
// (`window.__pwragentLogFilePath`). The snapshot IPC normally supplies it, but
// if that read fails — exactly when the user most needs to find the log on
// disk — this bootstrap value keeps the path + reveal button available.
function readBootstrapLogFilePath(): string | undefined {
  const value = (window as unknown as { __pwragentLogFilePath?: unknown })
    .__pwragentLogFilePath;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

type PausedState = {
  newLines: number;
  newErrors: number;
  since?: number;
};

const NOT_PAUSED: PausedState = { newLines: 0, newErrors: 0 };

export function LogsWindow() {
  const desktopApi = useDesktopApi();
  const [preferences, updatePreferences] = useLogsViewerPreferences(desktopApi);
  const logViewportRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const followingRef = useRef(true);
  const confirmedDebugCollectionRef = useRef(false);
  const desiredDebugCollectionRef = useRef(false);
  const debugCollectionSyncInFlightRef = useRef(false);
  const syncDebugCollectionRef = useRef<() => void>(() => undefined);
  const entryBufferRef = useRef(createRenderedLogEntryBuffer());
  const pathCopyResetTimerRef = useRef<number | undefined>(undefined);
  const copyButtonResetTimerRef = useRef<number | undefined>(undefined);
  const flashResetTimerRef = useRef<number | undefined>(undefined);
  const draggingSelectionRef = useRef(false);
  const scrollToSequenceRef = useRef<number | undefined>(undefined);
  // The newest sequence seen, drawn or not: while paused, entries are only
  // counted, and a Mark must still land after them.
  const newestSequenceRef = useRef(0);
  const selectedLevelsRef = useRef<readonly LogLevelFilter[]>([]);
  const searchingRef = useRef(false);
  const [renderVersion, setRenderVersion] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [logFilePath, setLogFilePath] = useState<string | undefined>(
    readBootstrapLogFilePath,
  );
  const [copiedLogFilePath, setCopiedLogFilePath] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState<LogSearch>(EMPTY_SEARCH);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [expandedGaps, setExpandedGaps] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [following, setFollowing] = useState(true);
  const [paused, setPaused] = useState<PausedState>(NOT_PAUSED);
  const [debugSelected, setDebugSelected] = useState(false);
  const [debugCollectionEnabled, setDebugCollectionEnabled] = useState(false);
  const [selection, setSelection] = useState<LogLineSelection | undefined>();
  const [mark, setMark] = useState<LogMark | undefined>();
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied">("idle");
  const [flashSequences, setFlashSequences] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [statusMessage, setStatusMessage] = useState<string | undefined>();

  const selectedLevels = useMemo<LogLevelFilter[]>(
    () => [...preferences.levels, ...(debugSelected ? ["debug" as const] : [])],
    [debugSelected, preferences.levels],
  );

  useEffect(() => {
    selectedLevelsRef.current = selectedLevels;
  }, [selectedLevels]);

  const setFollowingMode = useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowing(value);
  }, []);

  const applySnapshot = useCallback((value: AppLogSnapshot) => {
    entryBufferRef.current = createRenderedLogEntryBuffer(value.entries);
    newestSequenceRef.current = Math.max(
      newestSequenceRef.current,
      value.entries.at(-1)?.sequence ?? 0,
    );
    setRenderVersion((version) => version + 1);
    setLogFilePath(value.logFilePath ?? readBootstrapLogFilePath());
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
      for (const timer of [
        pathCopyResetTimerRef.current,
        copyButtonResetTimerRef.current,
        flashResetTimerRef.current,
      ]) {
        if (timer) window.clearTimeout(timer);
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

  // While paused the view holds still. New entries are counted, not drawn;
  // resuming reads the main process's buffer again, which still has them.
  useEffect(() => {
    if (!desktopApi?.onAppLogEntry) {
      return;
    }
    return desktopApi.onAppLogEntry((entry) => {
      newestSequenceRef.current = Math.max(newestSequenceRef.current, entry.sequence);
      if (!followingRef.current) {
        // Count only what resuming will show at the current levels.
        if (!shouldShowLogEntry(entry, selectedLevelsRef.current)) {
          return;
        }
        setPaused((current) => ({
          newLines: current.newLines + 1,
          newErrors:
            current.newErrors + (normalizeLogLevel(entry.level) === "error" ? 1 : 0),
          since: current.since ?? entry.timestamp,
        }));
        return;
      }
      const droppedEntry = appendRenderedLogEntry(entryBufferRef.current, entry);
      if (droppedEntry) {
        setTruncated(true);
      }
      setRenderVersion((version) => version + 1);
    });
  }, [desktopApi]);

  const pause = useCallback(() => {
    if (followingRef.current) {
      setPaused(NOT_PAUSED);
    }
    setFollowingMode(false);
  }, [setFollowingMode]);

  const resume = useCallback(() => {
    setFollowingMode(true);
    setPaused(NOT_PAUSED);
    const element = logViewportRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
    void loadSnapshot();
  }, [loadSnapshot, setFollowingMode]);

  // A text drag inside one line still pauses, so the live tail cannot move
  // the text being selected. Line-number selection does not.
  useEffect(() => {
    const handleSelectionChange = (): void => {
      const viewport = logViewportRef.current;
      if (viewport && textSelectionTouchesElement(viewport)) {
        pause();
      }
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [pause]);

  const allEntries = useMemo(
    () => orderedRenderedLogEntries(entryBufferRef.current),
    // The buffer is mutated in place; renderVersion is the change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [renderVersion],
  );
  const levelCounts = useMemo(() => countLogLevels(allEntries), [allEntries]);
  const levelFilteredEntries = useMemo(
    () => allEntries.filter((entry) => shouldShowLogEntry(entry, selectedLevels)),
    [allEntries, selectedLevels],
  );
  const searching = hasLogSearchCriteria(search);

  useEffect(() => {
    searchingRef.current = searching;
  }, [searching]);
  const display = useMemo(
    () =>
      buildLogDisplayRows({
        entries: levelFilteredEntries,
        search,
        mode: preferences.searchMode,
        contextLines: preferences.contextLines,
        expandedGaps,
        mark,
      }),
    [
      expandedGaps,
      levelFilteredEntries,
      mark,
      preferences.contextLines,
      preferences.searchMode,
      search,
    ],
  );
  const matchCount = display.matchSequences.length;
  const activeMatchSequence = display.matchSequences[activeMatchIndex];
  const selectedEntries = useMemo(
    () => selectedLogEntries(display.rows, selection),
    [display.rows, selection],
  );
  const selectedSequences = useMemo(
    () => new Set(selectedEntries.map((entry) => entry.sequence)),
    [selectedEntries],
  );
  const lastSequence = allEntries.at(-1)?.sequence ?? 0;
  const gutterDigits = Math.max(3, String(lastSequence).length);

  useEffect(() => {
    if (!following) {
      return;
    }
    const element = logViewportRef.current;
    if (!element) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [following, renderVersion, preferences.wrap]);

  useEffect(() => {
    setActiveMatchIndex(0);
    setExpandedGaps(new Set());
  }, [search, preferences.searchMode, preferences.contextLines]);

  useEffect(() => {
    if (activeMatchIndex >= matchCount) {
      setActiveMatchIndex(Math.max(0, matchCount - 1));
    }
  }, [activeMatchIndex, matchCount]);

  const scrollSequenceIntoView = useCallback((sequence: number) => {
    const row = logViewportRef.current?.querySelector<HTMLElement>(
      `[data-log-sequence="${sequence}"]`,
    );
    row?.scrollIntoView?.({ block: "center", inline: "nearest" });
  }, []);

  useEffect(() => {
    if (activeMatchSequence !== undefined && searching) {
      scrollSequenceIntoView(activeMatchSequence);
    }
  }, [activeMatchSequence, scrollSequenceIntoView, searching]);

  // After Esc clears the search, put the last active match back in view.
  useEffect(() => {
    const sequence = scrollToSequenceRef.current;
    if (sequence === undefined || searching) return;
    scrollToSequenceRef.current = undefined;
    scrollSequenceIntoView(sequence);
  }, [display.rows, scrollSequenceIntoView, searching]);

  const handleScroll = useCallback(() => {
    const element = logViewportRef.current;
    if (!element) {
      return;
    }
    if (textSelectionTouchesElement(element)) {
      pause();
      return;
    }
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    const atBottom = distanceFromBottom <= BOTTOM_THRESHOLD_PX;
    if (atBottom && !followingRef.current) {
      // A search holds the view still: a short filtered list clamps
      // scrollTop to the bottom, and a match near the end lands there too.
      // Only Live or the new-lines pill resumes it.
      if (!searchingRef.current) {
        resume();
      }
      return;
    }
    if (!atBottom) {
      pause();
    }
  }, [pause, resume]);

  const goToMatch = useCallback(
    (direction: -1 | 1) => {
      if (matchCount === 0) {
        return;
      }
      pause();
      setActiveMatchIndex(
        (current) => (current + direction + matchCount) % matchCount,
      );
    },
    [matchCount, pause],
  );

  const applySearch = useCallback(
    (next: LogSearch) => {
      setSearch(next);
      if (hasLogSearchCriteria(next)) {
        pause();
      }
    },
    [pause],
  );

  const handleSearchInput = useCallback(
    (value: string) => {
      const typed = extractTypedLogSearchToken(value);
      if (typed) {
        applySearch({
          text: typed.text,
          tokens: addLogSearchToken(search.tokens, typed.token),
        });
        return;
      }
      applySearch({ ...search, text: value });
    },
    [applySearch, search],
  );

  const clearSearch = useCallback(() => {
    scrollToSequenceRef.current = activeMatchSequence;
    setSearch(EMPTY_SEARCH);
  }, [activeMatchSequence]);

  const removeSearchToken = useCallback(
    (token: LogSearchToken) => {
      applySearch({
        ...search,
        tokens: search.tokens.filter(
          (existing) =>
            existing.kind !== token.kind || existing.value !== token.value,
        ),
      });
    },
    [applySearch, search],
  );

  const handleSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        goToMatch(event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        if (searching) {
          event.preventDefault();
          clearSearch();
        } else {
          event.currentTarget.blur();
        }
      } else if (
        event.key === "Backspace"
        && event.currentTarget.value === ""
        && search.tokens.length > 0
      ) {
        event.preventDefault();
        const last = search.tokens.at(-1);
        if (last) removeSearchToken(last);
      }
    },
    [clearSearch, goToMatch, removeSearchToken, search.tokens, searching],
  );

  const handleLevelToggle = useCallback(
    (value: DesktopLogsStoredLevel) => {
      const nextLevels = preferences.levels.includes(value)
        ? preferences.levels.filter((level) => level !== value)
        : [...preferences.levels, value];
      updatePreferences({ levels: nextLevels });
    },
    [preferences.levels, updatePreferences],
  );

  const handleDebugToggle = useCallback(() => {
    const nextDebugSelected = !debugSelected;
    setDebugSelected(nextDebugSelected);
    if (desiredDebugCollectionRef.current === nextDebugSelected) {
      return;
    }
    desiredDebugCollectionRef.current = nextDebugSelected;
    syncDebugCollection();
  }, [debugSelected, syncDebugCollection]);

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  const changeSelection = useCallback((next: LogLineSelection | undefined) => {
    setSelection(next);
    setStatusMessage(undefined);
    setCopyState("idle");
  }, []);

  const selectSequence = useCallback(
    (sequence: number, extend: boolean) => {
      const newest = displayedLogEntries(display.rows).at(-1)?.sequence;
      if (extend && selection) {
        changeSelection({
          anchor: selection.anchor,
          focus: sequence,
          followsTail: sequence === newest,
          sinceMark: false,
        });
        return;
      }
      changeSelection({
        anchor: sequence,
        focus: sequence,
        followsTail: false,
        sinceMark: false,
      });
    },
    [changeSelection, display.rows, selection],
  );

  const selectAllShown = useCallback(() => {
    const shown = displayedLogEntries(display.rows);
    const first = shown[0];
    const last = shown.at(-1);
    if (!first || !last) return;
    changeSelection({
      anchor: first.sequence,
      focus: last.sequence,
      followsTail: false,
      sinceMark: false,
    });
  }, [changeSelection, display.rows]);

  const selectSinceMark = useCallback(() => {
    if (!mark) return;
    const shown = displayedLogEntries(display.rows).filter(
      (entry) => entry.sequence > mark.afterSequence,
    );
    const first = shown[0];
    const last = shown.at(-1);
    if (!first || !last) return;
    changeSelection({
      anchor: first.sequence,
      focus: last.sequence,
      followsTail: true,
      sinceMark: true,
    });
  }, [changeSelection, display.rows, mark]);

  useEffect(() => {
    const endDrag = (): void => {
      draggingSelectionRef.current = false;
    };
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, []);

  const handleLinesPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const sequence = gutterSequence(event.target);
      if (sequence === undefined) return;
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      draggingSelectionRef.current = true;
      selectSequence(sequence, event.shiftKey);
    },
    [selectSequence],
  );

  const handleLinesPointerOver = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingSelectionRef.current || !selection) return;
      const sequence = gutterSequence(event.target);
      if (sequence === undefined || sequence === selection.focus) return;
      selectSequence(sequence, true);
    },
    [selectSequence, selection],
  );

  const handleLinesClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-log-token-kind]")
        : null;
      if (!target) return;
      const textSelection = window.getSelection();
      if (textSelection && !textSelection.isCollapsed) return;
      const kind = target.dataset.logTokenKind as LogSearchTokenKind;
      const value = target.dataset.logTokenValue;
      if (!value) return;
      applySearch({
        ...search,
        tokens: addLogSearchToken(search.tokens, { kind, value }),
      });
    },
    [applySearch, search],
  );

  // -------------------------------------------------------------------------
  // Copy
  // -------------------------------------------------------------------------

  const readDiagnostics = useCallback(async (): Promise<{
    diagnostics?: string;
    instanceReference?: string;
  }> => {
    const metadata = await desktopApi?.readAppMetadata?.().catch(() => undefined);
    if (!metadata) return {};
    const health = await desktopApi
      ?.readFederationHealth?.({})
      .then((response) => response.health)
      .catch(() => undefined);
    const local = listInstanceReferences(health).find(
      (reference) => reference.instanceId === health?.instanceId,
    );
    return {
      diagnostics: buildTroubleshootingDiagnosticsInfo(metadata),
      ...(local ? { instanceReference: buildInstanceReferenceMarkdown(local) } : {}),
    };
  }, [desktopApi]);

  const copySelection = useCallback(async () => {
    const entries = selectedEntries;
    if (entries.length === 0 || copyState === "copying") return;
    setCopyState("copying");
    const wantDiagnostics = preferences.includeDiagnostics;
    const diagnostics = wantDiagnostics ? await readDiagnostics() : {};
    const text = buildLogCopyText({
      entries,
      totalLoaded: allEntries.length,
      levels: selectedLevels,
      search,
      mode: preferences.searchMode,
      contextLines: preferences.contextLines,
      ...diagnostics,
    });
    try {
      await copyTextAsCodeBlock(text, desktopApi);
    } catch (copyError: unknown) {
      console.error("Failed to copy log lines", copyError);
      setCopyState("idle");
      setStatusMessage("Could not copy to the clipboard");
      return;
    }
    const lineCount = entries.length === 1
      ? "1 line"
      : `${formatLogCount(entries.length)} lines`;
    setStatusMessage(
      !wantDiagnostics
        ? `Copied ${lineCount}`
        : diagnostics.diagnostics
          ? `Copied ${lineCount} with diagnostics`
          : `Copied ${lineCount}; diagnostics unavailable`,
    );
    setCopyState("copied");
    setFlashSequences(new Set(entries.map((entry) => entry.sequence)));
    if (copyButtonResetTimerRef.current) {
      window.clearTimeout(copyButtonResetTimerRef.current);
    }
    copyButtonResetTimerRef.current = window.setTimeout(() => {
      setCopyState("idle");
      copyButtonResetTimerRef.current = undefined;
    }, COPIED_BUTTON_MS);
    if (flashResetTimerRef.current) {
      window.clearTimeout(flashResetTimerRef.current);
    }
    flashResetTimerRef.current = window.setTimeout(() => {
      setFlashSequences(new Set());
      flashResetTimerRef.current = undefined;
    }, COPIED_FLASH_MS);
  }, [
    allEntries.length,
    copyState,
    desktopApi,
    preferences.contextLines,
    preferences.includeDiagnostics,
    preferences.searchMode,
    readDiagnostics,
    search,
    selectedEntries,
    selectedLevels,
  ]);

  // Window shortcuts. ⌘C copies the line selection unless text is selected,
  // which keeps the native copy of exactly what is highlighted.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (isEditableTarget(event.target)) return;
      if (mod && event.key.toLowerCase() === "a") {
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
        selectAllShown();
        return;
      }
      if (mod && event.key.toLowerCase() === "c") {
        if (selectedEntries.length === 0 || hasTextSelection()) return;
        event.preventDefault();
        void copySelection();
        return;
      }
      if (event.key === "Escape" && selection) {
        event.preventDefault();
        changeSelection(undefined);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [changeSelection, copySelection, selectAllShown, selectedEntries.length, selection]);

  const handleCopyLogFilePath = useCallback(() => {
    if (!logFilePath) {
      return;
    }
    void copyText(logFilePath, desktopApi)
      .then(() => {
        if (pathCopyResetTimerRef.current) {
          window.clearTimeout(pathCopyResetTimerRef.current);
        }
        setCopiedLogFilePath(true);
        setStatusMessage("Copied the log file path");
        pathCopyResetTimerRef.current = window.setTimeout(() => {
          setCopiedLogFilePath(false);
          pathCopyResetTimerRef.current = undefined;
        }, 1400);
      })
      .catch((copyError: unknown) => {
        console.error("Failed to copy log file path", copyError);
      });
  }, [desktopApi, logFilePath]);

  const handleRevealLogFile = useCallback(() => {
    if (!logFilePath) {
      return;
    }
    const reveal = desktopApi?.revealPath ?? desktopApi?.openPath;
    void reveal?.({ path: logFilePath }).catch((revealError: unknown) => {
      console.error("Failed to reveal log file", revealError);
    });
  }, [desktopApi, logFilePath]);

  const handleMark = useCallback(() => {
    setMark({
      afterSequence: Math.max(lastSequence, newestSequenceRef.current),
      at: Date.now(),
    });
  }, [lastSequence]);

  const expandGap = useCallback((key: string) => {
    setExpandedGaps((current) => new Set(current).add(key));
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const searchCountLabel = searching
    ? matchCount > 0
      ? `${activeMatchIndex + 1} of ${formatLogCount(matchCount)} ${matchCount === 1 ? "line" : "lines"}`
      : "No matches"
    : undefined;
  const showContext = preferences.searchMode === "filter" && searching;
  const firstSelected = selectedEntries[0]?.sequence;
  const lastSelected = selectedEntries.at(-1)?.sequence;
  const selectionLabel = selection?.sinceMark
    ? `${formatLogCount(selectedEntries.length)} ${selectedEntries.length === 1 ? "line" : "lines"} since mark`
    : selectedEntries.length === 1
      ? `Line ${firstSelected}`
      : `${formatLogCount(selectedEntries.length)} lines selected`;
  const pausedSince = paused.since === undefined
    ? undefined
    : formatClockTime(paused.since);
  const fileName = logFilePath?.split(/[\\/]/).at(-1);

  return (
    <div className="document-window document-window--logs">
      <section aria-label="PwrAgent logs" className="activity-screen">
        <header className="activity-titlebar">
          <BrandLockup variant="activity-titlebar" />
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
            <div
              className="log-window__search"
              data-has-tokens={search.tokens.length > 0 ? "true" : undefined}
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) {
                  event.preventDefault();
                  searchInputRef.current?.focus();
                }
              }}
            >
              <SearchIcon aria-hidden="true" className="log-window__search-icon" size={14} />
              {search.tokens.map((token) => (
                <span
                  key={`${token.kind}:${token.value}`}
                  className="log-window__token-chip tooltip-target"
                  data-tooltip={`${token.kind}:${token.value}`}
                >
                  <span className="log-window__token-chip-kind">{token.kind}</span>
                  <span className="log-window__token-chip-value">
                    {logSearchTokenLabel(token)}
                  </span>
                  <button
                    aria-label={`Remove ${token.kind} filter ${token.value}`}
                    className="log-window__token-chip-remove"
                    type="button"
                    onClick={() => removeSearchToken(token)}
                  >
                    <CloseIcon aria-hidden="true" size={11} />
                  </button>
                </span>
              ))}
              <input
                ref={searchInputRef}
                aria-label="Search logs"
                value={search.text}
                onChange={(event) => handleSearchInput(event.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={search.tokens.length > 0 ? "" : "Search logs"}
                spellCheck={false}
              />
              {searchCountLabel ? (
                <>
                  <span className="log-window__match-count" aria-live="polite">
                    {searchCountLabel}
                  </span>
                  <button
                    aria-label="Previous match"
                    className="log-window__search-step tooltip-target"
                    disabled={matchCount === 0}
                    data-tooltip="Previous match (Shift-Enter)"
                    type="button"
                    onClick={() => goToMatch(-1)}
                  >
                    <ChevronUpIcon aria-hidden="true" size={14} />
                  </button>
                  <button
                    aria-label="Next match"
                    className="log-window__search-step tooltip-target"
                    disabled={matchCount === 0}
                    data-tooltip="Next match (Enter)"
                    type="button"
                    onClick={() => goToMatch(1)}
                  >
                    <ChevronDownIcon aria-hidden="true" size={14} />
                  </button>
                </>
              ) : (
                <kbd className="log-window__search-hint">⌘F</kbd>
              )}
            </div>

            <div aria-label="Search mode" className="log-window__segmented" role="group">
              <button
                aria-pressed={preferences.searchMode === "filter"}
                className="log-window__segment tooltip-target"
                data-tooltip="Show only matching lines"
                type="button"
                onClick={() => updatePreferences({ searchMode: "filter" })}
              >
                Filter
              </button>
              <button
                aria-pressed={preferences.searchMode === "highlight"}
                className="log-window__segment tooltip-target"
                data-tooltip="Show every line and highlight matches"
                type="button"
                onClick={() => updatePreferences({ searchMode: "highlight" })}
              >
                Highlight
              </button>
            </div>

            {showContext ? (
              <Select
                aria-label="Context lines"
                className="log-window__context"
                options={CONTEXT_OPTIONS}
                value={String(preferences.contextLines)}
                onChange={(value) =>
                  updatePreferences({
                    contextLines: Number(value) as DesktopLogsContextLines,
                  })
                }
              />
            ) : null}

            <div aria-label="Log levels" className="log-window__segmented" role="group">
              {STORED_LEVEL_FILTERS.map((option) => {
                const count = option.value === "error"
                  ? levelCounts.error
                  : option.value === "warn"
                    ? levelCounts.warn
                    : undefined;
                return (
                  <button
                    key={option.value}
                    aria-pressed={preferences.levels.includes(option.value)}
                    className="log-window__segment"
                    type="button"
                    onClick={() => handleLevelToggle(option.value)}
                  >
                    {option.label}
                    {count ? (
                      <span className="log-window__segment-count">
                        {formatLogCount(count)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
              <button
                aria-pressed={debugSelected}
                className="log-window__segment tooltip-target"
                data-debug-collection={
                  debugSelected && !debugCollectionEnabled ? "off" : undefined
                }
                data-tooltip="Show debug lines; turns on debug collection"
                type="button"
                onClick={handleDebugToggle}
              >
                Debug
              </button>
            </div>

            <span aria-hidden="true" className="log-window__toolbar-divider" />

            <button
              aria-label="Wrap"
              aria-pressed={preferences.wrap}
              className="log-window__button tooltip-target"
              data-tooltip="Wrap long lines"
              type="button"
              onClick={() => updatePreferences({ wrap: !preferences.wrap })}
            >
              <WrapIcon aria-hidden="true" size={14} />
              <span className="log-window__button-label">Wrap</span>
            </button>
            <button
              aria-label="Mark"
              className="log-window__button tooltip-target"
              data-tooltip="Drop a mark after the newest line"
              type="button"
              onClick={handleMark}
            >
              <BookmarkIcon aria-hidden="true" size={14} />
              <span className="log-window__button-label">Mark</span>
            </button>
            <button
              aria-pressed={following}
              className="log-window__button log-window__button--live tooltip-target"
              data-tooltip={following ? "Pause the live log" : "Resume the live log"}
              type="button"
              onClick={following ? pause : resume}
            >
              <span
                aria-hidden="true"
                className="log-window__live-dot"
                data-live={following ? "true" : "false"}
              />
              {following ? "Live" : "Paused"}
            </button>
          </div>

          {error ? (
            <p className="document-window__error" role="alert">
              Could not load logs: {error}
            </p>
          ) : null}

          <div className="log-window__viewport-frame">
            <div
              ref={logViewportRef}
              aria-label="Log viewport"
              className="log-window__viewport"
              onScroll={handleScroll}
            >
              {display.rows.length > 0 ? (
                <div
                  aria-label="Log output"
                  className={`log-window__lines${preferences.wrap ? " log-window__lines--wrap" : ""}`}
                  aria-live="off"
                  role="log"
                  style={{ "--log-gutter-digits": gutterDigits } as CSSProperties}
                  onClick={handleLinesClick}
                  onPointerDown={handleLinesPointerDown}
                  onPointerOver={handleLinesPointerOver}
                >
                  {display.rows.map((row) => {
                    if (row.kind === "gap") {
                      return (
                        <button
                          key={row.key}
                          className="log-window__gap"
                          type="button"
                          onClick={() => expandGap(row.key)}
                        >
                          {row.hiddenCount === 1
                            ? "1 line hidden"
                            : `${formatLogCount(row.hiddenCount)} lines hidden`}
                        </button>
                      );
                    }
                    if (row.kind === "mark") {
                      return mark ? (
                        <div key="mark" className="log-window__mark">
                          <BookmarkIcon aria-hidden="true" size={13} />
                          <span>Mark · {formatClockTime(mark.at)}</span>
                          <span aria-hidden="true" className="log-window__mark-rule" />
                          <button
                            className="log-window__mark-action"
                            disabled={lastSequence <= mark.afterSequence}
                            type="button"
                            onClick={selectSinceMark}
                          >
                            Select since mark
                          </button>
                          <button
                            aria-label="Remove mark"
                            className="log-window__mark-remove"
                            type="button"
                            onClick={() => setMark(undefined)}
                          >
                            <CloseIcon aria-hidden="true" size={11} />
                          </button>
                        </div>
                      ) : null;
                    }
                    const sequence = row.entry.sequence;
                    return (
                      <LogLine
                        key={sequence}
                        activeMatch={searching && sequence === activeMatchSequence}
                        context={row.context}
                        entry={row.entry}
                        flashing={flashSequences.has(sequence)}
                        highlightQuery={search.text}
                        match={row.match && preferences.searchMode === "highlight"}
                        selected={selectedSequences.has(sequence)}
                      />
                    );
                  })}
                </div>
              ) : (
                <p className="document-window__empty">
                  {loading
                    ? "Loading..."
                    : searching
                      ? "No lines match."
                      : "No log output yet."}
                </p>
              )}
            </div>

            {selectedEntries.length > 0 ? (
              <div aria-label="Selected lines" className="log-window__selection-bar" role="toolbar">
                <span className="log-window__selection-count">
                  {selectionLabel}
                  {selectedEntries.length > 1 ? (
                    <span className="log-window__selection-range">
                      {firstSelected}–{lastSelected}
                    </span>
                  ) : null}
                </span>
                <span aria-hidden="true" className="log-window__selection-divider" />
                <button
                  aria-checked={preferences.includeDiagnostics}
                  className="log-window__check tooltip-target"
                  role="checkbox"
                  data-tooltip="Start the copy with version, profile, process, log path and instance details"
                  type="button"
                  onClick={() =>
                    updatePreferences({
                      includeDiagnostics: !preferences.includeDiagnostics,
                    })
                  }
                >
                  <span aria-hidden="true" className="log-window__check-box">
                    {preferences.includeDiagnostics ? (
                      <CheckIcon size={11} />
                    ) : null}
                  </span>
                  Include diagnostics
                </button>
                <button
                  className="log-window__copy tooltip-target"
                  data-copied={copyState === "copied" ? "true" : undefined}
                  disabled={copyState === "copying"}
                  data-tooltip="Copy the selected lines (⌘C)"
                  type="button"
                  onClick={() => void copySelection()}
                >
                  {copyState === "copied" ? (
                    <CheckIcon aria-hidden="true" size={13} />
                  ) : (
                    <CopyIcon aria-hidden="true" size={13} />
                  )}
                  {copyState === "copied" ? "Copied" : "Copy"}
                </button>
                <button
                  aria-label="Clear selection"
                  className="log-window__selection-clear tooltip-target"
                  data-tooltip="Clear selection (Esc)"
                  type="button"
                  onClick={() => changeSelection(undefined)}
                >
                  <CloseIcon aria-hidden="true" size={12} />
                </button>
              </div>
            ) : !following && paused.newLines > 0 ? (
              <button className="log-window__new-lines" type="button" onClick={resume}>
                <ChevronDownIcon aria-hidden="true" size={13} />
                {paused.newLines === 1
                  ? "1 new line"
                  : `${formatLogCount(paused.newLines)} new lines`}
                {paused.newErrors > 0
                  ? ` · ${formatLogCount(paused.newErrors)} ${paused.newErrors === 1 ? "error" : "errors"}`
                  : ""}
              </button>
            ) : null}
          </div>

          <footer className="log-window__status-bar">
            <span className="log-window__status-text">
              {searching
                ? `${formatLogCount(matchCount)} of ${formatLogCount(levelFilteredEntries.length)} lines match`
                : following
                  ? `${formatLogCount(allEntries.length)} lines`
                  : paused.newLines > 0 && pausedSince
                    ? `Paused · ${formatLogCount(paused.newLines)} new since ${pausedSince}`
                    : `Paused · ${formatLogCount(allEntries.length)} lines`}
            </span>
            {truncated ? (
              <span className="log-window__status-note">Showing tail</span>
            ) : null}
            {debugCollectionEnabled ? (
              <span className="log-window__status-note">Debug collection on</span>
            ) : null}
            {fileName ? (
              <span className="log-window__status-file tooltip-target" data-tooltip={logFilePath}>
                {fileName}
              </span>
            ) : null}
            <span className="log-window__status-spacer" />
            <span aria-live="polite" className="log-window__status-live" role="status">
              {statusMessage ? (
                <span className="log-window__status-message">
                  <CheckIcon aria-hidden="true" size={12} />
                  {statusMessage}
                </span>
              ) : null}
            </span>
            {logFilePath ? (
              <>
                <button
                  aria-label={copiedLogFilePath ? "Copied log file path" : "Copy log file path"}
                  className="log-window__status-action tooltip-target"
                  data-copied={copiedLogFilePath ? "true" : undefined}
                  data-tooltip={logFilePath}
                  type="button"
                  onClick={handleCopyLogFilePath}
                >
                  {copiedLogFilePath ? (
                    <CheckIcon aria-hidden="true" size={12} />
                  ) : (
                    <CopyIcon aria-hidden="true" size={12} />
                  )}
                  Copy path
                </button>
                <button
                  aria-label="Reveal log file in file manager"
                  className="log-window__status-action tooltip-target"
                  data-tooltip="Reveal log file in file manager"
                  type="button"
                  onClick={handleRevealLogFile}
                >
                  <FolderIcon aria-hidden="true" size={12} />
                  Reveal
                </button>
              </>
            ) : null}
          </footer>
        </main>
      </section>
    </div>
  );
}

const LogLine = memo(function LogLine(props: {
  entry: AppLogEntry;
  highlightQuery: string;
  activeMatch: boolean;
  /** A match shown among every line (Highlight mode). */
  match: boolean;
  context: boolean;
  selected: boolean;
  flashing: boolean;
}) {
  const tokenized = tokenizedLogEntry(props.entry);
  const parts = useMemo(
    () => highlightLogLineParts(tokenized.parts, props.highlightQuery),
    [props.highlightQuery, tokenized.parts],
  );
  const level = tokenized.level ?? normalizeLogLevel(props.entry.level);
  const className = [
    "log-window__line",
    level ? `log-window__line--${level}` : undefined,
    props.context ? "log-window__line--context" : undefined,
    props.match ? "log-window__line--match" : undefined,
    props.activeMatch ? "log-window__line--active-match" : undefined,
    props.selected ? "log-window__line--selected" : undefined,
    props.flashing ? "log-window__line--copied" : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  let firstMatch = true;
  return (
    <div
      className={className}
      data-log-sequence={props.entry.sequence}
    >
      <span className="log-window__line-number" data-log-gutter={props.entry.sequence}>
        {props.entry.sequence}
      </span>
      <span className="log-window__line-text">
        {parts.map((part, index) => {
          const tone = part.tone ? ` log-window__part--${part.tone}` : "";
          const tokenProps = part.token
            ? {
                "data-log-token-kind": part.token.kind,
                "data-log-token-value": part.token.value,
              }
            : {};
          const tokenClass = part.token ? " log-window__token" : "";
          if (part.match) {
            const active = props.activeMatch && firstMatch;
            firstMatch = false;
            return (
              <mark
                key={index}
                className={`log-window__match${active ? " log-window__match--active" : ""}${tone}${tokenClass}`}
                {...tokenProps}
              >
                {part.text}
              </mark>
            );
          }
          return (
            <span
              key={index}
              className={`log-window__part${tone}${tokenClass}`}
              {...tokenProps}
            >
              {part.text}
            </span>
          );
        })}
      </span>
    </div>
  );
});

function gutterSequence(target: EventTarget | null): number | undefined {
  if (!(target instanceof Element)) return undefined;
  const gutter = target.closest<HTMLElement>("[data-log-gutter]");
  const value = gutter?.dataset.logGutter;
  return value === undefined ? undefined : Number(value);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable
    || target.tagName === "INPUT"
    || target.tagName === "TEXTAREA"
    || target.tagName === "SELECT"
  );
}

function textSelectionTouchesElement(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.toString().length === 0) {
    return false;
  }

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  return Boolean(
    (anchorNode && element.contains(anchorNode))
      || (focusNode && element.contains(focusNode)),
  );
}

/** Any highlighted text in the window; ⌘C then copies it natively. */
function hasTextSelection(): boolean {
  const selection = window.getSelection();
  return Boolean(
    selection && !selection.isCollapsed && selection.toString().length > 0,
  );
}

function formatClockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}
