import type { NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import { NAVIGATION_QUERY_MAX_RESULT_BYTES } from "@pwragent/shared";
import { navigationQueryKey } from "./navigation-query-projection";
import { NavigationQueryError } from "./navigation-query-store";

const MAX_QUERIES = 8;
const MAX_RETAINED_BYTES = 64 * 1024 * 1024;
const MAX_ACTIVE_READS = 8;
const DEADLINE_MS = 10_000;
const MAX_PENDING_READS = 256;
const MAX_CONSUMERS = 256;

type Read = {
  controller: AbortController;
  promise: Promise<NavigationQueryPage>;
};

type Query = {
  active: boolean;
  consumers: Set<string>;
  pages: Map<string, { page: NavigationQueryPage; bytes: number }>;
  reads: Map<string, Read>;
};

/** Process-owned query admission and cancellation shared by native windows. */
export class NavigationQueryPool {
  private readonly queries = new Map<string, Query>();
  private readonly wakeups = new Set<() => void>();
  private readonly admissions = new Map<string, Set<AbortController>>();
  private activeReads = 0;
  private pendingReads = 0;
  private retainedBytes = 0;

  async read(params: {
    consumerId: string;
    request: NavigationQueryRequest;
    load: (options: { signal: AbortSignal; deadlineAt: number }) => Promise<NavigationQueryPage>;
  }): Promise<NavigationQueryPage> {
    const consumers = new Set(this.admissions.keys());
    for (const query of this.queries.values()) {
      for (const consumer of query.consumers) consumers.add(consumer);
    }
    if ((!consumers.has(params.consumerId) && consumers.size >= MAX_CONSUMERS)
      || this.pendingReads >= MAX_PENDING_READS) {
      throw new NavigationQueryError("navigation_busy", "Navigation demand budget is occupied.");
    }
    if (params.request.deadlineAt !== undefined && !Number.isFinite(params.request.deadlineAt)) {
      throw new NavigationQueryError("navigation_invalid_request", "Navigation deadline must be finite.");
    }
    const deadlineAt = Math.min(params.request.deadlineAt ?? Infinity, Date.now() + DEADLINE_MS);
    if (deadlineAt <= Date.now()) throw new NavigationQueryError("navigation_busy", "Navigation read deadline expired.");
    const admission = new AbortController();
    const admissions = this.admissions.get(params.consumerId) ?? new Set<AbortController>();
    admissions.add(admission);
    this.admissions.set(params.consumerId, admissions);
    const key = JSON.stringify([
      params.request.federationTarget ?? { scope: "local" },
      navigationQueryKey(params.request),
    ]);
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
        if (this.queries.size < MAX_QUERIES) {
          query = { active: false, consumers: new Set(), pages: new Map(), reads: new Map() };
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
    const operationKey = JSON.stringify([
      params.request.cursor ?? null,
      params.request.completeBaselineRevision ?? null,
      params.request.pageSize ?? 100,
    ]);
    const pending = query.reads.get(operationKey);
    if (pending) return this.waitForRead(pending.promise, deadlineAt);
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
      retainedQuery.reads.delete(operationKey);
      this.wake();
    });
    query.reads.set(operationKey, { controller, promise });
    return promise;
  }

  release(consumerId: string): void {
    for (const admission of this.admissions.get(consumerId) ?? []) admission.abort();
    for (const query of this.queries.values()) {
      query.consumers.delete(consumerId);
      if (query.consumers.size === 0) {
        for (const read of query.reads.values()) read.controller.abort();
      }
    }
    this.wake();
  }

  getBudgetUsage(): { queries: number; retainedBytes: number; activeReads: number } {
    return { queries: this.queries.size, retainedBytes: this.retainedBytes, activeReads: this.activeReads };
  }

  private async fetch(params: {
    controller: AbortController;
    deadlineAt: number;
    load: (options: { signal: AbortSignal; deadlineAt: number }) => Promise<NavigationQueryPage>;
    operationKey: string;
    query: Query;
  }): Promise<NavigationQueryPage> {
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
      const page = await params.load({ signal, deadlineAt: params.deadlineAt });
      signal.throwIfAborted();
      if (page.unchanged) return page;
      const bytes = Buffer.byteLength(JSON.stringify(page), "utf8");
      if (bytes > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
        throw new NavigationQueryError("navigation_item_too_large", "Navigation page exceeds its result budget.");
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
      this.wake();
    });
    // Return by the deadline even if a local provider ignores cancellation.
    // Its physical slot remains occupied until that provider actually settles.
    return this.waitForRead(completion, params.deadlineAt, signal);
  }

  private waitForRead(
    promise: Promise<NavigationQueryPage>,
    deadlineAt: number,
    signal?: AbortSignal,
  ): Promise<NavigationQueryPage> {
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
