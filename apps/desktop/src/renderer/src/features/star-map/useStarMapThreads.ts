import { useEffect, useRef, useState } from "react";
import type {
  FederationPeerSummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

const REMOTE_REFRESH_INTERVAL_MS = 60_000;

export type StarMapRemoteThreads = {
  /** Per-instance thread lists for connected, navigation-capable peers. */
  threadsByInstance: Map<string, NavigationThreadSummary[]>;
  /** Instances whose last snapshot fetch failed (rendered as unreachable). */
  unreachableInstanceIds: Set<string>;
};

/**
 * Remote attention-thread feed for the Star Map: one navigation snapshot
 * per connected `thread_navigation` peer, refreshed on a slow tick and on
 * peer reconnects. Per-peer failures degrade that instance's cloud only.
 */
export function useStarMapThreads(params: {
  desktopApi?: DesktopApi;
  peers: readonly FederationPeerSummary[];
  enabled: boolean;
}): StarMapRemoteThreads {
  const desktopApi = params.desktopApi;
  const [state, setState] = useState<StarMapRemoteThreads>({
    threadsByInstance: new Map(),
    unreachableInstanceIds: new Set(),
  });
  // Peer identity list as a stable string so effect re-runs only when the
  // connected-peer set actually changes, not on every health object.
  const connectedIds = params.peers
    .filter(
      (peer) =>
        peer.status === "connected"
        && peer.capabilities.includes("thread_navigation"),
    )
    .map((peer) => peer.id)
    .sort()
    .join("\n");
  const generationRef = useRef(0);

  useEffect(() => {
    if (!params.enabled || !desktopApi?.getNavigationSnapshot) {
      return;
    }
    const instanceIds = connectedIds.length > 0 ? connectedIds.split("\n") : [];
    const generation = (generationRef.current += 1);
    // Prune instances that left the connected set: without this, a
    // disconnected peer's last thread list keeps rendering as if current
    // under an instance card that already shows it offline.
    setState((current) => {
      const keep = new Set(instanceIds);
      const stale = [...current.threadsByInstance.keys()].some(
        (instanceId) => !keep.has(instanceId),
      )
        || [...current.unreachableInstanceIds].some(
          (instanceId) => !keep.has(instanceId),
        );
      if (!stale) return current;
      return {
        threadsByInstance: new Map(
          [...current.threadsByInstance].filter(([instanceId]) =>
            keep.has(instanceId),
          ),
        ),
        unreachableInstanceIds: new Set(
          [...current.unreachableInstanceIds].filter((instanceId) =>
            keep.has(instanceId),
          ),
        ),
      };
    });

    const fetchAll = () => {
      for (const instanceId of instanceIds) {
        void desktopApi
          .getNavigationSnapshot?.({
            federationTarget: { scope: "remote", instanceId },
          })
          .then((snapshot) => {
            if (generationRef.current !== generation) return;
            setState((current) => {
              const threadsByInstance = new Map(current.threadsByInstance);
              threadsByInstance.set(instanceId, snapshot.threads);
              const unreachableInstanceIds = new Set(
                current.unreachableInstanceIds,
              );
              unreachableInstanceIds.delete(instanceId);
              return { threadsByInstance, unreachableInstanceIds };
            });
          })
          .catch(() => {
            if (generationRef.current !== generation) return;
            setState((current) => {
              const unreachableInstanceIds = new Set(
                current.unreachableInstanceIds,
              );
              unreachableInstanceIds.add(instanceId);
              return { ...current, unreachableInstanceIds };
            });
          });
      }
    };

    fetchAll();
    const timer = setInterval(fetchAll, REMOTE_REFRESH_INTERVAL_MS);
    return () => {
      generationRef.current += 1;
      clearInterval(timer);
    };
  }, [desktopApi, connectedIds, params.enabled]);

  return state;
}
