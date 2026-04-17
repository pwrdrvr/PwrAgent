import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AppServerBackendKind,
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
  error?: string;
  inboxThreads: NavigationThreadSummary[];
  loading: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
  selectedThread?: NavigationThreadSummary;
  selectedThreadKey?: string;
  setThreadExecutionMode: (
    thread: NavigationThreadSummary,
    executionMode: ThreadExecutionMode
  ) => Promise<void>;
  setThreadExecutionModeError?: string;
  updatingThreadExecutionMode?: ThreadExecutionMode;
  setBrowseMode: (browseMode: BrowseMode) => void;
  selectThread: (thread: NavigationThreadSummary) => void;
  snapshot?: NavigationSnapshot;
  threads: NavigationThreadSummary[];
} {
  const markThreadSeen = desktopApi?.markThreadSeen;
  const startThread = desktopApi?.startThread;
  const setThreadExecutionMode = desktopApi?.setThreadExecutionMode;
  const [browseMode, setBrowseMode] = useState<BrowseMode>("recents");
  const [selectedThreadKey, setSelectedThreadKey] = useState<string>();
  const [pendingSeenThreadKey, setPendingSeenThreadKey] = useState<string>();
  const [optimisticThread, setOptimisticThread] = useState<NavigationThreadSummary>();
  const [creatingThread, setCreatingThread] = useState<{
    backend: AppServerBackendKind;
    executionMode: ThreadExecutionMode;
  }>();
  const [createThreadError, setCreateThreadError] = useState<string>();
  const [updatingThreadExecutionMode, setUpdatingThreadExecutionMode] =
    useState<ThreadExecutionMode>();
  const [setThreadExecutionModeError, setSetThreadExecutionModeError] =
    useState<string>();
  const [state, setState] = useState<NavigationState>({
    loading: true,
    refreshing: false
  });

  const refresh = useCallback(async (
    preferredThreadKey?: string,
    preferredOptimisticThread?: NavigationThreadSummary
  ): Promise<void> => {
    if (!desktopApi?.getNavigationSnapshot) {
      setState({
        loading: false,
        refreshing: false,
        error: "Desktop bridge is missing getNavigationSnapshot().",
        response: undefined
      });
      return;
    }

    setState((current) => ({
      ...current,
      loading: !current.response,
      refreshing: Boolean(current.response),
      error: undefined
    }));

    try {
      const response = await desktopApi.getNavigationSnapshot();
      const optimisticSelection = preferredOptimisticThread ?? optimisticThread;
      const optimisticThreadKey = optimisticSelection
        ? buildThreadIdentityKey(optimisticSelection.source, optimisticSelection.id)
        : undefined;
      const hasPreferredThread = Boolean(
        preferredThreadKey &&
          response.threads.some(
            (thread) =>
              buildThreadIdentityKey(thread.source, thread.id) === preferredThreadKey,
          )
      );
      const hasOptimisticThread = Boolean(
        optimisticThreadKey &&
          response.threads.some(
            (thread) =>
              buildThreadIdentityKey(thread.source, thread.id) === optimisticThreadKey,
          )
      );

      setState((current) => {
        if (current.response && response.unchanged) {
          return {
            ...current,
            loading: false,
            refreshing: false,
            error: undefined
          };
        }

        return {
          loading: false,
          refreshing: false,
          error: undefined,
          response
        };
      });

      if (hasOptimisticThread) {
        setOptimisticThread(undefined);
      }

      if (!response.unchanged || preferredThreadKey) {
        setSelectedThreadKey((current) => {
          if (
            preferredThreadKey &&
            (hasPreferredThread || preferredThreadKey === optimisticThreadKey)
          ) {
            return preferredThreadKey;
          }

          if (
            current &&
            (
              response.threads.some(
                (thread) => buildThreadIdentityKey(thread.source, thread.id) === current,
              ) ||
              current === optimisticThreadKey
            )
          ) {
            return current;
          }

          if (optimisticThreadKey) {
            return optimisticThreadKey;
          }

          return response.threads[0]
            ? buildThreadIdentityKey(response.threads[0].source, response.threads[0].id)
            : undefined;
        });
      }
    } catch (error) {
      setState((current) => ({
        loading: false,
        refreshing: false,
        response: current.response,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }, [desktopApi, optimisticThread]);

  useEffect(() => {
    void refresh();
  }, [desktopApi, refresh]);

  useEffect(() => {
    if (!desktopApi?.onWindowFocus) {
      return;
    }

    return desktopApi.onWindowFocus(() => {
      void refresh();
    });
  }, [desktopApi, refresh]);

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
        void refresh();
      }
    });
  }, [desktopApi, refresh]);

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

  const inboxThreads = useMemo(() => {
    const inboxThreadKeys = new Set(state.response?.inboxThreadKeys ?? []);
    return threads.filter((thread) =>
      inboxThreadKeys.has(buildThreadIdentityKey(thread.source, thread.id)) ||
      thread.inbox.inInbox,
    );
  }, [state.response?.inboxThreadKeys, threads]);

  const selectedThread = useMemo(
    () =>
      threads.find(
        (thread) =>
          buildThreadIdentityKey(thread.source, thread.id) === selectedThreadKey,
      ) ?? threads[0],
    [selectedThreadKey, threads]
  );

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

    let cancelled = false;

    async function markSeen(): Promise<void> {
      try {
        await submitMarkThreadSeen!({
          backend: selectedThread.source,
          threadId: selectedThread.id,
          seenUpdatedAt: selectedThread.updatedAt
        });
        if (!cancelled) {
          await refresh();
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
  }, [markThreadSeen, pendingSeenThreadKey, refresh, selectedThread]);

  const selectThread = useCallback((thread: NavigationThreadSummary): void => {
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);
    setCreateThreadError(undefined);
    setSetThreadExecutionModeError(undefined);
    setSelectedThreadKey(threadKey);
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
            reason: "new-thread"
          }
        };
        setOptimisticThread(nextOptimisticThread);
        setSelectedThreadKey(nextThreadKey);
        setPendingSeenThreadKey(nextThreadKey);
        await refresh(nextThreadKey, nextOptimisticThread);
      } catch (error) {
        setCreateThreadError(error instanceof Error ? error.message : String(error));
      } finally {
        setCreatingThread(undefined);
      }
    },
    [refresh, startThread],
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
    error: state.error,
    inboxThreads,
    loading: state.loading,
    refreshing: state.refreshing,
    refresh,
    selectedThread,
    selectedThreadKey,
    setThreadExecutionMode: updateThreadExecutionMode,
    setThreadExecutionModeError,
    updatingThreadExecutionMode,
    setBrowseMode,
    selectThread,
    snapshot: state.response,
    threads
  };
}
