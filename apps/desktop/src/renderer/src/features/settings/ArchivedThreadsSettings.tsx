import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  buildThreadIdentityKey,
  isToolManagedWorktreePath,
  type AppServerBackendKind,
  type AppServerThreadSummary,
  type ArchiveThreadCleanupResult,
} from "@pwragent/shared";
import { SearchIcon } from "../../icons";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";

type ArchivedThreadsState = {
  error?: string;
  fetchedAt?: number;
  loading: boolean;
  threads: AppServerThreadSummary[];
  workspaceRoots: string[];
};

type ArchivedProjectGroup = {
  key: string;
  label: string;
  latestArchiveTimestamp: number;
  path?: string;
  threads: AppServerThreadSummary[];
};

type ArchivedProjectIdentity = Omit<ArchivedProjectGroup, "threads">;

/** A row's in-flight action, or the error its last action left behind. */
type ArchivedRowAction = {
  pending?: "restore" | "archive";
  error?: string;
  /** A completed action's caveat, such as a worktree the archive kept. */
  notice?: string;
};

type OpenThreadTarget = {
  backend: AppServerBackendKind;
  threadId: string;
};

const ARCHIVED_THREADS_PER_PROJECT_LIMIT = 20;
const COPIED_FEEDBACK_MS = 1_500;
const SHORT_THREAD_ID_LENGTH = 8;

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

