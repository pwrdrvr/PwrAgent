import { useCallback, useEffect, useRef, useState } from "react";
import type { BackendSummary, FederationTarget } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { federationTargetsEqual } from "./federated-thread-events";

type BackendSummaryData = {
  backends: BackendSummary[];
  error?: string;
  loaded: boolean;
};

type BackendSummaryState = BackendSummaryData & {
  refreshAcpAgents: () => Promise<BackendSummary[]>;
};

export const BACKEND_SUMMARIES_REFRESH_EVENT =
  "pwragent:backend-summaries-refresh";

export function useBackendSummaries(
  desktopApi?: DesktopApi,
  options: {
    enabled?: boolean;
    federationTarget?: FederationTarget;
    suspended?: boolean;
  } = {},
): BackendSummaryState {
  const enabled = options.enabled ?? true;
  const federationTarget = options.federationTarget;
  const suspended = options.suspended ?? false;
  const [state, setState] = useState<BackendSummaryData>({
    backends: [],
    loaded: false,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const acpRefreshPromiseRef =
    useRef<Promise<BackendSummary[]> | undefined>(undefined);

  const refresh = useCallback(async (): Promise<BackendSummary[]> => {
    if (!enabled) {
      setState({
        backends: [],
        error: undefined,
        loaded: false,
      });
      return [];
    }

    if (suspended) {
      return stateRef.current.backends;
    }

    if (!desktopApi?.listBackends) {
      setState({
        backends: [],
        error: undefined,
        loaded: true,
      });
      return [];
    }

    try {
      const response = await desktopApi.listBackends({
        includeUnavailable: true,
        ...(federationTarget ? { federationTarget } : {}),
      });
      setState({
        backends: response.backends,
        error: undefined,
        loaded: true,
      });
      return response.backends;
    } catch (error) {
      // A peer-status event can suspend this hook while an earlier remote
      // read is still in flight. Keep the last usable summaries in that race;
      // reconnecting changes `suspended` and immediately refreshes them.
      if (suspendedRef.current) {
        return stateRef.current.backends;
      }
      setState({
        backends: [],
        error: error instanceof Error ? error.message : String(error),
        loaded: true,
      });
      return [];
    }
  }, [desktopApi, enabled, federationTarget, suspended]);

  const refreshAcpAgents = useCallback(async (): Promise<BackendSummary[]> => {
    if (federationTarget?.scope === "remote") {
      return await refresh();
    }
    if (!enabled || !desktopApi?.listAcpAgents) {
      return [];
    }
    if (acpRefreshPromiseRef.current) {
      return await acpRefreshPromiseRef.current;
    }

    const refreshPromise = (async () => {
      try {
        await desktopApi.listAcpAgents?.({
          refresh: true,
          force: true,
        });
        return await refresh();
      } catch {
        // ACP discovery is best-effort. Keep the cached backend summaries
        // usable when one local CLI cannot be probed.
        return [];
      }
    })();
    acpRefreshPromiseRef.current = refreshPromise;
    try {
      return await refreshPromise;
    } finally {
      if (acpRefreshPromiseRef.current === refreshPromise) {
        acpRefreshPromiseRef.current = undefined;
      }
    }
  }, [desktopApi, enabled, federationTarget, refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    window.addEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, refresh);
    return () => {
      window.removeEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, refresh);
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || !desktopApi?.onAgentEvent) {
      return;
    }
    return desktopApi.onAgentEvent((event) => {
      if (!federationTargetsEqual(event.federationTarget, federationTarget)) {
        return;
      }
      if (
        (event.backend === "codex" &&
          (event.notification.method === "account/rateLimits/updated" ||
            event.notification.method === "account/updated")) ||
        event.notification.method === "backend/acpRuntimeCapabilities/updated" ||
        event.notification.method === "backend/providerStatus/updated"
      ) {
        void refresh();
      }
    });
  }, [desktopApi, enabled, federationTarget, refresh]);

  return {
    ...state,
    refreshAcpAgents,
  };
}
