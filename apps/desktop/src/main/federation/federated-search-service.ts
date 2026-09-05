import type {
  AppServerListThreadsResponse,
  AppServerThreadSummary,
  FederatedSearchRequest,
  FederatedSearchResponse,
  FederationInstanceId,
  FederationPeerSummary,
  FederationThreadSearchRequest,
  FederationThreadSearchResponse,
} from "@pwragent/shared";
import {
  buildFederatedThreadRef,
  buildThreadIdentityKey,
} from "@pwragent/shared";
import type { FederationBackendOperations } from "./federation-backend-bridge";
import {
  hasFederationErrorCode,
  type FederationRpcRequestOptions,
} from "./federation-rpc";

export type FederatedSearchPeer = {
  instanceId: FederationInstanceId;
  label: string;
  status?: FederationPeerSummary["status"];
  backend: Pick<
    Required<FederationBackendOperations>,
    "listThreads" | "searchFederatedThreads"
  >
    & Partial<Pick<FederationBackendOperations, "resolveThread">>;
};

export type FederatedSearchLocalBackend = Pick<
  FederationBackendOperations,
  "listThreads"
> & Partial<Pick<
  FederationBackendOperations,
  "resolveThread" | "searchFederatedThreads"
>>;

type FederatedSearchResultPage = {
  results: FederatedSearchResponse["results"];
  totalCount: number;
  truncated: boolean;
};

/**
 * Per-peer deadline for a search fan-out. Much tighter than the 30s RPC
 * default: one hung peer must not stall the whole global-search surface,
 * and a peer that cannot answer a metadata filter in this window is not
 * going to produce useful interactive results anyway.
 */
const FEDERATED_SEARCH_PEER_TIMEOUT_MS = 10_000;

export class FederatedSearchService {
  constructor(
    private readonly options: {
      local: FederatedSearchLocalBackend;
      peers: () => readonly FederatedSearchPeer[];
      includeLocal?: boolean;
      now?: () => number;
      peerTimeoutMs?: number;
    },
  ) {}

  async search(request: FederatedSearchRequest): Promise<FederatedSearchResponse> {
    const query = request.query.trim();
    const limit = searchLimit(request.limit);
    const searchedAt = this.options.now?.() ?? Date.now();
    const failures: FederatedSearchResponse["failures"] = [];
    let localSearch: FederatedSearchResponse["localSearch"];
    const searchedInstances: NonNullable<
      FederatedSearchResponse["searchedInstances"]
    > = [];
    const peerTimeoutMs =
      this.options.peerTimeoutMs ?? FEDERATED_SEARCH_PEER_TIMEOUT_MS;
    const resultGroups = await Promise.all([
      ...(this.options.includeLocal === false
        ? []
        : [(async () => {
            try {
              const page = await withTimeout(
                this.searchLocal(query, request, {
                  deadlineAt: Date.now() + peerTimeoutMs,
                }),
                peerTimeoutMs,
                "Local federated search timed out.",
              );
              localSearch = {
                totalCount: page.totalCount,
                truncated: page.truncated,
              };
              return page;
            } catch (error) {
              localSearch = {
                totalCount: 0,
                truncated: false,
                error: error instanceof Error ? error.message : String(error),
              };
              return { results: [], totalCount: 0, truncated: false };
            }
          })()]),
      ...this.options.peers().map(async (peer) => {
        const rpcOptions = { deadlineAt: Date.now() + peerTimeoutMs };
        try {
          const peerResults = await withTimeout(
            this.searchPeer(peer, query, request, rpcOptions),
            peerTimeoutMs,
            `Federated search timed out after ${Math.round(peerTimeoutMs / 1000)}s.`,
          );
          searchedInstances.push({
            instanceId: peer.instanceId,
            instanceLabel: peer.label,
            resultCount: peerResults.totalCount,
            ...(peerResults.truncated ? { truncated: true } : {}),
          });
          return peerResults;
        } catch (error) {
          failures.push({
            instanceId: peer.instanceId,
            instanceLabel: peer.label,
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            results: [],
            totalCount: 0,
            truncated: false,
          };
        }
      }),
    ]);
    const matches = resultGroups
      .flatMap((group) => group.results)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return (
          (right.thread.updatedAt ?? right.thread.createdAt ?? 0)
          - (left.thread.updatedAt ?? left.thread.createdAt ?? 0)
        );
      });
    const results = matches.slice(0, limit);
    const totalCount = resultGroups.reduce(
      (count, group) => count + group.totalCount,
      0,
    );

