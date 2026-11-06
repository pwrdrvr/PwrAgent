import { useMemo } from "react";
import {
  createThreadJumpMatcher,
  parseThreadJumpQuery,
  threadHasExactPrNumberMatch,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import { readRendererFederationTarget } from "../../lib/federation-window";
import {
  FEDERATED_THREAD_SEARCH_LIMIT,
  useFederatedThreadSearch,
} from "../../lib/useFederatedThreadSearch";
import { useNavigationOwnerSearch } from "../../lib/useNavigationOwnerSearch";
import {
  useNavigationQueryResource,
  type NavigationQueryApi,
} from "../../lib/useNavigationQueryResource";

export const JUMP_MAX_RESULTS = 8;
export const JUMP_MAX_RECENT_THREADS = 10;

export type ThreadJumpSearchApi = NavigationQueryApi & Pick<DesktopApi, "jumpSearchRemoteThreads">;

/**
 * The jump palette's (⌘K) thread search, for any surface that finds threads
 * the same way.
 *
 * - An empty query lists the most recently updated threads.
 * - Typed text filters the window's loaded rows at once, then the owning
 *   instance's search (debounced) leads with what it finds outside them.
 * - Connected peers answer in `remoteRows`, which the palette shows below
 *   "Other instances". A peer thread already in `results` is not repeated.
 */
export function useThreadJumpSearch(params: {
  query: string;
  /** What searches threads, when it differs from `query` (the palette clears it while an `@` mention completes). */
  threadQuery?: string;
  /** The window's loaded rows, which answer before any search does. */
  threads: readonly NavigationThreadSummary[];
  desktopApi?: ThreadJumpSearchApi;
}) {
  const trimmed = params.query.trim();
  const threadQuery = params.threadQuery ?? trimmed;
  // `@project` / `in:@project` scope the threads, as in thread search. The
  // whole query still goes to every matcher, which parses the mentions
  // itself; only PR-number ranking reads the free text alone.
  const jumpText = useMemo(() => parseThreadJumpQuery(trimmed).text, [trimmed]);
  const federationTarget = readRendererFederationTarget();
  const ownerSearch = useNavigationOwnerSearch({ query: threadQuery, desktopApi: params.desktopApi });
  const recentThreads = useNavigationQueryResource({
    desktopApi: params.desktopApi,
    request: !trimmed ? {
      protocol: 2, consumer: "search",
      inventory: federationTarget ? "owner" : "viewer",
      federationTarget,
      query: { kind: "lens", lens: "inbox" }, pageSize: JUMP_MAX_RECENT_THREADS,
    } : undefined,
  });

  const results = useMemo(() => {
    if (!trimmed) {
      // The Updated lens covers the full inventory without floating pins.
      // Loaded rows give an immediate first paint while that page arrives.
      const page = recentThreads.state?.request.query.kind === "lens"
        ? recentThreads.state.page : undefined;
      const candidates = page ? page.entries.map(({ row }) => row)
        : params.threads.filter((thread) => thread.codexNativeSubAgent === undefined);
      const unique = new Map(candidates
        .filter((thread) => thread.archivedAt === undefined)
        .map((thread) => [threadSummaryIdentityKey(thread), thread]));
      return [...unique.values()].sort((left, right) =>
        (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
        || threadSummaryIdentityKey(left).localeCompare(threadSummaryIdentityKey(right)))
        .slice(0, JUMP_MAX_RECENT_THREADS);
    }
    if (!threadQuery) {
      return [];
    }
    const immediate = params.threads
      .filter(createThreadJumpMatcher(threadQuery))
      .sort(
        (left, right) =>
          Number(threadHasExactPrNumberMatch(right, jumpText))
          - Number(threadHasExactPrNumberMatch(left, jumpText)),
      )
      .slice(0, JUMP_MAX_RESULTS);
    const ownerKeys = new Set(ownerSearch.rows.map(threadSummaryIdentityKey));
    return [...ownerSearch.rows, ...immediate.filter((thread) => !ownerKeys.has(threadSummaryIdentityKey(thread)))]
      .slice(0, JUMP_MAX_RESULTS);
  }, [trimmed, threadQuery, jumpText, params.threads, ownerSearch.rows, recentThreads.state]);

  const remote = useFederatedThreadSearch({
    query: threadQuery,
    limit: FEDERATED_THREAD_SEARCH_LIMIT,
    search: params.desktopApi?.jumpSearchRemoteThreads,
  });

  // A remote thread already pinned into the local list surfaces as a local
  // hit; don't show it twice.
  const remoteRows = useMemo(() => {
    const localKeys = new Set(results.map((thread) => threadSummaryIdentityKey(thread)));
    return !threadQuery ? [] : remote.results.filter(
      (thread) => !localKeys.has(threadSummaryIdentityKey(thread)),
    );
  }, [threadQuery, remote.results, results]);

  return { jumpText, results, remoteRows, ownerSearch, recentThreads, remote };
}
