import { useEffect, useState } from "react";
import type { BackendSummary, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "./useBackendSummaries";

const EMPTY_CATALOGS: ReadonlyMap<string, readonly BackendSummary[]> = new Map();

/** Remote pins need their owners' catalogs even before a transcript is selected. */
export function useSidebarOwnerBackends(
  api: DesktopApi | undefined,
  threads: readonly NavigationThreadSummary[],
  options: { enabled: boolean; windowInstanceId?: string },
): ReadonlyMap<string, readonly BackendSummary[]> {
  const ownersKey = JSON.stringify(options.enabled ? [...new Set(threads.flatMap((thread) => {
    const federation = thread.federation;
    const target = federation?.ref.target;
    return target?.scope === "remote"
      && target.instanceId !== options.windowInstanceId
      && federation?.peerStatus === "connected"
      && federation.capabilities?.includes("turn_control")
      ? [target.instanceId] : [];
  }))].sort() : []);
  const [state, setState] = useState({ key: "", catalogs: EMPTY_CATALOGS });

  useEffect(() => {
    const owners: string[] = JSON.parse(ownersKey);
    let cancelled = false;
    const generations = new Map<string, number>();
    setState({ key: ownersKey, catalogs: EMPTY_CATALOGS });
    if (!api?.listBackends || owners.length === 0) return;

    const refresh = async (instanceId: string): Promise<void> => {
      const generation = (generations.get(instanceId) ?? 0) + 1;
      generations.set(instanceId, generation);
      let backends: readonly BackendSummary[] = [];
      try {
        const response = await api.listBackends!({
          includeUnavailable: true,
          federationTarget: { scope: "remote", instanceId },
        });
        backends = response.backends;
      } catch {
        // A failed owner read must never fall back to the viewer's catalog.
      }
      if (cancelled || generations.get(instanceId) !== generation) return;
      setState((current) => ({
        key: ownersKey,
        catalogs: new Map(current.catalogs).set(instanceId, backends),
      }));
    };
    const refreshAll = (): void => { for (const owner of owners) void refresh(owner); };
    refreshAll();
    window.addEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, refreshAll);
    const unsubscribeFocus = api.onWindowFocus?.(refreshAll);
    const unsubscribeEvents = api.onAgentEvent?.((event) => {
      const target = event.federationTarget;
      if (target?.scope !== "remote" || !owners.includes(target.instanceId)) return;
      if ([
        "backend/acpRuntimeCapabilities/updated",
        "backend/providerStatus/updated",
        "navigation/providerThreads/refreshed",
      ].includes(event.notification.method)) void refresh(target.instanceId);
    });
    return () => {
      cancelled = true;
      window.removeEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, refreshAll);
      unsubscribeFocus?.();
      unsubscribeEvents?.();
    };
  }, [api, ownersKey]);

  return state.key === ownersKey ? state.catalogs : EMPTY_CATALOGS;
}
