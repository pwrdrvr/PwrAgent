import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppServerBackendKind,
  AppServerCollaborationModeRequest,
  AppServerReviewTarget,
  AppServerThreadImagePart,
  AppServerTurnInputItem,
  LinkedDirectorySummary,
  NavigationDirectorySummary,
  NavigationLaunchpadDefaults,
  NavigationLaunchpadDraft,
  NavigationSnapshot,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";
import type { DesktopApi } from "./desktop-api";

export type BrowseMode = "inbox" | "recents" | "directories";

const ROOT_NEW_THREAD_LAUNCHPAD_KEY = "unlinked:new-thread";

type NavigationState = {
  loading: boolean;
  refreshing: boolean;
  error?: string;
  response?: NavigationSnapshot;
};

function buildLaunchpadSelectionKey(directoryKey: string): string {
  return `launchpad:${directoryKey}`;
}

function getDirectoryKeyFromLaunchpadSelection(selectionKey?: string): string | undefined {
  if (!selectionKey?.startsWith("launchpad:")) {
    return undefined;
  }

  return selectionKey.slice("launchpad:".length);
}

function linkedDirectoriesEqual(
  left: NavigationThreadSummary["linkedDirectories"],
  right: NavigationThreadSummary["linkedDirectories"]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((directory, index) => {
    const candidate = right[index];
    return (
      directory?.id === candidate?.id &&
      directory?.label === candidate?.label &&
      directory?.path === candidate?.path &&
      directory?.worktreePath === candidate?.worktreePath &&
      directory?.kind === candidate?.kind
    );
  });
}

function worktreeSnapshotsEqual(
  left: NavigationThreadSummary["worktreeSnapshots"],
  right: NavigationThreadSummary["worktreeSnapshots"]
): boolean {
  const leftSnapshots = left ?? [];
  const rightSnapshots = right ?? [];
  if (leftSnapshots.length !== rightSnapshots.length) {
    return false;
  }

  return leftSnapshots.every((snapshot, index) => {
    const candidate = rightSnapshots[index];
    if (!candidate) {
      return false;
    }

    return (
      snapshot.id === candidate.id &&
      snapshot.worktreePath === candidate.worktreePath &&
      snapshot.repositoryPath === candidate.repositoryPath &&
      snapshot.snapshotRef === candidate.snapshotRef &&
      snapshot.snapshotCommit === candidate.snapshotCommit &&
      snapshot.state === candidate.state &&
      snapshot.archivedAt === candidate.archivedAt &&
      snapshot.restoredAt === candidate.restoredAt
    );
  });
}

function threadInboxEqual(
  left: NavigationThreadSummary["inbox"],
  right: NavigationThreadSummary["inbox"]
): boolean {
  return (
    left.inInbox === right.inInbox &&
    left.reason === right.reason &&
    left.lastSeenAt === right.lastSeenAt &&
    left.lastSeenUpdatedAt === right.lastSeenUpdatedAt
  );
}

function threadSummariesEqual(
  left: NavigationThreadSummary,
  right: NavigationThreadSummary
): boolean {
  return (
    left.id === right.id &&
    left.source === right.source &&
    left.title === right.title &&
    left.titleSource === right.titleSource &&
    left.summary === right.summary &&
    left.projectKey === right.projectKey &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.gitBranch === right.gitBranch &&
    left.observedGitBranch === right.observedGitBranch &&
    left.executionMode === right.executionMode &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.serviceTier === right.serviceTier &&
    left.fastMode === right.fastMode &&
    linkedDirectoriesEqual(left.linkedDirectories, right.linkedDirectories) &&
    worktreeSnapshotsEqual(left.worktreeSnapshots, right.worktreeSnapshots) &&
    threadInboxEqual(left.inbox, right.inbox)
  );
}

function reconcileNavigationSnapshot(
  previous: NavigationSnapshot | undefined,
  next: NavigationSnapshot
): NavigationSnapshot {
  if (!previous) {
    return next;
  }

  const previousByThreadKey = new Map(
    previous.threads.map((thread) => [
      buildThreadIdentityKey(thread.source, thread.id),
      thread,
    ])
  );
  return {
    ...next,
    threads: next.threads.map((thread) => {
      const previousThread = previousByThreadKey.get(
        buildThreadIdentityKey(thread.source, thread.id)
      );
      return previousThread && threadSummariesEqual(previousThread, thread)
        ? previousThread
        : thread;
    }),
  };
}

function markThreadSeenInSnapshot(
  snapshot: NavigationSnapshot | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
    seenUpdatedAt?: number;
  }
): NavigationSnapshot | undefined {
  if (!snapshot) {
    return snapshot;
  }

  const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
  let changed = false;
  const threads = snapshot.threads.map((thread) => {
    if (buildThreadIdentityKey(thread.source, thread.id) !== threadKey) {
      return thread;
    }

    if (!thread.inbox.inInbox && thread.inbox.lastSeenUpdatedAt === params.seenUpdatedAt) {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      inbox: {
        ...thread.inbox,
        inInbox: false,
        reason: undefined,
        lastSeenAt: Date.now(),
        lastSeenUpdatedAt: params.seenUpdatedAt,
      },
    };
  });

  if (!changed) {
    return snapshot;
  }

  const directories = snapshot.directories ?? [];
  const threadInboxByKey = new Map(
    threads.map((thread) => [
      buildThreadIdentityKey(thread.source, thread.id),
      thread.inbox.inInbox,
    ])
  );

  return {
    ...snapshot,
    directories: directories.map((directory) => ({
      ...directory,
      needsAttentionCount: directory.threadKeys.reduce(
        (count, threadKey) => count + (threadInboxByKey.get(threadKey) ? 1 : 0),
        0
      ),
    })),
    inboxThreadKeys: snapshot.inboxThreadKeys.filter((candidate) => candidate !== threadKey),
    threads,
  };
}

