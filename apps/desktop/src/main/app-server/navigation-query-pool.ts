import type { FederationTarget, NavigationIdentity, NavigationQueryPage, NavigationQueryRequest, NavigationSelectedDetailResponse,
  NavigationLaunchpadConfigResponse, NavigationQueueProjection, ListScheduledThreadActionsResponse } from "@pwragent/shared";
import { NAVIGATION_QUERY_MAX_RESULT_BYTES } from "@pwragent/shared";
import { navigationQueryKey } from "./navigation-query-projection";
import { NavigationQueryError } from "./navigation-query-store";

const MAX_QUERIES = 8;
const MAX_EXACT_RESOURCES = 32;
const MAX_RETAINED_BYTES = 64 * 1024 * 1024;
const MAX_ACTIVE_READS = 8;
const DEADLINE_MS = 10_000;
const MAX_PENDING_READS = 256;
const MAX_CONSUMERS = 256;

type ExactResources = {
  detail: NavigationSelectedDetailResponse;
  launchpad: NavigationLaunchpadConfigResponse;
  queue: NavigationQueueProjection;
  scheduled: ListScheduledThreadActionsResponse;
};
type Result = NavigationQueryPage | ExactResources[keyof ExactResources];
type Load<T extends Result> = (options: { signal: AbortSignal; deadlineAt: number }) => Promise<T>;
type Read = {
  controller: AbortController;
  promise: Promise<Result>;
};

type Query = {
  kind: "query" | keyof ExactResources;
  ownerKey: string;
  threadKey?: string;
  active: boolean;
  invalidationSequence: number;
  consumers: Set<string>;
  pages: Map<string, { page: Result; bytes: number }>;
  reads: Map<string, Read>;
};

function ownerKey(target?: FederationTarget): string {
  return JSON.stringify(target?.scope === "remote" ? ["remote", target.instanceId] : ["local"]);
}

/** Process-owned query admission and cancellation shared by native windows. */
export class NavigationQueryPool {
  private readonly queries = new Map<string, Query>();
  private readonly wakeups = new Set<() => void>();
  private readonly admissions = new Map<string, Set<AbortController>>();
  private readonly consumerKeys = new Map<string, string>();
  private activeReads = 0;
  private pendingReads = 0;
  private retainedBytes = 0;

  async read(params: {
    consumerId: string;
    /** Authenticated owner-side request scope; never taken from query payloads. */
    scopeKey?: string;
    request: NavigationQueryRequest;
    load: Load<NavigationQueryPage>;
  }): Promise<NavigationQueryPage> {
    return this.readOperation({
      ...params,
      kind: "query",
      ownerKey: ownerKey(params.request.federationTarget),
      key: JSON.stringify(["query", params.scopeKey ?? "renderer", params.request.federationTarget ?? { scope: "local" }, navigationQueryKey(params.request)]),
      operationKey: JSON.stringify([params.request.cursor ?? null, params.request.anchor ?? null,
        params.request.completeBaselineRevision ?? null, params.request.retainedRange ?? null, params.request.pageSize ?? 100]),
      deadlineAt: params.request.deadlineAt,
    });
  }

  readExact<K extends keyof ExactResources>(params: {
    kind: K;
    consumerId: string;
    scopeKey?: string;
    owner?: FederationTarget;
    ref?: NavigationIdentity;
    /** Includes the explicit owner and exact identity, without conditional revision or cursor. */
    identity: string;
    operation: string;
    deadlineAt?: number;
    load: Load<ExactResources[K]>;
  }): Promise<ExactResources[K]> {
    return this.readOperation({ ...params, ownerKey: ownerKey(params.owner),
      threadKey: params.ref ? JSON.stringify([params.ref.backend, params.ref.threadId]) : undefined,
      key: JSON.stringify([params.kind, params.scopeKey ?? "renderer", ownerKey(params.owner), params.identity]), operationKey: params.operation });
  }