export function ArchivedThreadsSettings(props: {
  desktopApi?: DesktopApi;
  onOpenThread?: (target: OpenThreadTarget) => void;
}) {
  const [state, setState] = useState<ArchivedThreadsState>({
    loading: true,
    threads: [],
    workspaceRoots: [],
  });
  // Threads restored during this visit, by key. A restored row keeps its
  // place in its project group so the operator never loses track of it, and
  // it outranks the fetched list: a refresh that still reports the thread as
  // archived (a stale response) or no longer reports it at all leaves it put.
  const [restoredThreads, setRestoredThreads] = useState<
    ReadonlyMap<string, AppServerThreadSummary>
  >(() => new Map());
  const [rowActions, setRowActions] = useState<
    ReadonlyMap<string, ArchivedRowAction>
  >(() => new Map());
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [filter, setFilter] = useState("");
  const pendingRowKeysRef = useRef(new Set<string>());

  const loadArchivedThreads = useCallback(async () => {
    const listThreads = props.desktopApi?.listThreads;
    if (!listThreads) {
      setState({
        error: "Desktop bridge is missing listThreads().",
        loading: false,
        threads: [],
        workspaceRoots: [],
      });
      return;
    }

    setState((current) => ({ ...current, error: undefined, loading: true }));
    try {
      const response = await listThreads({ archived: true });
      setState({
        fetchedAt: response.fetchedAt,
        loading: false,
        threads: response.threads,
        workspaceRoots: response.workspaceRoots ?? [],
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: errorMessage(error),
        loading: false,
      }));
    }
  }, [props.desktopApi]);

  useEffect(() => {
    void loadArchivedThreads();
  }, [loadArchivedThreads]);

  const filterQuery = filter.trim();
  const isFiltering = filterQuery.length > 0;
  const queryTerms = useMemo(
    () => filterQuery.toLocaleLowerCase().split(/\s+/).filter(Boolean),
    [filterQuery],
  );
  const displayThreads = useMemo(
    () =>
      sortArchivedThreads([
        ...state.threads.filter(
          (thread) => !restoredThreads.has(buildArchivedThreadKey(thread)),
        ),
        ...restoredThreads.values(),
      ]),
    [restoredThreads, state.threads],
  );
  const allGroups = useMemo(
    () => groupArchivedThreadsByProject(displayThreads, state.workspaceRoots),
    [displayThreads, state.workspaceRoots],
  );
  const projectGroups = useMemo(
    () =>
      queryTerms.length > 0
        ? filterArchivedProjectGroups(allGroups, queryTerms)
        : allGroups,
    [allGroups, queryTerms],
  );
  const totalRowCount = countGroupThreads(allGroups);
  const visibleRowCount = countGroupThreads(projectGroups);
  const restoredCount = restoredThreads.size;
  // Only a thread from a less common source is tagged with it; the usual
  // source goes without saying.
  const primarySource = useMemo(
    () => mostCommonSource(displayThreads),
    [displayThreads],
  );
  const updatedLabel = useMemo(
    () =>
      state.fetchedAt === undefined
        ? undefined
        : `Updated ${formatFetchedAt(state.fetchedAt)}`,
    [state.fetchedAt],
  );
  const hasLoaded = state.fetchedAt !== undefined;

  const setRowAction = (key: string, action: ArchivedRowAction | undefined) => {
    setRowActions((current) => {
      const next = new Map(current);
      if (action) {
        next.set(key, action);
      } else {
        next.delete(key);
      }
      return next;
    });
  };

  const restoreThread = async (thread: AppServerThreadSummary) => {
    const threadKey = buildArchivedThreadKey(thread);
    if (pendingRowKeysRef.current.has(threadKey)) {
      return;
    }
    const restoreThreadRequest = props.desktopApi?.restoreThread;
    if (!restoreThreadRequest) {
      setRowAction(threadKey, {
        error: "Desktop bridge is missing restoreThread().",
      });
      return;
    }

    pendingRowKeysRef.current.add(threadKey);
    setRowAction(threadKey, { pending: "restore" });
    try {
      await restoreThreadRequest({
        backend: thread.source,
        threadId: thread.id,
      });
      setRestoredThreads((current) => new Map(current).set(threadKey, thread));
      setRowAction(threadKey, undefined);
    } catch (error) {
      setRowAction(threadKey, {
        error: `Restore failed: ${errorMessage(error)}`,
      });
    } finally {
      pendingRowKeysRef.current.delete(threadKey);
    }
  };

  // Not an undo: this is the normal archive path, worktree snapshots
  // included, so the row goes back to the archived list as a fresh archive.
  const archiveThreadAgain = async (thread: AppServerThreadSummary) => {
    const threadKey = buildArchivedThreadKey(thread);
    if (pendingRowKeysRef.current.has(threadKey)) {
      return;
    }
    const archiveThreadRequest = props.desktopApi?.archiveThread;
    if (!archiveThreadRequest) {
      setRowAction(threadKey, {
        error: "Desktop bridge is missing archiveThread().",
      });
      return;
    }

    pendingRowKeysRef.current.add(threadKey);
    setRowAction(threadKey, { pending: "archive" });
    try {
      const response = await archiveThreadRequest({
        backend: thread.source,
        threadId: thread.id,
      });
      setState((current) =>
        current.threads.some(
          (candidate) => buildArchivedThreadKey(candidate) === threadKey,
        )
          ? current
          : { ...current, threads: [...current.threads, thread] },
      );
      setRestoredThreads((current) => {
        const next = new Map(current);
        next.delete(threadKey);
        return next;
      });
      const cleanupNotice = describeArchiveCleanup(response.cleanup);
      setRowAction(threadKey, cleanupNotice ? { notice: cleanupNotice } : undefined);
    } catch (error) {
      setRowAction(threadKey, {
        error: `Archive failed: ${errorMessage(error)}`,
      });
    } finally {
      pendingRowKeysRef.current.delete(threadKey);
    }
  };

  let toolbarStatus: ReactNode;
  if (state.loading && !hasLoaded) {
    toolbarStatus = (
      <>
        <span aria-hidden="true" className="pending-spinner pending-spinner--sm" />
        <span>Loading…</span>
      </>
    );
  } else if (!hasLoaded) {
    toolbarStatus = <span>Not loaded</span>;
  } else {
    toolbarStatus = joinWithDots([
      isFiltering ? (
        <span key="count">
          <b>{visibleRowCount}</b> of {totalRowCount}
        </span>
      ) : (
        <span key="count">
          <b>{totalRowCount - restoredCount}</b>{" "}
          {totalRowCount - restoredCount === 1 ? "thread" : "threads"}
        </span>
      ),
      !isFiltering && restoredCount > 0 ? (
        <span key="restored">{restoredCount} restored</span>
      ) : null,
      <span key="updated">{updatedLabel}</span>,
    ]);
  }

  return (
    <SettingsSectionStack paneId="archived" aria-label="Archived Threads settings">
      <SettingsPanelHead
        eyebrow="Archived Threads"
        title="Archived threads"
        help="Archived threads stay out of Inbox, Recents, and Directories until you restore them."
      />

      <div className="settings-archive-toolbar">
        <div
          className="settings-archive-filter"
          role="search"
          aria-label="Archived thread search"
        >
          <SearchIcon
            aria-hidden
            className="settings-archive-filter__icon"
            size={13}
          />
          <input
            className="settings-input settings-archive-filter__input"
            aria-label="Filter archived threads"
            placeholder="Filter by title, thread ID, branch, or project"
            spellCheck={false}
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && isFiltering) {
                event.preventDefault();
                setFilter("");
              }
            }}
          />
          {isFiltering ? (
            <button
              aria-label="Clear archived thread filter"
              className="button button--ghost settings-archive-filter__clear"
              type="button"
              onClick={() => setFilter("")}
            >
              Clear
            </button>
          ) : null}
        </div>
        <p className="settings-archive-toolbar__status" role="status">
          {toolbarStatus}
        </p>
        <button
          className="button button--ghost settings-section-controls__button"
          disabled={state.loading}
          type="button"
          onClick={() => {
            void loadArchivedThreads();
          }}
        >
          Refresh
        </button>
      </div>

      {state.error ? (
        <div className="settings-archive-banner" role="alert">
          <p className="settings-archive-banner__text">
            <b>
              {hasLoaded
                ? `Couldn’t refresh. Showing the list from ${formatFetchedAt(state.fetchedAt ?? 0)}.`
                : "Couldn’t load archived threads"}
            </b>
            <span>{state.error}</span>
          </p>
          <button
            className="button button--secondary settings-section-controls__button"
            disabled={state.loading}
            type="button"
            onClick={() => {
              void loadArchivedThreads();
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {state.loading && !hasLoaded ? <ArchivedThreadsSkeleton /> : null}

      {hasLoaded && totalRowCount === 0 ? (
        <div className="settings-archive-empty">
          <p className="settings-archive-empty__title">No archived threads</p>
          <p className="settings-archive-empty__detail">
            Threads you archive are listed here by project, ready to restore.
          </p>
        </div>
      ) : null}

      {isFiltering && totalRowCount > 0 && visibleRowCount === 0 ? (
        <div className="settings-archive-empty">
          <p className="settings-archive-empty__title">
            No archived threads match “{filterQuery}”.
          </p>
          <p className="settings-archive-empty__detail">
            Matching checks the title, summary, thread ID, branch, and project
            path.
          </p>
          <div className="settings-archive-empty__actions">
            <button
              className="button button--ghost settings-section-controls__button"
              type="button"
              onClick={() => setFilter("")}
            >
              Clear filter
            </button>
          </div>
        </div>
      ) : null}

      {projectGroups.map((group) => {
        const showAll = isFiltering || expandedGroupKeys.has(group.key);
        const visibleThreads = showAll
          ? group.threads
          : group.threads.slice(0, ARCHIVED_THREADS_PER_PROJECT_LIMIT);
        const hiddenThreadCount = group.threads.length - visibleThreads.length;
        const groupRestoredCount = group.threads.filter((thread) =>
          restoredThreads.has(buildArchivedThreadKey(thread)),
        ).length;
        return (
          <SettingsSection
            key={group.key}
            className="settings-archive-group"
            title={group.label}
            description={
              group.path ? (
                <span className="settings-archive-path">{group.path}</span>
              ) : undefined
            }
            chip={
              groupRestoredCount > 0
                ? `${group.threads.length - groupRestoredCount} · ${groupRestoredCount} restored`
                : String(group.threads.length)
            }
            chipKind="muted"
          >
            <div className="settings-archive-project__threads">
              {visibleThreads.map((thread) => {
                const threadKey = buildArchivedThreadKey(thread);
                const action = rowActions.get(threadKey);
                return restoredThreads.has(threadKey) ? (
                  <RestoredThreadRow
                    key={threadKey}
                    action={action}
                    desktopApi={props.desktopApi}
                    queryTerms={queryTerms}
                    showSource={thread.source !== primarySource}
                    thread={thread}
                    onArchiveAgain={() => {
                      void archiveThreadAgain(thread);
                    }}
                    onOpenThread={props.onOpenThread}
                  />
                ) : (
                  <ArchivedThreadRow
                    key={threadKey}
                    action={action}
                    desktopApi={props.desktopApi}
                    groupLabel={group.label}
                    queryTerms={queryTerms}
                    showSource={thread.source !== primarySource}
                    thread={thread}
                    onRestore={() => {
                      void restoreThread(thread);
                    }}
                  />
                );
              })}
              {hiddenThreadCount > 0 ? (
                <div className="settings-archive-more">
                  <span>{hiddenThreadCount} older</span>
                  <button
                    className="settings-archive-more__button"
                    type="button"
                    onClick={() =>
                      setExpandedGroupKeys((current) =>
                        new Set(current).add(group.key),
                      )
                    }
                  >
                    Show all {group.threads.length}
                  </button>
                </div>
              ) : null}
            </div>
          </SettingsSection>
        );
      })}
    </SettingsSectionStack>
  );
}

function ArchivedThreadRow(props: {
  action?: ArchivedRowAction;
  desktopApi?: DesktopApi;
  groupLabel: string;
  queryTerms: readonly string[];
  showSource: boolean;
  thread: AppServerThreadSummary;
  onRestore: () => void;
}) {
  const thread = props.thread;
  const terms = props.queryTerms;
  const restoring = props.action?.pending === "restore";
  // An ID match swaps the summary for the full ID, so the operator can see
  // what the filter matched.
  const idMatched = terms.some((term) =>
    thread.id.toLocaleLowerCase().includes(term),
  );
  const otherDirectories = [
    ...new Set(
      thread.linkedDirectories
        .map((directory) => directory.label || pathBaseName(directory.path))
        .filter((label) => label && label !== props.groupLabel),
    ),
  ];
  const timestamp =
    resolveArchiveTimestamp(thread) ?? thread.updatedAt ?? thread.createdAt;

  return (
    <article className="settings-archive-row">
      <div className="settings-archive-row__body">
        <div className="settings-archive-row__line">
          <h3 className="settings-archive-row__title">
            {highlightMatches(thread.title, terms)}
          </h3>
          {props.showSource ? (
            <span className="settings-pathrow__chip">{thread.source}</span>
          ) : null}
        </div>
        {!idMatched && thread.summary ? (
          <p className="settings-archive-row__summary">
            {highlightMatches(thread.summary, terms)}
          </p>
        ) : null}
        <p className="settings-archive-row__meta">
          {joinWithDots([
            timestamp ? (
              <span key="time">{formatTimestamp(timestamp)}</span>
            ) : null,
            thread.gitBranch ? (
              <span key="branch">{highlightMatches(thread.gitBranch, terms)}</span>
            ) : null,
            idMatched ? null : (
              <CopyThreadIdButton
                key="id"
                desktopApi={props.desktopApi}
                thread={thread}
                variant="short"
              />
            ),
            otherDirectories.length > 0 ? (
              <span key="dirs">also {otherDirectories.join(", ")}</span>
            ) : null,
          ])}
        </p>
        {idMatched ? (
          <p className="settings-archive-row__meta">
            <span className="settings-archive-row__id">
              {highlightMatches(thread.id, terms)}
            </span>
            <CopyThreadIdButton
              desktopApi={props.desktopApi}
              thread={thread}
              variant="link"
            />
          </p>
        ) : null}
        {props.action?.notice ? (
          <p className="settings-archive-row__notice" role="status">
            {props.action.notice}
          </p>
        ) : null}
        {props.action?.error ? (
          <p className="settings-archive-row__error" role="alert">
            {props.action.error}
          </p>
        ) : null}
      </div>
      <div className="settings-archive-row__side">
        <button
          aria-disabled={restoring || undefined}
          className="button button--secondary settings-archive-row__button"
          type="button"
          onClick={restoring ? undefined : props.onRestore}
        >
          {restoring ? "Restoring…" : props.action?.error ? "Retry" : "Restore"}
        </button>
      </div>
    </article>
  );
}

function RestoredThreadRow(props: {
  action?: ArchivedRowAction;
  desktopApi?: DesktopApi;
  queryTerms: readonly string[];
  showSource: boolean;
  thread: AppServerThreadSummary;
  onArchiveAgain: () => void;
  onOpenThread?: (target: OpenThreadTarget) => void;
}) {
  const thread = props.thread;
  const archiving = props.action?.pending === "archive";

  return (
    <article className="settings-archive-row settings-archive-row--restored">
      <div className="settings-archive-row__body">
        <div className="settings-archive-row__line">
          <span className="settings-pathrow__chip settings-pathrow__chip--ok">
            Restored
          </span>
          <h3 className="settings-archive-row__title">
            {highlightMatches(thread.title, props.queryTerms)}
          </h3>
          {props.showSource ? (
            <span className="settings-pathrow__chip">{thread.source}</span>
          ) : null}
        </div>
        <p className="settings-archive-row__restored-note">
          Back in Inbox, Recents, and Directories.
        </p>
        <p className="settings-archive-row__meta">
          <span className="settings-archive-row__id">
            {highlightMatches(thread.id, props.queryTerms)}
          </span>
          <CopyThreadIdButton
            desktopApi={props.desktopApi}
            thread={thread}
            variant="link"
          />
        </p>
        {props.action?.error ? (
          <p className="settings-archive-row__error" role="alert">
            {props.action.error}
          </p>
        ) : null}
      </div>
      <div className="settings-archive-row__side">
        <button
          aria-disabled={archiving || undefined}
          aria-label={`Archive ${thread.title} again`}
          className="button button--ghost settings-archive-row__button"
          type="button"
          onClick={archiving ? undefined : props.onArchiveAgain}
        >
          {archiving ? "Archiving…" : "Archive again"}
        </button>
        {props.onOpenThread ? (
          <button
            aria-label={`Open ${thread.title}`}
            className="button button--secondary settings-archive-row__button"
            type="button"
            onClick={() =>
              props.onOpenThread?.({
                backend: thread.source,
                threadId: thread.id,
              })
            }
          >
            Open thread
          </button>
        ) : null}
      </div>
    </article>
  );
}

function CopyThreadIdButton(props: {
  desktopApi?: DesktopApi;
  thread: AppServerThreadSummary;
  /** `short` shows the ID's first characters; `link` sits beside a full ID. */
  variant: "short" | "link";
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(copiedTimerRef.current), []);

  const copyThreadId = async () => {
    try {
      await copyText(props.thread.id, props.desktopApi);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(
      () => setCopied(false),
      COPIED_FEEDBACK_MS,
    );
  };

  const label =
    props.variant === "short"
      ? props.thread.id.slice(0, SHORT_THREAD_ID_LENGTH)
      : "Copy ID";
  return (
    <button
      aria-label={`Copy thread ID for ${props.thread.title}`}
      className={`settings-archive-copy-id settings-archive-copy-id--${props.variant}${
        copied ? " is-copied" : ""
      }`}
      type="button"
      onClick={() => {
        void copyThreadId();
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function ArchivedThreadsSkeleton() {
  return (
    <div className="settings-archive-skeleton" aria-hidden="true">
      <div className="settings-archive-skeleton__head">
        <span className="settings-archive-skeleton__bar" />
      </div>
      {[0, 1].map((index) => (
        <div key={index} className="settings-archive-skeleton__row">
          <span className="settings-archive-skeleton__bar" />
          <span className="settings-archive-skeleton__bar" />
          <span className="settings-archive-skeleton__bar" />
        </div>
      ))}
    </div>
  );
}

/** Interleaves `·` separators between the present items. */
function joinWithDots(items: ReactNode[]): ReactNode[] {
  const present = items.filter((item) => item !== null && item !== undefined);
  return present.flatMap((item, index) =>
    index === 0
      ? [item]
      : [
          <span
            key={`dot-${index}`}
            aria-hidden="true"
            className="settings-archive-dot"
          >
            ·
          </span>,
          item,
        ],
  );
}

/** Wraps each case-insensitive occurrence of a filter term in `<mark>`. */
function highlightMatches(text: string, terms: readonly string[]): ReactNode {
  if (terms.length === 0 || !text) {
    return text;
  }
  const lowerText = text.toLocaleLowerCase();
  // Offsets found in the lowercased text index the original only while the
  // two are the same length; a few characters ("İ") lowercase to two.
  if (lowerText.length !== text.length) {
    return text;
  }
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    let index = lowerText.indexOf(term);
    while (index !== -1) {
      ranges.push([index, index + term.length]);
      index = lowerText.indexOf(term, index + term.length);
    }
  }
  if (ranges.length === 0) {
    return text;
  }

  ranges.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([range[0], range[1]]);
    }
  }

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) {
      parts.push(text.slice(cursor, start));
    }
    parts.push(
      <mark key={start} className="settings-archive-hit">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts;
}

function countGroupThreads(groups: ArchivedProjectGroup[]): number {
  return groups.reduce((count, group) => count + group.threads.length, 0);
}

/** What an archive's worktree cleanup left behind, if anything. */
function describeArchiveCleanup(
  cleanup: readonly ArchiveThreadCleanupResult[],
): string | undefined {
  const failure = cleanup.find(
    (item) => !item.removedWorktree || item.error || item.skippedReason,
  );
  if (!failure) {
    return undefined;
  }
  const reason = failure.error ?? failure.skippedReason ?? "cleanup was skipped";
  const location = failure.worktreePath ? `${failure.worktreePath}: ` : "";
  return `Archived. The worktree was not removed (${location}${reason}).`;
}

/** The failure without the "Error invoking remote method …" wrapper Electron adds. */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}

function mostCommonSource(
  threads: readonly AppServerThreadSummary[],
): AppServerThreadSummary["source"] | undefined {
  const counts = new Map<AppServerThreadSummary["source"], number>();
  for (const thread of threads) {
    counts.set(thread.source, (counts.get(thread.source) ?? 0) + 1);
  }
  let primary: AppServerThreadSummary["source"] | undefined;
  let primaryCount = 0;
  for (const [source, count] of counts) {
    if (count > primaryCount) {
      primary = source;
      primaryCount = count;
    }
  }
  return primary;
}

function sortArchivedThreads(
  threads: AppServerThreadSummary[],
): AppServerThreadSummary[] {
  return [...threads].sort((left, right) => {
    const rightTimestamp = resolveArchiveSortTimestamp(right);
    const leftTimestamp = resolveArchiveSortTimestamp(left);
    const timestampDelta = rightTimestamp - leftTimestamp;
    return timestampDelta !== 0
      ? timestampDelta
      : left.title.localeCompare(right.title);
  });
}

function groupArchivedThreadsByProject(
  threads: AppServerThreadSummary[],
  workspaceRoots: string[] = [],
): ArchivedProjectGroup[] {
  const groups = new Map<string, ArchivedProjectGroup>();
  for (const thread of threads) {
    const project = resolveArchivedProject(thread, workspaceRoots);
    if (!project) {
      continue;
    }
    const existing = groups.get(project.key);
    if (existing) {
      existing.threads.push(thread);
      existing.latestArchiveTimestamp = Math.max(
        existing.latestArchiveTimestamp,
        project.latestArchiveTimestamp,
      );
      continue;
    }
    groups.set(project.key, {
      ...project,
      threads: [thread],
    });
  }

  return [...groups.values()].sort((left, right) => {
    if (left.key === "__no-project__") return 1;
    if (right.key === "__no-project__") return -1;
    const timestampDelta =
      right.latestArchiveTimestamp - left.latestArchiveTimestamp;
    return timestampDelta !== 0
      ? timestampDelta
      : left.label.localeCompare(right.label);
  });
}

function filterArchivedProjectGroups(
  groups: ArchivedProjectGroup[],
  queryTerms: readonly string[],
): ArchivedProjectGroup[] {
  return groups.flatMap((group) => {
    const threads = group.threads.filter((thread) =>
      archivedThreadMatchesFilter(thread, group, queryTerms),
    );
    return threads.length > 0 ? [{ ...group, threads }] : [];
  });
}

function archivedThreadMatchesFilter(
  thread: AppServerThreadSummary,
  group: ArchivedProjectGroup,
  queryTerms: readonly string[],
): boolean {
  const searchText = [
    group.label,
    group.path,
    thread.id,
    thread.title,
    thread.summary,
    thread.projectKey,
    thread.source,
    thread.gitBranch,
    thread.observedGitBranch,
    ...thread.linkedDirectories.flatMap((directory) => [
      directory.label,
      directory.path,
      directory.worktreePath,
    ]),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLocaleLowerCase();

  return queryTerms.every((term) => searchText.includes(term));
}

function resolveArchivedProject(
  thread: AppServerThreadSummary,
  workspaceRoots: string[] = [],
): ArchivedProjectIdentity | null | undefined {
  const workspaceProject = resolveWorkspaceProject(thread, workspaceRoots);
  if (workspaceProject !== undefined) {
    return workspaceProject;
  }

  const repositoryDirectory = resolveRepositoryLinkedDirectory(thread);
  if (repositoryDirectory) {
    return {
      key:
        repositoryDirectory.path ||
        repositoryDirectory.id ||
        repositoryDirectory.label,
      label:
        repositoryDirectory.label ||
        pathBaseName(repositoryDirectory.path) ||
        "Project",
      latestArchiveTimestamp: resolveArchiveSortTimestamp(thread),
      path: repositoryDirectory.path,
    };
  }

  const snapshotRepositoryPath = resolveSnapshotRepositoryPath(thread);
  if (snapshotRepositoryPath) {
    return {
      key: snapshotRepositoryPath,
      label: pathBaseName(snapshotRepositoryPath) || snapshotRepositoryPath,
      latestArchiveTimestamp: resolveArchiveSortTimestamp(thread),
      path: snapshotRepositoryPath,
    };
  }

  const managedWorktreeProject = resolveManagedWorktreeProject(thread);
  if (managedWorktreeProject) {
    return {
      ...managedWorktreeProject,
      latestArchiveTimestamp: resolveArchiveSortTimestamp(thread),
    };
  }

  const projectKey = thread.projectKey?.trim();
  if (projectKey) {
    return {
      key: projectKey,
      label: pathBaseName(projectKey) || projectKey,
      latestArchiveTimestamp: resolveArchiveSortTimestamp(thread),
      path: projectKey,
    };
  }

  return {
    key: "__no-project__",
    label: "No project",
    latestArchiveTimestamp: resolveArchiveSortTimestamp(thread),
  };
}

function resolveWorkspaceProject(
  thread: AppServerThreadSummary,
  workspaceRoots: string[],
): ArchivedProjectIdentity | null | undefined {
  const workspaceRoot = threadWorkspaceRoot(thread);
  if (!workspaceRoot) {
    return undefined;
  }

  const activeRoot = activeWorkspaceRoot(workspaceRoot, workspaceRoots);
  if (!activeRoot) {
    return null;
  }

  return {
    key: `workspace:${activeRoot}`,
    label: "Workspaces",
    latestArchiveTimestamp: resolveArchiveSortTimestamp(thread),
    path: activeRoot,
  };
}

function threadWorkspaceRoot(
  thread: AppServerThreadSummary,
): string | undefined {
  return [
    thread.projectKey,
    ...thread.linkedDirectories.flatMap((directory) => [
      directory.path,
      directory.worktreePath,
    ]),
  ]
    .map(matchScratchProjectsRoot)
    .find((root): root is string => Boolean(root));
}

function activeWorkspaceRoot(
  candidateRoot: string,
  workspaceRoots: string[],
): string | undefined {
  if (workspaceRoots.length === 0) {
    return candidateRoot;
  }

  const normalizedCandidate = normalizeComparablePath(candidateRoot);
  return workspaceRoots.find(
    (workspaceRoot) =>
      normalizeComparablePath(workspaceRoot) === normalizedCandidate,
  );
}

function matchScratchProjectsRoot(pathname: string | undefined): string | undefined {
  const normalized = normalizePath(pathname);
  if (!normalized) {
    return undefined;
  }

  const match = normalized.match(
    /^(.*\/\.pwrag(?:ent|nt)(?:\/profiles\/[^/]+)?\/projects)(?:\/.*)?$/,
  );
  return match?.[1];
}

function resolveRepositoryLinkedDirectory(
  thread: AppServerThreadSummary,
): AppServerThreadSummary["linkedDirectories"][number] | undefined {
  const localDirectory = thread.linkedDirectories.find(
    (candidate) =>
      candidate.kind === "local" &&
      candidate.path.trim() &&
      !isManagedWorktreePath(candidate.path),
  );
  if (localDirectory) {
    return localDirectory;
  }

  return thread.linkedDirectories.find((candidate) => {
    if (candidate.kind !== "worktree") {
      return false;
    }

    const directoryPath = candidate.path.trim();
    if (!directoryPath || isManagedWorktreePath(directoryPath)) {
      return false;
    }

    const worktreePath = candidate.worktreePath?.trim();
    return (
      !worktreePath ||
      normalizePath(directoryPath) !== normalizePath(worktreePath)
    );
  });
}

function resolveSnapshotRepositoryPath(
  thread: AppServerThreadSummary,
): string | undefined {
  return [...(thread.worktreeSnapshots ?? [])]
    .sort(
      (left, right) =>
        (right.archivedAt ?? right.createdAt) -
        (left.archivedAt ?? left.createdAt),
    )
    .map((snapshot) => snapshot.repositoryPath.trim())
    .find((repositoryPath) => {
      if (!repositoryPath || isManagedWorktreePath(repositoryPath)) {
        return false;
      }
      return !(thread.worktreeSnapshots ?? []).some(
        (snapshot) =>
          normalizePath(snapshot.worktreePath) === normalizePath(repositoryPath),
      );
    });
}

function resolveManagedWorktreeProject(
  thread: AppServerThreadSummary,
): ArchivedProjectIdentity | undefined {
  const managedPath =
    thread.linkedDirectories
      .flatMap((directory) => [directory.worktreePath, directory.path])
      .find((candidate) => candidate && isManagedWorktreePath(candidate)) ??
    (isManagedWorktreePath(thread.projectKey) ? thread.projectKey : undefined);
  if (!managedPath) {
    return undefined;
  }

  const label =
    thread.linkedDirectories
      .find((directory) => directory.label.trim())
      ?.label.trim() ||
    pathBaseName(managedPath) ||
    "Project";
  return {
    key: `managed-worktree:${label}`,
    label,
    path: `Recovered from managed worktrees named ${label}`,
    latestArchiveTimestamp: resolveArchiveSortTimestamp(thread),
  };
}

function resolveArchiveSortTimestamp(thread: AppServerThreadSummary): number {
  return (
    resolveArchiveTimestamp(thread) ??
    thread.updatedAt ??
    thread.createdAt ??
    0
  );
}

function resolveArchiveTimestamp(
  thread: AppServerThreadSummary,
): number | undefined {
  const explicitArchivedAt = thread.archivedAt;
  if (explicitArchivedAt) {
    return explicitArchivedAt;
  }

  return (thread.worktreeSnapshots ?? []).reduce<number | undefined>(
    (latest, snapshot) => {
      if (!snapshot.archivedAt) {
        return latest;
      }
      return latest === undefined
        ? snapshot.archivedAt
        : Math.max(latest, snapshot.archivedAt);
    },
    undefined,
  );
}

function buildArchivedThreadKey(thread: AppServerThreadSummary): string {
  return buildThreadIdentityKey(thread.source, thread.id);
}

function formatTimestamp(timestamp: number): string {
  return dateFormatter.format(timestamp);
}

/** Time only when the list was fetched today; otherwise date and time. */
function formatFetchedAt(timestamp: number): string {
  const fetched = new Date(timestamp);
  return fetched.toDateString() === new Date().toDateString()
    ? timeFormatter.format(fetched)
    : dateFormatter.format(fetched);
}

function pathBaseName(pathname: string): string {
  return pathname.split(/[\\/]/).filter(Boolean).at(-1) ?? pathname;
}

function isManagedWorktreePath(pathname: string | undefined): boolean {
  return isToolManagedWorktreePath(normalizePath(pathname));
}

function normalizePath(pathname: string | undefined): string {
  return pathname?.trim().replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
}

function normalizeComparablePath(pathname: string | undefined): string {
  return normalizePath(pathname).replace(/\/+$/, "");
}
