import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  NavigationSnapshot,
  NavigationThreadSummary
} from "@pwragnt/shared";
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
  error?: string;
  inboxThreads: NavigationThreadSummary[];
  loading: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
  selectedThread?: NavigationThreadSummary;
  setBrowseMode: (browseMode: BrowseMode) => void;
  selectThread: (thread: NavigationThreadSummary) => void;
  snapshot?: NavigationSnapshot;
  threads: NavigationThreadSummary[];
} {
  const markThreadSeen = desktopApi?.markThreadSeen;
  const [browseMode, setBrowseMode] = useState<BrowseMode>("recents");
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [pendingSeenThreadId, setPendingSeenThreadId] = useState<string>();
  const [state, setState] = useState<NavigationState>({
    loading: true,
    refreshing: false
  });

  const refresh = useCallback(async (): Promise<void> => {
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
      const response = await desktopApi.getNavigationSnapshot({ backend: "codex" });
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

      if (!response.unchanged) {
        setSelectedThreadId((current) => {
          if (current && response.threads.some((thread) => thread.id === current)) {
            return current;
          }
          return response.threads[0]?.id;
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
    const inboxIds = new Set(state.response?.inboxThreadIds ?? []);
    return threads.filter((thread) => inboxIds.has(thread.id));
  }, [state.response?.inboxThreadIds, threads]);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? threads[0],
    [selectedThreadId, threads]
  );

  useEffect(() => {
    const submitMarkThreadSeen = markThreadSeen;

    if (
      !pendingSeenThreadId ||
      !selectedThread ||
      pendingSeenThreadId !== selectedThread.id ||
      !submitMarkThreadSeen
    ) {
      return;
    }

    let cancelled = false;

    async function markSeen(): Promise<void> {
      try {
        await submitMarkThreadSeen!({
          backend: "codex",
          threadId: selectedThread.id,
          seenUpdatedAt: selectedThread.updatedAt
        });
        if (!cancelled) {
          await refresh();
        }
      } finally {
        if (!cancelled) {
          setPendingSeenThreadId(undefined);
        }
      }
    }

    void markSeen();

    return () => {
      cancelled = true;
    };
  }, [markThreadSeen, pendingSeenThreadId, refresh, selectedThread]);

  const selectThread = useCallback((thread: NavigationThreadSummary): void => {
    setSelectedThreadId(thread.id);
    setPendingSeenThreadId(thread.id);
  }, []);

  return {
    browseMode,
    error: state.error,
    inboxThreads,
    loading: state.loading,
    refreshing: state.refreshing,
    refresh,
    selectedThread,
    setBrowseMode,
    selectThread,
    snapshot: state.response,
    threads
  };
}