function removeThreadFromSnapshot(
  snapshot: NavigationSnapshot | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
  }
): NavigationSnapshot | undefined {
  if (!snapshot) {
    return snapshot;
  }

  const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
  const threads = snapshot.threads.filter(
    (thread) => buildThreadIdentityKey(thread.source, thread.id) !== threadKey
  );
  if (threads.length === snapshot.threads.length) {
    return snapshot;
  }

  const threadInboxByKey = new Map(
    threads.map((thread) => [
      buildThreadIdentityKey(thread.source, thread.id),
      thread.inbox.inInbox,
    ])
  );

  return {
    ...snapshot,
    directories: snapshot.directories.map((directory) => {
      const threadKeys = directory.threadKeys.filter((candidate) => candidate !== threadKey);
      return {
        ...directory,
        threadKeys,
        needsAttentionCount: threadKeys.reduce(
          (count, candidate) => count + (threadInboxByKey.get(candidate) ? 1 : 0),
          0
        ),
      };
    }),
    inboxThreadKeys: snapshot.inboxThreadKeys.filter((candidate) => candidate !== threadKey),
    threads,
  };
}

function removeThreadKeysFromSnapshot(
  snapshot: NavigationSnapshot,
  threadKeysToRemove: ReadonlySet<string>
): NavigationSnapshot {
  if (threadKeysToRemove.size === 0) {
    return snapshot;
  }

  const threads = snapshot.threads.filter(
    (thread) => !threadKeysToRemove.has(buildThreadIdentityKey(thread.source, thread.id))
  );
  if (threads.length === snapshot.threads.length) {
    return snapshot;
  }

  const threadInboxByKey = new Map(
    threads.map((thread) => [
      buildThreadIdentityKey(thread.source, thread.id),
      thread.inbox.inInbox,
    ])
  );

  return {
    ...snapshot,
    directories: snapshot.directories.map((directory) => {
      const threadKeys = directory.threadKeys.filter(
        (candidate) => !threadKeysToRemove.has(candidate)
      );
      return {
        ...directory,
        threadKeys,
        needsAttentionCount: threadKeys.reduce(
          (count, candidate) => count + (threadInboxByKey.get(candidate) ? 1 : 0),
          0
        ),
      };
    }),
    inboxThreadKeys: snapshot.inboxThreadKeys.filter(
      (candidate) => !threadKeysToRemove.has(candidate)
    ),
    threads,
  };
}

function getFallbackSelectionAfterRemoval(
  snapshot: NavigationSnapshot | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
    optimisticThreadKey?: string;
  }
): string | undefined {
  const nextSnapshot = removeThreadFromSnapshot(snapshot, params);
  return nextSnapshot
    ? getFallbackSelectionKey(nextSnapshot, params.optimisticThreadKey)
    : undefined;
}

function applyThreadNameUpdate(
  snapshot: NavigationSnapshot | undefined,
  params: { backend: AppServerBackendKind; threadId: string; threadName?: string }
): NavigationSnapshot | undefined {
  const threadName = params.threadName?.trim();
  if (!snapshot || !threadName) {
    return snapshot;
  }

  let changed = false;
  const threads = snapshot.threads.map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }

    if (thread.title === threadName && thread.titleSource === "explicit") {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      title: threadName,
      titleSource: "explicit" as const,
    };
  });

  return changed
    ? {
        ...snapshot,
        threads,
      }
      : snapshot;
}

function applyThreadModelSettingsUpdate(
  snapshot: NavigationSnapshot | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
    model?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    fastMode?: boolean;
  }
): NavigationSnapshot | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = snapshot.threads.map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      model: params.model,
      reasoningEffort: params.reasoningEffort,
      serviceTier: params.serviceTier,
      fastMode: params.fastMode,
    };
  });

  return changed
    ? {
        ...snapshot,
        threads,
      }
    : snapshot;
}

function applyLaunchpadUpdate(
  snapshot: NavigationSnapshot | undefined,
  launchpad: NavigationLaunchpadDraft,
  defaults: NavigationSnapshot["launchpadDefaults"]
): NavigationSnapshot | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let foundDirectory = false;
  const directories = snapshot.directories.map((directory) => {
    if (directory.key !== launchpad.directoryKey) {
      return directory;
    }

    foundDirectory = true;
    return {
      ...directory,
      kind: launchpad.directoryKind,
      label: launchpad.directoryLabel,
      path: launchpad.directoryPath ?? directory.path,
      launchpad,
    };
  });

  return {
    ...snapshot,
    directories: foundDirectory
      ? directories
      : [
          {
            key: launchpad.directoryKey,
            kind: launchpad.directoryKind,
            label: launchpad.directoryLabel,
            path: launchpad.directoryPath,
            threadKeys: [],
            needsAttentionCount: 0,
            launchpad,
          },
          ...directories,
        ],
    launchpadDefaults: defaults,
  };
}

function applyLaunchpadReset(
  snapshot: NavigationSnapshot | undefined,
  directoryKey: string,
  defaults: NavigationSnapshot["launchpadDefaults"]
): NavigationSnapshot | undefined {
  if (!snapshot) {
    return snapshot;
  }

  return {
    ...snapshot,
    directories: snapshot.directories.map((directory) =>
      directory.key === directoryKey ? { ...directory, launchpad: undefined } : directory
    ),
    launchpadDefaults: defaults,
  };
}

function projectOptimisticThreadIntoDirectories(
  directories: NavigationSnapshot["directories"],
  optimisticThread?: NavigationThreadSummary
): NavigationSnapshot["directories"] {
  if (!optimisticThread) {
    return directories;
  }

  const threadKey = buildThreadIdentityKey(optimisticThread.source, optimisticThread.id);
  let changed = false;
  const nextDirectories = [...directories];

  for (const linkedDirectory of optimisticThread.linkedDirectories) {
    const directoryKey = linkedDirectory.id.startsWith("launchpad:")
      ? linkedDirectory.id.slice("launchpad:".length)
      : linkedDirectory.path
        ? `directory:${linkedDirectory.path}`
        : undefined;
    if (!directoryKey) {
      continue;
    }

    const existingIndex = nextDirectories.findIndex(
      (directory) => directory.key === directoryKey
    );
    if (existingIndex >= 0) {
      const existing = nextDirectories[existingIndex]!;
      if (existing.threadKeys.includes(threadKey)) {
        continue;
      }

      nextDirectories[existingIndex] = {
        ...existing,
        threadKeys: [threadKey, ...existing.threadKeys],
        needsAttentionCount:
          existing.needsAttentionCount + (optimisticThread.inbox.inInbox ? 1 : 0),
        latestUpdatedAt: Math.max(
          existing.latestUpdatedAt ?? 0,
          optimisticThread.updatedAt ?? 0
        ),
      };
      changed = true;
      continue;
    }

    nextDirectories.push({
      key: directoryKey,
      kind: "directory",
      label: linkedDirectory.label,
      path: linkedDirectory.path,
      threadKeys: [threadKey],
      needsAttentionCount: optimisticThread.inbox.inInbox ? 1 : 0,
      latestUpdatedAt: optimisticThread.updatedAt,
    });
    changed = true;
  }

  return changed ? nextDirectories : directories;
}