    return {
      query,
      searchedAt,
      results,
      totalCount,
      truncated:
        totalCount > limit
        || resultGroups.some((group) => group.truncated),
      failures,
      ...(localSearch ? { localSearch } : {}),
      searchedInstances,
    };
  }

  private async searchLocal(
    query: string,
    request: FederatedSearchRequest,
    rpcOptions: FederationRpcRequestOptions,
  ): Promise<FederatedSearchResultPage> {
    const ownerResponse = this.options.local.searchFederatedThreads
      ? await this.options.local.searchFederatedThreads(
          buildOwnerSearchRequest(query, request),
          rpcOptions,
        )
      : await searchFederatedThreadsOnOwner(
          this.options.local,
          buildOwnerSearchRequest(query, request),
          rpcOptions,
        );
    return {
      results: ownerResponse.threads.map((thread) => ({
        ref: buildFederatedThreadRef({
          backend: thread.source,
          threadId: thread.id,
        }),
        thread,
        instanceLabel: "This Mac",
        score: scoreThread(thread, query),
      })),
      totalCount: ownerResponse.totalCount,
      truncated: ownerResponse.truncated,
    };
  }

  private async searchPeer(
    peer: FederatedSearchPeer,
    query: string,
    request: FederatedSearchRequest,
    rpcOptions: FederationRpcRequestOptions,
  ): Promise<FederatedSearchResultPage> {
    let ownerResponse: FederationThreadSearchResponse;
    try {
      ownerResponse = await peer.backend.searchFederatedThreads(
        buildOwnerSearchRequest(query, request),
        rpcOptions,
      );
    } catch (error) {
      if (!hasFederationErrorCode(error, "method_not_found")) {
        throw error;
      }
      ownerResponse = await searchFederatedThreadsOnOwner(
        peer.backend,
        buildOwnerSearchRequest(query, request),
        rpcOptions,
      );
    }
    return {
      results: ownerResponse.threads.map((thread) => ({
        ref: buildFederatedThreadRef({
          backend: thread.source,
          instanceId: peer.instanceId,
          threadId: thread.id,
        }),
        thread,
        instanceLabel: peer.label,
        peerStatus: peer.status,
        score: scoreThread(thread, query),
      })),
      totalCount: ownerResponse.totalCount,
      truncated: ownerResponse.truncated,
    };
  }
}

function searchLimit(limit: number | undefined): number {
  return Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.floor(limit!), 200))
    : 50;
}

function buildOwnerSearchRequest(
  query: string,
  request: FederatedSearchRequest,
): FederationThreadSearchRequest {
  return {
    query,
    limit: searchLimit(request.limit),
    ...(request.backend !== undefined ? { backend: request.backend } : {}),
    ...(request.includeArchived !== undefined
      ? { includeArchived: request.includeArchived }
      : {}),
    ...(request.projectKeys !== undefined
      ? { projectKeys: request.projectKeys }
      : {}),
    ...(request.updatedAfter !== undefined
      ? { updatedAfter: request.updatedAfter }
      : {}),
    ...(request.updatedBefore !== undefined
      ? { updatedBefore: request.updatedBefore }
      : {}),
  };
}

