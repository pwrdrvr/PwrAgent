import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { NavigationDiagnosticCause } from "../../shared/navigation-diagnostic-cause";
import { listingDiagnostics, listingRequestFields } from "../diagnostics/listing-diagnostics";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type {
  NavigationIdentity,
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationSelectedDetailResponse,
  NavigationLaunchpadConfigResponse,
  NavigationQueueProjection,
} from "@pwragent/shared/contracts/navigation";
import type { ListScheduledThreadActionsResponse } from "@pwragent/shared/contracts/scheduled-thread-actions";
import { NAVIGATION_QUERY_MAX_RESULT_BYTES } from "@pwragent/shared/contracts/navigation";
import { navigationQueryPageBudgetBytes } from "@pwragent/shared/navigation-remote-owner";
import { navigationQueryKey } from "@pwragent/owner-core/navigation-query-projection";
import { getMainLogger } from "../log";
import { NavigationQueryError } from "./navigation-query-store";

const MAX_QUERIES = 8;
const MAX_EXACT_RESOURCES = 32;
const MAX_RETAINED_BYTES = 64 * 1024 * 1024;
const MAX_ACTIVE_READS = 8;
const DEADLINE_MS = 10_000;
const MAX_PENDING_READS = 256;
const MAX_CONSUMERS = 256;
const DEFAULT_SLOW_READ_THRESHOLD_MS = 2_000;
const BUSY_WARNING_COOLDOWN_MS = 1_000;
const navigationPoolLog = getMainLogger("pwragent:navigation-pool");

export type NavigationQueryPoolOptions = {
  slowReadThresholdMs?: number;
  onDiagnosticWarning?: (message: string, fields: Record<string, unknown>) => void;
};

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
  /** The invalidation sequence its load began under; unset while it waits for admission. */
  loadedAt?: number;
};

type Query = {
  kind: "query" | keyof ExactResources;
  ownerKey: string;
  threadKey?: string;
  active: boolean;
  invalidationSequence: number;
  consumers: Set<string>;
  pages: Map<string, { page: Result; bytes: number }>;
  /** The read each operation's new readers join. */
  reads: Map<string, Read>;
  /** Reads an invalidation overtook. They finish only for the readers they already have. */
  overtaken: Set<Read>;
};

function readsOf(query: Query): Read[] {
  return [...query.reads.values(), ...query.overtaken];
}

function ownerKey(target?: FederationTarget): string {
  return JSON.stringify(target?.scope === "remote" ? ["remote", target.instanceId] : ["local"]);
}

function navigationReadCancelled(): NavigationQueryError {
  // Capacity waiters and throwIfAborted propagate the signal reason directly,
  // before waitForRead can translate cancellation for the quiet IPC path.
  return new NavigationQueryError("navigation_busy", "Navigation read cancelled or its deadline expired.");
}

/** Process-owned query admission and cancellation shared by native windows. */
export class NavigationQueryPool {
  private readonly queries = new Map<string, Query>();
  private readonly wakeups = new Set<() => void>();
  private readonly admissions = new Map<string, Set<AbortController>>();
  private readonly consumerKeys = new Map<string, string>();
  private readonly slowReadThresholdMs: number;
  private readonly onDiagnosticWarning: (message: string, fields: Record<string, unknown>) => void;
  private lastBusyWarningAt = Number.NEGATIVE_INFINITY;
  private activeReads = 0;
  private pendingReads = 0;
  private retainedBytes = 0;

  constructor(options: NavigationQueryPoolOptions = {}) {
    this.slowReadThresholdMs = options.slowReadThresholdMs ?? DEFAULT_SLOW_READ_THRESHOLD_MS;
    this.onDiagnosticWarning = options.onDiagnosticWarning
      ?? ((message, fields) => navigationPoolLog.warn(message, fields));
  }