function hasSelectionKey(
  response: NavigationSnapshot,
  selectionKey: string,
  optimisticThreadKey?: string
): boolean {
  const launchpadDirectoryKey = getDirectoryKeyFromLaunchpadSelection(selectionKey);
  if (launchpadDirectoryKey) {
    return response.directories.some(
      (directory) =>
        directory.key === launchpadDirectoryKey && Boolean(directory.launchpad)
    );
  }

  return (
    response.threads.some(
      (thread) => buildThreadIdentityKey(thread.source, thread.id) === selectionKey
    ) || selectionKey === optimisticThreadKey
  );
}

function getFallbackSelectionKey(
  response: NavigationSnapshot,
  optimisticThreadKey?: string
): string | undefined {
  if (optimisticThreadKey) {
    return optimisticThreadKey;
  }

  if (response.threads[0]) {
    return buildThreadIdentityKey(response.threads[0].source, response.threads[0].id);
  }

  const firstLaunchpadDirectory = response.directories.find((directory) => directory.launchpad);
  return firstLaunchpadDirectory
    ? buildLaunchpadSelectionKey(firstLaunchpadDirectory.key)
    : undefined;
}

function buildOptimisticThreadFromLaunchpad(params: {
  directory?: NavigationDirectorySummary;
  launchpad: NavigationLaunchpadDraft;
  backend: AppServerBackendKind;
  threadId: string;
  executionMode: ThreadExecutionMode;
  workMode: NavigationLaunchpadDraft["workMode"];
  optimisticUserMessage?: NavigationThreadSummary["optimisticUserMessage"];
}): NavigationThreadSummary {
  return {
    id: params.threadId,
    title: "Untitled thread",
    titleSource: "fallback",
    summary: params.launchpad.prompt.trim() || undefined,
    projectKey: params.launchpad.directoryPath,
    source: params.backend,
    executionMode: params.executionMode,
    model: params.launchpad.model,
    reasoningEffort: params.launchpad.reasoningEffort,
    serviceTier: params.launchpad.serviceTier,
    fastMode: params.launchpad.fastMode,
    optimisticUserMessage: params.optimisticUserMessage,
    linkedDirectories: params.launchpad.directoryPath
      ? [
          {
            id: `launchpad:${params.launchpad.directoryKey}`,
            label: params.launchpad.directoryLabel,
            path: params.launchpad.directoryPath,
            kind: params.workMode === "worktree" ? "worktree" : "local",
          },
        ]
      : [],
    gitBranch:
      params.workMode === "worktree"
        ? "HEAD"
        : params.directory?.gitStatus?.currentBranch ?? params.launchpad.branchName,
    observedGitBranch: params.workMode === "worktree" ? "HEAD" : undefined,
    updatedAt: Date.now(),
    inbox: {
      inInbox: true,
      reason: "new-thread",
    },
  };
}

function buildOptimisticUserMessage(
  input: AppServerTurnInputItem[] | undefined
): NavigationThreadSummary["optimisticUserMessage"] {
  if (!input?.length) {
    return undefined;
  }

  const text = input
    .filter((item): item is Extract<AppServerTurnInputItem, { type: "text" }> =>
      item.type === "text" && typeof item.text === "string"
    )
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const imageParts: AppServerThreadImagePart[] = input
    .filter((item): item is Extract<AppServerTurnInputItem, { type: "image" }> =>
      item.type === "image" && typeof item.url === "string"
    )
    .map((item) => ({
      type: "image",
      url: item.url,
    }));

  if (!text && imageParts.length === 0) {
    return undefined;
  }

  return {
    text,
    ...(imageParts.length > 0 ? { imageParts } : {}),
    createdAt: Date.now(),
  };
}

