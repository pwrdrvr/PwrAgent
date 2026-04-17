import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AppServerBackendKind,
  NavigationSnapshot,
  NavigationThreadSummary
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

export function useThreadNavigation(desktopApi?: DesktopApi): {
  browseMode: BrowseMode;
  createThread: (backend: AppServerBackendKind) => Promise<void>;
  createThreadError?: string;
  creatingThreadBackend?: AppServerBackendKind;
  error?: string;
  inboxThreads: NavigationThreadSummary[];
  loading: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
  selectedThread?: NavigationThreadSummary;
  selectedThreadKey?: string;
  setBrowseMode: (browseMode: BrowseMode) => void;
  selectThread: (thread: NavigationThreadSummary) => void;
  snapshot?: NavigationSnapshot;
  threads: NavigationThreadSummary[];
} {
  const markThreadSeen = desktopApi?.markThreadSeen;
  const startThread = desktopApi?.startThread;
  const [browseMode, setBrowseMode] = useState<BrowseMode>("recents");
  const [selectedThreadKey, setSelectedThreadKey] = useState<string>();
  const [pendingSeenThreadKey, setPendingSeenThreadKey] = useState<string>();
  const [optimisticThread, setOptimisticThread] = useState<NavigationThreadSummary>();
  const [creatingThreadBackend, setCreatingThreadBackend] =
    useState<AppServerBackendKind>();
  const [createThreadError, setCreateThreadError] = useState<string>();
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
    setSelectedThreadKey(threadKey);
    setPendingSeenThreadKey(threadKey);
  }, []);

  const createThread = useCallback(
    async (backend: AppServerBackendKind): Promise<void> => {
      if (!startThread) {
        setCreateThreadError("Desktop bridge is missing startThread().");
        return;
      }

      setCreatingThreadBackend(backend);
      setCreateThreadError(undefined);

      try {
        const response = await startThread({ backend });
        const optimisticUpdatedAt = Date.now();
        const nextThreadKey = buildThreadIdentityKey(response.backend, response.threadId);
        const nextOptimisticThread: NavigationThreadSummary = {
          id: response.threadId,
          title: "Untitled thread",
          summary: undefined,
          source: response.backend,
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
        setCreatingThreadBackend(undefined);
      }
    },
    [refresh, startThread],
  );

  return {
    browseMode,
    createThread,
    createThreadError,
    creatingThreadBackend,
    error: state.error,
    inboxThreads,
    loading: state.loading,
    refreshing: state.refreshing,
    refresh,
    selectedThread,
    selectedThreadKey,
    setBrowseMode,
    selectThread,
    snapshot: state.response,
    threads
  };
}