  async read(params: {
    consumerId: string;
    /** Authenticated owner-side request scope; never taken from query payloads. */
    scopeKey?: string;
    request: NavigationQueryRequest;
    load: Load<NavigationQueryPage>;
  }): Promise<NavigationQueryPage> {
    return listingDiagnostics.trace("navigation", { ...listingRequestFields(params.request),
      ...(params.scopeKey?.startsWith("federation:") ? { source: "owner" as const } : {}),
    }, () => this.readOperation({
      ...params,
      kind: "query",
      queryKind: params.request.query.kind,
      consumer: params.request.consumer,
      ownerKey: ownerKey(params.request.federationTarget),
      key: JSON.stringify(["query", params.scopeKey ?? "renderer", params.request.federationTarget ?? { scope: "local" }, navigationQueryKey(params.request)]),
      operationKey: JSON.stringify([params.request.cursor ?? null, params.request.anchor ?? null,
        params.request.completeBaselineRevision ?? null, params.request.retainedRange ?? null, params.request.pageSize ?? 100]),
      deadlineAt: params.request.deadlineAt,
    }));
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
    return this.readOperation({ ...params, queryKind: params.kind, ownerKey: ownerKey(params.owner),
      threadKey: params.ref ? JSON.stringify([params.ref.backend, params.ref.threadId]) : undefined,
      key: JSON.stringify([params.kind, params.scopeKey ?? "renderer", ownerKey(params.owner), params.identity]), operationKey: params.operation });
  }

  private reportDiagnostic(
    message: "slow navigation query" | "navigation query busy",
    fields: Record<string, unknown>,
  ): void {
    if (message === "navigation query busy") {
      const now = Date.now();
      if (now - this.lastBusyWarningAt < BUSY_WARNING_COOLDOWN_MS) return;
      this.lastBusyWarningAt = now;
    }
    this.onDiagnosticWarning(message, fields);
  }

