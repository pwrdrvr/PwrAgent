import { useEffect, useMemo, useState } from "react";
import type {
  FederationConnectionState,
  FederationRemoteTarget,
} from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

export type FederationPeerConnectivity = {
  /**
   * True while the target peer is reachable — and also before the first
   * health read resolves, so surfaces never flash "disconnected" during
   * boot. Local windows (no target) are always connected.
   */
  connected: boolean;
  status?: FederationConnectionState;
  unavailableReason?: string;
};

/**
 * Live connectivity of the federation peer this window targets. Seeds
 * from readFederationHealth, then follows the
 * `federation/peerStatus/changed` agent events the runtime publishes on
 * every transition — the same signal useThreadNavigation uses for its
 * error state. Consumers use it to suspend remote polling and disable
 * write surfaces instead of hammering a dead peer with RPCs.
 */
export function useFederationPeerConnectivity(params: {
  desktopApi?: DesktopApi;
  target?: FederationRemoteTarget;
}): FederationPeerConnectivity {
  const desktopApi = params.desktopApi;
  const instanceId = params.target?.instanceId;
  const [state, setState] = useState<{
    status?: FederationConnectionState;
    unavailableReason?: string;
  }>({});

  useEffect(() => {
    if (!instanceId) {
      setState({});
      return;
    }
    let cancelled = false;
    void desktopApi
      ?.readFederationHealth?.({})
      .then((response) => {
        if (cancelled) return;
        const peer = response.health.peers.find(
          (candidate) => candidate.id === instanceId,
        );
        if (peer) {
          // Functional update: a peerStatus event that raced the health
          // read is newer — do not clobber it with the snapshot.
          setState((current) =>
            current.status === undefined
              ? {
                  status: peer.status,
                  unavailableReason: peer.unavailableReason,
                }
              : current,
          );
        }
      })
      .catch(() => {
        // Health is a seed; the event stream below is the live source.
      });
    const unsubscribe = desktopApi?.onAgentEvent?.((event) => {
      if (event.notification.method !== "federation/peerStatus/changed") {
        return;
      }
      const status = event.notification.params as {
        instanceId: string;
        status: FederationConnectionState;
        unavailableReason?: string;
      };
      if (status.instanceId !== instanceId) return;
      setState({
        status: status.status,
        unavailableReason: status.unavailableReason,
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [desktopApi, instanceId]);

  return useMemo(
    () => ({
      connected:
        !instanceId
        || state.status === undefined
        || state.status === "connected",
      status: state.status,
      unavailableReason: state.unavailableReason,
    }),
    [instanceId, state],
  );
}
