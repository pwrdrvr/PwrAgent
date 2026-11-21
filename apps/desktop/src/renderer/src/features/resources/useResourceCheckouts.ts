import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ResourceCheckoutActionRequest,
  ResourceCheckoutActionResult,
  ResourceCheckoutsSnapshot,
} from "@pwragent/shared/contracts/resource-checkouts";
import type { ResourceCheckoutsSource } from "./resource-checkouts-source";

export type ResourceCheckoutsView =
  | { status: "loading" }
  | { status: "ready"; snapshot: ResourceCheckoutsSnapshot }
  | {
    status: "error";
    message: string;
    /** The last snapshot shown, kept on screen and marked stale. */
    snapshot?: ResourceCheckoutsSnapshot;
  };

/**
 * Whether an arriving snapshot replaces the one on screen. Reads can resolve
 * out of order (a change event's read overtaking the mount read), so only a
 * strictly newer revision wins; an equal or older one is dropped.
 */
export function acceptSnapshot(
  current: ResourceCheckoutsSnapshot | undefined,
  incoming: ResourceCheckoutsSnapshot,
): boolean {
  return current === undefined || incoming.revision > current.revision;
}

export type PendingResourceAction = {
  request: ResourceCheckoutActionRequest;
};

export type SettledResourceAction = {
  request: ResourceCheckoutActionRequest;
  result: ResourceCheckoutActionResult;
};

/**
 * Reads and follows a resource checkouts source.
 *
 * Actions are never applied to the snapshot locally: after an action settles
 * the hook re-reads, and the screen shows whatever the authority reports.
 */
export function useResourceCheckouts(source: ResourceCheckoutsSource) {
  const [view, setView] = useState<ResourceCheckoutsView>({ status: "loading" });
  const [pending, setPending] = useState<PendingResourceAction | null>(null);
  const [settled, setSettled] = useState<SettledResourceAction | null>(null);
  const shownRef = useRef<ResourceCheckoutsSnapshot | undefined>(undefined);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await source.read();
      if (!mountedRef.current || !acceptSnapshot(shownRef.current, snapshot)) return;
      shownRef.current = snapshot;
      setView({ status: "ready", snapshot });
    } catch (error) {
      if (!mountedRef.current) return;
      setView({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        ...(shownRef.current ? { snapshot: shownRef.current } : {}),
      });
    }
  }, [source]);

  useEffect(() => {
    mountedRef.current = true;
    shownRef.current = undefined;
    setView({ status: "loading" });
    const unsubscribe = source.subscribe((event) => {
      if (shownRef.current && event.revision <= shownRef.current.revision) return;
      void refresh();
    });
    void refresh();
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, [refresh, source]);

  const perform = useCallback(
    async (request: ResourceCheckoutActionRequest): Promise<ResourceCheckoutActionResult> => {
      setPending({ request });
      setSettled(null);
      let result: ResourceCheckoutActionResult;
      try {
        result = await source.perform(request);
      } catch (error) {
        result = {
          outcome: "unknown",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (mountedRef.current) {
        setPending(null);
        setSettled({ request, result });
        void refresh();
      }
      return result;
    },
    [refresh, source],
  );

  const dismissSettled = useCallback(() => setSettled(null), []);

  return { view, pending, settled, perform, refresh, dismissSettled };
}
