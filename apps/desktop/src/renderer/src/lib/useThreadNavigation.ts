import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppServerBackendKind,
  AppServerTurnInputItem,
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
  NavigationSnapshot,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";
import type { DesktopApi } from "./desktop-api";

export type BrowseMode = "recents" | "directories";

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
    left.executionMode === right.executionMode &&
    linkedDirectoriesEqual(left.linkedDirectories, right.linkedDirectories) &&
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
}): NavigationThreadSummary {
  return {
    id: params.threadId,
    title: "Untitled thread",
    titleSource: "fallback",
    summary: params.launchpad.prompt.trim() || undefined,
    projectKey: params.launchpad.directoryPath,
    source: params.backend,
    executionMode: params.executionMode,
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
        ? params.launchpad.branchName
        : params.directory?.gitStatus?.currentBranch ?? params.launchpad.branchName,
    updatedAt: Date.now(),
    inbox: {
      inInbox: true,
      reason: "new-thread",
    },
  };
}

export function useThreadNavigation(desktopApi?: DesktopApi): {
  browseMode: BrowseMode;
  createThread: (
    backend: AppServerBackendKind,
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
  loading: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
  materializeDirectoryLaunchpad: (
    directoryKey: string,
    input?: AppServerTurnInputItem[]
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
  updatingThreadExecutionMode?: ThreadExecutionMode;
  updateDirectoryLaunchpad: (
    directoryKey: string,
    patch: Parameters<NonNullable<DesktopApi["updateDirectoryLaunchpad"]>>[0]["patch"]
  ) => Promise<void>;
  setBrowseMode: (browseMode: BrowseMode) => void;
  selectThread: (thread: NavigationThreadSummary) => void;
  snapshot?: NavigationSnapshot;
  threads: NavigationThreadSummary[];
} {
  const markThreadSeen = desktopApi?.markThreadSeen;
  const startThread = desktopApi?.startThread;
  const setThreadExecutionMode = desktopApi?.setThreadExecutionMode;
  const [browseMode, setBrowseMode] = useState<BrowseMode>("recents");
  const [selectedItemKey, setSelectedItemKey] = useState<string>();
  const [pendingSeenThreadKey, setPendingSeenThreadKey] = useState<string>();
  const [optimisticThread, setOptimisticThread] = useState<NavigationThreadSummary>();
  const [creatingThread, setCreatingThread] = useState<{
    backend: AppServerBackendKind;
    executionMode: ThreadExecutionMode;
  }>();
  const [createThreadError, setCreateThreadError] = useState<string>();
  const [launchpadError, setLaunchpadError] = useState<string>();
  const [updatingThreadExecutionMode, setUpdatingThreadExecutionMode] =
    useState<ThreadExecutionMode>();
  const [setThreadExecutionModeError, setSetThreadExecutionModeError] =
    useState<string>();
  const [state, setState] = useState<NavigationState>({
    loading: true,
    refreshing: false,
  });

  const optimisticThreadRef = useRef<NavigationThreadSummary | undefined>(undefined);
  const refreshInFlightRef = useRef(false);
  const queuedRefreshRef = useRef<
    | {
        preferredOptimisticThread?: NavigationThreadSummary;
        preferredSelectionKey?: string;
      }
    | undefined
  >(undefined);
  const scheduledRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  optimisticThreadRef.current = optimisticThread;

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
        const response = await desktopApi.getNavigationSnapshot();
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
          setOptimisticThread(undefined);
        }

        setSelectedItemKey((current) => {
          const candidate = preferredSelectionKey ?? current;
          if (candidate && hasSelectionKey(response, candidate, optimisticThreadKey)) {
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

      if (
        method === "turn/completed" ||
        method === "turn/failed" ||
        method === "turn/cancelled"
      ) {
        scheduleRefresh();
      }
    });
  }, [desktopApi, scheduleRefresh]);

  const threads = useMemo(() => {
    const currentThreads = state.response?.threads ?? [];
    if (!optimisticThread) {
      return currentThreads;
    }

    const optimisticThreadKey = buildThreadIdentityKey(
      optimisticThread.source,
      optimisticThread.id
    );

    if (
      currentThreads.some(
        (thread) => buildThreadIdentityKey(thread.source, thread.id) === optimisticThreadKey
      )
    ) {
      return currentThreads;
    }

    return [optimisticThread, ...currentThreads];
  }, [optimisticThread, state.response?.threads]);

  const directories = state.response?.directories ?? [];

  const inboxThreads = useMemo(() => {
    const inboxThreadKeys = new Set(state.response?.inboxThreadKeys ?? []);
    return threads.filter((thread) =>
      inboxThreadKeys.has(buildThreadIdentityKey(thread.source, thread.id)) ||
      thread.inbox.inInbox
    );
  }, [state.response?.inboxThreadKeys, threads]);

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
          setState((current) => ({
            ...current,
            response: markThreadSeenInSnapshot(current.response, {
              backend: threadToMarkSeen.source,
              threadId: threadToMarkSeen.id,
              seenUpdatedAt: threadToMarkSeen.updatedAt,
            }),
          }));
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
  }, [markThreadSeen, pendingSeenThreadKey, selectedThread]);

  const selectThread = useCallback((thread: NavigationThreadSummary): void => {
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);
    setCreateThreadError(undefined);
    setLaunchpadError(undefined);
    setSetThreadExecutionModeError(undefined);
    setSelectedItemKey(threadKey);
    setPendingSeenThreadKey(threadKey);
  }, []);

  const createThread = useCallback(
    async (
      backend: AppServerBackendKind,
      executionMode: ThreadExecutionMode = "default"
    ): Promise<void> => {
      if (!startThread) {
        setCreateThreadError("Desktop bridge is missing startThread().");
        return;
      }

      setCreatingThread({ backend, executionMode });
      setCreateThreadError(undefined);
      setLaunchpadError(undefined);

      try {
        const response = await startThread({ backend, executionMode });
        const optimisticUpdatedAt = Date.now();
        const nextThreadKey = buildThreadIdentityKey(response.backend, response.threadId);
        const nextOptimisticThread: NavigationThreadSummary = {
          id: response.threadId,
          title: "Untitled thread",
          titleSource: "fallback",
          summary: undefined,
          source: response.backend,
          executionMode: response.executionMode,
          linkedDirectories: [],
          updatedAt: optimisticUpdatedAt,
          inbox: {
            inInbox: true,
            reason: "new-thread",
          },
        };
        setOptimisticThread(nextOptimisticThread);
        setSelectedItemKey(nextThreadKey);
        setPendingSeenThreadKey(nextThreadKey);
        await refresh(nextThreadKey, nextOptimisticThread);
      } catch (error) {
        setCreateThreadError(error instanceof Error ? error.message : String(error));
      } finally {
        setCreatingThread(undefined);
      }
    },
    [refresh, startThread]
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
      setSetThreadExecutionModeError(undefined);

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
      input?: AppServerTurnInputItem[]
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
        });
        const optimisticMaterializedThread = buildOptimisticThreadFromLaunchpad({
          directory,
          launchpad,
          backend: response.backend,
          threadId: response.threadId,
          executionMode: response.executionMode,
          workMode: response.workMode,
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

  return {
    browseMode,
    createThread,
    createThreadError,
    creatingThread,
    directories,
    error: state.error,
    inboxThreads,
    launchpadError,
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
    updatingThreadExecutionMode,
    updateDirectoryLaunchpad,
    setBrowseMode,
    selectThread,
    snapshot: state.response,
    threads,
  };
}
