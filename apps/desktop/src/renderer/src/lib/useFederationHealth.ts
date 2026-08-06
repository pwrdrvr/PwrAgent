import { useCallback, useEffect, useState } from "react";
import type { FederationHealthStatus } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

/**
 * Live federation health for whole-federation surfaces (the Star Map).
 * Seeds from readFederationHealth and re-reads on every
 * `federation/peerStatus/changed` / `federation/celestialIcons/changed`
 * agent event — peer transitions are the only signal that changes the
 * topology, so a re-read per transition stays cheap.
 */
export function useFederationHealth(params: {
  desktopApi?: DesktopApi;
  /** Suspend event-driven refreshes while the consumer is hidden. */
  enabled?: boolean;
}): { health?: FederationHealthStatus; refresh: () => void } {
  const desktopApi = params.desktopApi;
  const enabled = params.enabled ?? true;
  const [health, setHealth] = useState<FederationHealthStatus>();

  const refresh = useCallback(() => {
    void desktopApi
      ?.readFederationHealth?.({})
      .then((response) => setHealth(response.health))
      .catch(() => {
        // Keep the last known topology; peer events retrigger the read.
      });
  }, [desktopApi]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const unsubscribe = desktopApi?.onAgentEvent?.((event) => {
      if (
        event.notification.method === "federation/peerStatus/changed"
        || event.notification.method === "federation/celestialIcons/changed"
      ) {
        refresh();
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, [desktopApi, enabled, refresh]);

  return { health, refresh };
}
