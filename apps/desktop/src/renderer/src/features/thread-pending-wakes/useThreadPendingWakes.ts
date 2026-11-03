import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isThreadPendingWakeInvalidation } from "@pwragent/shared";
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
  /**
   * Another control ended a wake, such as Send Now on a held one. A local
   * list reads again; a peer's hides the row until its owner's next list.
   */
  ended: (key: string) => void;
};

type PendingWakesApi = Pick<DesktopApi, "manageThreadPendingWakes" | "onAgentEvent">;

const UNKNOWN: ThreadPendingWakesState = { status: "unknown" };
const REFRESH_DEBOUNCE_MS = 200;
const EMPTY_ENDED: readonly ThreadPendingWakeEnded[] = [];

/**
 * The selected thread's pending wakes. A local thread's list is read from
 * main and re-read when any wake source changes for the thread. A peer's
 * thread uses its owner's projection on selected detail.
 */
export function useThreadPendingWakes(
  thread: NavigationThreadSummary | undefined,
  desktopApi?: PendingWakesApi,
  options: { includeEnded?: boolean } = {},
): ThreadPendingWakesController {
  const federationTarget = readThreadFederationTarget(thread);
  const peer = federationTarget !== undefined;
  const backend = thread?.source;
  const threadId = thread?.id;
  const includeEnded = options.includeEnded === true;
  const historyRef = useRef(includeEnded);
  const lastHistoryRef = useRef(includeEnded);
  historyRef.current = includeEnded;
  const identity = JSON.stringify([backend, threadId, federationTarget?.scope === "remote" ? federationTarget.instanceId : undefined]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [local, setLocal] = useState<{ identity: string; state: ThreadPendingWakesState }>();
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  // A peer's list arrives with selected detail, which does not re-read for
  // every source's change. Hide what its owner confirmed stopped until the
  // next projection arrives.
  const [peerStopped, setPeerStopped] = useState<{
    identity: string;
    wakes: readonly ThreadPendingWake[] | undefined;
    keys: ReadonlySet<string>;
  }>();

  useEffect(() => {
    const publish = (state: ThreadPendingWakesState) => setLocal({ identity, state });
    if (peer || !backend || !threadId || !desktopApi?.manageThreadPendingWakes) {
      publish(UNKNOWN);
      refreshRef.current = async () => {};
      return;
    }
    const manage = desktopApi.manageThreadPendingWakes;
    let disposed = false;
    let generation = 0;
    let pending: Promise<void> | undefined;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A failed first read must not leave the panel loading; a later failure
    // keeps the last list until the next change event reads again.
    const settleFailedRead = () => setLocal((current) => current?.identity === identity && current.state.status === "ready"
      ? { identity, state: { ...current.state, incomplete: true } } : { identity, state: UNKNOWN });
    const refresh = (): Promise<void> => {
      if (disposed) return Promise.resolve();
      clearTimeout(timer);
      timer = undefined;
      dirty = true;
      if (pending) return pending;
      pending = (async () => {
        while (dirty && !disposed) {
          dirty = false;
          const started = generation;
          try {
            const response = await manage({ action: "list", backend, threadId, endedLimit: historyRef.current ? 8 : 0 });
            if (disposed || started !== generation) continue;
            if (!response.ok) { settleFailedRead(); continue; }
            publish({ status: "ready", wakes: response.wakes ?? [], ended: response.ended ?? EMPTY_ENDED,
              incomplete: response.incomplete === true, peer: false });
          } catch {
            if (!disposed && started === generation) settleFailedRead();
          }
        }
      })().finally(() => { pending = undefined; });
      return pending;
    };
    refreshRef.current = () => { generation += 1; return refresh(); };
    publish({ status: "loading" });
    void refresh();
    const unsubscribe = desktopApi.onAgentEvent?.((event) => {
      if (!isSourceEventFor(event, backend, threadId)) return;
      generation += 1;
      if (timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; void refresh(); }, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [backend, desktopApi, peer, threadId, identity]);

  useEffect(() => {
    if (lastHistoryRef.current === includeEnded) return;
    lastHistoryRef.current = includeEnded;
    void refreshRef.current();
  }, [includeEnded]);

  const projectedPeerWakes = thread?.pendingWakes;
  const hidePeerWake = useCallback((key: string) => {
    if (identityRef.current !== identity) return;
    setPeerStopped((current) => ({
      identity,
      wakes: projectedPeerWakes,
      keys: new Set(current && current.identity === identity && current.wakes === projectedPeerWakes ? [...current.keys, key] : [key]),
    }));
  }, [identity, projectedPeerWakes]);

  const stop = useCallback(async (key: string): Promise<ThreadPendingWakesResponse> => {
    if (!backend || !threadId || !desktopApi?.manageThreadPendingWakes) {
      return { ok: false, error: { code: "failed", message: "This window cannot stop wakes." } };
    }
    const refresh = refreshRef.current;
    try {
      const response = await desktopApi.manageThreadPendingWakes({
        action: "stop",
        backend,
        threadId,
        ...(federationTarget ? { federationTarget } : {}),
        key,
      });
      if (response.ok && federationTarget) hidePeerWake(key);
      return response;
    } catch (error) {
      return { ok: false, error: { code: "failed", message: error instanceof Error ? error.message : String(error) } };
    } finally {
      void refresh();
    }
  }, [backend, desktopApi, federationTarget, hidePeerWake, threadId]);

  const ended = useCallback((key: string) => {
    if (identityRef.current !== identity) return;
    if (federationTarget) hidePeerWake(key);
    else void refreshRef.current();
  }, [federationTarget, hidePeerWake, identity]);

  const peerWakes = thread?.pendingWakes;
  const peerIncomplete = thread?.pendingWakesIncomplete === true;
  const hidden = peerStopped?.identity === identity && peerStopped.wakes === peerWakes ? peerStopped.keys : undefined;
  const peerState = useMemo((): ThreadPendingWakesState => peerWakes
    ? {
        status: "ready",
        wakes: hidden ? peerWakes.filter((wake) => !hidden.has(wake.key)) : peerWakes,
        ended: EMPTY_ENDED,
        incomplete: peerIncomplete,
        peer: true,
      }
    : UNKNOWN, [hidden, peerIncomplete, peerWakes]);
  return { state: peer ? peerState : local?.identity === identity ? local.state : { status: "loading" }, stop, ended };
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
  if (!isThreadPendingWakeInvalidation(method, event.notification.params)) return false;
  // A project's change is stamped with whichever backend published it.
  if (method === "directory/forgeAutomation/updated") return true;
  if (event.backend !== backend) return false;
  const params = event.notification.params as { threadId?: unknown; action?: { threadId?: unknown } } | undefined;
  return params?.threadId === threadId || params?.action?.threadId === threadId;
}
