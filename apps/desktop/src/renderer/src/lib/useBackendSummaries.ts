import { useCallback, useEffect, useState } from "react";
import type { BackendSummary } from "@pwragnt/shared";
import type { DesktopApi } from "./desktop-api";

type BackendSummaryState = {
  backends: BackendSummary[];
  error?: string;
};

export function useBackendSummaries(desktopApi?: DesktopApi): BackendSummaryState {
  const [state, setState] = useState<BackendSummaryState>({
    backends: []
  });

  const refresh = useCallback(async (): Promise<void> => {
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
  }, [desktopApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!desktopApi?.onWindowFocus) {
      return;
    }

    return desktopApi.onWindowFocus(() => {
      void refresh();
    });
  }, [desktopApi, refresh]);

  return state;
}
