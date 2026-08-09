import { useEffect, useState } from "react";
import type { FederationLoadStatus } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

/**
 * Load is queried on demand, never gossiped, so an open card is the only
 * thing that costs anything. 8s is slow enough that a fleet of cards is
 * cheap and fast enough that "high CPU" is still true when you read it.
 */
export const STAR_MAP_LOAD_POLL_INTERVAL_MS = 8_000;

/**
 * Polls live load for exactly the instances that have a load card open.
 *
 * Two deliberate properties:
 * - The poll set is driven by card membership, so closing a card stops its
 *   queries — there is no background load traffic for an unwatched peer.
 * - Polling pauses while the document is hidden. A backgrounded map must not
 *   keep waking peers, and a reading taken while you were away is not worth
 *   the round trip.
 *
 * A failed or timed-out query leaves the previous reading in place rather
 * than blanking the card; the card renders its own staleness from
 * `sampledAt`, so a stalled peer reads as stale instead of as healthy zero.
 */
export function useStarMapInstanceLoad(params: {
  desktopApi?: DesktopApi;
  /** Instance ids with a load card on the map. */
  instanceIds: readonly string[];
  intervalMs?: number;
}): Map<string, FederationLoadStatus> {
  const { desktopApi } = params;
  const intervalMs = params.intervalMs ?? STAR_MAP_LOAD_POLL_INTERVAL_MS;
  const [loads, setLoads] = useState<Map<string, FederationLoadStatus>>(
    new Map(),
  );
  // Membership drives the effect, but its identity must not: a re-render that
  // rebuilds the same list would otherwise restart the timer every frame.
  const instanceKey = [...params.instanceIds].sort().join(",");

  useEffect(() => {
    const read = desktopApi?.readFederationInstanceLoad;
    const instanceIds = instanceKey ? instanceKey.split(",") : [];
    if (!read || instanceIds.length === 0) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const sample = async () => {
      await Promise.all(
        instanceIds.map(async (instanceId) => {
          try {
            const response = await read({ instanceId });
            if (cancelled || !response.load) return;
            setLoads((current) => {
              const next = new Map(current);
              next.set(instanceId, response.load!);
              return next;
            });
          } catch {
            // Keep the last reading; the card ages it via `sampledAt`.
          }
        }),
      );
    };

    const tick = () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        void sample();
      }
      timer = setTimeout(tick, intervalMs);
    };
    tick();

    // Coming back to a visible map should not wait out the interval.
    const onVisibility = () => {
      if (document.visibilityState === "visible") void sample();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [desktopApi, instanceKey, intervalMs]);

  return loads;
}
