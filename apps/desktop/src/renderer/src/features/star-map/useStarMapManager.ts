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

export type StarMapManagerController = {
  /** True while the manager is being resolved; the button reads it. */
  busy: boolean;
  /** Resolve the manager thread and float its chat card over the map. */
  open: () => void;
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
  /**
   * Where a failure is shown. The map already owns one error banner, and
   * `.star-map__card-error` is absolutely positioned, so a second one would
   * sit in the same box as the first.
   */
  onError: (message: string) => void;
}): StarMapManagerController {
  const [busy, setBusy] = useState(false);
  const [pendingThreadKey, setPendingThreadKey] = useState<string>();
  const timerRef = useRef<number | undefined>(undefined);
  const openThreadRef = useRef(params.openThread);
  openThreadRef.current = params.openThread;
  const threadsRef = useRef(params.threads);
  threadsRef.current = params.threads;
  // Held in refs so `open` keeps one identity: the caller rebuilds this
  // props object every render, and a callback that changes with it would
  // make the button's `onClick` a new value on every frame of a pan.
  const resolveRef = useRef(params.desktopApi?.openStarMapManager);
  resolveRef.current = params.desktopApi?.openStarMapManager;
  const refreshRef = useRef(params.onRefreshLocalThreads);
  refreshRef.current = params.onRefreshLocalThreads;
  const errorRef = useRef(params.onError);
  errorRef.current = params.onError;
  // `open`'s continuation can land after the surface is gone: resolving the
  // manager writes files and starts a thread, so the operator has time to
  // close the window. The unmount cleanup runs before the timer is created,
  // so without this flag nothing is left to clear it.
  const mountedRef = useRef(true);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  const fail = useCallback((message: string) => {
    setBusy(false);
    setPendingThreadKey(undefined);
    errorRef.current(message);
  }, []);

  const open = useCallback(() => {
    const resolve = resolveRef.current;
    if (!resolve || busy) return;
    setBusy(true);
    void resolve({})
      .then((response) => {
        if (!mountedRef.current) return;
        if (response.status !== "ready") {
          fail(response.error ?? "The Star Map manager could not be opened.");
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
          setBusy(false);
          return;
        }
        // Freshly created: the card needs the thread's navigation summary,
        // which only arrives with the next snapshot.
        setPendingThreadKey(threadKey);
        // Awaited only for its failure: the arrival effect is what ends the
        // wait, but an unhandled rejection here would leave the button
        // disabled for the full timeout with nothing said.
        void Promise.resolve(refreshRef.current?.()).catch(() => undefined);
        clearTimer();
        timerRef.current = window.setTimeout(() => {
          fail("The manager thread did not load. Try again.");
        }, MANAGER_THREAD_ARRIVAL_TIMEOUT_MS);
      })
      .catch((cause: unknown) => {
        if (!mountedRef.current) return;
        fail(cause instanceof Error ? cause.message : String(cause));
      });
  }, [busy, clearTimer, fail]);

  useEffect(() => {
    if (!pendingThreadKey) return;
    const arrived = params.threads.find(
      (thread) =>
        buildThreadIdentityKey(thread.source, thread.id) === pendingThreadKey,
    );
    if (!arrived) return;
    clearTimer();
    setPendingThreadKey(undefined);
    setBusy(false);
    openThreadRef.current(arrived);
  }, [clearTimer, params.threads, pendingThreadKey]);

  return { busy, open };
}
