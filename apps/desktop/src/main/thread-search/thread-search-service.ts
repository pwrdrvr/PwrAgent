import type {
  AppServerBackendKind,
  AppServerBackendScope,
  AppServerThreadSummary,
  ThreadSearchFilters,
  ThreadSearchRequest,
  ThreadSearchResponse,
  ThreadSearchUnavailableScope,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  normalizeThreadSearchContentMode,
  normalizeThreadSearchLimit,
  normalizeThreadSearchSemanticMode,
} from "@pwragent/shared";
import type { ThreadSearchStore } from "./thread-search-store";
import type {
  ThreadContentSearchResponse,
  ProviderTranscriptThreadSearchAdapter,
} from "./thread-search-provider-adapters";

const CONTENT_SEARCH_CANDIDATE_LIMIT = 50;

export type ThreadSearchThreadLister = (request: {
  backend?: AppServerBackendKind;
  archived?: boolean;
}) => Promise<AppServerThreadSummary[]>;

export class ThreadSearchService {
  constructor(
    private readonly store: ThreadSearchStore,
    private readonly listThreads: ThreadSearchThreadLister,
    private readonly contentAdapter?: ProviderTranscriptThreadSearchAdapter,
  ) {}

  async search(request: ThreadSearchRequest = {}): Promise<ThreadSearchResponse> {
    const filters = normalizeFilters(request.filters);
    const backend = filters.backend ?? "all";
    const contentMode = normalizeThreadSearchContentMode(request.contentMode);
    const semanticMode = normalizeThreadSearchSemanticMode(request.semanticMode);
    const limit = normalizeThreadSearchLimit(request.limit);
    const query = request.query?.trim() ?? "";

    const listBackend = backend === "all" ? undefined : backend;
    const activeThreads = await this.listThreads({
      backend: listBackend,
      archived: false,
    });
    const threads = filters.includeArchived
      ? dedupeThreads([
          ...activeThreads,
          ...(await this.listThreads({
            backend: listBackend,
            archived: true,
          })),
        ])
      : activeThreads;
    for (const thread of threads) {
      this.store.upsertThread(thread);
    }
    this.store.pruneMissingThreads({
      backend: listBackend,
      includeArchived: filters.includeArchived === true,
      retainedIdentityKeys: threads.map((thread) =>
        buildThreadIdentityKey(thread.source, thread.id),
      ),
    });

    const metadataResults = this.store
      .search({
        backend: backend === "all" ? undefined : backend,
        filters,
        includeArchived: filters.includeArchived,
        limit,
        query,
      })
      .filter((result) => matchesFilters(result, filters));
    const contentResults =
      contentMode === "metadata" || !this.contentAdapter
        ? emptyContentSearchResponse()
        : await this.contentAdapter.searchContent({
            candidates: buildContentCandidates({
              backend,
              filters,
              metadataResults,
              store: this.store,
            }),
            limit,
            query,
          });
    const results = mergeSearchResults(metadataResults, contentResults.results).slice(
      0,
      limit,
    );

    return {
      backend,
      fetchedAt: Date.now(),
      query,
      filters,
      contentMode,
      semanticMode,
      results,
      searchedScopes: ["metadata", "projection"],
      unavailableScopes: [
        ...buildUnavailableScopes({
          backend,
          contentMode,
          contentSearchAttempted: Boolean(this.contentAdapter),
          semanticMode,
        }),
        ...contentResults.unavailableScopes,
      ],
      truncated: results.length >= limit,
    };
  }
}

