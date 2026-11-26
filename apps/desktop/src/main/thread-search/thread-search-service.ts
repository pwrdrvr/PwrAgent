import { setImmediate } from "node:timers/promises";
import type {
  AppServerBackendKind,
  AppServerBackendScope,
  AppServerThreadSummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import type {
  ThreadSearchFilters,
  ThreadSearchRequest,
  ThreadSearchResponse,
  ThreadSearchResult,
  ThreadSearchUnavailableScope,
} from "@pwragent/shared/contracts/thread-search";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { parseThreadSearchQuery, matchesThreadSearchProjects } from "@pwragent/shared/thread-search-query";
import {
  normalizeThreadSearchContentMode,
  normalizeThreadSearchLimit,
  normalizeThreadSearchSemanticMode,
} from "@pwragent/shared/contracts/thread-search";
import { THREAD_SEARCH_SLICE_SIZE, type ThreadSearchStorage } from "@pwragent/owner-core/thread-search-storage";
import { awaitThreadSearchRead } from "./thread-search-cancellation";
import type {
  ThreadContentSearchResponse,
  ProviderTranscriptThreadSearchAdapter,
} from "./thread-search-provider-adapters";

const CONTENT_SEARCH_CANDIDATE_LIMIT = 50;

/** Available inventory, possibly partial; omissions never authorize durable deletion. */
export type ThreadSearchThreadLister = (request: {
  backend?: AppServerBackendKind;
  archived?: boolean;
}) => Promise<AppServerThreadSummary[]>;

export class ThreadSearchService {
  constructor(
    private readonly store: ThreadSearchStorage,
    private readonly listThreads: ThreadSearchThreadLister,
    private readonly contentAdapter?: ProviderTranscriptThreadSearchAdapter,
  ) {}

  async search(
    request: ThreadSearchRequest = {},
    signal?: AbortSignal,
  ): Promise<ThreadSearchResponse> {
    signal?.throwIfAborted();
    const filters = normalizeFilters(request.filters);
    const backend = filters.backend ?? "all";
    const contentMode = normalizeThreadSearchContentMode(request.contentMode);
    const semanticMode = normalizeThreadSearchSemanticMode(request.semanticMode);
    const limit = normalizeThreadSearchLimit(request.limit);
    const rawQuery = request.query?.trim() ?? "";
    const { query, projects } = parseThreadSearchQuery(rawQuery);

    const listBackend = backend === "all" ? undefined : backend;
    const activeThreads = await awaitThreadSearchRead(() => this.listThreads({
      backend: listBackend,
      archived: false,
    }), signal);
    const threads = filters.includeArchived
      ? dedupeThreads([
          ...activeThreads,
          ...(await awaitThreadSearchRead(() => this.listThreads({
            backend: listBackend,
            archived: true,
          }), signal)),
        ])
      : activeThreads;
    signal?.throwIfAborted();
    // Listings can omit failed, unavailable or paged providers. They are a
    // visibility oracle for this request, never evidence of durable deletion.
    // Bound synchronous indexing work and let cancellation run between slices.
    let needsSnapshot = false;
    for (let offset = 0; offset < threads.length; offset += THREAD_SEARCH_SLICE_SIZE) {
      if (offset > 0) await setImmediate();
      signal?.throwIfAborted();
      needsSnapshot = this.store.upsertThreads(threads.slice(offset, offset + THREAD_SEARCH_SLICE_SIZE)) || needsSnapshot;
    }
    const scopedThreads = projects.length ? threads.filter((thread) => matchesThreadSearchProjects(thread, projects)) : threads;
    const metadataRequest = {
      backend: listBackend,
      filters,
      identityKeys: scopedThreads.map((thread) => buildThreadIdentityKey(thread.source, thread.id)),
      includeArchived: filters.includeArchived,
      limit,
      query,
    };
    const contentAdapter = contentMode === "metadata" ? undefined : this.contentAdapter;
    const requests = contentAdapter
      ? [metadataRequest, { ...metadataRequest, limit: CONTENT_SEARCH_CANDIDATE_LIMIT, query: undefined }]
      : [metadataRequest];
    const [metadata = [], recent = []] = needsSnapshot && scopedThreads.length > 0
      ? await this.store.searchInVerifiedSnapshot(scopedThreads, requests, signal)
      : requests.map((request) => this.store.search(request));
    const metadataResults = metadata.filter((result) => matchesFilters(result, filters));
    const contentResults = !contentAdapter
      ? emptyContentSearchResponse()
      : await contentAdapter.searchContent({
          candidates: buildContentCandidates({
            metadataResults,
            recentResults: recent.filter((result) => matchesFilters(result, filters)),
          }),
          limit,
          query,
          signal,
        });
    const results = mergeSearchResults(metadataResults, contentResults.results).slice(
      0,
      limit,
    );

    return {
      backend,
      fetchedAt: Date.now(),
      query: rawQuery,
      filters,
      contentMode,
      semanticMode,
      results,
      searchedScopes: [
        "metadata", "projection",
        ...(contentMode !== "metadata" && this.contentAdapter ? ["provider_content" as const] : []),
      ],
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
  metadataResults: ThreadSearchResponse["results"];
  recentResults: ThreadSearchResponse["results"];
}): ThreadSearchResponse["results"] {
  // Preserve the original exact-then-recent window. Relaxed projections can
  // use spare slots, but cannot displace a transcript-only candidate.
  const exact = params.metadataResults.filter((result) => result.score >= 0);
  const relaxed = params.metadataResults.filter((result) => result.score < 0);
  const candidates = new Map<string, ThreadSearchResult>();
  for (const result of [...exact, ...params.recentResults, ...relaxed]) {
    if (!candidates.has(result.identityKey)) candidates.set(result.identityKey, result);
    if (candidates.size === CONTENT_SEARCH_CANDIDATE_LIMIT) break;
  }
  return [...candidates.values()];
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
