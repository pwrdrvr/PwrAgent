import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  NavigationDirectoryRow,
  NavigationIdentity,
  NavigationQueryRequest,
  NavigationRow,
  NavigationStarMapFilterSelection,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { navigationGeometryBudget, navigationExactRowsBudget } from "../../lib/navigation-metadata-budget";
import { navigationQueryEventRequiresRefresh } from "../../lib/navigation-query-events";
import { navigationIdentityKey } from "../../lib/navigation-query-state";
import { readNavigationQueryRange } from "../../lib/read-navigation-query-range";
import { useNavigationQueryResource } from "../../lib/useNavigationQueryResource";

const METADATA_MAX_BYTES = 8 * 1024 * 1024;

/** Local map demand uses the same main-process query pool as remote windows. */
export function useLocalStarMapThreads(params: {
  desktopApi?: DesktopApi;
  enabled: boolean;
  filters: NavigationStarMapFilterSelection;
  demandedIdentities: readonly NavigationIdentity[];
  promoteOnTurnEnd?: boolean;
}) {
  const id = useId();
  const api = params.desktopApi;
  const request = useMemo<NavigationQueryRequest | undefined>(() => params.enabled ? {
    protocol: 2,
    consumer: "star-map",
    query: { kind: "star-map", filters: params.filters },
    attentionView: { id, promoteOnTurnEnd: params.promoteOnTurnEnd ?? true },
    pageSize: 10,
  } : undefined, [id, params.enabled, params.filters, params.promoteOnTurnEnd]);
  const rows = useNavigationQueryResource({ desktopApi: api, request });
  useEffect(() => () => {
    void api?.releaseNavigationAttentionView?.({ viewId: id }).catch(() => undefined);
  }, [api, id]);
  const [directories, setDirectories] = useState<NavigationDirectoryRow[]>([]);
  const [geometryReady, setGeometryReady] = useState(false);
  const [metadataError, setMetadataError] = useState<string>();
  const [exactRows, setExactRows] = useState<NavigationRow[]>([]);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const geometrySequence = useRef(0);
  const exactSequence = useRef(0);
  const identitiesKey = JSON.stringify(params.demandedIdentities);
  const identitiesRef = useRef(params.demandedIdentities);
  identitiesRef.current = params.demandedIdentities;

  useEffect(() => {
    if (!params.enabled || !api?.getNavigationQueryPage) return;
    const sequence = ++geometrySequence.current;
    const consumerId = `${id}:geometry`;
    setGeometryReady(false);
    void (async () => {
      const lease = navigationGeometryBudget.begin(consumerId);
      try {
        const page = await readNavigationQueryRange({
          request: { protocol: 2, consumer: "star-map", query: { kind: "star-map-geometry" }, pageSize: 100 },
          read: (query) => api.getNavigationQueryPage!(query, consumerId),
          isCancelled: () => geometrySequence.current !== sequence,
          maxBytes: METADATA_MAX_BYTES,
          reserveBytes: lease.reserve,
          releaseBytes: lease.unreserve,
        });
        if (geometrySequence.current !== sequence) return;
        lease.commit();
        setDirectories(page.directories ?? []);
        setGeometryReady(true);
        setMetadataError(undefined);
      } finally { lease.dispose(); }
    })().catch((error: unknown) => {
      if (geometrySequence.current === sequence) setMetadataError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      geometrySequence.current += 1;
      void api.releaseNavigationQuery?.(consumerId);
    };
  }, [api, id, params.enabled, refreshNonce]);

  useEffect(() => {
    if (!params.enabled || !api?.getNavigationQueryPage) return;
    const sequence = ++exactSequence.current;
    const consumerId = `${id}:exact`;
    const identities = identitiesRef.current;
    void (async () => {
      const lease = navigationExactRowsBudget.begin(consumerId);
      try {
        const deadlineAt = Date.now() + 10_000;
        const selected = new Map<string, NavigationRow>();
        let remainingBytes = METADATA_MAX_BYTES;
        const encoder = new TextEncoder();
        for (let offset = 0; offset < identities.length; offset += 100) {
          const page = await readNavigationQueryRange({
            request: { protocol: 2, consumer: "star-map", deadlineAt,
              query: { kind: "exact", identities: identities.slice(offset, offset + 100), includeAncestry: true }, pageSize: 100 },
            read: (query) => api.getNavigationQueryPage!(query, consumerId),
            isCancelled: () => exactSequence.current !== sequence,
            maxBytes: remainingBytes,
            reserveBytes: lease.reserve,
            releaseBytes: lease.unreserve,
          });
          remainingBytes -= encoder.encode(JSON.stringify(page)).byteLength;
          for (const entry of page.entries) selected.set(navigationIdentityKey(entry.row.ref), entry.row);
        }
        if (exactSequence.current === sequence) {
          lease.commit();
          setExactRows([...selected.values()]);
        }
      } finally { lease.dispose(); }
    })().catch((error: unknown) => {
      if (exactSequence.current === sequence) setMetadataError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      exactSequence.current += 1;
      void api.releaseNavigationQuery?.(consumerId);
    };
  }, [api, id, identitiesKey, params.enabled, refreshNonce]);

  useEffect(() => () => {
    navigationGeometryBudget.release(`${id}:geometry`);
    navigationExactRowsBudget.release(`${id}:exact`);
  }, [id]);

  const refreshRows = rows.refresh;
  const refresh = useCallback(async () => {
    setRefreshNonce((value) => value + 1);
    await refreshRows();
  }, [refreshRows]);
  useEffect(() => {
    if (!params.enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api?.onAgentEvent?.((event) => {
      if (event.federationTarget?.scope === "remote") return;
      const method = event.notification.method;
      if (!navigationQueryEventRequiresRefresh(method)) return;
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; void refresh(); }, 250);
    });
    return () => { unsubscribe?.(); if (timer) clearTimeout(timer); };
  }, [api, params.enabled, refresh]);

  const threads = useMemo(() => {
    const result = new Map((rows.state?.page?.entries ?? []).map((entry) => [navigationIdentityKey(entry.row.ref), entry.row]));
    for (const row of exactRows) result.set(navigationIdentityKey(row.ref), row);
    return [...result.values()];
  }, [rows.state?.page, exactRows]);
  return { threads, directories, geometryReady, refresh, loadMore: rows.loadMore,
    counts: rows.state?.page?.counts, facets: rows.state?.page?.facets,
    stale: rows.state?.stale ?? false, error: rows.state?.error ?? metadataError };
}
