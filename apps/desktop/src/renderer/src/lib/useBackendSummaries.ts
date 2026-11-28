import { useCallback, useEffect, useRef, useState } from "react";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type { DesktopApi } from "./desktop-api";
import { federationTargetsEqual } from "./federated-thread-events";

type BackendSummaryData = {
  backends: BackendSummary[];
  error?: string;
  loaded: boolean;
};

type BackendSummaryState = BackendSummaryData & {
  refreshRateLimits: () => Promise<BackendSummary[]>;
  requestAntigravityQuota: () => void;
  refreshAcpAgents: () => Promise<BackendSummary[]>;
};

const PENDING_SUMMARIES: BackendSummaryData = { backends: [], loaded: false };

export const BACKEND_SUMMARIES_REFRESH_EVENT =
  "pwragent:backend-summaries-refresh";

export function useBackendSummaries(
  desktopApi?: DesktopApi,
  options: {
    enabled?: boolean;
    pollRateLimits?: boolean;
    federationTarget?: FederationTarget;
    suspended?: boolean;
  } = {},
): BackendSummaryState {
  const enabled = options.enabled ?? true;
  const federationTarget = options.federationTarget;
  const suspended = options.suspended ?? false;
  const [state, setState] = useState<BackendSummaryData & { source?: FederationTarget }>(PENDING_SUMMARIES);
  const stateRef = useRef(state);
  stateRef.current = state;
  const requestContext = useRef({ enabled, suspended, federationTarget });
  requestContext.current = { enabled, suspended, federationTarget };
  const quotaRequests = useRef(new Set<string | undefined>());
  const acpRefreshPromiseRef =
    useRef<Promise<BackendSummary[]> | undefined>(undefined);
  // Reads overlap: an event refresh and a slower rate-limit refresh can
  // resolve in either order. Each response says when main assembled it, and
  // only a newer one replaces what is shown, so a value never steps back.
  const appliedRef = useRef<{ source: FederationTarget | undefined; fetchedAt: number } | undefined>(undefined);
  // The shown list as JSON, kept so each response is serialized only once.
  const shownJsonRef = useRef<string | undefined>(undefined);

  const readSummaries = useCallback(async (
    refreshRateLimits = false,
    refreshAntigravityQuota = false,
  ): Promise<BackendSummary[]> => {
    if (!enabled) {
      setState({ ...PENDING_SUMMARIES, source: federationTarget });
      return [];
    }

    const cachedBackends = () => federationTargetsEqual(stateRef.current.source, federationTarget)
      ? stateRef.current.backends : PENDING_SUMMARIES.backends;
    if (suspended) {
      return cachedBackends();
    }

    if (!desktopApi?.listBackends) {
      setState({
        backends: [],
        error: undefined,
        loaded: true,
        source: federationTarget,
      });
      return [];
    }

    const requestIsCurrent = () => {
      const current = requestContext.current;
      return current.enabled && !current.suspended
        && federationTargetsEqual(current.federationTarget, federationTarget);
    };
    const appliedAtStart = appliedRef.current;
    try {
      const response = await desktopApi.listBackends({
        includeUnavailable: true,
        ...(refreshRateLimits ? { refreshRateLimits: true } : {}),
        ...(refreshAntigravityQuota ? { refreshAntigravityQuota: true } : {}),
        ...(federationTarget ? { federationTarget } : {}),
      });
      if (!requestIsCurrent()) return cachedBackends();
      const applied = appliedRef.current;
      const sameSource = applied !== undefined
        && federationTargetsEqual(applied.source, federationTarget);
      if (
        sameSource
        && typeof response.fetchedAt === "number"
        && response.fetchedAt < applied.fetchedAt
      ) {
        return cachedBackends();
      }
      if (typeof response.fetchedAt === "number") {
        appliedRef.current = { source: federationTarget, fetchedAt: response.fetchedAt };
      }
      // Most refreshes find nothing new. Keep the same objects so nothing
      // that reads them renders again.
      const current = stateRef.current;
      const responseJson = JSON.stringify(response.backends);
      if (
        current.loaded
        && current.error === undefined
        && sameSource
        && shownJsonRef.current === responseJson
      ) {
        return current.backends;
      }
      shownJsonRef.current = responseJson;
      setState({
        backends: response.backends,
        error: undefined,
        loaded: true,
        source: federationTarget,
      });
      return response.backends;
    } catch (error) {
      // Failures have no assembly timestamp. Keep a snapshot from this owner
      // if it was accepted while this read was pending.
      const applied = appliedRef.current;
      if (!requestIsCurrent() || (applied && applied !== appliedAtStart
        && federationTargetsEqual(applied.source, federationTarget))) {
        return cachedBackends();
      }
      setState({
        backends: refreshRateLimits || refreshAntigravityQuota ? cachedBackends() : [],
        error: error instanceof Error ? error.message : String(error),
        loaded: true,
        source: federationTarget,
      });
      return [];
    }
  }, [desktopApi, enabled, federationTarget, suspended]);

  const refresh = useCallback(() => readSummaries(), [readSummaries]);
  const refreshRateLimits = useCallback(
    () => readSummaries(true),
    [readSummaries],
  );
  const requestAntigravityQuota = useCallback((): void => {
    if (!enabled || suspended || document.visibilityState !== "visible" || !document.hasFocus()) return;
    const owner = federationTarget?.scope === "remote" ? federationTarget.instanceId : undefined;
    const pending = quotaRequests.current;
    if (pending.has(owner)) return;
    pending.add(owner);
    void readSummaries(false, true).finally(() => {
      pending.delete(owner);
    });
  }, [enabled, federationTarget, readSummaries, suspended]);

  useEffect(() => {
    if (!enabled || suspended || !options.pollRateLimits) return;
    const refreshVisible = (): void => {
      if (document.visibilityState !== "hidden") void refreshRateLimits();
    };
    refreshVisible();
    const timer = window.setInterval(refreshVisible, 30_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [enabled, suspended, options.pollRateLimits, refreshRateLimits]);

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
        return await refresh();
      } catch {
        // Keep the cached backend summaries usable when the main-process
        // projection is temporarily unavailable. Runtime surfaces never
        // launch provider discovery; Settings/setup own explicit probes.
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
    window.addEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, refreshRateLimits);
    return () => {
      window.removeEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, refreshRateLimits);
    };
  }, [enabled, refreshRateLimits]);

  // Settings' "Refresh all providers" runs in main and can outlive the pane
  // that started it, so the window-local refresh event is not enough: re-read
  // when main reports the run settled. The run refreshes local providers only.
  useEffect(() => {
    if (
      !enabled
      || federationTarget?.scope === "remote"
      || !desktopApi?.onProviderCatalogRefresh
    ) {
      return;
    }
    return desktopApi.onProviderCatalogRefresh((state) => {
      if (state.status !== "running") {
        void refresh();
      }
    });
  }, [desktopApi, enabled, federationTarget, refresh]);

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
        event.notification.method === "backend/providerStatus/updated" ||
        event.notification.method === "navigation/providerThreads/refreshed"
      ) {
        void refresh();
      }
    });
  }, [desktopApi, enabled, federationTarget, refresh]);

  const shown = federationTargetsEqual(state.source, federationTarget) ? state : PENDING_SUMMARIES;
  return {
    backends: shown.backends,
    error: shown.error,
    loaded: shown.loaded,
    refreshRateLimits,
    requestAntigravityQuota,
    refreshAcpAgents,
  };
}
