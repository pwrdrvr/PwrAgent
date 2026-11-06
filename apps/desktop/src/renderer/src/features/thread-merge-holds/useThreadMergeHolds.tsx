import { createContext, useContext, useEffect, useState } from "react";
import type { AppServerBackendKind, FederationTarget, ManageThreadMergeHoldsResponse, NavigationThreadSummary } from "@pwragent/shared";
import { getDesktopApi, type DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";

export const ThreadMergeHoldsContext = createContext<{
  open: (thread: NavigationThreadSummary) => void;
} | undefined>(undefined);

export function useThreadMergeHoldsOpener() {
  return useContext(ThreadMergeHoldsContext)?.open;
}

/** Refresh on lifecycle events and focus, never on a timer or every render. */
export function useThreadMergeHolds(
  backend: AppServerBackendKind,
  threadId: string,
  federationTarget?: FederationTarget,
  api: DesktopApi | undefined = getDesktopApi(),
  enabled = true,
  pullRequest?: string,
) {
  const target = federationTarget ?? readRendererFederationTarget();
  const instanceId = target?.scope === "remote" ? target.instanceId : undefined;
  const key = JSON.stringify([backend, threadId, instanceId, pullRequest]);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; data?: ManageThreadMergeHoldsResponse; error?: string }>({ key });
  useEffect(() => {
    if (!enabled || !api?.manageThreadMergeHolds) return;
    let disposed = false;
    let sequence = 0;
    const refresh = async () => {
      const current = ++sequence;
      try {
        const data = await api.manageThreadMergeHolds!({ action: "list", backend, threadId,
          ...(pullRequest ? { pullRequest, includeDependents: false } : {}),
          ...(instanceId ? { federationTarget: { scope: "remote", instanceId } } : {}),
        });
        if (!disposed && current === sequence) setState({ key, data });
      } catch (reason) {
        if (!disposed && current === sequence) setState((previous) => ({
          key, ...(previous.key === key ? { data: previous.data } : {}),
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      }
    };
    void refresh();
    const unsubscribe = api.onAgentEvent?.((event) => {
      if (event.notification.method === "thread/mergeHolds/updated") void refresh();
    });
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { disposed = true; unsubscribe?.(); window.removeEventListener("focus", focus); };
  }, [api, enabled, backend, threadId, instanceId, key, revision, pullRequest]);
  const current = state.key === key ? state : undefined;
  return {
    refresh: () => setRevision((value) => value + 1),
    data: current?.data,
    error: current?.error,
    ready: !enabled || !api?.manageThreadMergeHolds || Boolean(current?.data),
  };
}
