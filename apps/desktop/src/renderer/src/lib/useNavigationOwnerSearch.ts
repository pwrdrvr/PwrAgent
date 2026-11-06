import { useEffect, useMemo, useState } from "react";
import { readRendererFederationTarget } from "./federation-window";
import { useNavigationQueryResource, type NavigationQueryApi } from "./useNavigationQueryResource";

/** A palette's owning instance can match threads outside its loaded rows. */
export function useNavigationOwnerSearch(params: { query: string; desktopApi?: NavigationQueryApi }) {
  const query = params.query.trim();
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const resource = useNavigationQueryResource({ desktopApi: params.desktopApi,
    request: query && debounced === query ? { protocol: 2, consumer: "search", inventory: "owner",
      federationTarget: readRendererFederationTarget(), query: { kind: "search", text: query }, pageSize: 8 } : undefined });
  const current = resource.state?.request.query;
  const page = current?.kind === "search" && current.text === query ? resource.state?.page : undefined;
  const rows = useMemo(() => page?.entries.map(({ row }) => row) ?? [], [page]);
  return { rows,
    loading: Boolean(query && (query !== debounced || resource.loading)),
    error: query === debounced ? resource.state?.error : undefined };
}
