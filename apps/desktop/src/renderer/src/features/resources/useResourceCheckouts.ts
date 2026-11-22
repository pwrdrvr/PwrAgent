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

export type PerformResourceActionOptions = {
  /**
   * Whether a rejected or unknown result is reported through `settled`. A
   * dialog that shows its own failure passes false so the result is not
   * announced twice; success is always reported.
   */
  reportFailure?: boolean;
};

/**
 * Reads and follows a resource checkouts source.
 *
 * Actions are never applied to the snapshot locally: after an action settles
 * the hook re-reads, and the screen shows whatever the authority reports.
 */
export function useResourceCheckouts(source: ResourceCheckoutsSource) {
  const [view, setView] = useState<ResourceCheckoutsView>({ status: "loading" });
  const [pending, setPending] = useState<readonly PendingResourceAction[]>([]);
  const [settled, setSettled] = useState<SettledResourceAction | null>(null);
  const shownRef = useRef<ResourceCheckoutsSnapshot | undefined>(undefined);
  const mountedRef = useRef(true);
  const readSeqRef = useRef(0);
  const succeededSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++readSeqRef.current;
    try {
      const snapshot = await source.read();
      if (!mountedRef.current) return;
      succeededSeqRef.current = Math.max(succeededSeqRef.current, seq);
      if (!acceptSnapshot(shownRef.current, snapshot)) return;
      shownRef.current = snapshot;
      setView({ status: "ready", snapshot });
    } catch (error) {
      // A read started after this one already succeeded, so what is on
      // screen is newer than anything this failure could say is stale.
      if (!mountedRef.current || succeededSeqRef.current > seq) return;
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
    succeededSeqRef.current = readSeqRef.current;
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
    async (
      request: ResourceCheckoutActionRequest,
      options: PerformResourceActionOptions = {},
    ): Promise<ResourceCheckoutActionResult> => {
      const entry: PendingResourceAction = { request };
      setPending((current) => [...current, entry]);
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
        setPending((current) => current.filter((candidate) => candidate !== entry));
        const failed = result.outcome === "rejected" || result.outcome === "unknown";
        if (!failed || options.reportFailure !== false) setSettled({ request, result });
        void refresh();
      }
      return result;
    },
    [refresh, source],
  );

  const dismissSettled = useCallback(() => setSettled(null), []);

  return { view, pending, settled, perform, refresh, dismissSettled };
}
