import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { NavigationQueryRequest } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import {
  applyNavigationPage,
  beginNavigationPageRead,
  createNavigationPageState,
  failNavigationPageRead,
  type NavigationPageState,
} from "./navigation-query-state";

/** Explicitly demanded page range, with one process-pool lease per resource. */
export function useNavigationQueryResource(params: {
  desktopApi?: DesktopApi;
  request?: NavigationQueryRequest;
}): {
  state?: NavigationPageState;
  loading: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
} {
  const consumerId = useId();
  const requestKey = params.request ? JSON.stringify(params.request) : undefined;
  const requestRef = useRef(params.request);
  requestRef.current = params.request;
  const currentRef = useRef<NavigationPageState | undefined>(undefined);
  const [state, setState] = useState<NavigationPageState>();
  const [loading, setLoading] = useState(false);
  const lifetimeRef = useRef(0);
  const pendingRef = useRef<{ lifetime: number; promise: Promise<void> } | undefined>(undefined);
  const api = params.desktopApi;

  const publish = useCallback((next: NavigationPageState) => {
    currentRef.current = next;
    setState(next);
  }, []);

  const read = useCallback(async (continuation: boolean): Promise<void> => {
    const lifetime = lifetimeRef.current;
    const pending = pendingRef.current;
    if (pending?.lifetime === lifetime) return pending.promise;
    const current = currentRef.current;
    if (!current) return;
    if (!api?.getNavigationQueryPage) {
      publish(failNavigationPageRead(current, current.pendingSequence, new Error("Navigation queries are unavailable. Upgrade this instance.")));
      return;
    }
    const cursor = continuation ? current.page?.nextCursor : undefined;
    if (continuation && !cursor) return;
    const started = beginNavigationPageRead(current);
    publish(started);
    setLoading(true);
    const promise = (async () => {
      try {
        const page = await api.getNavigationQueryPage!({
          ...started.request,
          cursor,
          completeBaselineRevision: !cursor && !started.stale && started.page?.complete && (started.page.rangeStart ?? 0) === 0
            ? started.page.countsRevision : undefined,
        }, consumerId);
        if (lifetimeRef.current !== lifetime) return;
        publish(applyNavigationPage({
          state: currentRef.current!, sequence: started.pendingSequence, page, cursor,
        }));
      } catch (error) {
        if (lifetimeRef.current === lifetime) {
          publish(failNavigationPageRead(currentRef.current!, started.pendingSequence, error));
        }
      } finally {
        if (pendingRef.current?.lifetime === lifetime) pendingRef.current = undefined;
        if (lifetimeRef.current === lifetime) setLoading(false);
      }
    })();
    pendingRef.current = { lifetime, promise };
    return promise;
  }, [api, consumerId, publish]);

  useEffect(() => {
    lifetimeRef.current += 1;
    const request = requestRef.current;
    currentRef.current = request ? createNavigationPageState(request) : undefined;
    setState(currentRef.current);
    setLoading(false);
    if (request) void read(false);
    return () => {
      lifetimeRef.current += 1;
      void api?.releaseNavigationQuery?.(consumerId);
    };
  }, [api, consumerId, read, requestKey]);

  const refresh = useCallback(() => read(false), [read]);
  const loadMore = useCallback(() => read(true), [read]);
  return { state, loading, refresh, loadMore };
}
