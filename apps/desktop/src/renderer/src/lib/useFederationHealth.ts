import { useCallback, useEffect, useRef, useState } from "react";
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
  /** Also suspend explicit refreshes (for an inactive Star Map). */
  suspended?: boolean;
}): { health?: FederationHealthStatus; refresh: () => void } {
  const desktopApi = params.desktopApi;
  const enabled = params.enabled ?? true;
  const lifetime = useRef(0);
  const active = useRef(!params.suspended);
  active.current = !params.suspended;
  const [health, setHealth] = useState<FederationHealthStatus>();

  const refresh = useCallback(() => {
    if (!active.current) return;
    const generation = lifetime.current;
    void Promise.resolve().then(async () => {
      // Cleanup must be able to revoke a mount read before it reaches IPC.
      if (!active.current || lifetime.current !== generation) return;
      const response = await desktopApi?.readFederationHealth?.({});
      if (response && active.current && lifetime.current === generation) setHealth(response.health);
    })
      .catch(() => {
        // Keep the last known topology; peer events retrigger the read.
      });
  }, [desktopApi]);

  useEffect(() => {
    lifetime.current += 1;
    if (!enabled || params.suspended) return;
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
      lifetime.current += 1;
      unsubscribe?.();
    };
  }, [desktopApi, enabled, refresh, params.suspended]);

  return { health, refresh };
}
