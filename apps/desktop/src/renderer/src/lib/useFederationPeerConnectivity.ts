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
  /** True once health or a live peer-status event has identified the target. */
  ready: boolean;
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
    healthSeedFailed?: boolean;
    instanceId?: string;
    ready: boolean;
    status?: FederationConnectionState;
    unavailableReason?: string;
  }>({ ready: false });

  useEffect(() => {
    if (!instanceId) {
      setState({ ready: true });
      return;
    }
    setState({ instanceId, ready: false });
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
            current.instanceId === instanceId && current.status === undefined
              ? {
                  instanceId,
                  ready: true,
                  status: peer.status,
                  unavailableReason: peer.unavailableReason,
                }
              : current,
          );
        } else {
          setState((current) =>
            current.instanceId === instanceId && current.status === undefined
              ? { instanceId, ready: true }
              : current,
          );
        }
      })
      .catch(() => {
        if (cancelled) return;
        // A failed seed is not evidence that the peer is disconnected. Let
        // remote reads proceed; a later status event remains authoritative.
        setState((current) =>
          current.instanceId === instanceId && !current.ready
            ? { healthSeedFailed: true, instanceId, ready: true }
            : current,
        );
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
        instanceId,
        ready: true,
        status: status.status,
        unavailableReason: status.unavailableReason,
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [desktopApi, instanceId]);

  return useMemo(() => {
    const targetState = state.instanceId === instanceId ? state : undefined;
    const healthReadable = Boolean(desktopApi?.readFederationHealth);
    const targetReady = targetState?.ready === true;
    const ready = !instanceId || !healthReadable || targetReady;
    return {
      connected:
        !instanceId
        || (!healthReadable && !targetReady)
        || targetState?.healthSeedFailed === true
        || !ready
        || targetState?.status === "connected",
      ready,
      status: targetState?.status,
      unavailableReason: targetState?.unavailableReason,
    };
  }, [desktopApi?.readFederationHealth, instanceId, state]);
}
