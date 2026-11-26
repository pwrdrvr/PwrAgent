import type {
  AppServerBackendKind,
  AppServerThreadSummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadSearchFilters, ThreadSearchResult } from "@pwragent/shared/contracts/thread-search";

export type ThreadSearchProjectionSearchRequest = {
  query?: string;
  identityKeys?: string[];
  backend?: AppServerBackendKind;
  includeArchived?: boolean;
  filters?: ThreadSearchFilters;
  limit: number;
};

export const THREAD_SEARCH_SLICE_SIZE = 64;

/** Compact provider-owned thread projections for desktop search. */
export interface ThreadSearchStorage {
  /** Returns true when the request needs searchInVerifiedSnapshot before querying. */
  upsertThreads(threads: readonly AppServerThreadSummary[]): boolean;
  upsertThread(thread: AppServerThreadSummary, indexedAt?: number): void;
  deleteThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): void;
  /** Inspect at most 64 documents, deleting omissions from an explicitly complete inventory; never pass search listings. */
  pruneMissingThreads(params: {
    backend?: AppServerBackendKind;
    includeArchived: boolean;
    retainedIdentityKeys: string[];
  }): void;
  search(request: ThreadSearchProjectionSearchRequest): ThreadSearchResult[];
  /** Verify the listed projections and read all requests from the same snapshot. */
  searchInVerifiedSnapshot(
    threads: readonly AppServerThreadSummary[],
    requests: readonly ThreadSearchProjectionSearchRequest[],
    signal?: AbortSignal,
  ): Promise<ThreadSearchResult[][]>;
}