function dedupeThreads(threads: AppServerThreadSummary[]): AppServerThreadSummary[] {
  const seen = new Set<string>();
  const deduped: AppServerThreadSummary[] = [];
  for (const thread of threads) {
    const key = buildThreadIdentityKey(thread.source, thread.id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(thread);
  }
  return deduped;
}

function normalizeFilters(filters: ThreadSearchFilters | undefined): ThreadSearchFilters {
  return {
    ...filters,
    backend: filters?.backend ?? "all",
    includeArchived: filters?.includeArchived === true,
  };
}

function buildUnavailableScopes(params: {
  backend: AppServerBackendScope;
  contentSearchAttempted: boolean;
  contentMode: ThreadSearchResponse["contentMode"];
  semanticMode: ThreadSearchResponse["semanticMode"];
}): ThreadSearchUnavailableScope[] {
  return [
    ...(params.contentMode === "metadata" || params.contentSearchAttempted
      ? []
      : [
          {
            scope: "provider_content" as const,
            backend: params.backend === "all" ? undefined : params.backend,
            reason: "unsupported" as const,
            message:
              "Provider content search is not wired yet; searched metadata projections only.",
          },
        ]),
    ...(params.semanticMode === "disabled"
      ? []
      : [
          {
            scope: "semantic" as const,
            backend: params.backend === "all" ? undefined : params.backend,
            reason: "disabled" as const,
            message:
              "Semantic thread search is disabled by default and has no configured local index.",
          },
        ]),
  ];
}

function buildContentCandidates(params: {
  backend: AppServerBackendScope;
  filters: ThreadSearchFilters;
  metadataResults: ThreadSearchResponse["results"];
  store: ThreadSearchStore;
}): ThreadSearchResponse["results"] {
  const recentResults = params.store
    .search({
      backend: params.backend === "all" ? undefined : params.backend,
      filters: params.filters,
      includeArchived: params.filters.includeArchived,
      limit: CONTENT_SEARCH_CANDIDATE_LIMIT,
    })
    .filter((result) => matchesFilters(result, params.filters));
  return mergeSearchResults(params.metadataResults, recentResults).slice(
    0,
    CONTENT_SEARCH_CANDIDATE_LIMIT,
  );
}

function mergeSearchResults(
  primary: ThreadSearchResponse["results"],
  secondary: ThreadSearchResponse["results"],
): ThreadSearchResponse["results"] {
  const byKey = new Map<string, ThreadSearchResponse["results"][number]>();
  for (const result of [...primary, ...secondary]) {
    const existing = byKey.get(result.identityKey);
    if (!existing) {
      byKey.set(result.identityKey, result);
      continue;
    }
    byKey.set(result.identityKey, {
      ...existing,
      score: Math.max(existing.score, result.score),
      confidence:
        existing.confidence === "high" || result.confidence === "high"
          ? "high"
          : existing.confidence === "medium" || result.confidence === "medium"
            ? "medium"
            : "low",
      matchReasons: [...existing.matchReasons, ...result.matchReasons],
      snippets: [...existing.snippets, ...result.snippets],
    });
  }
  return [...byKey.values()].sort((left, right) => right.score - left.score);
}

function emptyContentSearchResponse(): ThreadContentSearchResponse {
  return { results: [], unavailableScopes: [] };
}

function matchesFilters(
  result: ThreadSearchResponse["results"][number],
  filters: ThreadSearchFilters,
): boolean {
  if (
    filters.projectKeys?.length &&
    (!result.projectKey || !filters.projectKeys.includes(result.projectKey))
  ) {
    return false;
  }
  if (filters.directoryIds?.length) {
    const ids = new Set(result.linkedDirectories.map((directory) => directory.id));
    if (!filters.directoryIds.some((id) => ids.has(id))) {
      return false;
    }
  }
  if (filters.directoryPaths?.length) {
    const paths = new Set(
      result.linkedDirectories.flatMap((directory) =>
        [directory.path, directory.worktreePath].filter(Boolean),
      ),
    );
    if (!filters.directoryPaths.some((directoryPath) => paths.has(directoryPath))) {
      return false;
    }
  }
  if (filters.models?.length && (!result.model || !filters.models.includes(result.model))) {
    return false;
  }
  if (filters.dateRange?.from && (result.updatedAt ?? result.createdAt ?? 0) < filters.dateRange.from) {
    return false;
  }
  if (filters.dateRange?.to && (result.updatedAt ?? result.createdAt ?? 0) > filters.dateRange.to) {
    return false;
  }
  return true;
}
