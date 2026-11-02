import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentEvent,
  FederationTarget,
  NavigationThreadSummary,
  ThreadPendingWake,
  ThreadPendingWakeEnded,
  ThreadPendingWakesResponse,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";

/**
 * `unknown`: no list to show, rather than a false "nothing waiting": the
 * window has no API, or the thread's owner predates the list.
 */
export type ThreadPendingWakesState =
  | { status: "unknown" }
  | { status: "loading" }
  | {
      status: "ready";
      wakes: readonly ThreadPendingWake[];
      ended: readonly ThreadPendingWakeEnded[];
      /** A source could not be read, so a wake may be missing. */
      incomplete: boolean;
      /** The thread runs on a peer; the list is its owner's. */
      peer: boolean;
    };

export type ThreadPendingWakesController = {
  state: ThreadPendingWakesState;
  /** Resolves with the owner's answer; refreshes the list either way. */
  stop: (key: string) => Promise<ThreadPendingWakesResponse>;
};

type PendingWakesApi = Pick<DesktopApi, "manageThreadPendingWakes" | "onAgentEvent">;

const UNKNOWN: ThreadPendingWakesState = { status: "unknown" };
const REFRESH_DEBOUNCE_MS = 200;
const EMPTY_ENDED: readonly ThreadPendingWakeEnded[] = [];

/** The change events each wake source already sends. */
const SOURCE_EVENTS = new Set<string>([
  "thread/prWatches/updated",
  "thread/dependencies/updated",
  "thread/scheduledAction/updated",
  "thread/subAgents/updated",
  "thread/backgroundTasks/updated",
]);

/**
 * The selected thread's pending wakes. A local thread's list is read from
 * main and re-read when any wake source changes for the thread. A peer's
 * thread uses its owner's projection on selected detail.
 */
export function useThreadPendingWakes(
  thread: NavigationThreadSummary | undefined,
  desktopApi?: PendingWakesApi,
): ThreadPendingWakesController {
  const federationTarget = readThreadFederationTarget(thread);
  const peer = federationTarget !== undefined;
  const backend = thread?.source;
  const threadId = thread?.id;
  const [local, setLocal] = useState<ThreadPendingWakesState>(UNKNOWN);
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (peer || !backend || !threadId || !desktopApi?.manageThreadPendingWakes) {
      setLocal(UNKNOWN);
      refreshRef.current = async () => {};
      return;
    }
    const manage = desktopApi.manageThreadPendingWakes;
    let disposed = false;
    let latest = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const sequence = ++latest;
      try {
        const response = await manage({ action: "list", backend, threadId });
        if (disposed || sequence !== latest || !response.ok) return;
        setLocal({
          status: "ready",
          wakes: response.wakes ?? [],
          ended: response.ended ?? EMPTY_ENDED,
          incomplete: response.incomplete === true,
          peer: false,
        });
      } catch {
        // Keep the last list; the next change event reads again.
      }
    };
    refreshRef.current = refresh;
    setLocal({ status: "loading" });
    void refresh();
    const unsubscribe = desktopApi.onAgentEvent?.((event) => {
      if (!isSourceEventFor(event, threadId)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS);
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [backend, desktopApi, peer, threadId]);

  const stop = useCallback(async (key: string): Promise<ThreadPendingWakesResponse> => {
    if (!backend || !threadId || !desktopApi?.manageThreadPendingWakes) {
      return { ok: false, error: { code: "failed", message: "This window cannot stop wakes." } };
    }
    try {
      return await desktopApi.manageThreadPendingWakes({
        action: "stop",
        backend,
        threadId,
        ...(federationTarget ? { federationTarget } : {}),
        key,
      });
    } catch (error) {
      return { ok: false, error: { code: "failed", message: error instanceof Error ? error.message : String(error) } };
    } finally {
      void refreshRef.current();
    }
  }, [backend, desktopApi, federationTarget, threadId]);

  const peerWakes = thread?.pendingWakes;
  const peerState = useMemo((): ThreadPendingWakesState => peerWakes
    ? { status: "ready", wakes: peerWakes, ended: EMPTY_ENDED, incomplete: false, peer: true }
    : UNKNOWN, [peerWakes]);
  return { state: peer ? peerState : local, stop };
}

function readThreadFederationTarget(
  thread: NavigationThreadSummary | undefined,
): FederationTarget | undefined {
  const target = thread?.federation?.ref.target ?? readRendererFederationTarget();
  return target?.scope === "remote" ? target : undefined;
}

/** The thread an event names: most carry `threadId`; scheduled actions nest it. */
function isSourceEventFor(event: AgentEvent, threadId: string): boolean {
  if (event.federationTarget?.scope === "remote") return false;
  const { method } = event.notification;
  if (!SOURCE_EVENTS.has(method)) return false;
  const params = event.notification.params as { threadId?: unknown; action?: { threadId?: unknown } } | undefined;
  return params?.threadId === threadId || params?.action?.threadId === threadId;
}
