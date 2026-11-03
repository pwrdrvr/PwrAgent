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
  // Turning a thread's Auto-fix on or off sends only this one.
  "thread/prAutoDispatch/updated",
  "thread/prWatches/updated",
  "thread/dependencies/updated",
  "thread/scheduledAction/updated",
  "thread/subAgents/updated",
  "thread/backgroundTasks/updated",
  // Holds: a lock, the queue it holds, and a project paused or resumed.
  "thread/lock/updated",
  "thread/turnQueue/updated",
  "directory/forgeAutomation/updated",
]);

/** Events that name no thread but can change any thread's holds. */
const ANY_THREAD_EVENTS = new Set<string>(["directory/forgeAutomation/updated"]);

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
  // A peer's list arrives with selected detail, which does not re-read for
  // every source's change. Hide what its owner confirmed stopped until the
  // next projection arrives.
  const [peerStopped, setPeerStopped] = useState<{
    wakes: readonly ThreadPendingWake[] | undefined;
    keys: ReadonlySet<string>;
  }>();

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
    // A failed first read must not leave the panel loading; a later failure
    // keeps the last list until the next change event reads again.
    const settleFailedRead = () => setLocal((current) => current.status === "loading" ? UNKNOWN : current);
    const refresh = async () => {
      const sequence = ++latest;
      try {
        const response = await manage({ action: "list", backend, threadId });
        if (disposed || sequence !== latest) return;
        if (!response.ok) {
          settleFailedRead();
          return;
        }
        setLocal({
          status: "ready",
          wakes: response.wakes ?? [],
          ended: response.ended ?? EMPTY_ENDED,
          incomplete: response.incomplete === true,
          peer: false,
        });
      } catch {
        if (!disposed && sequence === latest) settleFailedRead();
      }
    };
    refreshRef.current = refresh;
    setLocal({ status: "loading" });
    void refresh();
    const unsubscribe = desktopApi.onAgentEvent?.((event) => {
      if (!isSourceEventFor(event, backend, threadId)) return;
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
      const response = await desktopApi.manageThreadPendingWakes({
        action: "stop",
        backend,
        threadId,
        ...(federationTarget ? { federationTarget } : {}),
        key,
      });
      if (response.ok && federationTarget) {
        const projected = thread?.pendingWakes;
        setPeerStopped((current) => ({
          wakes: projected,
          keys: new Set(current && current.wakes === projected ? [...current.keys, key] : [key]),
        }));
      }
      return response;
    } catch (error) {
      return { ok: false, error: { code: "failed", message: error instanceof Error ? error.message : String(error) } };
    } finally {
      void refreshRef.current();
    }
  }, [backend, desktopApi, federationTarget, thread?.pendingWakes, threadId]);

  const peerWakes = thread?.pendingWakes;
  const peerIncomplete = thread?.pendingWakesIncomplete === true;
  const hidden = peerStopped?.wakes === peerWakes ? peerStopped?.keys : undefined;
  const peerState = useMemo((): ThreadPendingWakesState => peerWakes
    ? {
        status: "ready",
        wakes: hidden ? peerWakes.filter((wake) => !hidden.has(wake.key)) : peerWakes,
        ended: EMPTY_ENDED,
        incomplete: peerIncomplete,
        peer: true,
      }
    : UNKNOWN, [hidden, peerIncomplete, peerWakes]);
  return { state: peer ? peerState : local, stop };
}

function readThreadFederationTarget(
  thread: NavigationThreadSummary | undefined,
): FederationTarget | undefined {
  const target = thread?.federation?.ref.target ?? readRendererFederationTarget();
  return target?.scope === "remote" ? target : undefined;
}

/** The thread an event names: most carry `threadId`; scheduled actions nest it. */
function isSourceEventFor(event: AgentEvent, backend: string, threadId: string): boolean {
  if (event.federationTarget?.scope === "remote") return false;
  const { method } = event.notification;
  if (!SOURCE_EVENTS.has(method)) return false;
  // A project's change is stamped with whichever backend published it.
  if (ANY_THREAD_EVENTS.has(method)) return true;
  if (event.backend !== backend) return false;
  const params = event.notification.params as { threadId?: unknown; action?: { threadId?: unknown } } | undefined;
  return params?.threadId === threadId || params?.action?.threadId === threadId;
}
