import type { FederationContentSearchRequest, ThreadSearchRequest, ThreadSearchResponse } from "@pwragent/shared";
import type { FederationRpcRequestOptions } from "../federation/federation-rpc";
import { awaitThreadSearchRead } from "./thread-search-cancellation";

/** Requester-scoped cancellation; no retained results, index, or background job. */
export class OwnerContentSearch {
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly search: (request: ThreadSearchRequest, signal: AbortSignal) => Promise<ThreadSearchResponse>) {}

  async run(request: FederationContentSearchRequest, options: FederationRpcRequestOptions = {}): Promise<ThreadSearchResponse> {
    const key = this.key(request.searchId, options);
    if (this.running.has(key)) throw new Error("Content search is already running.");
    const controller = new AbortController();
    if (options.deadlineAt !== undefined && options.deadlineAt <= Date.now()) {
      throw new Error("Content search timed out.");
    }
    this.running.set(key, controller);
    const timer = setTimeout(() => controller.abort(new Error("Content search timed out.")),
      Math.max(0, (options.deadlineAt ?? Date.now() + 120_000) - Date.now()));
    timer.unref();
    try {
      return await awaitThreadSearchRead(() => this.search(request.request, controller.signal), controller.signal);
    } finally {
      clearTimeout(timer);
      this.running.delete(key);
    }
  }

  cancel(searchId: string, options: FederationRpcRequestOptions = {}): void {
    this.running.get(this.key(searchId, options))?.abort(new Error("Content search cancelled."));
  }

  private key(searchId: string, options: FederationRpcRequestOptions): string {
    if (typeof searchId !== "string" || !searchId || searchId.length > 128) {
      throw new Error("Invalid content search id.");
    }
    if (!options.requesterInstanceId) throw new Error("Content search requires an authenticated requester.");
    return JSON.stringify([options.requesterInstanceId, searchId]);
  }
}