  private async readOperation<T extends Result>(params: {
    kind: Query["kind"];
    ownerKey: string;
    threadKey?: string;
    consumerId: string;
    key: string;
    operationKey: string;
    deadlineAt?: number;
    load: Load<T>;
  }): Promise<T> {
    const consumers = new Set(this.consumerKeys.keys());
    const pendingAdmissions = [...this.admissions.values()].reduce((count, entries) => count + entries.size, 0);
    if ((!consumers.has(params.consumerId) && consumers.size >= MAX_CONSUMERS)
      || this.pendingReads + pendingAdmissions >= MAX_PENDING_READS) {
      throw new NavigationQueryError("navigation_busy", "Navigation demand budget is occupied.");
    }
    if (params.deadlineAt !== undefined && !Number.isFinite(params.deadlineAt)) {
      throw new NavigationQueryError("navigation_invalid_request", "Navigation deadline must be finite.");
    }
    const deadlineAt = Math.min(params.deadlineAt ?? Infinity, Date.now() + DEADLINE_MS);
    if (deadlineAt <= Date.now()) throw new NavigationQueryError("navigation_busy", "Navigation read deadline expired.");
    const admission = new AbortController();
    const admissions = this.admissions.get(params.consumerId) ?? new Set<AbortController>();
    admissions.add(admission);
    this.admissions.set(params.consumerId, admissions);
    const key = params.key;
    this.consumerKeys.set(params.consumerId, key);
    // One consumer token owns one canonical query. Changing a search or exact
    // selection releases the previous query instead of retaining every edit.
    for (const [otherKey, other] of this.queries) {
      if (otherKey === key || !other.consumers.delete(params.consumerId)) continue;
      if (other.consumers.size === 0) {
        for (const read of other.reads.values()) read.controller.abort();
      }
    }
    let query = this.queries.get(key);
    try {
      while (!query) {
        this.evictUnused();
        const isQuery = params.kind === "query";
        let occupied = [...this.queries.values()].filter((entry) => (entry.kind === "query") === isQuery).length;
        if (occupied >= (isQuery ? MAX_QUERIES : MAX_EXACT_RESOURCES)) {
          // Mounted views own their displayed pages and owner cursors. An idle
          // process cache entry must not reserve admission for their lifetime.
          // Preserve consumer leases separately so eviction cannot bypass the
          // consumer budget or cancel physical work still in progress.
          for (const [idleKey, idle] of this.queries) {
            if ((idle.kind === "query") !== isQuery || idle.active || idle.reads.size) continue;
            for (const page of idle.pages.values()) this.retainedBytes -= page.bytes;
            this.queries.delete(idleKey);
            occupied -= 1;
            break;
          }
        }
        if (occupied < (isQuery ? MAX_QUERIES : MAX_EXACT_RESOURCES)) {
          query = { kind: params.kind, ownerKey: params.ownerKey, threadKey: params.threadKey,
            active: false, invalidationSequence: 0, consumers: new Set(), pages: new Map(), reads: new Map() };
          this.queries.set(key, query);
          break;
        }
        await this.waitForCapacity(deadlineAt, admission.signal);
        query = this.queries.get(key);
      }
    } finally {
      admissions.delete(admission);
      if (admissions.size === 0) this.admissions.delete(params.consumerId);
    }
    query.consumers.add(params.consumerId);
    const operationKey = params.operationKey;
    const pending = query.reads.get(operationKey);
    // Keys are constructed by the typed public entry points and partition result kinds.
    if (pending && !pending.controller.signal.aborted) {
      this.pendingReads += 1;
      // An early waiter deadline does not detach its Promise continuation.
      // Keep that backing charged until the shared logical read settles.
      const release = (): void => { this.pendingReads -= 1; this.wake(); };
      void pending.promise.then(release, release);
      return this.waitForRead(pending.promise, deadlineAt) as Promise<T>;
    }
    const controller = new AbortController();
    const retainedQuery = query;
    this.pendingReads += 1;
    const promise = this.fetch({
      controller,
      deadlineAt,
      load: params.load,
      operationKey,
      query: retainedQuery,
    }).finally(() => {
      this.pendingReads -= 1;
      if (retainedQuery.reads.get(operationKey)?.promise === promise) retainedQuery.reads.delete(operationKey);
      this.evictUnused();
      this.wake();
    });
    query.reads.set(operationKey, { controller, promise });
    return promise;
  }

  invalidateQueryOwner(target?: FederationTarget): void {
    const owner = ownerKey(target);
    for (const query of this.queries.values()) {
      if (query.kind !== "query" || query.ownerKey !== owner) continue;
      // A post-event refresh may join an older physical read. Replace its
      // result under the original deadline before satisfying either reader.
      query.invalidationSequence += 1;
      for (const page of query.pages.values()) this.retainedBytes -= page.bytes;
      query.pages.clear();
    }
    this.wake();
  }

  invalidateExactOwner(target?: FederationTarget, ref?: NavigationIdentity): void {
    const owner = ownerKey(target);
    const thread = ref ? JSON.stringify([ref.backend, ref.threadId]) : undefined;
    for (const query of this.queries.values()) {
      if (query.kind === "query" || query.ownerKey !== owner) continue;
      if (thread && query.threadKey !== thread) continue;
      // Canonical changes invalidate the result, not the consumer's demand.
      // Finish the physical read and replace it under its existing deadline;
      // otherwise ordinary owner events reject all mounted configuration/FIFO
      // readers as though the operator had cancelled them.
      query.invalidationSequence += 1;
      for (const page of query.pages.values()) this.retainedBytes -= page.bytes;
      query.pages.clear();
    }
    this.wake();
  }

