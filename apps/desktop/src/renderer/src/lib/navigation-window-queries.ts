import { NAVIGATION_QUERY_MAX_RESULT_BYTES } from "@pwragent/shared";
import type { NavigationQueryRequest } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import {
  applyNavigationPage, beginNavigationPageRead, createNavigationPageState,
  failNavigationPageRead, type NavigationPageState,
} from "./navigation-query-state";

const MAX_RESOURCES = 8;
const MAX_RETAINED_BYTES = 8 * 1024 * 1024;
let nextWindow = 0;

export type NavigationWindowResource = {
  id: string;
  state: NavigationPageState;
  loading: boolean;
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
  released: boolean;
};

/** Window demand and loaded ranges only. All I/O shares the main-process query pool. */
export class NavigationWindowQueries {
  private readonly prefix = `navigation-window:${++nextWindow}`;
  private nextResource = 0;
  private readonly resources = new Map<string, Resource>();
  private readonly listeners = new Set<() => void>();
  private visible = true;
  private disposed = false;
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
  }

  setDemand(demand: ReadonlyMap<string, NavigationQueryRequest>): void {
    if (this.disposed) return;
    const admitted = new Map([...demand].slice(0, MAX_RESOURCES));
    const admissionError = demand.size > MAX_RESOURCES
      ? "Navigation can keep eight queries active. Collapse a directory before opening more." : undefined;
    for (const [id, resource] of this.resources) {
      const request = admitted.get(id);
      if (!request || JSON.stringify(request) !== resource.requestKey) {
        this.release(resource);
        this.resources.delete(id);
      }
    }
    const added: Resource[] = [];
    for (const [id, request] of admitted) {
      if (this.resources.has(id)) continue;
      const resource: Resource = {
        requestKey: JSON.stringify(request), token: `${this.prefix}:${++this.nextResource}`,
        value: { id, state: createNavigationPageState(request), loading: false },
        refreshAfterPending: false, released: !this.visible,
      };
      this.resources.set(id, resource);
      added.push(resource);
    }
    this.snapshot = { ...this.snapshot, admissionError };
    this.publish();
    if (this.visible) for (const resource of added) void this.read(resource, false);
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
          released: false, pending: undefined, refreshAfterPending: false };
        this.resources.set(resource.value.id, next);
        void this.read(next, false);
      }
    }
    this.publish();
  }

  refresh(id?: string): Promise<void> {
    if (!this.visible || this.disposed) return Promise.resolve();
    const resources = id ? [this.resources.get(id)].filter((value): value is Resource => Boolean(value)) : [...this.resources.values()];
    return Promise.all(resources.map((resource) => {
      if (resource.pending) resource.refreshAfterPending = true;
      return this.read(resource, false);
    })).then(() => undefined);
  }

  loadMore(id: string): Promise<void> {
    const resource = this.resources.get(id);
    return resource ? this.read(resource, true) : Promise.resolve();
  }

  private isCurrent(resource: Resource): boolean {
    return !this.disposed && this.visible && !resource.released
      && this.resources.get(resource.value.id) === resource;
  }

  private read(resource: Resource, continuation: boolean): Promise<void> {
    if (!this.isCurrent(resource)) return Promise.resolve();
    if (resource.pending) return resource.pending;
    const cursor = continuation ? resource.value.state.page?.nextCursor : undefined;
    if (continuation && !cursor) return Promise.resolve();
    const started = beginNavigationPageRead(resource.value.state);
    resource.value = { ...resource.value, state: started, loading: true };
    this.publish();
    const promise = Promise.resolve().then(async () => {
      try {
        if (!this.isCurrent(resource)) return;
        if (!this.api.getNavigationQueryPage) throw new Error("Navigation query protocol 2 is required. Upgrade this instance.");
        const page = await this.api.getNavigationQueryPage({ ...started.request, cursor,
          completeBaselineRevision: !cursor && started.page?.complete ? started.page.countsRevision : undefined,
        }, resource.token);
        if (!this.isCurrent(resource)) return;
        if (new TextEncoder().encode(JSON.stringify(page)).byteLength > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
          throw new Error("Navigation page exceeds the bounded response size.");
        }
        const next = applyNavigationPage({ state: resource.value.state, sequence: started.pendingSequence, page, cursor });
        const retainedBytes = [...this.resources.values()].reduce((bytes, candidate) => {
          const candidatePage = candidate === resource ? next.page : candidate.value.state.page;
          return bytes + (candidatePage ? new TextEncoder().encode(JSON.stringify(candidatePage)).byteLength : 0);
        }, 0);
        if (retainedBytes > MAX_RETAINED_BYTES) throw new Error("Navigation retained-page budget reached. Collapse a directory or change lens to release pages.");
        resource.value = { ...resource.value, state: next };
      } catch (error) {
        if (this.isCurrent(resource)) resource.value = { ...resource.value,
          state: failNavigationPageRead(resource.value.state, started.pendingSequence, error) };
      } finally {
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
    this.publish();
    this.listeners.clear();
  }
}
