import type {
  AppServerListThreadsResponse,
  AppServerThreadSummary,
  FederatedSearchRequest,
  FederatedSearchResponse,
  FederationInstanceId,
  FederationPeerSummary,
} from "@pwragent/shared";
import {
  buildFederatedThreadRef,
  buildThreadIdentityKey,
} from "@pwragent/shared";
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
        : [this.searchLocal(query, request)]),
      ...this.options.peers().map(async (peer) => {
        try {
          const peerResults = await withTimeout(
            this.searchPeer(peer, query, request),
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
    const matches = resultGroups
      .flat()
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return (right.thread.updatedAt ?? 0) - (left.thread.updatedAt ?? 0);
      });
    const results = matches.slice(0, limit);

    return {
      query,
      searchedAt,
      results,
      totalCount: matches.length,
      truncated: matches.length > limit,
      failures,
      searchedInstances,
    };
  }

  private async searchLocal(
    query: string,
    request: FederatedSearchRequest,
  ): Promise<FederatedSearchResponse["results"]> {
    const resolved = await this.resolveExactThreadId(
      this.options.local,
      query,
      request,
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
    const threads = await listFederatedSearchThreads(
      this.options.local,
      query,
      request,
    );
    return threads.map((thread) => ({
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
    request: FederatedSearchRequest,
  ): Promise<FederatedSearchResponse["results"]> {
    const resolved = await this.resolveExactThreadId(
      peer.backend,
      query,
      request,
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
    const threads = await listFederatedSearchThreads(
      peer.backend,
      query,
      request,
    );
    return threads.map((thread) => ({
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
    request: FederatedSearchRequest,
  ): Promise<AppServerThreadSummary | null | undefined> {
    if (
      !backendOperations.resolveThread
      || !looksLikeExactThreadId(query)
    ) {
      return undefined;
    }
    try {
      const response = await backendOperations.resolveThread({
        ...(request.backend && request.backend !== "all"
          ? { backend: request.backend }
          : {}),
        threadId: query,
      });
      if (
        response.thread
        && matchesFederatedSearchFilters(response.thread, request)
      ) {
        return response.thread;
      }
      if (!request.includeArchived) {
        return null;
      }
    } catch {
      // Mixed-version peers may not expose the exact lookup RPC yet. Fall
      // through to exact list scans rather than using fuzzy UUID filtering.
    }
    const threads = await listFederatedSearchThreads(
      backendOperations,
      "",
      request,
    );
    return threads.find((thread) => thread.id === query) ?? null;
  }
}

async function listFederatedSearchThreads(
  backendOperations: FederatedSearchPeer["backend"],
  query: string,
  request: FederatedSearchRequest,
): Promise<AppServerThreadSummary[]> {
  const list = async (archived: boolean) =>
    await backendOperations.listThreads({
      backend: request.backend === "all" ? undefined : request.backend,
      archived,
      ...(query ? { filter: query } : {}),
    });
  const responses: AppServerListThreadsResponse[] = [await list(false)];
  if (request.includeArchived) {
    responses.push(await list(true));
  }
  const byIdentity = new Map<string, AppServerThreadSummary>();
  for (const thread of responses.flatMap((response) => response.threads)) {
    if (matchesFederatedSearchFilters(thread, request)) {
      byIdentity.set(buildThreadIdentityKey(thread.source, thread.id), thread);
    }
  }
  return [...byIdentity.values()];
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
  return score;
}