export function useThreadNavigation(desktopApi?: DesktopApi): {
  browseMode: BrowseMode;
  createThread: (
    backend?: AppServerBackendKind,
    executionMode?: ThreadExecutionMode
  ) => Promise<void>;
  createThreadError?: string;
  creatingThread?: {
    backend: AppServerBackendKind;
    executionMode: ThreadExecutionMode;
  };
  directories: NavigationDirectorySummary[];
  error?: string;
  inboxThreads: NavigationThreadSummary[];
  launchpadError?: string;
  archiveThreadError?: string;
  worktreeArchiveError?: string;
  renameThreadError?: string;
  loading: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
  materializeDirectoryLaunchpad: (
    directoryKey: string,
    input?: AppServerTurnInputItem[],
    collaborationMode?: AppServerCollaborationModeRequest,
    reviewTarget?: AppServerReviewTarget
  ) => Promise<void>;
  openDirectoryLaunchpad: (
    directory: NavigationDirectorySummary,
    preferredBackend?: AppServerBackendKind
  ) => Promise<void>;
  resetDirectoryLaunchpad: (directoryKey: string) => Promise<void>;
  selectedDirectory?: NavigationDirectorySummary;
  selectedItemKey?: string;
  selectedLaunchpad?: NavigationLaunchpadDraft;
  selectedThread?: NavigationThreadSummary;
  selectedThreadKey?: string;
  setThreadExecutionMode: (
    thread: NavigationThreadSummary,
    executionMode: ThreadExecutionMode
  ) => Promise<void>;
  setThreadExecutionModeError?: string;
  setThreadModelSettings: (
    thread: NavigationThreadSummary,
    patch: Partial<
      Pick<
      NavigationThreadSummary,
      "model" | "reasoningEffort" | "serviceTier" | "fastMode"
      >
    >
  ) => Promise<void>;
  setThreadModelSettingsError?: string;
  updatingThreadExecutionMode?: ThreadExecutionMode;
  updateDirectoryLaunchpad: (
    directoryKey: string,
    patch: Parameters<NonNullable<DesktopApi["updateDirectoryLaunchpad"]>>[0]["patch"]
  ) => Promise<void>;
  setBrowseMode: (browseMode: BrowseMode) => void;
  selectThread: (thread: NavigationThreadSummary) => void;
  archiveThread: (thread: NavigationThreadSummary) => Promise<void>;
  archiveWorktree: (
    thread: NavigationThreadSummary,
    directory: LinkedDirectorySummary
  ) => Promise<void>;
  restoreWorktree: (
    thread: NavigationThreadSummary,
    snapshotRef: string,
    worktreePath: string
  ) => Promise<void>;
  renameThread: (thread: NavigationThreadSummary, name: string) => Promise<void>;
  snapshot?: NavigationSnapshot;
  threads: NavigationThreadSummary[];
} {
  const markThreadSeen = desktopApi?.markThreadSeen;
  const archiveThreadRequest = desktopApi?.archiveThread;
  const archiveWorktreeRequest = desktopApi?.archiveWorktree;
  const restoreWorktreeRequest = desktopApi?.restoreWorktree;
  const renameThreadRequest = desktopApi?.renameThread;
  const setThreadExecutionMode = desktopApi?.setThreadExecutionMode;
  const setThreadModelSettings = desktopApi?.setThreadModelSettings;
  const [browseMode, setBrowseMode] = useState<BrowseMode>("recents");
  const [selectedItemKey, setSelectedItemKey] = useState<string>();
  const [pendingSeenThreadKey, setPendingSeenThreadKey] = useState<string>();
  const [retainedUnreadThread, setRetainedUnreadThread] =
    useState<NavigationThreadSummary>();
  const [optimisticThread, setOptimisticThread] = useState<NavigationThreadSummary>();
  const [creatingThread, setCreatingThread] = useState<{
    backend: AppServerBackendKind;
    executionMode: ThreadExecutionMode;
  }>();
  const [createThreadError, setCreateThreadError] = useState<string>();
  const [launchpadError, setLaunchpadError] = useState<string>();
  const [archiveThreadError, setArchiveThreadError] = useState<string>();
  const [worktreeArchiveError, setWorktreeArchiveError] = useState<string>();
  const [renameThreadError, setRenameThreadError] = useState<string>();
  const [updatingThreadExecutionMode, setUpdatingThreadExecutionMode] =
    useState<ThreadExecutionMode>();
  const [setThreadExecutionModeError, setSetThreadExecutionModeError] =
    useState<string>();
  const [setThreadModelSettingsError, setSetThreadModelSettingsError] =
    useState<string>();
  const [state, setState] = useState<NavigationState>({
    loading: true,
    refreshing: false,
  });

  const optimisticThreadRef = useRef<NavigationThreadSummary | undefined>(undefined);
  const retainedUnreadThreadRef = useRef<NavigationThreadSummary | undefined>(undefined);
  const refreshInFlightRef = useRef(false);
  const queuedRefreshRef = useRef<
    | {
        preferredOptimisticThread?: NavigationThreadSummary;
        preferredSelectionKey?: string;
      }
    | undefined
  >(undefined);
  const suppressedArchivedThreadKeysRef = useRef<Set<string>>(new Set());
  const scheduledRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  optimisticThreadRef.current = optimisticThread;
  retainedUnreadThreadRef.current = retainedUnreadThread;

  const releaseRetainedUnreadThread = useCallback((nextSelectionKey?: string): void => {
    const retainedThread = retainedUnreadThreadRef.current;
    if (!retainedThread) {
      return;
    }

    const retainedThreadKey = buildThreadIdentityKey(
      retainedThread.source,
      retainedThread.id
    );
    if (nextSelectionKey === retainedThreadKey) {
      return;
    }

    setState((current) => ({
      ...current,
      response: markThreadSeenInSnapshot(current.response, {
        backend: retainedThread.source,
        threadId: retainedThread.id,
        seenUpdatedAt: retainedThread.updatedAt,
      }),
    }));
    setRetainedUnreadThread(undefined);
  }, []);

  const performRefresh = useCallback(
    async (
      preferredSelectionKey?: string,
      preferredOptimisticThread?: NavigationThreadSummary
    ): Promise<void> => {
      if (!desktopApi?.getNavigationSnapshot) {
        setState({
          loading: false,
          refreshing: false,
          error: "Desktop bridge is missing getNavigationSnapshot().",
          response: undefined,
        });
        return;
      }

      setState((current) => ({
        ...current,
        loading: !current.response,
        refreshing: Boolean(current.response),
        error: undefined,
      }));

      try {
        const response = removeThreadKeysFromSnapshot(
          await desktopApi.getNavigationSnapshot(),
          suppressedArchivedThreadKeysRef.current
        );
        const optimisticSelection = preferredOptimisticThread ?? optimisticThreadRef.current;
        const optimisticThreadKey = optimisticSelection
          ? buildThreadIdentityKey(optimisticSelection.source, optimisticSelection.id)
          : undefined;

        setState((current) => {
          if (current.response && response.unchanged && !preferredSelectionKey) {
            return {
              ...current,
              loading: false,
              refreshing: false,
              error: undefined,
            };
          }

          return {
            loading: false,
            refreshing: false,
            error: undefined,
            response: reconcileNavigationSnapshot(current.response, response),
          };
        });

        if (
          optimisticThreadKey &&
          response.threads.some(
            (thread) => buildThreadIdentityKey(thread.source, thread.id) === optimisticThreadKey
          )
        ) {
          setOptimisticThread((current) =>
            current?.optimisticUserMessage ? current : undefined
          );
        }

        setSelectedItemKey((current) => {
          const candidate = preferredSelectionKey ?? current;
          if (candidate && hasSelectionKey(response, candidate, optimisticThreadKey)) {
            return candidate;
          }

          if (candidate) {
            return candidate;
          }

          return getFallbackSelectionKey(response, optimisticThreadKey);
        });
      } catch (error) {
        setState((current) => ({
          loading: false,
          refreshing: false,
          response: current.response,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [desktopApi]
  );

  const refresh = useCallback(
    async (
      preferredSelectionKey?: string,
      preferredOptimisticThread?: NavigationThreadSummary
    ): Promise<void> => {
      const initialRequest = {
        preferredOptimisticThread,
        preferredSelectionKey,
      };

      if (refreshInFlightRef.current) {
        queuedRefreshRef.current = initialRequest;
        return;
      }

      refreshInFlightRef.current = true;
      let nextRequest: typeof initialRequest | undefined = initialRequest;

      try {
        while (nextRequest) {
          queuedRefreshRef.current = undefined;
          await performRefresh(
            nextRequest.preferredSelectionKey,
            nextRequest.preferredOptimisticThread
          );
          nextRequest = queuedRefreshRef.current;
        }
      } finally {
        refreshInFlightRef.current = false;
      }
    },
    [performRefresh]
  );

  const scheduleRefresh = useCallback(
    (
      preferredSelectionKey?: string,
      preferredOptimisticThread?: NavigationThreadSummary
    ): void => {
      queuedRefreshRef.current = {
        preferredOptimisticThread,
        preferredSelectionKey,
      };

      if (scheduledRefreshTimerRef.current !== undefined) {
        return;
      }

      scheduledRefreshTimerRef.current = setTimeout(() => {
        scheduledRefreshTimerRef.current = undefined;
        const nextRequest = queuedRefreshRef.current;
        queuedRefreshRef.current = undefined;
        if (!nextRequest) {
          return;
        }

        void refresh(
          nextRequest.preferredSelectionKey,
          nextRequest.preferredOptimisticThread
        );
      }, 0);
    },
    [refresh]
  );

  useEffect(() => {
    return () => {
      if (scheduledRefreshTimerRef.current !== undefined) {
        clearTimeout(scheduledRefreshTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!desktopApi?.onAgentEvent) {
      return;
    }

    return desktopApi.onAgentEvent((event) => {
      const method = event.notification.method;
      if (method === "thread/name/updated") {
        const { threadId, threadName } = event.notification.params as {
          threadId: string;
          threadName?: string;
        };
        setState((current) => ({
          ...current,
          response: applyThreadNameUpdate(current.response, {
            backend: event.backend,
            threadId,
            threadName,
          }),
        }));
        setOptimisticThread((current) => {
          if (current?.source !== event.backend || current.id !== threadId) {
            return current;
          }

          const nextThreadName = threadName?.trim();
          if (!nextThreadName) {
            return current;
          }

          return {
            ...current,
            title: nextThreadName,
            titleSource: "explicit",
          };
        });
        return;
      }

      if (method === "thread/archived") {
        const { threadId } = event.notification.params as {
          threadId: string;
        };
        const threadKey = buildThreadIdentityKey(event.backend, threadId);
        suppressedArchivedThreadKeysRef.current.add(threadKey);

        setState((current) => ({
          ...current,
          response: removeThreadFromSnapshot(current.response, {
            backend: event.backend,
            threadId,
          }),
        }));
        setSelectedItemKey((current) =>
          current === threadKey
            ? getFallbackSelectionAfterRemoval(state.response, {
                backend: event.backend,
                threadId,
                optimisticThreadKey: optimisticThreadRef.current
                  ? buildThreadIdentityKey(
                      optimisticThreadRef.current.source,
                      optimisticThreadRef.current.id
                    )
                  : undefined,
              })
            : current
        );
        setRetainedUnreadThread((current) =>
          current?.source === event.backend && current.id === threadId ? undefined : current
        );
        setOptimisticThread((current) =>
          current?.source === event.backend && current.id === threadId ? undefined : current
        );
        return;
      }

      if (method === "thread/unarchived") {
        const { threadId } = event.notification.params as {
          threadId: string;
        };
        suppressedArchivedThreadKeysRef.current.delete(
          buildThreadIdentityKey(event.backend, threadId)
        );
        scheduleRefresh();
        return;
      }

      if (method === "thread/started") {
        scheduleRefresh();
        return;
      }

      if (
        method === "turn/completed" ||
        method === "turn/failed" ||
        method === "turn/cancelled"
      ) {
        scheduleRefresh();
      }
    });
  }, [desktopApi, scheduleRefresh, state.response]);

  const threads = useMemo(() => {
    const currentThreads = state.response?.threads ?? [];
    if (!optimisticThread) {
      return currentThreads;
    }

    const optimisticThreadKey = buildThreadIdentityKey(
      optimisticThread.source,
      optimisticThread.id
    );

    const hasHydratedThread = currentThreads.some(
      (thread) => buildThreadIdentityKey(thread.source, thread.id) === optimisticThreadKey
    );
    if (hasHydratedThread) {
      if (!optimisticThread.optimisticUserMessage) {
        return currentThreads;
      }

      return currentThreads.map((thread) =>
        buildThreadIdentityKey(thread.source, thread.id) === optimisticThreadKey
          ? {
              ...thread,
              optimisticUserMessage:
                thread.optimisticUserMessage ?? optimisticThread.optimisticUserMessage,
            }
          : thread
      );
    }

    return [optimisticThread, ...currentThreads];
  }, [optimisticThread, state.response?.threads]);

  const directories = useMemo(
    () =>
      projectOptimisticThreadIntoDirectories(
        state.response?.directories ?? [],
        optimisticThread
      ),
    [optimisticThread, state.response?.directories]
  );

  const inboxThreads = useMemo(() => {
    const unreadThreads = threads.filter(
      (thread) => thread.inbox.inInbox && thread.inbox.reason === "updated-since-seen"
    );
    if (!retainedUnreadThread) {
      return unreadThreads;
    }

    const retainedThreadKey = buildThreadIdentityKey(
      retainedUnreadThread.source,
      retainedUnreadThread.id
    );
    if (
      unreadThreads.some(
        (thread) => buildThreadIdentityKey(thread.source, thread.id) === retainedThreadKey
      )
    ) {
      return unreadThreads;
    }

    return [retainedUnreadThread, ...unreadThreads];
  }, [retainedUnreadThread, threads]);

  const selectedThreadKey = useMemo(() => {
    if (selectedItemKey && !getDirectoryKeyFromLaunchpadSelection(selectedItemKey)) {
      return selectedItemKey;
    }

    return undefined;
  }, [selectedItemKey]);

  const selectedThread = useMemo<NavigationThreadSummary | undefined>(
    () =>
      selectedThreadKey
        ? threads.find(
            (thread) =>
              buildThreadIdentityKey(thread.source, thread.id) === selectedThreadKey
          )
        : undefined,
    [selectedThreadKey, threads]
  );

  const selectedDirectory = useMemo(() => {
    const launchpadDirectoryKey = getDirectoryKeyFromLaunchpadSelection(selectedItemKey);
    if (!launchpadDirectoryKey) {
      return undefined;
    }

    return directories.find((directory) => directory.key === launchpadDirectoryKey);
  }, [directories, selectedItemKey]);

  const selectedLaunchpad = selectedDirectory?.launchpad;

  useEffect(() => {
    releaseRetainedUnreadThread(selectedItemKey);
  }, [releaseRetainedUnreadThread, retainedUnreadThread, selectedItemKey]);

  useEffect(() => {
    const submitMarkThreadSeen = markThreadSeen;

    if (
      !pendingSeenThreadKey ||
      !selectedThread ||
      pendingSeenThreadKey !==
        buildThreadIdentityKey(selectedThread.source, selectedThread.id) ||
      !submitMarkThreadSeen
    ) {
      return;
    }

    const markThreadSeenRequest = submitMarkThreadSeen;
    const threadToMarkSeen = selectedThread;
    let cancelled = false;

    async function markSeen(): Promise<void> {
      try {
        await markThreadSeenRequest({
          backend: threadToMarkSeen.source,
          threadId: threadToMarkSeen.id,
          seenUpdatedAt: threadToMarkSeen.updatedAt,
        });
        if (!cancelled) {
          const threadKey = buildThreadIdentityKey(
            threadToMarkSeen.source,
            threadToMarkSeen.id
          );
          if (
            !retainedUnreadThread ||
            buildThreadIdentityKey(retainedUnreadThread.source, retainedUnreadThread.id) !==
              threadKey
          ) {
            setState((current) => ({
              ...current,
              response: markThreadSeenInSnapshot(current.response, {
                backend: threadToMarkSeen.source,
                threadId: threadToMarkSeen.id,
                seenUpdatedAt: threadToMarkSeen.updatedAt,
              }),
            }));
          }
        }
      } finally {
        if (!cancelled) {
          setPendingSeenThreadKey(undefined);
        }
      }
    }

    void markSeen();

    return () => {
      cancelled = true;
    };
  }, [markThreadSeen, pendingSeenThreadKey, retainedUnreadThread, selectedThread]);

  const selectThread = useCallback((thread: NavigationThreadSummary): void => {
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);
    releaseRetainedUnreadThread(threadKey);
    setCreateThreadError(undefined);
    setLaunchpadError(undefined);
    setArchiveThreadError(undefined);
    setSetThreadExecutionModeError(undefined);
    setSetThreadModelSettingsError(undefined);
    setSelectedItemKey(threadKey);
    setPendingSeenThreadKey(threadKey);
    if (thread.inbox.inInbox && thread.inbox.reason === "updated-since-seen") {
      setRetainedUnreadThread(thread);
    }
  }, [releaseRetainedUnreadThread]);

  const createThread = useCallback(
    async (
      backend?: AppServerBackendKind,
      executionMode: ThreadExecutionMode = "default"
    ): Promise<void> => {
      if (!desktopApi?.ensureDirectoryLaunchpad) {
        setCreateThreadError("Desktop bridge is missing ensureDirectoryLaunchpad().");
        return;
      }

      setCreatingThread({ backend: backend ?? "codex", executionMode });
      setCreateThreadError(undefined);
      setLaunchpadError(undefined);
      setArchiveThreadError(undefined);
      setSetThreadModelSettingsError(undefined);

      try {
        const response = await desktopApi.ensureDirectoryLaunchpad({
          directoryKey: ROOT_NEW_THREAD_LAUNCHPAD_KEY,
          directoryKind: "unlinked",
          directoryLabel: "New thread",
          preferredBackend: backend,
        });
        let launchpad = response.launchpad;
        let defaults: NavigationLaunchpadDefaults = response.defaults;
        if (
          executionMode !== response.launchpad.executionMode &&
          desktopApi.updateDirectoryLaunchpad
        ) {
          const updated = await desktopApi.updateDirectoryLaunchpad({
            directoryKey: ROOT_NEW_THREAD_LAUNCHPAD_KEY,
            patch: { executionMode },
          });
          launchpad = updated.launchpad;
          defaults = updated.defaults;
        }
        setState((current) => ({
          ...current,
          response: applyLaunchpadUpdate(current.response, launchpad, defaults),
        }));
        setSelectedItemKey(buildLaunchpadSelectionKey(ROOT_NEW_THREAD_LAUNCHPAD_KEY));
      } catch (error) {
        setCreateThreadError(error instanceof Error ? error.message : String(error));
      } finally {
        setCreatingThread(undefined);
      }
    },
    [desktopApi]
  );

  const openDirectoryLaunchpad = useCallback(
    async (
      directory: NavigationDirectorySummary,
      preferredBackend?: AppServerBackendKind
    ): Promise<void> => {
      if (!desktopApi?.ensureDirectoryLaunchpad) {
        setLaunchpadError("Desktop bridge is missing ensureDirectoryLaunchpad().");
        return;
      }

      setLaunchpadError(undefined);
      setCreateThreadError(undefined);
      setArchiveThreadError(undefined);
      setSetThreadExecutionModeError(undefined);
      setSetThreadModelSettingsError(undefined);

      try {
        const response = await desktopApi.ensureDirectoryLaunchpad({
          directoryKey: directory.key,
          directoryKind: directory.kind,
          directoryLabel: directory.label,
          directoryPath: directory.path,
          currentBranch: directory.gitStatus?.currentBranch,
          preferredBackend,
        });
        setState((current) => ({
          ...current,
          response: applyLaunchpadUpdate(
            current.response,
            response.launchpad,
            response.defaults
          ),
        }));
        setSelectedItemKey(buildLaunchpadSelectionKey(directory.key));
      } catch (error) {
        setLaunchpadError(error instanceof Error ? error.message : String(error));
      }
    },
    [desktopApi]
  );

  const updateDirectoryLaunchpad = useCallback(
    async (
      directoryKey: string,
      patch: Parameters<NonNullable<DesktopApi["updateDirectoryLaunchpad"]>>[0]["patch"]
    ): Promise<void> => {
      if (!desktopApi?.updateDirectoryLaunchpad) {
        setLaunchpadError("Desktop bridge is missing updateDirectoryLaunchpad().");
        return;
      }

      setLaunchpadError(undefined);

      try {
        const response = await desktopApi.updateDirectoryLaunchpad({
          directoryKey,
          patch,
        });
        setState((current) => ({
          ...current,
          response: applyLaunchpadUpdate(
            current.response,
            response.launchpad,
            response.defaults
          ),
        }));
      } catch (error) {
        setLaunchpadError(error instanceof Error ? error.message : String(error));
      }
    },
    [desktopApi]
  );

  const resetDirectoryLaunchpad = useCallback(
    async (directoryKey: string): Promise<void> => {
      if (!desktopApi?.resetDirectoryLaunchpad) {
        setLaunchpadError("Desktop bridge is missing resetDirectoryLaunchpad().");
        return;
      }

      setLaunchpadError(undefined);

      try {
        const response = await desktopApi.resetDirectoryLaunchpad({ directoryKey });
        setState((current) => ({
          ...current,
          response: applyLaunchpadReset(
            current.response,
            response.directoryKey,
            response.defaults
          ),
        }));
        setSelectedItemKey((current) =>
          current === buildLaunchpadSelectionKey(directoryKey)
            ? getFallbackSelectionKey(
                state.response
                  ? applyLaunchpadReset(state.response, response.directoryKey, response.defaults)!
                  : {
                      backend: "all",
                      fetchedAt: Date.now(),
                      unchanged: false,
                      threads,
                      inboxThreadKeys: [],
                      directories,
                      launchpadDefaults: response.defaults,
                    },
                optimisticThread
                  ? buildThreadIdentityKey(optimisticThread.source, optimisticThread.id)
                  : undefined
              )
            : current
        );
      } catch (error) {
        setLaunchpadError(error instanceof Error ? error.message : String(error));
      }
    },
    [desktopApi, directories, optimisticThread, state.response, threads]
  );

  const materializeDirectoryLaunchpad = useCallback(
    async (
      directoryKey: string,
      input?: AppServerTurnInputItem[],
      collaborationMode?: AppServerCollaborationModeRequest,
      reviewTarget?: AppServerReviewTarget
    ): Promise<void> => {
      if (!desktopApi?.materializeDirectoryLaunchpad) {
        setLaunchpadError("Desktop bridge is missing materializeDirectoryLaunchpad().");
        return;
      }

      const directory = directories.find((candidate) => candidate.key === directoryKey);
      const launchpad = directory?.launchpad;
      if (!launchpad) {
        setLaunchpadError(`No launchpad found for ${directoryKey}.`);
        return;
      }

      setLaunchpadError(undefined);

      try {
        const response = await desktopApi.materializeDirectoryLaunchpad({
          directoryKey,
          input,
          collaborationMode,
          reviewTarget,
        });
        const optimisticMaterializedThread = buildOptimisticThreadFromLaunchpad({
          directory,
          launchpad,
          backend: response.backend,
          threadId: response.threadId,
          executionMode: response.executionMode,
          workMode: response.workMode,
          optimisticUserMessage: buildOptimisticUserMessage(input),
        });
        const nextThreadKey = buildThreadIdentityKey(response.backend, response.threadId);
        setOptimisticThread(optimisticMaterializedThread);
        setSelectedItemKey(nextThreadKey);
        setPendingSeenThreadKey(nextThreadKey);
        setState((current) => ({
          ...current,
          response: current.response
            ? applyLaunchpadReset(
                current.response,
                directoryKey,
                current.response.launchpadDefaults
              )
            : current.response,
        }));
        await refresh(nextThreadKey, optimisticMaterializedThread);
      } catch (error) {
        setLaunchpadError(error instanceof Error ? error.message : String(error));
      }
    },
    [desktopApi, directories, refresh]
  );

  const archiveThread = useCallback(
    async (thread: NavigationThreadSummary): Promise<void> => {
      if (!archiveThreadRequest) {
        setArchiveThreadError("Desktop bridge is missing archiveThread().");
        return;
      }

      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      const optimisticThreadKey = optimisticThread
        ? buildThreadIdentityKey(optimisticThread.source, optimisticThread.id)
        : undefined;

      suppressedArchivedThreadKeysRef.current.add(threadKey);
      setArchiveThreadError(undefined);
      setCreateThreadError(undefined);
      setLaunchpadError(undefined);
      setSetThreadExecutionModeError(undefined);
      setSetThreadModelSettingsError(undefined);
      setState((current) => ({
        ...current,
        response: removeThreadFromSnapshot(current.response, {
          backend: thread.source,
          threadId: thread.id,
        }),
      }));
      setSelectedItemKey((current) =>
        current === threadKey
          ? getFallbackSelectionAfterRemoval(state.response, {
              backend: thread.source,
              threadId: thread.id,
              optimisticThreadKey,
            })
          : current
      );
      setRetainedUnreadThread((current) =>
        current?.source === thread.source && current.id === thread.id ? undefined : current
      );
      setOptimisticThread((current) =>
        current?.source === thread.source && current.id === thread.id ? undefined : current
      );

      try {
        await archiveThreadRequest({
          backend: thread.source,
          threadId: thread.id,
        });
        await refresh();
      } catch (error) {
        suppressedArchivedThreadKeysRef.current.delete(threadKey);
        setArchiveThreadError(error instanceof Error ? error.message : String(error));
        await refresh(threadKey);
      }
    },
    [archiveThreadRequest, optimisticThread, refresh, state.response]
  );

  const archiveWorktree = useCallback(
    async (
      thread: NavigationThreadSummary,
      directory: LinkedDirectorySummary
    ): Promise<void> => {
      if (!archiveWorktreeRequest) {
        setWorktreeArchiveError("Desktop bridge is missing archiveWorktree().");
        return;
      }

      const worktreePath = directory.worktreePath ?? directory.path;
      setWorktreeArchiveError(undefined);
      setArchiveThreadError(undefined);

      try {
        await archiveWorktreeRequest({
          backend: thread.source,
          threadId: thread.id,
          repositoryPath: directory.path,
          worktreePath,
        });
        await refresh(buildThreadIdentityKey(thread.source, thread.id));
      } catch (error) {
        setWorktreeArchiveError(error instanceof Error ? error.message : String(error));
      }
    },
    [archiveWorktreeRequest, refresh]
  );

  const restoreWorktree = useCallback(
    async (
      thread: NavigationThreadSummary,
      snapshotRef: string,
      worktreePath: string
    ): Promise<void> => {
      if (!restoreWorktreeRequest) {
        setWorktreeArchiveError("Desktop bridge is missing restoreWorktree().");
        return;
      }

      setWorktreeArchiveError(undefined);
      setArchiveThreadError(undefined);

      try {
        await restoreWorktreeRequest({
          backend: thread.source,
          threadId: thread.id,
          snapshotRef,
          worktreePath,
        });
        await refresh(buildThreadIdentityKey(thread.source, thread.id));
      } catch (error) {
        setWorktreeArchiveError(error instanceof Error ? error.message : String(error));
      }
    },
    [refresh, restoreWorktreeRequest]
  );

  const renameThread = useCallback(
    async (thread: NavigationThreadSummary, name: string): Promise<void> => {
      const nextName = name.trim();
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);

      if (!nextName) {
        setRenameThreadError("Thread name cannot be blank.");
        return;
      }

      if (!renameThreadRequest) {
        setRenameThreadError("Desktop bridge is missing renameThread().");
        return;
      }

      setRenameThreadError(undefined);
      setArchiveThreadError(undefined);
      setCreateThreadError(undefined);
      setLaunchpadError(undefined);
      setSetThreadExecutionModeError(undefined);
      setSetThreadModelSettingsError(undefined);
      setState((current) => ({
        ...current,
        response: applyThreadNameUpdate(current.response, {
          backend: thread.source,
          threadId: thread.id,
          threadName: nextName,
        }),
      }));
      setRetainedUnreadThread((current) =>
        current?.source === thread.source && current.id === thread.id
          ? {
              ...current,
              title: nextName,
              titleSource: "explicit",
            }
          : current
      );
      setOptimisticThread((current) =>
        current?.source === thread.source && current.id === thread.id
          ? {
              ...current,
              title: nextName,
              titleSource: "explicit",
            }
          : current
      );

      try {
        await renameThreadRequest({
          backend: thread.source,
          threadId: thread.id,
          name: nextName,
        });
        await refresh(threadKey);
      } catch (error) {
        setRenameThreadError(error instanceof Error ? error.message : String(error));
        await refresh(threadKey);
      }
    },
    [refresh, renameThreadRequest]
  );

  const updateThreadExecutionMode = useCallback(
    async (
      thread: NavigationThreadSummary,
      executionMode: ThreadExecutionMode
    ): Promise<void> => {
      if (!setThreadExecutionMode) {
        setSetThreadExecutionModeError(
          "Desktop bridge is missing setThreadExecutionMode()."
        );
        return;
      }

      setUpdatingThreadExecutionMode(executionMode);
      setSetThreadExecutionModeError(undefined);
      setOptimisticThread((current) =>
        current && current.id === thread.id && current.source === thread.source
          ? { ...current, executionMode }
          : current
      );
      setState((current) =>
        current.response
          ? {
              ...current,
              response: {
                ...current.response,
                threads: current.response.threads.map((candidate) =>
                  candidate.id === thread.id && candidate.source === thread.source
                    ? { ...candidate, executionMode }
                    : candidate
                ),
              },
            }
          : current
      );

      try {
        await setThreadExecutionMode({
          backend: thread.source,
          threadId: thread.id,
          executionMode,
        });
        await refresh(buildThreadIdentityKey(thread.source, thread.id));
      } catch (error) {
        setSetThreadExecutionModeError(error instanceof Error ? error.message : String(error));
        await refresh(buildThreadIdentityKey(thread.source, thread.id));
      } finally {
        setUpdatingThreadExecutionMode(undefined);
      }
    },
    [refresh, setThreadExecutionMode]
  );

  const updateThreadModelSettings = useCallback(
    async (
      thread: NavigationThreadSummary,
      patch: Partial<
        Pick<
          NavigationThreadSummary,
          "model" | "reasoningEffort" | "serviceTier" | "fastMode"
        >
      >
    ): Promise<void> => {
      if (!setThreadModelSettings) {
        setSetThreadModelSettingsError(
          "Desktop bridge is missing setThreadModelSettings()."
        );
        return;
      }

      const nextSettings = {
        model: "model" in patch ? patch.model : thread.model,
        reasoningEffort:
          "reasoningEffort" in patch
            ? patch.reasoningEffort
            : thread.reasoningEffort,
        serviceTier: "serviceTier" in patch ? patch.serviceTier : thread.serviceTier,
        fastMode:
          thread.source === "codex"
            ? "fastMode" in patch
              ? patch.fastMode
              : thread.fastMode
            : undefined,
      };

      setSetThreadModelSettingsError(undefined);
      setOptimisticThread((current) =>
        current && current.id === thread.id && current.source === thread.source
          ? { ...current, ...nextSettings }
          : current
      );
      setState((current) => ({
        ...current,
        response: applyThreadModelSettingsUpdate(current.response, {
          backend: thread.source,
          threadId: thread.id,
          ...nextSettings,
        }),
      }));

      try {
        await setThreadModelSettings({
          backend: thread.source,
          threadId: thread.id,
          ...nextSettings,
        });
      } catch (error) {
        setSetThreadModelSettingsError(
          error instanceof Error ? error.message : String(error)
        );
        await refresh(buildThreadIdentityKey(thread.source, thread.id));
      }
    },
    [refresh, setThreadModelSettings]
  );

  return {
    browseMode,
    createThread,
    createThreadError,
    creatingThread,
    directories,
    error: state.error,
    inboxThreads,
    launchpadError,
    archiveThreadError,
    worktreeArchiveError,
    renameThreadError,
    loading: state.loading,
    refreshing: state.refreshing,
    refresh: async () => await refresh(),
    materializeDirectoryLaunchpad,
    openDirectoryLaunchpad,
    resetDirectoryLaunchpad,
    selectedDirectory,
    selectedItemKey,
    selectedLaunchpad,
    selectedThread,
    selectedThreadKey,
    setThreadExecutionMode: updateThreadExecutionMode,
    setThreadExecutionModeError,
    setThreadModelSettings: updateThreadModelSettings,
    setThreadModelSettingsError,
    updatingThreadExecutionMode,
    updateDirectoryLaunchpad,
    setBrowseMode,
    selectThread,
    archiveThread,
    archiveWorktree,
    restoreWorktree,
    renameThread,
    snapshot: state.response,
    threads,
  };
}
