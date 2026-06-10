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
  backend: Pick<FederationBackendOperations, "listThreads">;
};

export type FederatedSearchLocalBackend = Pick<
  FederationBackendOperations,
  "listThreads"
>;

export class FederatedSearchService {
  constructor(
    private readonly options: {
      local: FederatedSearchLocalBackend;
      peers: () => readonly FederatedSearchPeer[];
      now?: () => number;
    },
  ) {}

  async search(request: FederatedSearchRequest): Promise<FederatedSearchResponse> {
    const query = request.query.trim();
    const limit = Math.max(1, Math.min(request.limit ?? 50, 200));
    const searchedAt = this.options.now?.() ?? Date.now();
    const failures: FederatedSearchResponse["failures"] = [];
    const resultGroups = await Promise.all([
      this.searchLocal(query),
      ...this.options.peers().map(async (peer) => {
        try {
          return await this.searchPeer(peer, query);
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
    };
  }

  private async searchLocal(query: string): Promise<FederatedSearchResponse["results"]> {
    const response = await this.options.local.listThreads({ filter: query });
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
  ): Promise<FederatedSearchResponse["results"]> {
    const response: AppServerListThreadsResponse = await peer.backend.listThreads({
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
