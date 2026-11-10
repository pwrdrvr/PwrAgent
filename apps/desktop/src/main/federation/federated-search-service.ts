export { searchFederatedThreadsOnOwner } from "@pwragent/owner-core/federated-search";
import { searchFederatedThreadsOnOwner, scoreThread } from "@pwragent/owner-core/federated-search";
import type {
  FederatedSearchRequest,
  FederatedSearchResponse,
  FederationInstanceId,
  FederationPeerSummary,
  FederationThreadSearchRequest,
  FederationThreadSearchResponse,
} from "@pwragent/shared";
import {
  buildFederatedThreadRef, parseThreadSearchQuery, matchesThreadSearchProjects,
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
    // Older peers may treat mentions as text. Never admit an out-of-scope hit.
    const projects = parseThreadSearchQuery(query).projects;
    const scopedThreads = ownerResponse.threads.filter((thread) =>
      matchesThreadSearchProjects(thread, projects),
    );
    return {
      results: scopedThreads.map((thread) => ({
        ref: buildFederatedThreadRef({
          backend: thread.source,
          threadId: thread.id,
        }),
        thread,
        instanceLabel: "This Mac",
        score: scoreThread(thread, query),
      })),
      totalCount: scopedThreads.length === ownerResponse.threads.length
        ? ownerResponse.totalCount
        : scopedThreads.length,
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
      throw new Error("Upgrade this PwrAgent peer and its gateways: bounded federated search is required.");
    }
    // Older peers may treat mentions as text. Never admit an out-of-scope hit.
    const projects = parseThreadSearchQuery(query).projects;
    const scopedThreads = ownerResponse.threads.filter((thread) =>
      matchesThreadSearchProjects(thread, projects),
    );
    return {
      results: scopedThreads.map((thread) => ({
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
      totalCount: scopedThreads.length === ownerResponse.threads.length
        ? ownerResponse.totalCount
        : scopedThreads.length,
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
