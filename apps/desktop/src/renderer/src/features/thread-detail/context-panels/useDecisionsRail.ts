import { useCallback, useEffect, useState } from "react";
import {
  decisionBatchIdFromSubAgentId,
  type DecisionsRailSnapshot,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { readRendererFederationTarget } from "../../../lib/federation-window";
import { decisionsRailPollDelayMs } from "./decisions-format";

export type DecisionsRailState = {
  snapshot?: DecisionsRailSnapshot;
  /** The last read failed; the snapshot, if any, is the one before it. */
  error: boolean;
  /** Decisions run on the thread's owner, so a peer's thread has no tab here. */
  available: boolean;
  refresh: () => void;
};

/**
 * The selected thread's decisions and batches. It reads once when the
 * thread changes or shows new activity (a turn starting or ending, a
 * batch card moving), which is enough to decide whether the tab shows at all. While
 * the tab is open it also polls: every 2 s while a batch can still move,
 * every 10 s otherwise. Nothing here is persisted.
 */
export function useDecisionsRail(params: {
  desktopApi?: Pick<DesktopApi, "readDecisionsRail">;
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
  // A turn starting or ending (a decision registered) and a batch card
  // changing state (a batch started or ended) are the cheap signals that
  // the tab's content moved while it is closed. updatedAt is not: it moves
  // on every summary update of a busy thread.
  const activityKey = [
    thread?.threadStatus ?? "",
    ...(thread?.subAgents ?? [])
      .filter((subAgent) => decisionBatchIdFromSubAgentId(subAgent.monitorId) !== undefined)
      .map((subAgent) => `${subAgent.monitorId}:${subAgent.status}`),
  ].join("|");
  const [state, setState] = useState<{ key?: string; snapshot?: DecisionsRailSnapshot; error: boolean }>({ error: false });
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  useEffect(() => {
    if (!available || !read || !backend || !threadId || !threadKey) return;
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
        if (!disposed && params.open) {
          timer = setTimeout(() => { void load(); }, decisionsRailPollDelayMs(next));
        }
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
