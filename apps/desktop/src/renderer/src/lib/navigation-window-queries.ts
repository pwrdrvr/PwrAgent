import { NAVIGATION_QUERY_MAX_PAGE_ROWS, NAVIGATION_QUERY_MAX_RESULT_BYTES, navigationInvalidationMayChangeMembership, navigationWorkingStatePath } from "@pwragent/shared";
import type { AgentEvent, FederationTarget, NavigationQueryAnchor, NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { federationTargetsEqual } from "./federated-thread-events";
import {
  applyNavigationPage, beginNavigationPageRead, createNavigationPageState,
  failNavigationPageRead, isNavigationCursorExpired, navigationRetainedRange, type NavigationPageState,
} from "./navigation-query-state";

const MAX_CONCURRENT_READS = 4;
const MAX_DEMAND_BYTES = 1024 * 1024;
const MAX_RETAINED_BYTES = 8 * 1024 * 1024;
/** One click loads a block of rows. Demand page sizes pace a first paint; an
 * explicit continuation is the operator asking for the rest, and answering it
 * with one transport page costs a click and a scroll for every page. */
const LOAD_MORE_ROWS = 100;
/** An owner that clamps a page to the byte budget still finishes a click in a
 * few reads. The chain is bounded so it can never become an unbounded scan. */
const MAX_LOAD_MORE_READS = 8;
let nextWindow = 0;

export type NavigationWindowResource = {
  id: string;
  state: NavigationPageState;
  loading: boolean;
  /** Cached membership awaiting a fresh owner read; existing row metadata wins. */
  restoredFromCache?: boolean;
};
export type NavigationWindowQueriesState = {
  resources: ReadonlyMap<string, NavigationWindowResource>;
  admissionError?: string;
};
type Resource = {
  requestKey: string;
  token: string;
  value: NavigationWindowResource;
  pending?: Promise<void>;
  refreshAfterPending: boolean;
  invalidated: boolean;
  released: boolean;
  anchor?: NavigationQueryAnchor;
};

/** Semantic demand ignores object insertion order and identity-set ordering. */
export function navigationDemandKey(request: NavigationQueryRequest): string {
  return JSON.stringify(request, (key, value: unknown) => {
    if (key === "readReason" || key === "deadlineAt") return undefined;
    if (Array.isArray(value) && ["identities", "roots", "keys"].includes(key)) {
      return [...value].sort((a, b) => JSON.stringify(a, Object.keys(a ?? {}).sort()).localeCompare(JSON.stringify(b, Object.keys(b ?? {}).sort())));
    }
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value;
  });
}

/** Window demand and loaded ranges only. All I/O shares the main-process query pool. */
export class NavigationWindowQueries {
  private readonly prefix = `navigation-window:${++nextWindow}`;
  private nextResource = 0;
  private readonly resources = new Map<string, Resource>();
  // Released transport leases need not discard the view. Keep recently used
  // ranges window-local, sharing the same byte budget as active resources.
  private readonly retained = new Map<string, { state: NavigationPageState; anchor?: NavigationQueryAnchor; bytes: number }>();
  private readonly listeners = new Set<() => void>();
  private visible = true;
  private disposed = false;
  private activeReads = 0;
  private readonly readWaiters = new Set<() => void>();
  private snapshot: NavigationWindowQueriesState = { resources: new Map() };

  constructor(private readonly api: Pick<DesktopApi, "getNavigationQueryPage" | "releaseNavigationQuery">) {}

  getSnapshot = (): NavigationWindowQueriesState => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(): void {
    const admissionError = this.snapshot.admissionError;
    this.snapshot = { resources: new Map([...this.resources].map(([id, resource]) => [id, resource.value])), admissionError };
    for (const listener of this.listeners) listener();
  }

  private release(resource: Resource): void {
    resource.released = true;
    // Every lifetime has its own token: a delayed release cannot cancel its successor.
    void this.api.releaseNavigationQuery?.(resource.token).catch(() => undefined);
    this.wakeReaders();
  }

  private retainedKey(id: string, requestKey: string): string {
    return JSON.stringify([id, requestKey]);
  }

  private trimRetained(activeBytes: number): void {
    let bytes = activeBytes + [...this.retained.values()].reduce((total, entry) => total + entry.bytes, 0);
    for (const [key, entry] of this.retained) {
      if (bytes <= MAX_RETAINED_BYTES && this.retained.size <= 64) break;
      this.retained.delete(key);
      bytes -= entry.bytes;
    }
  }

  setDemand(demand: ReadonlyMap<string, NavigationQueryRequest>): void {
    if (this.disposed) return;
    const admitted = new Map<string, NavigationQueryRequest>();
    let demandBytes = 0;
    for (const [id, request] of demand) {
      demandBytes += new TextEncoder().encode(JSON.stringify([id, request])).byteLength;
      if (demandBytes > MAX_DEMAND_BYTES) break;
      admitted.set(id, request);
    }
    let changed = false;
    const admissionError = admitted.size !== demand.size
      ? "Navigation request metadata exceeds its memory budget." : undefined;
    for (const [id, resource] of this.resources) {
      const request = admitted.get(id);
      if (!request || navigationDemandKey(request) !== resource.requestKey) {
        if (resource.value.state.page) {
          const key = this.retainedKey(id, resource.requestKey);
          this.retained.delete(key);
          this.retained.set(key, { state: resource.value.state, anchor: resource.anchor,
            bytes: new TextEncoder().encode(JSON.stringify(resource.value.state.page)).byteLength });
        }
        this.release(resource);
        this.resources.delete(id);
        changed = true;
      }
    }
    const added: Resource[] = [];
    for (const [id, request] of admitted) {
      if (this.resources.has(id)) continue;
      const requestKey = navigationDemandKey(request);
      const retainedKey = this.retainedKey(id, requestKey);
      const retained = this.retained.get(retainedKey);
      this.retained.delete(retainedKey);
      const resource: Resource = {
        requestKey, token: `${this.prefix}:${++this.nextResource}`,
        value: { id, state: retained ? { ...retained.state, stale: true, error: undefined } : createNavigationPageState(request),
          loading: false, restoredFromCache: Boolean(retained) },
        refreshAfterPending: false, invalidated: false, released: !this.visible, anchor: retained?.anchor ?? request.anchor,
      };
      this.resources.set(id, resource);
      added.push(resource);
      changed = true;
    }
    if (changed) this.trimRetained([...this.resources.values()].reduce((bytes, resource) => bytes
      + (resource.value.state.page ? new TextEncoder().encode(JSON.stringify(resource.value.state.page)).byteLength : 0), 0));
    if (changed || admissionError !== this.snapshot.admissionError) {
      this.snapshot = { ...this.snapshot, admissionError };
      this.publish();
    }
    if (this.visible) for (const resource of added) void this.read(resource, false, undefined, false, "demand");
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    for (const resource of this.resources.values()) {
      if (!visible) {
        this.release(resource);
        resource.value = { ...resource.value, loading: false };
      } else {
        // Replace the lifetime rather than revive a released token or pending read.
        const next: Resource = { ...resource, token: `${this.prefix}:${++this.nextResource}`,
          released: false, pending: undefined, refreshAfterPending: false, invalidated: false };
        this.resources.set(resource.value.id, next);
        void this.read(next, false);
      }
    }
    this.publish();
  }

  refresh(id?: string, owners?: readonly FederationTarget[], invalidatedOnly = false): Promise<void> {
    if (!this.visible || this.disposed) return Promise.resolve();
    const resources = id ? [this.resources.get(id)].filter((value): value is Resource => Boolean(value)) : [...this.resources.values()];
    return Promise.all(resources.filter((resource) => (!invalidatedOnly || resource.invalidated)
      && (!owners || owners.some((owner) => federationTargetsEqual(owner, resource.value.state.request.federationTarget)))).map(async (resource) => {
      if (resource.pending) resource.refreshAfterPending = true;
      await this.read(resource, false);
      // A caller awaiting refresh owns the coalesced replacement too, not
      // merely the stale read that happened to occupy this resource first.
      while (this.isCurrent(resource) && resource.pending) await resource.pending;
    })).then(() => undefined);
  }

  /** Invalidate transport baselines before canonical owner events can race a late page. */
  invalidate(id?: string, owners?: readonly FederationTarget[], event?: AgentEvent): void {
    let changed = false;
    for (const resource of this.resources.values()) {
      if (id && resource.value.id !== id) continue;
      if (owners && !owners.some((owner) => federationTargetsEqual(owner, resource.value.state.request.federationTarget))) continue;
      if (event && !this.eventAffectsResource(resource, event)) continue;
      // Fence each physical read once. Further events before its replacement
      // carry no new presentation state and must not rerender every row.
      if (resource.invalidated) continue;
      resource.invalidated = true;
      changed = true;
      // Some canonical events patch settled rows without scheduling a read.
      // If they fence a pending page, replace that discarded read so initial
      // readiness and refreshed counts cannot remain stranded indefinitely.
      if (resource.pending) resource.refreshAfterPending = true;
      resource.value = { ...resource.value, state: { ...resource.value.state,
        pendingSequence: resource.value.state.pendingSequence + 1, stale: true } };
    }
    if (changed) this.publish();
  }

  private eventAffectsResource(resource: Resource, event: AgentEvent): boolean {
    // A remote row event cannot change membership of an exact identity query.
    // Collection queries retain conservative invalidation for counts/order.
    const request = resource.value.state.request;
    if (request.federationTarget?.scope !== "remote" || request.query.kind !== "exact") return true;
    const params = event.notification.params as { sourceMethod?: unknown; threadId?: unknown; worktreePath?: unknown; directoryKey?: unknown };
    const method = event.notification.method === "navigation/invalidated" ? params?.sourceMethod : event.notification.method;
    if (navigationInvalidationMayChangeMembership(method)) return true;
    const page = resource.value.state.page;
    if (method === "navigation/directoryGitStatus/updated" && typeof params?.directoryKey === "string"
      && page?.coverage.state === "complete" && page.complete) {
      return page.selectionDirectory?.key === params.directoryKey || Boolean(page.directories?.some((directory) => directory.key === params.directoryKey));
    }
    const refs = [...request.query.identities, ...(page?.entries.map(({ row }) => row.ref) ?? [])];
    if (typeof params?.threadId === "string") return refs.some((ref) => ref.backend === event.backend && ref.threadId === params.threadId);
    if (method === "navigation/threadGitWorkingState/updated" && typeof params?.worktreePath === "string"
      && page?.coverage.state === "complete" && page.complete
      && request.query.identities.every((ref) => page.entries.some(({ row }) => row.ref.backend === ref.backend && row.ref.threadId === ref.threadId))) {
      return page.entries.some(({ row }) => navigationWorkingStatePath(row) === params.worktreePath);
    }
    return true;
  }

  setVisibleAnchor(id: string, anchor: NavigationQueryAnchor | undefined): void {
    const resource = this.resources.get(id);
    if (resource) resource.anchor = anchor;
  }

  rebaseline(id: string, anchor: NavigationQueryAnchor): Promise<void> {
    this.setVisibleAnchor(id, anchor);
    const resource = this.resources.get(id);
    return resource ? this.read(resource, false, anchor) : Promise.resolve();
  }

  /** Returning to the start after a removed anchor is an explicit viewer action. */
  async restart(id: string): Promise<void> {
    const resource = this.resources.get(id);
    if (!resource) return;
    while (this.isCurrent(resource) && resource.pending) await resource.pending;
    if (!this.isCurrent(resource)) return;
    resource.anchor = undefined;
    resource.value = { ...resource.value, state: { ...resource.value.state, rebaselineRequired: false, stale: true } };
    return this.read(resource, false, undefined, true);
  }

  async loadMore(id: string): Promise<void> {
    const resource = this.resources.get(id);
    if (!resource) return;
    // A refresh can begin between the button's render and its click. Preserve
    // that explicit continuation demand instead of treating the refresh as it.
    while (this.isCurrent(resource) && resource.pending) await resource.pending;
    await this.read(resource, true);
  }

  private isCurrent(resource: Resource): boolean {
    return !this.disposed && this.visible && !resource.released
      && this.resources.get(resource.value.id) === resource;
  }

  private wakeReaders(): void {
    for (const wake of this.readWaiters) wake();
    this.readWaiters.clear();
  }

  private async acquireReadSlot(resource: Resource): Promise<boolean> {
    while (this.isCurrent(resource) && this.activeReads >= MAX_CONCURRENT_READS) {
      await new Promise<void>((resolve) => this.readWaiters.add(resolve));
    }
    if (!this.isCurrent(resource)) return false;
    this.activeReads += 1;
    return true;
  }

  private read(resource: Resource, continuation: boolean, anchor?: NavigationQueryAnchor, fromStart = false, reason: NavigationQueryRequest["readReason"] = "refresh"): Promise<void> {
    if (!this.isCurrent(resource)) return Promise.resolve();
    if (resource.pending) {
      if (anchor) resource.refreshAfterPending = true;
      return resource.pending;
    }
    const explicitAnchor = anchor;
    anchor = continuation || fromStart ? undefined : anchor ?? resource.anchor;
    if (resource.value.state.rebaselineRequired && !anchor) return Promise.resolve();
    const cursor = continuation ? resource.value.state.page?.nextCursor : undefined;
    if (continuation && !cursor) return Promise.resolve();
    const started = beginNavigationPageRead(resource.value.state);
    resource.invalidated = false;
    resource.value = { ...resource.value, state: started, loading: true };
    this.publish();
    const promise = Promise.resolve().then(async () => {
      let acquired = false;
      try {
        acquired = await this.acquireReadSlot(resource);
        if (!acquired) return;
        if (!this.api.getNavigationQueryPage) throw new Error("Navigation query protocol 2 is required. Upgrade this instance.");
        const size = (page?: NavigationQueryPage) => page?.modelGroups?.length
          || page?.directories?.length || page?.entries.length || 0;
        const assertRetained = (next: NavigationPageState) => {
          const retainedBytes = [...this.resources.values()].reduce((bytes, candidate) => {
            const candidatePage = candidate === resource ? next.page : candidate.value.state.page;
            return bytes + (candidatePage ? new TextEncoder().encode(JSON.stringify(candidatePage)).byteLength : 0);
          }, 0);
          this.trimRetained(retainedBytes);
          if (retainedBytes > MAX_RETAINED_BYTES) throw new Error("Navigation retained-page budget reached. Collapse a directory or change lens to release pages.");
        };
        const readPage = async (request: NavigationQueryRequest) => {
          const page = await this.api.getNavigationQueryPage!({ ...request,
            readReason: continuation ? "continuation" : explicitAnchor || fromStart ? "rebaseline" : reason,
          }, resource.token);
          if (new TextEncoder().encode(JSON.stringify(page)).byteLength > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
            throw new Error("Navigation page exceeds the bounded response size.");
          }
          return page;
        };
        let page: NavigationQueryPage;
        let pageCursor = cursor;
        const wanted = explicitAnchor || fromStart ? 0 : size(started.page) + (continuation ? LOAD_MORE_ROWS : 0);
        // A cursor read serves rows this window has already committed to: the
        // block an explicit click asked for, or the range a refresh must
        // restore. Neither is paced by the demand page size that bounds a
        // first paint, so read exactly what is still wanted in as few round
        // trips as the protocol allows. Owners clamp to their byte budget.
        const cursorPageSize = (loaded: number) =>
          Math.max(1, Math.min(NAVIGATION_QUERY_MAX_PAGE_ROWS, wanted - loaded));
        try {
          page = await readPage({ ...started.request, cursor, anchor,
            ...(cursor ? { pageSize: cursorPageSize(size(started.page)) } : {}),
            completeBaselineRevision: !fromStart && !anchor && !cursor && !started.stale && started.page?.complete && (started.page.rangeStart ?? 0) === 0 ? started.page.countsRevision : undefined,
            retainedRange: !fromStart && !explicitAnchor && !cursor
              && (anchor || !started.page?.complete || (started.page.rangeStart ?? 0) !== 0)
              ? navigationRetainedRange(started) : undefined,
          });
        } catch (error) {
          if (!cursor || !isNavigationCursorExpired(error)) throw error;
          // Cursor cache eviction is ordinary pressure, not a broken folder.
          // Rebuild only the already displayed range plus the block this
          // click asked for; `wanted` already counts that block.
          pageCursor = undefined;
          const previous = started.page;
          const firstDirectory = previous?.directories?.[0];
          const firstThread = previous?.entries[0]?.row.ref;
          const recoveryAnchor = resource.anchor ?? ((previous?.rangeStart ?? 0) > 0
            ? firstDirectory ? { kind: "directory" as const, key: firstDirectory.key }
              : firstThread ? { kind: "thread" as const, ref: firstThread } : undefined : undefined);
          page = await readPage({ ...started.request, anchor: recoveryAnchor });
        }
        if (!this.isCurrent(resource) || resource.value.state.pendingSequence !== started.pendingSequence) return;
        let next = applyNavigationPage({ state: resource.value.state, sequence: started.pendingSequence, page, cursor: pageCursor });
        assertRetained(next);
        let extensions = 0;
        // A range rebuild reads until it has restored everything the window
        // displays. A continuation reads until it has delivered its block.
        while (next.page?.nextCursor && size(next.page) < wanted
          && (!pageCursor || extensions < MAX_LOAD_MORE_READS)) {
          const nextCursor = next.page.nextCursor;
          const before = size(next.page);
          try {
            const continuationPage = await readPage({ ...started.request, cursor: nextCursor, pageSize: cursorPageSize(before) });
            if (!this.isCurrent(resource) || resource.value.state.pendingSequence !== started.pendingSequence) return;
            const extended = applyNavigationPage({ state: next, sequence: started.pendingSequence, page: continuationPage, cursor: nextCursor });
            if (size(extended.page) <= before) throw new Error("Navigation range refresh did not advance.");
            assertRetained(extended);
            next = extended;
          } catch (error) {
            // A rebuild owes the window every row it already displays, so a
            // failed extension discards the partial range. A continuation
            // owes it only the requested block: commit the rows this click
            // did deliver, then report what stopped it. A silent stop would
            // leave the button looking inert at the retained-page budget.
            if (!pageCursor) throw error;
            resource.value = { ...resource.value, state: next, restoredFromCache: false };
            throw error;
          }
          extensions += 1;
        }
        resource.value = { ...resource.value, state: next, restoredFromCache: false };
      } catch (error) {
        if (this.isCurrent(resource)) resource.value = { ...resource.value,
          state: failNavigationPageRead(resource.value.state, started.pendingSequence, error) };
      } finally {
        if (acquired) {
          this.activeReads -= 1;
          this.wakeReaders();
        }
        if (resource.pending === promise) resource.pending = undefined;
        if (this.isCurrent(resource)) {
          resource.value = { ...resource.value, loading: false };
          this.publish();
          if (resource.refreshAfterPending) {
            resource.refreshAfterPending = false;
            void this.read(resource, false);
          }
        }
      }
    });
    resource.pending = promise;
    return promise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const resource of this.resources.values()) this.release(resource);
    this.resources.clear();
    this.retained.clear();
    this.publish();
    this.listeners.clear();
  }
}
