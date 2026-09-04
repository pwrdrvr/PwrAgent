import { useEffect, useRef, useState } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { getDesktopApi, type DesktopApi } from "./desktop-api";
import { readRendererFederationTarget } from "./federation-window";

export const FEDERATED_THREAD_SEARCH_LIMIT = 8;
export const FEDERATED_THREAD_SEARCH_DEBOUNCE_MS = 200;

type RemoteThreadSearch = NonNullable<DesktopApi["jumpSearchRemoteThreads"]>;

export function useFederatedThreadSearch(params: {
  query: string;
  limit?: number;
  search?: RemoteThreadSearch;
}): {
  available: boolean;
  completedPeerCount: number;
  loading: boolean;
  results: NavigationThreadSummary[];
  /**
   * The (trimmed) query `results` actually answer.
   *
   * `loading` alone cannot tell a caller "the peers have replied about
   * *this* query": it is set from inside an effect, so for one commit
   * after the query changes it still reads `false` while carrying the
   * previous query's results. A caller that treats that frame as a
   * settled empty answer acts on the wrong query. Compare against this
   * instead.
   */
  settledQuery: string;
  totalPeerCount: number;
} {
  const [results, setResults] = useState<NavigationThreadSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [settledQuery, setSettledQuery] = useState("");
  const [completedPeerCount, setCompletedPeerCount] = useState(0);
  const [totalPeerCount, setTotalPeerCount] = useState(0);
  const generationRef = useRef(0);
  const query = params.query.trim();
  const search = params.search ?? getDesktopApi()?.jumpSearchRemoteThreads;
  // A remote-viewer window already scopes to one peer; only the main window
  // fans a thread search out across the federation.
  const available =
    !readRendererFederationTarget()
    && typeof search === "function";

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    if (!query || !available || !search) {
      setResults([]);
      setLoading(false);
      setCompletedPeerCount(0);
      setTotalPeerCount(0);
      // Nothing to ask, so this query is answered the moment it arrives.
      setSettledQuery(query);
      return;
    }

    setLoading(true);
    setCompletedPeerCount(0);
    setTotalPeerCount(0);
    const timer = setTimeout(() => {
      search(
        {
          query,
          limit: params.limit ?? FEDERATED_THREAD_SEARCH_LIMIT,
        },
        (progress) => {
          if (generationRef.current !== generation) {
            return;
          }
          setResults(progress.results);
          setCompletedPeerCount(progress.completedPeerCount);
          setTotalPeerCount(progress.totalPeerCount);
          if (progress.complete) {
            setLoading(false);
            setSettledQuery(query);
          }
        },
      )
        .then((response) => {
          if (generationRef.current !== generation) {
            return;
          }
          setResults(response.results);
          setLoading(false);
          setSettledQuery(query);
        })
        .catch(() => {
          if (generationRef.current !== generation) {
            return;
          }
          setResults([]);
          setLoading(false);
          setSettledQuery(query);
        });
    }, FEDERATED_THREAD_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      if (generationRef.current === generation) {
        generationRef.current += 1;
      }
    };
  }, [available, params.limit, query, search]);

  return {
    available,
    completedPeerCount,
    loading,
    results,
    settledQuery,
    totalPeerCount,
  };
}
