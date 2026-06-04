import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEventHandler,
} from "react";
import {
  isToolManagedWorktreePath,
  type ListThreadMigrationSourcesResponse,
  type StartThreadMigrationResponse,
  type ThreadIdentifier,
  type ThreadMigrationCopyStrategy,
  type ThreadMigrationOperation,
  type ThreadMigrationRunItem,
  type ThreadMigrationSourceProjectGroup,
  type ThreadMigrationSourceThreadSummary,
  type ThreadMigrationSourceProfileSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";

type SourceThreadsState = {
  error?: string;
  fetchedAt?: number;
  loading: boolean;
  projects: ThreadMigrationSourceProjectGroup[];
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function safeProjectThreads(
  project: ThreadMigrationSourceProjectGroup,
): ThreadMigrationSourceThreadSummary[] {
  return Array.isArray(project.threads)
    ? project.threads.filter((thread): thread is ThreadMigrationSourceThreadSummary =>
        Boolean(thread),
      )
    : [];
}

function hasMalformedLinkedDirectories(
  thread: ThreadMigrationSourceThreadSummary,
): boolean {
  return (
    !Array.isArray(thread.linkedDirectories) ||
    thread.linkedDirectories.some(
      (directory) => !directory || typeof directory !== "object",
    )
  );
}

function hasProfileOwnedWorktree(
  thread: ThreadMigrationSourceThreadSummary,
): boolean {
  return (
    isToolManagedWorktreePath(thread.projectKey) ||
    (Array.isArray(thread.linkedDirectories)
      ? thread.linkedDirectories.some(
          (directory) =>
            Boolean(directory) &&
            typeof directory === "object" &&
            (isToolManagedWorktreePath(directory.worktreePath) ||
              isToolManagedWorktreePath(directory.path)),
        )
      : false)
  );
}

export function ThreadManagementSettings(props: { desktopApi?: DesktopApi }) {
  const [sources, setSources] = useState<ListThreadMigrationSourcesResponse>();
  const [sourcesError, setSourcesError] = useState<string>();
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [selectedProfile, setSelectedProfile] = useState<string>();
  const [threadsState, setThreadsState] = useState<SourceThreadsState>({
    loading: false,
    projects: [],
  });
  const [selectedThreadIds, setSelectedThreadIds] = useState<Set<ThreadIdentifier>>(
    () => new Set(),
  );
  const [run, setRun] = useState<StartThreadMigrationResponse>();
  const [startError, setStartError] = useState<string>();
  const [startingOperation, setStartingOperation] =
    useState<ThreadMigrationOperation>();
  const [retryingThreadId, setRetryingThreadId] = useState<ThreadIdentifier>();
  const [copyStrategy, setCopyStrategy] =
    useState<ThreadMigrationCopyStrategy>("detached-destination");
  const [includeArchived, setIncludeArchived] = useState(false);
  const sourceThreadsRequestIdRef = useRef(0);

  const loadSources = useCallback(async () => {
    const listSources = props.desktopApi?.listThreadMigrationSources;
    if (!listSources) {
      setSourcesError("Desktop bridge is missing listThreadMigrationSources().");
      setSourcesLoading(false);
      return;
    }

    setSourcesLoading(true);
    setSourcesError(undefined);
    try {
      const response = await listSources();
      setSources(response);
      setSelectedProfile((current) => {
        if (current && response.profiles.some((profile) => profile.profile === current)) {
          return current;
        }
        return response.profiles.find((profile) => profile.available)?.profile;
      });
    } catch (error) {
      setSourcesError(error instanceof Error ? error.message : String(error));
    } finally {
      setSourcesLoading(false);
    }
  }, [props.desktopApi]);

  const loadSourceThreads = useCallback(
    async (profile: string | undefined, archived: boolean) => {
      const requestId = sourceThreadsRequestIdRef.current + 1;
      sourceThreadsRequestIdRef.current = requestId;
      if (profile === undefined) {
        setThreadsState({ loading: false, projects: [] });
        setSelectedThreadIds(new Set());
        return;
      }
      const listThreads = props.desktopApi?.listThreadMigrationSourceThreads;
      if (!listThreads) {
        setThreadsState({
          error: "Desktop bridge is missing listThreadMigrationSourceThreads().",
          loading: false,
          projects: [],
        });
        return;
      }

      setThreadsState((current) => ({
        ...current,
        error: undefined,
        loading: true,
      }));
      setSelectedThreadIds(new Set());
      setRun(undefined);
      try {
        const response = await listThreads({
          sourceProfile: profile,
          archived,
        });
        if (sourceThreadsRequestIdRef.current !== requestId) {
          return;
        }
        setThreadsState({
          fetchedAt: response.fetchedAt,
          loading: false,
          projects: response.projects,
        });
      } catch (error) {
        if (sourceThreadsRequestIdRef.current !== requestId) {
          return;
        }
        setThreadsState({
          error: error instanceof Error ? error.message : String(error),
          loading: false,
          projects: [],
        });
      }
    },
    [props.desktopApi],
  );

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  useEffect(() => {
    void loadSourceThreads(selectedProfile, includeArchived);
  }, [includeArchived, loadSourceThreads, selectedProfile]);

  const selectedSource = sources?.profiles.find(
    (profile) => profile.profile === selectedProfile,
  );
  const runItemsByThreadId = useMemo(
    () =>
      new Map(
        run?.items.map((item) => [item.sourceThreadId, item] as const) ?? [],
      ),
    [run],
  );
  const runWarningCount =
    run?.items.reduce((count, item) => count + (item.warnings?.length ?? 0), 0) ??
    0;
  const runCompletedWithWarningsCount =
    run?.items.filter(
      (item) => item.status === "completed" && (item.warnings?.length ?? 0) > 0,
    ).length ?? 0;
  const selectedCount = selectedThreadIds.size;
  const selectedHasManagedWorktree = useMemo(
    () =>
      threadsState.projects.some((project) =>
        safeProjectThreads(project).some(
          (thread) =>
            selectedThreadIds.has(thread.threadId) &&
            hasProfileOwnedWorktree(thread),
        ),
      ),
    [selectedThreadIds, threadsState.projects],
  );
  const canStartBase =
    Boolean(selectedSource?.available) &&
    selectedCount > 0 &&
    !startingOperation &&
    !threadsState.loading;
  const canMove = canStartBase;
  const canCopy = canStartBase;

  const toggleThread = (threadId: ThreadIdentifier) => {
    setSelectedThreadIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  };

  const selectProject = (project: ThreadMigrationSourceProjectGroup) => {
    const projectThreads = safeProjectThreads(project);
    const malformedThreadCount = projectThreads.filter(
      hasMalformedLinkedDirectories,
    ).length;
    if (malformedThreadCount > 0) {
      void props.desktopApi?.logRendererDiagnostic?.({
        level: "warn",
        message: "Thread migration source project has malformed linked directories.",
        details: {
          malformedThreadCount,
          projectKey: project.key,
          projectLabel: project.label,
          threadCount: projectThreads.length,
        },
      })?.catch(() => undefined);
    }
    setSelectedThreadIds((current) => {
      const next = new Set(current);
      const currentAllSelected = projectThreads.every((thread) =>
        next.has(thread.threadId),
      );
      for (const thread of projectThreads) {
        if (currentAllSelected) {
          next.delete(thread.threadId);
        } else {
          next.add(thread.threadId);
        }
      }
      return next;
    });
  };

  const startMigration = async (operation: ThreadMigrationOperation) => {
    const startThreadMigration = props.desktopApi?.startThreadMigration;
    if (!startThreadMigration || !selectedSource) {
      setStartError("Desktop bridge is missing startThreadMigration().");
      return;
    }
    setStartingOperation(operation);
    setStartError(undefined);
    try {
      const response = await startThreadMigration({
        sourceProfile: selectedSource.profile,
        operation,
        ...(operation === "copy" ? { copyStrategy } : {}),
        threadIds: [...selectedThreadIds],
      });
      setRun(response);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setStartingOperation(undefined);
    }
  };

  const retryMigration = async (threadId: ThreadIdentifier) => {
    const retryThreadMigration = props.desktopApi?.retryThreadMigration;
    if (!retryThreadMigration || !selectedSource || !run) {
      setStartError("Desktop bridge is missing retryThreadMigration().");
      return;
    }
    setRetryingThreadId(threadId);
    setStartError(undefined);
    try {
      const response = await retryThreadMigration({
        sourceProfile: selectedSource.profile,
        operation: run.operation,
        ...(run.operation === "copy" ? { copyStrategy } : {}),
        threadId,
      });
      const retryItem = response.items[0];
      if (!retryItem) {
        return;
      }
      setRun((current) => {
        if (!current) {
          return response;
        }
        return {
          ...current,
          items: current.items.map((item) =>
            item.sourceThreadId === retryItem.sourceThreadId ? retryItem : item,
          ),
        };
      });
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setRetryingThreadId(undefined);
    }
  };

  return (
    <SettingsSectionStack
      paneId="thread-management"
      aria-label="Thread Management settings"
    >
      <SettingsPanelHead
        eyebrow="Thread Management"
        title="Thread migration"
        help="Copy or move Codex threads from another Codex auth profile into this profile through Codex App Server."
        action={
          <button
            className="button button--secondary"
            disabled={sourcesLoading}
            type="button"
            onClick={() => {
              void loadSources();
            }}
          >
            Refresh
          </button>
        }
      />

      <SettingsSection
        eyebrow="Source"
        title="Codex profiles"
        description="The active Codex auth profile is excluded from migration sources."
        chip={sourcesLoading ? "loading" : `${sources?.profiles.length ?? 0} profiles`}
        chipKind="muted"
      >
        {sourcesLoading ? (
          <p className="settings-empty settings-thread-management__status">
            Loading source profiles...
          </p>
        ) : null}
        {sourcesError ? (
          <p className="settings-row__error settings-thread-management__status" role="alert">
            {sourcesError}
          </p>
        ) : null}
        {!sourcesLoading && !sourcesError && sources?.profiles.length === 0 ? (
          <p className="settings-empty settings-thread-management__status">
            No other Codex profiles found.
          </p>
        ) : null}
        {sources?.profiles.length ? (
          <div className="settings-paths">
            {sources.profiles.map((profile) => (
              <SourceProfileRow
                key={profile.profile || "__default__"}
                profile={profile}
                selected={selectedProfile === profile.profile}
                onSelect={() => {
                  if (profile.available) {
                    setSelectedProfile(profile.profile);
                  }
                }}
              />
            ))}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        eyebrow="Selection"
        title="Threads"
        description={selectedSource?.displayName ?? "Choose a source profile."}
        chip={
          threadsState.loading
            ? "loading"
            : selectedCount
              ? `${selectedCount} selected`
              : "none selected"
        }
        chipKind={selectedCount ? "ok" : "muted"}
      >
        {threadsState.error ? (
          <p className="settings-row__error settings-thread-management__status" role="alert">
            {threadsState.error}
          </p>
        ) : null}
        {threadsState.loading ? (
          <p className="settings-empty settings-thread-management__status">
            Loading source threads...
          </p>
        ) : null}
        {!threadsState.loading &&
        !threadsState.error &&
        selectedSource &&
        threadsState.projects.length === 0 ? (
          <p className="settings-empty settings-thread-management__status">
            No source threads found.
          </p>
        ) : null}
        <div className="settings-thread-management__selection-shell">
          <div className="settings-thread-management__actionbar">
            <div className="settings-thread-management__actioncopy">
              <p className="settings-thread-management__action-title">
                Migration action
              </p>
              <p className="settings-thread-management__action-description">
                {selectedCount === 0
                  ? "Select one or more threads to enable Move or Copy."
                  : selectedHasManagedWorktree
                    ? "Move transfers branches to destination worktrees before archiving the source. Copy leaves source branches active and uses the selected strategy."
                    : "Move copies, validates, then archives source last. Copy leaves source threads active."}
              </p>
            </div>
            <div className="settings-thread-management__controls">
              <label className="settings-thread-management__toggle">
                <input
                  checked={includeArchived}
                  type="checkbox"
                  onChange={(event) => {
                    setIncludeArchived(event.target.checked);
                  }}
                />
                <span>Show archived</span>
              </label>
              {selectedHasManagedWorktree ? (
                <label className="settings-thread-management__copy-strategy">
                  <span>Copy strategy</span>
                  <select
                    value={copyStrategy}
                    onChange={(event) =>
                      setCopyStrategy(
                        event.target.value as ThreadMigrationCopyStrategy,
                      )
                    }
                  >
                    <option value="detached-destination">
                      Detached destination
                    </option>
                  </select>
                </label>
              ) : null}
              <button
                className="button button--primary"
                disabled={!canMove}
                type="button"
                onClick={() => {
                  void startMigration("move");
                }}
              >
                {startingOperation === "move"
                  ? `Moving ${selectedCount}`
                  : `Move ${selectedCount}`}
              </button>
              <button
                className="button button--secondary"
                disabled={!canCopy}
                type="button"
                onClick={() => {
                  void startMigration("copy");
                }}
              >
                {startingOperation === "copy"
                  ? `Copying ${selectedCount}`
                  : `Copy ${selectedCount}`}
              </button>
            </div>
          </div>
          <div className="settings-thread-management__projects-list">
            {threadsState.projects.map((project) => {
              const projectThreads = safeProjectThreads(project);
              const projectSelected =
                projectThreads.length > 0 &&
                projectThreads.every((thread) =>
                  selectedThreadIds.has(thread.threadId),
                );
              return (
                <div className="settings-thread-management__project" key={project.key}>
                  <label className="settings-thread-management__project-head">
                    <input
                      checked={projectSelected}
                      className="settings-thread-management__checkbox-input"
                      type="checkbox"
                      onChange={() => selectProject(project)}
                    />
                    <span
                      aria-hidden="true"
                      className={`settings-thread-management__checkbox settings-thread-management__checkbox--project${
                        projectSelected ? " is-checked" : ""
                      }`}
                    />
                    <div>
                      <p className="settings-thread-management__project-title">
                        {project.label}
                      </p>
                      {project.path ? (
                        <p className="settings-thread-management__project-path">
                          {project.path}
                        </p>
                      ) : null}
                    </div>
                  </label>
                  <div>
                    {projectThreads.map((thread) => (
                      <label
                        key={thread.threadId}
                        className={`settings-thread-management__thread${
                          selectedThreadIds.has(thread.threadId)
                            ? " is-selected"
                            : ""
                        }`}
                      >
                        <input
                          checked={selectedThreadIds.has(thread.threadId)}
                          className="settings-thread-management__checkbox-input"
                          type="checkbox"
                          onChange={() => toggleThread(thread.threadId)}
                        />
                        <span
                          aria-hidden="true"
                          className={`settings-thread-management__checkbox${
                            selectedThreadIds.has(thread.threadId)
                              ? " is-checked"
                              : ""
                          }`}
                        />
                        <span className="settings-archive-row__body">
                          <span className="settings-archive-row__title">
                            {thread.title}
                          </span>
                          {thread.summary ? (
                            <span className="settings-archive-row__summary">
                              {thread.summary}
                            </span>
                          ) : null}
                          <span className="settings-archive-row__meta">
                            <span>{thread.threadId}</span>
                            {thread.gitBranch ? (
                              <span>{thread.gitBranch}</span>
                            ) : null}
                            {thread.updatedAt ? (
                              <span>
                                Updated {dateFormatter.format(thread.updatedAt)}
                              </span>
                            ) : null}
                          </span>
                          <RunDiagnostics
                            item={runItemsByThreadId.get(thread.threadId)}
                          />
                        </span>
                        <span className="settings-archive-row__side">
                          <RunStatus item={runItemsByThreadId.get(thread.threadId)} />
                          <RetryMigrationButton
                            item={runItemsByThreadId.get(thread.threadId)}
                            retrying={retryingThreadId === thread.threadId}
                            onRetry={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void retryMigration(thread.threadId);
                            }}
                          />
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {startError ? (
          <p className="settings-row__error settings-thread-management__status" role="alert">
            {startError}
          </p>
        ) : null}
        {run ? (
          <p className="settings-thread-management__status" role="status">
            Run {run.runId}: {run.items.filter((item) => item.status === "completed").length} of{" "}
            {run.items.length} completed
            {runWarningCount > 0
              ? `, ${runCompletedWithWarningsCount} with ${
                  runWarningCount === 1 ? "a warning" : "warnings"
                }`
              : ""}
            .
          </p>
        ) : null}
      </SettingsSection>
    </SettingsSectionStack>
  );
}

function SourceProfileRow(props: {
  profile: ThreadMigrationSourceProfileSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const label = props.profile.displayName || props.profile.profile || "System default";
  return (
    <button
      className={`settings-pathrow settings-thread-management__profile${
        props.selected ? " is-selected" : ""
      }`}
      disabled={!props.profile.available}
      type="button"
      onClick={props.onSelect}
    >
      <span className="settings-pathrow__body">
        <span className="settings-pathrow__title">{label}</span>
        <span className="settings-pathrow__path">{props.profile.codexHome}</span>
        {props.profile.accountEmail ? (
          <span className="settings-pathrow__meta">
            {props.profile.accountEmail}
          </span>
        ) : null}
        {props.profile.unavailableReason ? (
          <span className="settings-row__error">
            {props.profile.unavailableReason}
          </span>
        ) : null}
      </span>
      <span className="settings-pathrow__chips">
        <span
          className={`settings-pathrow__chip ${
            props.profile.available
              ? "settings-pathrow__chip--ok"
              : "settings-pathrow__chip--err"
          }`}
        >
          {props.profile.available ? "Available" : "Unavailable"}
        </span>
      </span>
    </button>
  );
}

function RunStatus(props: { item?: ThreadMigrationRunItem }) {
  if (!props.item) {
    return null;
  }
  const completedWithWarnings =
    props.item.status === "completed" && (props.item.warnings?.length ?? 0) > 0;
  return (
    <span
      className={`settings-pathrow__chip ${
        completedWithWarnings
          ? "settings-pathrow__chip--warn"
          : props.item.status === "completed"
          ? "settings-pathrow__chip--ok"
          : props.item.status === "failed"
            ? "settings-pathrow__chip--err"
            : "settings-pathrow__chip--warn"
      }`}
      title={[props.item.error, ...(props.item.warnings ?? [])]
        .filter(Boolean)
        .join("\n")}
    >
      {completedWithWarnings ? "completed with warning" : props.item.status}
    </span>
  );
}

function RetryMigrationButton(props: {
  item?: ThreadMigrationRunItem;
  retrying: boolean;
  onRetry: MouseEventHandler<HTMLButtonElement>;
}) {
  if (!props.item || props.item.status !== "failed") {
    return null;
  }
  return (
    <button
      className="button button--secondary settings-thread-management__retry"
      disabled={props.retrying}
      type="button"
      onClick={props.onRetry}
    >
      {props.retrying ? "Trying" : "Try harder"}
    </button>
  );
}

function RunDiagnostics(props: { item?: ThreadMigrationRunItem }) {
  const item = props.item;
  if (!item) {
    return null;
  }
  const detail = describeRunDetail(item);
  return (
    <span className="settings-thread-management__run-details">
      {detail ? (
        <span className="settings-thread-management__run-detail">{detail}</span>
      ) : null}
      {item.warnings?.map((warning) => (
        <span
          className="settings-thread-management__run-warning"
          key={warning}
        >
          {warning}
        </span>
      ))}
      {item.error ? (
        <span className="settings-thread-management__run-warning">
          {item.error}
        </span>
      ) : null}
    </span>
  );
}

function describeRunDetail(item: ThreadMigrationRunItem): string | undefined {
  const diagnostics = item.diagnostics;
  if (!diagnostics) {
    return undefined;
  }
  if (diagnostics.destinationWorktreePath) {
    return `Destination worktree ${diagnostics.destinationWorktreePath}`;
  }
  if (diagnostics.destinationDirectoryPath) {
    return `Destination ${diagnostics.destinationWorkMode ?? "local"} ${diagnostics.destinationDirectoryPath}`;
  }
  if (diagnostics.requestedWorkMode) {
    return `Requested ${diagnostics.requestedWorkMode}`;
  }
  return undefined;
}
