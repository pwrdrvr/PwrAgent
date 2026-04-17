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
  const [creatingThreadBackend, setCreatingThreadBackend] =
    useState<AppServerBackendKind>();
  const [createThreadError, setCreateThreadError] = useState<string>();
  const [state, setState] = useState<NavigationState>({
    loading: true,
    refreshing: false
  });

  const refresh = useCallback(async (preferredThreadKey?: string): Promise<void> => {
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

      if (!response.unchanged || preferredThreadKey) {
        setSelectedThreadKey((current) => {
          if (
            preferredThreadKey &&
            response.threads.some(
              (thread) =>
                buildThreadIdentityKey(thread.source, thread.id) === preferredThreadKey,
            )
          ) {
            return preferredThreadKey;
          }

          if (
            current &&
            response.threads.some(
              (thread) => buildThreadIdentityKey(thread.source, thread.id) === current,
            )
          ) {
            return current;
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
  }, [desktopApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!desktopApi?.onWindowFocus) {
      return;
    }

    return desktopApi.onWindowFocus(() => {
      void refresh();
    });
  }, [desktopApi, refresh]);

  const threads = state.response?.threads ?? [];
  const inboxThreads = useMemo(() => {
    const inboxThreadKeys = new Set(state.response?.inboxThreadKeys ?? []);
    return threads.filter((thread) =>
      inboxThreadKeys.has(buildThreadIdentityKey(thread.source, thread.id)),
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
        const nextThreadKey = buildThreadIdentityKey(response.backend, response.threadId);
        setSelectedThreadKey(nextThreadKey);
        setPendingSeenThreadKey(nextThreadKey);
        await refresh(nextThreadKey);
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