  private async readOperation<T extends Result>(params: {
    kind: Query["kind"];
    queryKind?: string;
    consumer?: string;
    ownerKey: string;
    threadKey?: string;
    consumerId: string;
    key: string;
    operationKey: string;
    deadlineAt?: number;
    load: Load<T>;
  }): Promise<T> {
    const startedAt = Date.now();
    const timing: { admittedAt?: number } = {};
    const diagnosticFields = (outcome: "ok" | "error", extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      kind: params.kind,
      ...(params.queryKind ? { queryKind: params.queryKind } : {}),
      ...(params.consumer ? { consumer: params.consumer } : {}),
      elapsedMs: Math.max(0, Date.now() - startedAt),
      ...(timing.admittedAt !== undefined ? { waitMs: Math.max(0, timing.admittedAt - startedAt) } : {}),
      activeReads: this.activeReads,
      pendingReads: this.pendingReads,
      queries: this.queries.size,
      outcome,
      ...extra,
    });
    const observe = <V>(work: Promise<V>, wasCancelledByConsumer: () => boolean): Promise<V> =>
      work.then((value) => {
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= this.slowReadThresholdMs) {
          this.reportDiagnostic("slow navigation query", diagnosticFields("ok"));
        }
        return value;
      }, (error: unknown) => {
        const elapsedMs = Date.now() - startedAt;
        if (error instanceof NavigationQueryError && error.code === "navigation_busy" && !wasCancelledByConsumer()) {
          this.reportDiagnostic("navigation query busy", diagnosticFields("error", { reason: error.message }));
        } else if (elapsedMs >= this.slowReadThresholdMs && !wasCancelledByConsumer()) {
          this.reportDiagnostic("slow navigation query", diagnosticFields("error"));
        }
        throw error;
      });
    const consumers = new Set(this.consumerKeys.keys());
    const pendingAdmissions = [...this.admissions.values()].reduce((count, entries) => count + entries.size, 0);
    if ((!consumers.has(params.consumerId) && consumers.size >= MAX_CONSUMERS)
      || this.pendingReads + pendingAdmissions >= MAX_PENDING_READS) {
      const error = new NavigationQueryError("navigation_busy", "Navigation demand budget is occupied.");
      this.reportDiagnostic("navigation query busy", diagnosticFields("error", { reason: error.message }));
      throw error;
    }
    if (params.deadlineAt !== undefined && !Number.isFinite(params.deadlineAt)) {
      throw new NavigationQueryError("navigation_invalid_request", "Navigation deadline must be finite.");
    }
    const deadlineAt = Math.min(params.deadlineAt ?? Infinity, Date.now() + DEADLINE_MS);
    if (deadlineAt <= Date.now()) {
      const error = new NavigationQueryError("navigation_busy", "Navigation read deadline expired.");
      this.reportDiagnostic("navigation query busy", diagnosticFields("error", { reason: error.message }));
      throw error;
    }
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
        for (const read of readsOf(other)) {
          if (other.kind === "query" && !read.controller.signal.aborted) listingDiagnostics.link("owner-page", "cancel", read.promise);
          read.controller.abort(navigationReadCancelled());
        }
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
            if ((idle.kind === "query") !== isQuery || idle.active || idle.reads.size || idle.overtaken.size) continue;
            for (const page of idle.pages.values()) this.retainedBytes -= page.bytes;
            this.queries.delete(idleKey);
            occupied -= 1;
            break;
          }
        }
        if (occupied < (isQuery ? MAX_QUERIES : MAX_EXACT_RESOURCES)) {
          query = { kind: params.kind, ownerKey: params.ownerKey, threadKey: params.threadKey,
            active: false, invalidationSequence: 0, consumers: new Set(), pages: new Map(), reads: new Map(), overtaken: new Set() };
          this.queries.set(key, query);
          break;
        }
        try {
          await this.waitForCapacity(deadlineAt, admission.signal);
        } catch (error) {
          if (error instanceof NavigationQueryError && error.code === "navigation_busy" && !admission.signal.aborted) {
            this.reportDiagnostic("navigation query busy", diagnosticFields("error", { reason: error.message }));
          }
          throw error;
        }
        query = this.queries.get(key);
      }
    } finally {
      admissions.delete(admission);
      if (admissions.size === 0) this.admissions.delete(params.consumerId);
    }
    timing.admittedAt = Date.now();
    query.consumers.add(params.consumerId);
    const consumerLeft = (): boolean => !query.consumers.has(params.consumerId);
    const operationKey = params.operationKey;
    let pending = query.reads.get(operationKey);
    // A read whose load began before an invalidation still finishes for the
    // readers it has. Later readers share one follow-up that starts after it,
    // so an operation has at most one read loading and one waiting.
    if (pending?.loadedAt !== undefined && pending.loadedAt !== query.invalidationSequence) {
      query.reads.delete(operationKey);
      query.overtaken.add(pending);
      pending = undefined;
    }
    // Keys are constructed by the typed public entry points and partition result kinds.
    if (pending && !pending.controller.signal.aborted) {
      if (params.kind === "query") listingDiagnostics.link("navigation", "coalesced", pending.promise);
      this.pendingReads += 1;
      // An early waiter deadline does not detach its Promise continuation.
      // Keep that backing charged until the shared logical read settles.
      const release = (): void => { this.pendingReads -= 1; this.wake(); };
      void pending.promise.then(release, release);
      return observe(this.waitForRead(pending.promise, deadlineAt) as Promise<T>, consumerLeft);
    }
    const read: Read = { controller: new AbortController(), promise: undefined as unknown as Promise<Result> };
    const retainedQuery = query;
    this.pendingReads += 1;
    const fetch = () => this.fetch({
      read,
      deadlineAt,
      load: params.load,
      operationKey,
      query: retainedQuery,
    });
    const execution = params.kind === "query" ? listingDiagnostics.trace("owner-page", {}, fetch) : fetch();
    const promise = execution.finally(() => {
      this.pendingReads -= 1;
      if (retainedQuery.reads.get(operationKey) === read) retainedQuery.reads.delete(operationKey);
      retainedQuery.overtaken.delete(read);
      this.evictUnused();
      this.wake();
    });
    read.promise = promise;
    if (params.kind === "query") listingDiagnostics.remember(promise, execution);
    query.reads.set(operationKey, read);
    return observe(promise as Promise<T>, consumerLeft);
  }

  invalidateQueryOwner(target?: FederationTarget, reason?: NavigationDiagnosticCause, trigger?: string, event?: AgentEvent): void {
    listingDiagnostics.record("navigation", "invalidate", { ...listingDiagnostics.launchFields(event, target?.scope === "remote" ? target.instanceId : undefined),
      reason, trigger, source: target?.scope === "remote" ? "remote" : "local" });
    const owner = ownerKey(target);
    for (const query of this.queries.values()) {
      if (query.kind !== "query" || query.ownerKey !== owner) continue;
      // A read already loading finishes for its own readers but stops
      // admitting new ones; a post-event refresh gets a read built after it.
      query.invalidationSequence += 1;
      for (const page of query.pages.values()) this.retainedBytes -= page.bytes;
      query.pages.clear();
    }
    this.wake();
  }

  invalidateExactOwner(target?: FederationTarget, ref?: NavigationIdentity, kind?: keyof ExactResources): void {
    const owner = ownerKey(target);
    const thread = ref ? JSON.stringify([ref.backend, ref.threadId]) : undefined;
    for (const query of this.queries.values()) {
      if (query.kind === "query" || query.ownerKey !== owner || (kind && query.kind !== kind)) continue;
      if (thread && query.threadKey !== thread) continue;
      // Canonical changes invalidate the result, not the consumer's demand.
      // A loading read still finishes for its readers rather than rejecting
      // mounted configuration/FIFO readers as though the operator had
      // cancelled them; readers admitted after the change get a new read.
      query.invalidationSequence += 1;
      for (const page of query.pages.values()) this.retainedBytes -= page.bytes;
      query.pages.clear();
    }
    this.wake();
  }

  release(consumerId: string): void {
    this.consumerKeys.delete(consumerId);
    for (const admission of this.admissions.get(consumerId) ?? []) admission.abort(navigationReadCancelled());
    for (const query of this.queries.values()) {
      query.consumers.delete(consumerId);
      if (query.consumers.size === 0) {
        for (const read of readsOf(query)) {
          if (query.kind === "query" && !read.controller.signal.aborted) listingDiagnostics.link("owner-page", "cancel", read.promise);
          read.controller.abort(navigationReadCancelled());
        }
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
    read: Read;
    deadlineAt: number;
    load: Load<T>;
    operationKey: string;
    query: Query;
  }): Promise<T> {
    const { signal } = params.read.controller;
    // A query has one owner read, including requests for different pages.
    while (this.activeReads >= MAX_ACTIVE_READS || params.query.active) {
      await this.waitForCapacity(params.deadlineAt, signal);
    }
    signal.throwIfAborted();
    this.activeReads += 1;
    params.query.active = true;
    const timer = setTimeout(() => {
      if (params.query.kind === "query") listingDiagnostics.record("owner-page", "cancel");
      params.read.controller.abort(navigationReadCancelled());
    },
      Math.max(0, params.deadlineAt - Date.now()));
    const completion = (async () => {
      params.read.loadedAt = params.query.invalidationSequence;
      const load = () => params.load({ signal, deadlineAt: params.deadlineAt });
      const page = await (params.query.kind === "query" ? listingDiagnostics.trace("owner-read", {}, load) : load());
      signal.throwIfAborted();
      const bytes = Buffer.byteLength(JSON.stringify(page), "utf8");
      // The budget is the owner's content. A viewer's `remoteOwner` block is
      // retained and counted below, but it has its own cap.
      if ((params.query.kind === "query" ? navigationQueryPageBudgetBytes(page as NavigationQueryPage) : bytes) > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
        throw new NavigationQueryError("navigation_item_too_large", "Navigation page exceeds its result budget.");
      }
      if (params.read.loadedAt !== params.query.invalidationSequence) {
        // Its readers asked before the change and get this page. It is not
        // the query's current result; the follow-up's page replaces it.
        if (params.query.kind === "query") listingDiagnostics.record("owner-page", "overtaken", { reason: "owner-invalidated" });
        return page;
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
      const cancel = (): void => reject(navigationReadCancelled());
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
      if (query === except || query.consumers.size > 0 || query.reads.size > 0 || query.overtaken.size > 0 || query.active) continue;
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
