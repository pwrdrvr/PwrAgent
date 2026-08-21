import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FederationPeerSummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

const REMOTE_REFRESH_INTERVAL_MS = 60_000;

export type StarMapRemoteThreads = {
  /** Per-instance thread lists, retained across peer reconnect churn. */
  threadsByInstance: Map<string, NavigationThreadSummary[]>;
  /** Instances whose last snapshot fetch failed (rendered as unreachable). */
  unreachableInstanceIds: Set<string>;
  /**
   * Instances whose cards are last-known rather than live: the peer is
   * enrolled but not currently connected, so its cloud renders dimmed
   * instead of vanishing.
   */
  staleInstanceIds: Set<string>;
  /** Refresh one owning peer and resolve only after its snapshot is applied. */
  refreshInstance: (instanceId: string) => Promise<void>;
};

type StarMapRemoteThreadState = Omit<
  StarMapRemoteThreads,
  "refreshInstance"
>;

/**
 * Remote attention-thread feed for the Star Map: one navigation snapshot
 * per connected `thread_navigation` peer, refreshed on a slow tick and on
 * peer reconnects. Per-peer failures degrade that instance's cloud only.
 *
 * Retention rule: a peer's cards are dropped ONLY when the peer leaves the
 * directory entirely (revoked/removed). A peer that merely disconnects
 * keeps its last-known cards, marked stale — the federation reconnect
 * backoff tops out at 30s, so pruning on disconnect made a flapping peer's
 * whole cloud blink out and back on that cadence.
 */
export function useStarMapThreads(params: {
  desktopApi?: DesktopApi;
  peers: readonly FederationPeerSummary[];
  enabled: boolean;
  /** Bump to force an immediate refetch (e.g. after intake creates a thread). */
  refreshNonce?: number;
}): StarMapRemoteThreads {
  const desktopApi = params.desktopApi;
  const [state, setState] = useState<StarMapRemoteThreadState>({
    threadsByInstance: new Map(),
    unreachableInstanceIds: new Set(),
    staleInstanceIds: new Set(),
  });
  // Two identity lists as stable strings so effects re-run only when the
  // sets actually change, not on every health object:
  //   connected -> who we can fetch from now
  //   known     -> who still exists at all (retention scope)
  const connectedIds = params.peers
    .filter(
      (peer) =>
        peer.status === "connected"
        && peer.capabilities.includes("thread_navigation"),
    )
    .map((peer) => peer.id)
    .sort()
    .join("\n");
  const knownIds = params.peers
    .map((peer) => peer.id)
    .sort()
    .join("\n");
  const generationRef = useRef(0);

  const refreshInstanceForGeneration = useCallback(
    async (instanceId: string, generation: number): Promise<void> => {
      if (!desktopApi?.getNavigationSnapshot) return;
      try {
        const snapshot = await desktopApi.getNavigationSnapshot({
          federationTarget: { scope: "remote", instanceId },
        });
        if (generationRef.current !== generation) return;
        setState((current) => {
          const threadsByInstance = new Map(current.threadsByInstance);
          threadsByInstance.set(instanceId, snapshot.threads);
          const unreachableInstanceIds = new Set(
            current.unreachableInstanceIds,
          );
          unreachableInstanceIds.delete(instanceId);
          const staleInstanceIds = new Set(current.staleInstanceIds);
          staleInstanceIds.delete(instanceId);
          return {
            threadsByInstance,
            unreachableInstanceIds,
            staleInstanceIds,
          };
        });
      } catch (error) {
        if (generationRef.current === generation) {
          setState((current) => {
            const unreachableInstanceIds = new Set(
              current.unreachableInstanceIds,
            );
            unreachableInstanceIds.add(instanceId);
            // A failed refresh keeps whatever cards we already had; the
            // instance card carries the unreachable marker instead.
            const staleInstanceIds = new Set(current.staleInstanceIds);
            if (current.threadsByInstance.has(instanceId)) {
              staleInstanceIds.add(instanceId);
            }
            return {
              ...current,
              unreachableInstanceIds,
              staleInstanceIds,
            };
          });
        }
        throw error;
      }
    },
    [desktopApi],
  );

  const refreshInstance = useCallback(
    async (instanceId: string): Promise<void> => {
      await refreshInstanceForGeneration(instanceId, generationRef.current);
    },
    [refreshInstanceForGeneration],
  );

  // Retention pass: drop only peers that left the directory, and mark
  // everything we hold but cannot currently reach as stale.
  useEffect(() => {
    const known = new Set(knownIds.length > 0 ? knownIds.split("\n") : []);
    const connected = new Set(
      connectedIds.length > 0 ? connectedIds.split("\n") : [],
    );
    setState((current) => {
      const nextThreads = new Map(
        [...current.threadsByInstance].filter(([instanceId]) =>
          known.has(instanceId),
        ),
      );
      const nextUnreachable = new Set(
        [...current.unreachableInstanceIds].filter((instanceId) =>
          known.has(instanceId),
        ),
      );
      const nextStale = new Set(
        [...nextThreads.keys()].filter(
          (instanceId) => !connected.has(instanceId),
        ),
      );
      const unchanged =
        nextThreads.size === current.threadsByInstance.size
        && nextUnreachable.size === current.unreachableInstanceIds.size
        && nextStale.size === current.staleInstanceIds.size
        && [...nextStale].every((instanceId) =>
          current.staleInstanceIds.has(instanceId),
        );
      if (unchanged) return current;
      return {
        threadsByInstance: nextThreads,
        unreachableInstanceIds: nextUnreachable,
        staleInstanceIds: nextStale,
      };
    });
  }, [connectedIds, knownIds]);

  useEffect(() => {
    if (!params.enabled || !desktopApi?.getNavigationSnapshot) {
      return;
    }
    const instanceIds = connectedIds.length > 0 ? connectedIds.split("\n") : [];
    const generation = (generationRef.current += 1);

    const fetchAll = () => {
      for (const instanceId of instanceIds) {
        void refreshInstanceForGeneration(instanceId, generation).catch(
          () => undefined,
        );
      }
    };

    fetchAll();
    const timer = setInterval(fetchAll, REMOTE_REFRESH_INTERVAL_MS);
    return () => {
      generationRef.current += 1;
      clearInterval(timer);
    };
  }, [
    connectedIds,
    desktopApi?.getNavigationSnapshot,
    params.enabled,
    params.refreshNonce,
    refreshInstanceForGeneration,
  ]);

  return { ...state, refreshInstance };
}
