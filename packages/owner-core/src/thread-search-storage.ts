import type {
  AppServerBackendKind,
  AppServerThreadSummary,
  ThreadSearchFilters,
  ThreadSearchResult,
} from "@pwragent/shared";

export type ThreadSearchProjectionSearchRequest = {
  query?: string;
  identityKeys?: string[];
  backend?: AppServerBackendKind;
  includeArchived?: boolean;
  filters?: ThreadSearchFilters;
  limit: number;
};

/** Compact provider-owned thread projections for desktop search. */
export interface ThreadSearchStorage {
  upsertThreads(threads: readonly AppServerThreadSummary[]): void;
  upsertThread(thread: AppServerThreadSummary, indexedAt?: number): void;
  deleteThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): void;
  pruneMissingThreads(params: {
    backend?: AppServerBackendKind;
    includeArchived: boolean;
    retainedIdentityKeys: string[];
  }): void;
  search(request: ThreadSearchProjectionSearchRequest): ThreadSearchResult[];
}
