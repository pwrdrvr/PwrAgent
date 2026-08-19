import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildThreadIdentityKey,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

/**
 * How long to wait for a newly created manager thread to appear in the
 * navigation snapshot before telling the operator it did not. The refresh
 * is a round trip through the main process; a spinner that never resolves
 * is worse than a message saying to try again.
 */
const MANAGER_THREAD_ARRIVAL_TIMEOUT_MS = 15_000;

export type StarMapManagerStatus = "idle" | "opening" | "failed";

export type StarMapManagerController = {
  status: StarMapManagerStatus;
  error?: string;
  /** Resolve the manager thread and float its chat card over the map. */
  open: () => void;
  dismissError: () => void;
};

/**
 * Opens the Star Map manager: the thread the operator talks to about the
 * map itself.
 *
 * The manager is resolved in the main process (which owns its identity and
 * its workspace) and then shown with the same floating chat card any other
 * thread gets — it is an ordinary thread with the ordinary tool catalog,
 * not a privileged surface.
 */
export function useStarMapManager(params: {
  desktopApi?: DesktopApi;
  /** Local navigation threads, unfiltered by the map's own filters. */
  threads: readonly NavigationThreadSummary[];
  openThread: (thread: NavigationThreadSummary) => void;
  onRefreshLocalThreads?: () => void;
}): StarMapManagerController {
  const [status, setStatus] = useState<StarMapManagerStatus>("idle");
  const [error, setError] = useState<string>();
  const [pendingThreadKey, setPendingThreadKey] = useState<string>();
  const timerRef = useRef<number | undefined>(undefined);
  const openThreadRef = useRef(params.openThread);
  openThreadRef.current = params.openThread;
  const threadsRef = useRef(params.threads);
  threadsRef.current = params.threads;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const open = useCallback(() => {
    const resolve = params.desktopApi?.openStarMapManager;
    if (!resolve || status === "opening") return;
    setError(undefined);
    setStatus("opening");
    void resolve({})
      .then((response) => {
        if (response.status !== "ready") {
          setStatus("failed");
          setError(response.error);
          return;
        }
        const threadKey = buildThreadIdentityKey(
          response.backend as NavigationThreadSummary["source"],
          response.threadId,
        );
        const existing = threadsRef.current.find(
          (thread) =>
            buildThreadIdentityKey(thread.source, thread.id) === threadKey,
        );
        if (existing) {
          openThreadRef.current(existing);
          setStatus("idle");
          return;
        }
        // Freshly created: the card needs the thread's navigation summary,
        // which only arrives with the next snapshot.
        setPendingThreadKey(threadKey);
        params.onRefreshLocalThreads?.();
        clearTimer();
        timerRef.current = window.setTimeout(() => {
          setPendingThreadKey(undefined);
          setStatus("failed");
          setError("The manager thread did not load. Try again.");
        }, MANAGER_THREAD_ARRIVAL_TIMEOUT_MS);
      })
      .catch((cause: unknown) => {
        setStatus("failed");
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [clearTimer, params, status]);

  useEffect(() => {
    if (!pendingThreadKey) return;
    const arrived = params.threads.find(
      (thread) =>
        buildThreadIdentityKey(thread.source, thread.id) === pendingThreadKey,
    );
    if (!arrived) return;
    clearTimer();
    setPendingThreadKey(undefined);
    setStatus("idle");
    openThreadRef.current(arrived);
  }, [clearTimer, params.threads, pendingThreadKey]);

  return {
    status,
    error,
    open,
    dismissError: useCallback(() => {
      setError(undefined);
      setStatus("idle");
    }, []),
  };
}
