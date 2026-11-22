import { useCallback, useEffect, useState } from "react";
import type { DecisionsRailSnapshot } from "@pwragent/shared/decisions-rail";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../../../lib/desktop-api";
import { readRendererFederationTarget } from "../../../lib/federation-window";
import { decisionsRailPollDelayMs } from "./decisions-format";
import { isDecisionBatchEventFor } from "./decision-batch-events";

export type DecisionsRailState = {
  snapshot?: DecisionsRailSnapshot;
  /** The last read failed; the snapshot, if any, is the one before it. */
  error: boolean;
  /** Decisions run on the thread's owner, so a peer's thread has no tab here. */
  available: boolean;
  refresh: () => void;
};

/**
 * The selected thread's decisions and batches, read while the tab is open:
 * on opening, when the thread shows new activity (a turn starting or
 * ending, which is when a decision gets registered, or the owner
 * announcing that a batch moved), and on a poll, every 2 s while a batch
 * can still move and every 10 s otherwise. The tab shows whether or not
 * the thread has used decisions, so a closed tab reads nothing. Nothing
 * here is persisted.
 */
export function useDecisionsRail(params: {
  desktopApi?: Pick<DesktopApi, "readDecisionsRail" | "onAgentEvent">;
  thread?: NavigationThreadSummary;
  open: boolean;
}): DecisionsRailState {
  const read = params.desktopApi?.readDecisionsRail;
  const thread = params.thread;
  const available = Boolean(
    read
    && thread
    && !thread.federation?.ref.target
    && !readRendererFederationTarget(),
  );
  const backend = thread?.source;
  const threadId = thread?.id;
  const threadKey = backend && threadId ? `${backend}:${threadId}` : undefined;
  // A turn starting or ending (a decision registered) is a cheap signal
  // that the tab's content moved while it is closed. updatedAt is not: it
  // moves on every summary update of a busy thread.
  const activityKey = thread?.threadStatus ?? "";
  const [state, setState] = useState<{ key?: string; snapshot?: DecisionsRailSnapshot; error: boolean }>({ error: false });
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  // The owner announces a batch starting, each tenth of it, and its end.
  const subscribe = params.desktopApi?.onAgentEvent;
  useEffect(() => {
    if (!available || !params.open || !subscribe || !backend || !threadId) return;
    return subscribe((event) => {
      if (isDecisionBatchEventFor(event, { backend, threadId })) refresh();
    });
  }, [available, backend, params.open, refresh, subscribe, threadId]);

  useEffect(() => {
    if (!available || !params.open || !read || !backend || !threadId || !threadKey) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      let next: DecisionsRailSnapshot | undefined;
      try {
        next = await read({ backend, threadId });
        if (!disposed) setState({ key: threadKey, snapshot: next, error: false });
      } catch {
        if (!disposed) {
          setState((current) => ({ key: threadKey, snapshot: current.key === threadKey ? current.snapshot : undefined, error: true }));
        }
      } finally {
        if (!disposed) timer = setTimeout(() => { void load(); }, decisionsRailPollDelayMs(next));
      }
    };
    void load();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [activityKey, available, backend, params.open, read, refreshToken, threadId, threadKey]);

  const current = state.key === threadKey;
  return {
    ...(current && state.snapshot ? { snapshot: state.snapshot } : {}),
    error: current && state.error,
    available,
    refresh,
  };
}
