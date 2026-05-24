import { useCallback, useEffect, useState } from "react";
import type { BackendSummary } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

type BackendSummaryState = {
  backends: BackendSummary[];
  error?: string;
};

export const BACKEND_SUMMARIES_REFRESH_EVENT =
  "pwragent:backend-summaries-refresh";

export function useBackendSummaries(
  desktopApi?: DesktopApi,
  options: { enabled?: boolean } = {},
): BackendSummaryState {
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<BackendSummaryState>({
    backends: []
  });

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled) {
      setState({
        backends: [],
        error: undefined
      });
      return;
    }

    if (!desktopApi?.listBackends) {
      setState({
        backends: [],
        error: undefined
      });
      return;
    }

    try {
      const response = await desktopApi.listBackends({
        includeUnavailable: true
      });
      setState({
        backends: response.backends,
        error: undefined
      });
    } catch (error) {
      setState({
        backends: [],
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, [desktopApi, enabled]);

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
      if (
        (event.backend === "codex" &&
          (event.notification.method === "account/rateLimits/updated" ||
            event.notification.method === "account/updated")) ||
        event.notification.method === "backend/acpRuntimeCapabilities/updated"
      ) {
        void refresh();
      }
    });
  }, [desktopApi, enabled, refresh]);

  return state;
}
