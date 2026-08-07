import type {
  AppServerListThreadsResponse,
  AppServerThreadSummary,
  FederatedSearchRequest,
  FederatedSearchResponse,
  FederationInstanceId,
  FederationPeerSummary,
} from "@pwragent/shared";
import { buildFederatedThreadRef } from "@pwragent/shared";
import type { FederationBackendOperations } from "./federation-backend-bridge";

export type FederatedSearchPeer = {
  instanceId: FederationInstanceId;
  label: string;
  status?: FederationPeerSummary["status"];
  backend: Pick<FederationBackendOperations, "listThreads">
    & Partial<Pick<FederationBackendOperations, "resolveThread">>;
};

export type FederatedSearchLocalBackend = Pick<
  FederationBackendOperations,
  "listThreads"
> & Partial<Pick<FederationBackendOperations, "resolveThread">>;

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
    const limit = Math.max(1, Math.min(request.limit ?? 50, 200));
    const searchedAt = this.options.now?.() ?? Date.now();
    const failures: FederatedSearchResponse["failures"] = [];
    const searchedInstances: NonNullable<
      FederatedSearchResponse["searchedInstances"]
    > = [];
    const peerTimeoutMs =
      this.options.peerTimeoutMs ?? FEDERATED_SEARCH_PEER_TIMEOUT_MS;
    const resultGroups = await Promise.all([
      ...(this.options.includeLocal === false
        ? []
        : [this.searchLocal(query, request.backend)]),
      ...this.options.peers().map(async (peer) => {
        try {
          const peerResults = await withTimeout(
            this.searchPeer(peer, query, request.backend),
            peerTimeoutMs,
            `Federated search timed out after ${Math.round(peerTimeoutMs / 1000)}s.`,
          );
          searchedInstances.push({
            instanceId: peer.instanceId,
            instanceLabel: peer.label,
            resultCount: peerResults.length,
          });
          return peerResults;
        } catch (error) {
          failures.push({
            instanceId: peer.instanceId,
            instanceLabel: peer.label,
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      }),
    ]);
    const results = resultGroups
      .flat()
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return (right.thread.updatedAt ?? 0) - (left.thread.updatedAt ?? 0);
      })
      .slice(0, limit);

    return {
      query,
      searchedAt,
      results,
      failures,
      searchedInstances,
    };
  }

  private async searchLocal(
    query: string,
    backend?: FederatedSearchRequest["backend"],
  ): Promise<FederatedSearchResponse["results"]> {
    const resolved = await this.resolveExactThreadId(
      this.options.local,
      query,
      backend,
    );
    if (resolved !== undefined) {
      return resolved
        ? [{
            ref: buildFederatedThreadRef({
              backend: resolved.source,
              threadId: resolved.id,
            }),
            thread: resolved,
            instanceLabel: "This Mac",
            score: scoreThread(resolved, query),
          }]
        : [];
    }
    const response = await this.options.local.listThreads({
      backend: backend === "all" ? undefined : backend,
      filter: query,
    });
    return response.threads.map((thread) => ({
      ref: buildFederatedThreadRef({
        backend: thread.source,
        threadId: thread.id,
      }),
      thread,
      instanceLabel: "This Mac",
      score: scoreThread(thread, query),
    }));
  }

  private async searchPeer(
    peer: FederatedSearchPeer,
    query: string,
    backend?: FederatedSearchRequest["backend"],
  ): Promise<FederatedSearchResponse["results"]> {
    const resolved = await this.resolveExactThreadId(
      peer.backend,
      query,
      backend,
    );
    if (resolved !== undefined) {
      return resolved
        ? [{
            ref: buildFederatedThreadRef({
              backend: resolved.source,
              instanceId: peer.instanceId,
              threadId: resolved.id,
            }),
            thread: resolved,
            instanceLabel: peer.label,
            peerStatus: peer.status,
            score: scoreThread(resolved, query),
          }]
        : [];
    }
    const response: AppServerListThreadsResponse = await peer.backend.listThreads({
      backend: backend === "all" ? undefined : backend,
      filter: query,
    });
    return response.threads.map((thread) => ({
      ref: buildFederatedThreadRef({
        backend: thread.source,
        instanceId: peer.instanceId,
        threadId: thread.id,
      }),
      thread,
      instanceLabel: peer.label,
      peerStatus: peer.status,
      score: scoreThread(thread, query),
    }));
  }

  private async resolveExactThreadId(
    backendOperations: FederatedSearchPeer["backend"],
    query: string,
    backend?: FederatedSearchRequest["backend"],
  ): Promise<AppServerThreadSummary | null | undefined> {
    if (
      !backendOperations.resolveThread
      || !looksLikeExactThreadId(query)
    ) {
      return undefined;
    }
    try {
      const response = await backendOperations.resolveThread({
        ...(backend && backend !== "all" ? { backend } : {}),
        threadId: query,
      });
      return response.thread ?? null;
    } catch {
      // Mixed-version peers may not expose the exact lookup RPC yet. Avoid
      // their provider's fuzzy UUID filter and scan the active list exactly.
      const response = await backendOperations.listThreads({
        backend: backend === "all" ? undefined : backend,
      });
      return response.threads.find((thread) => thread.id === query) ?? null;
    }
  }
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
  if (!query) return thread.updatedAt ?? thread.createdAt ?? 0;
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
  score += Math.min(thread.updatedAt ?? thread.createdAt ?? 0, 9_999_999_999) / 1_000_000;
  return score;
}
