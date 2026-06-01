import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isToolManagedWorktreePath,
  type ListThreadMigrationSourcesResponse,
  type StartThreadMigrationResponse,
  type ThreadIdentifier,
  type ThreadMigrationOperation,
  type ThreadMigrationRunItem,
  type ThreadMigrationSourceProjectGroup,
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
  const [operation, setOperation] = useState<ThreadMigrationOperation>("move");
  const [run, setRun] = useState<StartThreadMigrationResponse>();
  const [startError, setStartError] = useState<string>();
  const [starting, setStarting] = useState(false);

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
    async (profile: string | undefined) => {
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
        const response = await listThreads({ sourceProfile: profile });
        setThreadsState({
          fetchedAt: response.fetchedAt,
          loading: false,
          projects: response.projects,
        });
      } catch (error) {
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
    void loadSourceThreads(selectedProfile);
  }, [loadSourceThreads, selectedProfile]);

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
  const selectedCount = selectedThreadIds.size;
  const selectedHasProfileOwnedWorktree = useMemo(
    () =>
      threadsState.projects.some((project) =>
        project.threads.some(
          (thread) =>
            selectedThreadIds.has(thread.threadId) &&
            thread.linkedDirectories.some(
              (directory) =>
                isToolManagedWorktreePath(directory.worktreePath) ||
                isToolManagedWorktreePath(directory.path),
            ),
        ),
      ),
    [selectedThreadIds, threadsState.projects],
  );
  const canStart =
    Boolean(selectedSource?.available) &&
    selectedCount > 0 &&
    !selectedHasProfileOwnedWorktree &&
    !starting &&
    !threadsState.loading;

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
    setSelectedThreadIds((current) => {
      const next = new Set(current);
      const allSelected = project.threads.every((thread) =>
        next.has(thread.threadId),
      );
      for (const thread of project.threads) {
        if (allSelected) {
          next.delete(thread.threadId);
        } else {
          next.add(thread.threadId);
        }
      }
      return next;
    });
  };

  const startMigration = async () => {
    const startThreadMigration = props.desktopApi?.startThreadMigration;
    if (!startThreadMigration || !selectedSource) {
      setStartError("Desktop bridge is missing startThreadMigration().");
      return;
    }
    setStarting(true);
    setStartError(undefined);
    try {
      const response = await startThreadMigration({
        sourceProfile: selectedSource.profile,
        operation,
        threadIds: [...selectedThreadIds],
      });
      setRun(response);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
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
        {threadsState.projects.map((project) => (
          <div className="settings-thread-management__project" key={project.key}>
            <label className="settings-thread-management__project-head">
              <input
                checked={project.threads.every((thread) =>
                  selectedThreadIds.has(thread.threadId),
                )}
                className="settings-thread-management__checkbox-input"
                type="checkbox"
                onChange={() => selectProject(project)}
              />
              <span
                aria-hidden="true"
                className={`settings-thread-management__checkbox settings-thread-management__checkbox--project${
                  project.threads.every((thread) =>
                    selectedThreadIds.has(thread.threadId),
                  )
                    ? " is-checked"
                    : ""
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
              {project.threads.map((thread) => (
                <label
                  key={thread.threadId}
                  className={`settings-thread-management__thread${
                    selectedThreadIds.has(thread.threadId) ? " is-selected" : ""
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
                      selectedThreadIds.has(thread.threadId) ? " is-checked" : ""
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
                      {thread.gitBranch ? <span>{thread.gitBranch}</span> : null}
                      {thread.updatedAt ? (
                        <span>Updated {dateFormatter.format(thread.updatedAt)}</span>
                      ) : null}
                    </span>
                  </span>
                  <span className="settings-archive-row__side">
                    <RunStatus item={runItemsByThreadId.get(thread.threadId)} />
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </SettingsSection>

      <SettingsSection
        eyebrow="Run"
        title="Migration action"
        description={
          selectedHasProfileOwnedWorktree
            ? "Profile-owned worktree migration is blocked until branch and worktree relocation is implemented."
            : "Move copies, validates, then archives source last. Copy leaves source threads active."
        }
        chip={operation === "move" ? "recommended" : "advanced"}
        chipKind={operation === "move" ? "ok" : "warn"}
      >
        <div className="settings-thread-management__controls">
          <div className="settings-thread-management__segmented" role="group">
            <button
              className={`button ${
                operation === "move" ? "button--primary" : "button--secondary"
              }`}
              type="button"
              onClick={() => setOperation("move")}
            >
              Move
            </button>
            <button
              className={`button ${
                operation === "copy" ? "button--primary" : "button--secondary"
              }`}
              type="button"
              onClick={() => setOperation("copy")}
            >
              Copy
            </button>
          </div>
          <button
            className="button button--primary"
            disabled={!canStart}
            type="button"
            onClick={() => {
              void startMigration();
            }}
          >
            {starting
              ? "Starting"
              : operation === "move"
                ? `Move ${selectedCount || ""}`.trim()
                : `Copy ${selectedCount || ""}`.trim()}
          </button>
        </div>
        {startError ? (
          <p className="settings-row__error settings-thread-management__status" role="alert">
            {startError}
          </p>
        ) : null}
        {selectedHasProfileOwnedWorktree ? (
          <p className="settings-row__error settings-thread-management__status" role="alert">
            Selected threads include a profile-owned worktree. This PR blocks
            that path until branch conflict strategies are implemented.
          </p>
        ) : null}
        {run ? (
          <p className="settings-thread-management__status" role="status">
            Run {run.runId}: {run.items.filter((item) => item.status === "completed").length} of{" "}
            {run.items.length} completed.
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
  return (
    <span
      className={`settings-pathrow__chip ${
        props.item.status === "completed"
          ? "settings-pathrow__chip--ok"
          : props.item.status === "failed"
            ? "settings-pathrow__chip--err"
            : "settings-pathrow__chip--warn"
      }`}
      title={props.item.error}
    >
      {props.item.status}
    </span>
  );
}