  release(consumerId: string): void {
    this.consumerKeys.delete(consumerId);
    for (const admission of this.admissions.get(consumerId) ?? []) admission.abort();
    for (const query of this.queries.values()) {
      query.consumers.delete(consumerId);
      if (query.consumers.size === 0) {
        for (const read of query.reads.values()) read.controller.abort();
      }
    }
    this.evictUnused();
    this.wake();
  }

  getBudgetUsage(): { queries: number; exactResources: number; retainedBytes: number; activeReads: number } {
    const queries = [...this.queries.values()].filter((query) => query.kind === "query").length;
    return { queries, exactResources: this.queries.size - queries, retainedBytes: this.retainedBytes, activeReads: this.activeReads };
  }

  private async fetch<T extends Result>(params: {
    controller: AbortController;
    deadlineAt: number;
    load: Load<T>;
    operationKey: string;
    query: Query;
  }): Promise<T> {
    const { signal } = params.controller;
    // A query has one owner read, including requests for different pages.
    while (this.activeReads >= MAX_ACTIVE_READS || params.query.active) {
      await this.waitForCapacity(params.deadlineAt, signal);
    }
    signal.throwIfAborted();
    this.activeReads += 1;
    params.query.active = true;
    const timer = setTimeout(() => params.controller.abort(),
      Math.max(0, params.deadlineAt - Date.now()));
    const completion = (async () => {
      let page: T;
      for (;;) {
        const sequence = params.query.invalidationSequence;
        page = await params.load({ signal, deadlineAt: params.deadlineAt });
        signal.throwIfAborted();
        if (Date.now() >= params.deadlineAt) {
          throw new NavigationQueryError("navigation_busy", "Navigation read deadline expired.");
        }
        if (sequence === params.query.invalidationSequence) break;
      }
      const bytes = Buffer.byteLength(JSON.stringify(page), "utf8");
      if (bytes > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
        throw new NavigationQueryError("navigation_item_too_large", "Navigation page exceeds its result budget.");
      }
      if ("unchanged" in page && page.unchanged) return page;
      // Exact consumers retain their own complete revision. The process pool
      // needs only the latest admitted result, not every conditional revision
      // or FIFO cursor visited during an open window's lifetime.
      if (params.query.kind !== "query") {
        for (const previous of params.query.pages.values()) this.retainedBytes -= previous.bytes;
        params.query.pages.clear();
      }
      const previous = params.query.pages.get(params.operationKey);
      this.evictUnused(params.query);
      if (this.retainedBytes - (previous?.bytes ?? 0) + bytes > MAX_RETAINED_BYTES) {
        throw new NavigationQueryError("navigation_busy", "Navigation page pool exceeds its retained budget.");
      }
      this.retainedBytes += bytes - (previous?.bytes ?? 0);
      params.query.pages.set(params.operationKey, { page, bytes });
      return page;
    })().finally(() => {
      clearTimeout(timer);
      this.activeReads -= 1;
      params.query.active = false;
      this.evictUnused();
      this.wake();
    });
    // Return by the deadline even if a local provider ignores cancellation.
    // Its physical slot remains occupied until that provider actually settles.
    return this.waitForRead(completion, params.deadlineAt, signal);
  }

  private waitForRead<T extends Result>(
    promise: Promise<T>,
    deadlineAt: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const cancel = (): void => reject(new NavigationQueryError("navigation_busy", "Navigation read cancelled or its deadline expired."));
      const timer = setTimeout(cancel, Math.max(0, deadlineAt - Date.now()));
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      promise.then(resolve, reject).finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      });
    });
  }

  private evictUnused(except?: Query): void {
    for (const [key, query] of this.queries) {
      if (query === except || query.consumers.size > 0 || query.reads.size > 0 || query.active) continue;
      for (const page of query.pages.values()) this.retainedBytes -= page.bytes;
      this.queries.delete(key);
    }
  }

  private wake(): void {
    for (const wakeup of this.wakeups) wakeup();
  }

  private waitForCapacity(deadlineAt: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (deadlineAt <= Date.now()) {
      return Promise.reject(new NavigationQueryError("navigation_busy", "Navigation admission deadline expired."));
    }
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.wakeups.delete(wake);
        signal?.removeEventListener("abort", abort);
      };
      const wake = (): void => { cleanup(); resolve(); };
      const abort = (): void => { cleanup(); reject(signal?.reason); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new NavigationQueryError("navigation_busy", "Navigation admission deadline expired."));
      }, deadlineAt - Date.now());
      this.wakeups.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

let desktopNavigationQueryPool: NavigationQueryPool | undefined;

/** Native windows and owner-local query consumers share physical admission and backing. */
export function getDesktopNavigationQueryPool(): NavigationQueryPool {
  return desktopNavigationQueryPool ??= new NavigationQueryPool();
}
