import { randomUUID } from "node:crypto";
import {
  buildFederatedThreadRef,
  federatedThreadIdentityKey,
  normalizeThreadSearchLimit,
  type ThreadSearchRequest,
  type ThreadSearchResponse,
  type ThreadSearchRemoteInstance,
} from "@pwragent/shared";
import type { FederationBackendOperations } from "./federation-backend-bridge";
import { hasFederationErrorCode } from "./federation-rpc";

export type ContentSearchPeer = {
  instanceId: string;
  label: string;
  backend: Pick<Required<FederationBackendOperations>, "searchThreadContent" | "cancelThreadContentSearch">;
};

/** Run the same search on each owner, publishing each answer independently. */
export async function searchFederatedContent(options: {
  request: ThreadSearchRequest;
  local: (request: ThreadSearchRequest, signal?: AbortSignal) => Promise<ThreadSearchResponse>;
  peers: ContentSearchPeer[];
  signal?: AbortSignal;
  onProgress?: (response: ThreadSearchResponse) => void;
}): Promise<ThreadSearchResponse> {
  const { request, signal } = options;
  const searchId = randomUUID();
  const answers = new Map<string, ThreadSearchResponse>();
  const instances = new Map<string, ThreadSearchRemoteInstance>(options.peers.map((peer) => [peer.instanceId, {
    instanceId: peer.instanceId, instanceLabel: peer.label, resultCount: 0, searching: true,
  }]));
  const failures: ThreadSearchResponse["unavailableScopes"] = [];
  const snapshot = (): ThreadSearchResponse => {
    const local = answers.get("local");
    const responses = [...answers.values()];
    const results = responses.flatMap((response) => response.results).sort((left, right) =>
      right.score - left.score || (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    const limit = normalizeThreadSearchLimit(request.limit);
    return {
      backend: request.filters?.backend ?? "all", fetchedAt: Date.now(), query: request.query?.trim() ?? "",
      filters: request.filters ?? {}, contentMode: request.contentMode ?? "available",
      semanticMode: request.semanticMode ?? "disabled", ...local,
      results: results.slice(0, limit),
      searchedScopes: [...new Set(responses.flatMap((response) => response.searchedScopes))],
      unavailableScopes: [...failures, ...responses.flatMap((response) => response.unavailableScopes)],
      remoteInstances: [...instances.values()],
      truncated: results.length > limit || responses.some((response) => response.truncated),
    };
  };
  const publish = (): void => {
    if (!signal?.aborted) options.onProgress?.(snapshot());
  };
  signal?.throwIfAborted();
  await Promise.all([
    (async () => {
      try {
        answers.set("local", await options.local(request, signal));
      } catch (error) {
        if (!signal?.aborted) failures.push({ scope: "provider_content", reason: "error",
          message: `This instance: ${error instanceof Error ? error.message : String(error)}` });
      }
      publish();
    })(),
    ...options.peers.map(async (peer) => {
      const cancel = (): void => {
        void peer.backend.cancelThreadContentSearch({ searchId }).catch(() => undefined);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        signal?.throwIfAborted();
        const response = await peer.backend.searchThreadContent({ searchId, request }, {
          signal, deadlineAt: Date.now() + 120_000,
        });
        signal?.throwIfAborted();
        answers.set(peer.instanceId, {
          ...response,
          unavailableScopes: response.unavailableScopes.map((scope) => ({ ...scope, message: `${peer.label}: ${scope.message}` })),
          results: response.results.map((result) => {
            const ref = buildFederatedThreadRef({ backend: result.backend, threadId: result.threadId, instanceId: peer.instanceId });
            return { ...result, identityKey: federatedThreadIdentityKey(ref),
              federation: { ref, instanceLabel: peer.label } };
          }),
        });
        instances.set(peer.instanceId, { instanceId: peer.instanceId, instanceLabel: peer.label,
          resultCount: response.results.length });
      } catch (error) {
        if (signal?.aborted) return;
        const message = hasFederationErrorCode(error, "method_not_found")
          ? "Update PwrAgent on this instance to search message content."
          : error instanceof Error ? error.message : String(error);
        instances.set(peer.instanceId, { instanceId: peer.instanceId, instanceLabel: peer.label,
          resultCount: 0, failed: true, error: message });
        failures.push({ scope: "provider_content", reason: "error", message: `${peer.label}: ${message}` });
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
      publish();
    }),
  ]);
  signal?.throwIfAborted();
  return snapshot();
}
