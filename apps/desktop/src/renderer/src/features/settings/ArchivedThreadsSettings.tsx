import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isToolManagedWorktreePath,
  type AppServerThreadSummary,
} from "@pwragent/shared";
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

const ARCHIVED_THREADS_PER_PROJECT_LIMIT = 20;

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function ArchivedThreadsSettings(props: {
  desktopApi?: DesktopApi;
}) {
  const [state, setState] = useState<ArchivedThreadsState>({
    loading: true,
    threads: [],
    workspaceRoots: [],
  });
  const [restoringThreadKey, setRestoringThreadKey] = useState<string>();
  const [restoreMessage, setRestoreMessage] = useState<string>();
  const restoredThreadKeysRef = useRef(new Set<string>());

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
        threads: sortArchivedThreads(
          response.threads.filter(
            (thread) =>
              !restoredThreadKeysRef.current.has(buildArchivedThreadKey(thread)),
          ),
        ),
        workspaceRoots: response.workspaceRoots ?? [],
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      }));
    }
  }, [props.desktopApi]);

  useEffect(() => {
    void loadArchivedThreads();
  }, [loadArchivedThreads]);

  const projectGroups = useMemo(() => {
    return groupArchivedThreadsByProject(state.threads, state.workspaceRoots);
  }, [state.threads, state.workspaceRoots]);

  const fetchedAtLabel = useMemo(() => {
    return state.fetchedAt
      ? `Updated ${formatTimestamp(state.fetchedAt)}`
      : "Archived Threads";
  }, [state.fetchedAt]);

  const restoreThread = async (thread: AppServerThreadSummary) => {
    const restoreThreadRequest = props.desktopApi?.restoreThread;
    if (!restoreThreadRequest) {
      setState((current) => ({
        ...current,
        error: "Desktop bridge is missing restoreThread().",
      }));
      return;
    }

    const threadKey = buildArchivedThreadKey(thread);
    setRestoreMessage(undefined);
    setState((current) => ({ ...current, error: undefined }));
    setRestoringThreadKey(threadKey);
    try {
      await restoreThreadRequest({
        backend: thread.source,
        threadId: thread.id,
      });
      restoredThreadKeysRef.current.add(threadKey);
      setState((current) => ({
        ...current,
        threads: current.threads.filter(
          (candidate) => buildArchivedThreadKey(candidate) !== threadKey,
        ),
      }));
      setRestoreMessage(`Restored ${thread.title}.`);
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setRestoringThreadKey(undefined);
    }
  };

  return (
    <SettingsSectionStack paneId="archived" aria-label="Archived Threads settings">
      <SettingsPanelHead
        eyebrow="Archived Threads"
        title="Archived threads"
        help="Archived threads stay out of Inbox, Recents, and Directories. Restore one from its project group to make it visible again."
        action={
          <button
            className="button button--secondary"
            disabled={state.loading}
            type="button"
            onClick={() => {
              void loadArchivedThreads();
            }}
          >
            Refresh
          </button>
        }
      />

      {(state.loading && state.threads.length === 0) ||
      (!state.loading && projectGroups.length === 0) ||
      restoreMessage ||
      state.error ? (
        <SettingsSection
          eyebrow="Archived Threads"
          title="Project folders"
          description="Review archived work by project and restore threads that should return to the main thread lists."
          chip={state.loading ? "loading" : fetchedAtLabel}
          chipKind="muted"
        >
          {state.loading && state.threads.length === 0 ? (
            <p className="settings-empty settings-archive-empty">
              Loading archived threads...
            </p>
          ) : null}
          {!state.loading && projectGroups.length === 0 ? (
            <p className="settings-empty settings-archive-empty">
              No archived threads.
            </p>
          ) : null}
          {restoreMessage ? (
            <p className="settings-archive-status" role="status">
              {restoreMessage}
            </p>
          ) : null}
          {state.error ? (
            <p
              className="settings-row__error settings-archive-status"
              role="alert"
            >
              {state.error}
            </p>
          ) : null}
        </SettingsSection>
      ) : null}

      {projectGroups.map((group) => {
        const visibleThreads = group.threads.slice(
          0,
          ARCHIVED_THREADS_PER_PROJECT_LIMIT,
        );
        const hiddenThreadCount = group.threads.length - visibleThreads.length;
        return (
          <SettingsSection
            key={group.key}
            eyebrow="Project folder"
            title={group.label}
            description={group.path}
            chip={
              group.threads.length === 1
                ? "1 thread"
                : `${group.threads.length} threads`
            }
            chipKind="muted"
          >
            <div className="settings-archive-project__threads">
              {visibleThreads.map((thread) => {
                const threadKey = buildArchivedThreadKey(thread);
                return (
                  <ArchivedThreadRow
                    key={threadKey}
                    restoring={restoringThreadKey === threadKey}
                    thread={thread}
                    onRestore={() => {
                      void restoreThread(thread);
                    }}
                  />
                );
              })}
              {hiddenThreadCount > 0 ? (
                <p className="settings-archive-status">
                  Showing {ARCHIVED_THREADS_PER_PROJECT_LIMIT} of{" "}
                  {group.threads.length} most recent archived threads.
                </p>
              ) : null}
            </div>
          </SettingsSection>
        );
      })}
    </SettingsSectionStack>
  );
}

function ArchivedThreadRow(props: {
  restoring: boolean;
  thread: AppServerThreadSummary;
  onRestore: () => void;
}) {
  const thread = props.thread;
  const directories = thread.linkedDirectories
    .map((directory) => directory.label || directory.path)
    .filter(Boolean);
  const archivedAt = resolveArchiveTimestamp(thread);
  const activityLabel = archivedAt
    ? `Archived ${formatTimestamp(archivedAt)}`
    : thread.updatedAt
    ? `Updated ${formatTimestamp(thread.updatedAt)}`
    : thread.createdAt
      ? `Created ${formatTimestamp(thread.createdAt)}`
      : "No timestamp";

  return (
    <article className="settings-archive-row">
      <div className="settings-archive-row__body">
        <h3 className="settings-archive-row__title">{thread.title}</h3>
        {thread.summary ? (
          <p className="settings-archive-row__summary">{thread.summary}</p>
        ) : null}
        <p className="settings-archive-row__meta">
          <span>{activityLabel}</span>
          {directories.length ? <span>{directories.join(", ")}</span> : null}
        </p>
      </div>
      <div className="settings-archive-row__side">
        <div className="settings-pathrow__chips">
          <span className="settings-pathrow__chip">{thread.source}</span>
          {thread.gitBranch ? (
            <span className="settings-pathrow__chip">{thread.gitBranch}</span>
          ) : null}
        </div>
        <button
          className="button button--secondary settings-archive-row__button"
          disabled={props.restoring}
          type="button"
          onClick={props.onRestore}
        >
          {props.restoring ? "Restoring..." : "Restore"}
        </button>
      </div>
    </article>
  );
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
  return `${thread.source}:${thread.id}`;
}

function formatTimestamp(timestamp: number): string {
  return dateFormatter.format(timestamp);
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