export async function searchFederatedThreadsOnOwner(
  backendOperations: Pick<FederationBackendOperations, "listThreads">,
  request: FederationThreadSearchRequest,
  rpcOptions?: FederationRpcRequestOptions,
): Promise<FederationThreadSearchResponse> {
  const limit = searchLimit(request.limit);
  const query = request.query.trim();
  const threads = await listFederatedSearchThreads(
    backendOperations,
    request,
    rpcOptions,
  );
  const exact = looksLikeExactThreadId(query);
  const normalized = query.toLowerCase();
  const matches = threads.filter((thread) => exact
    ? thread.id.toLowerCase() === normalized
    : !query || scoreThread(thread, query) > 0 || thread.id.toLowerCase().includes(normalized));
  matches.sort(compareFederatedSearchThreads(query));
  checkSearchDeadline(rpcOptions);
  return {
    threads: matches.slice(0, limit),
    totalCount: matches.length,
    truncated: matches.length > limit,
  };
}

async function listFederatedSearchThreads(
  backendOperations: Pick<FederationBackendOperations, "listThreads">,
  request: FederatedSearchRequest,
  rpcOptions?: FederationRpcRequestOptions,
): Promise<AppServerThreadSummary[]> {
  const list = async (archived: boolean) => {
    checkSearchDeadline(rpcOptions);
    const listRequest = {
      backend: request.backend === "all" ? undefined : request.backend,
      archived,
    };
    return rpcOptions
      ? await backendOperations.listThreads(listRequest, rpcOptions)
      : await backendOperations.listThreads(listRequest);
  };
  const responses: AppServerListThreadsResponse[] = [await list(false)];
  if (request.includeArchived) {
    responses.push(await list(true));
  }
  const byIdentity = new Map<string, AppServerThreadSummary>();
  // Active membership wins if an old provider reports the same row in both lists.
  for (const thread of responses.slice().reverse().flatMap((response) => response.threads)) {
    byIdentity.set(buildThreadIdentityKey(thread.source, thread.id), thread);
  }
  return [...byIdentity.values()].filter((thread) => matchesFederatedSearchFilters(thread, request));
}

function checkSearchDeadline(options?: FederationRpcRequestOptions): void {
  if (options?.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
    throw new Error("Federated search deadline expired.");
  }
}

function matchesFederatedSearchFilters(
  thread: AppServerThreadSummary,
  request: FederatedSearchRequest,
): boolean {
  if (
    request.backend
    && request.backend !== "all"
    && thread.source !== request.backend
  ) {
    return false;
  }
  if (
    request.projectKeys?.length
    && (!thread.projectKey || !request.projectKeys.includes(thread.projectKey))
  ) {
    return false;
  }
  const updatedAt = thread.updatedAt ?? thread.createdAt ?? 0;
  if (request.updatedAfter !== undefined && updatedAt < request.updatedAfter) {
    return false;
  }
  if (request.updatedBefore !== undefined && updatedAt > request.updatedBefore) {
    return false;
  }
  return true;
}

function looksLikeExactThreadId(query: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(query)
    || /^session_[0-9a-z_-]{10,}$/i.test(query)
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    if (timer.unref) timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function scoreThread(thread: AppServerThreadSummary, query: string): number {
  if (!query) return 0;
  const normalized = query.toLowerCase();
  const title = thread.title.toLowerCase();
  const summary = thread.summary?.toLowerCase() ?? "";
  const directories = thread.linkedDirectories
    .map((directory) => `${directory.label} ${directory.path} ${directory.worktreePath ?? ""}`)
    .join(" ")
    .toLowerCase();
  let score = 0;
  if (title === normalized) score += 1_000;
  if (title.startsWith(normalized)) score += 500;
  if (title.includes(normalized)) score += 250;
  if (summary.includes(normalized)) score += 100;
  if (directories.includes(normalized)) score += 50;
  if (thread.projectKey?.toLowerCase().includes(normalized)) score += 50;
  return score;
}

function compareFederatedSearchThreads(query: string) {
  return (
    left: AppServerThreadSummary,
    right: AppServerThreadSummary,
  ): number => {
    const scoreDifference = scoreThread(right, query) - scoreThread(left, query);
    if (scoreDifference !== 0) return scoreDifference;
    return (
      (right.updatedAt ?? right.createdAt ?? 0)
      - (left.updatedAt ?? left.createdAt ?? 0)
    );
  };
}
