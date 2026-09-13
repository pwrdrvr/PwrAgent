import type { AppServerReadThreadRequest, ThreadDisplayData } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

export type DisplayResourceState = { data?: ThreadDisplayData; loading?: boolean; error?: string };
const MAX_RETAINED_BYTES = 8 * 1024 * 1024;

function appendPage(previous: ThreadDisplayData, page: ThreadDisplayData): ThreadDisplayData {
  if (previous.revision !== page.revision) throw new Error("Thread history changed. Refresh this panel to continue.");
  return { ...page,
    ...(page.subAgents && previous.subAgents ? { subAgents: [...previous.subAgents, ...page.subAgents] } : {}),
    ...(page.pricingPage && previous.pricingPage ? { pricingPage: { ...page.pricingPage, rows: [...previous.pricingPage.rows, ...page.pricingPage.rows] } } : {}),
    ...(page.toolsPage && previous.toolsPage ? { toolsPage: { ...page.toolsPage, invocations: [...previous.toolsPage.invocations, ...page.toolsPage.invocations] } } : {}),
  };
}

/** One mounted resource owns pagination, the conditional baseline and its in-flight read.
 * Sibling panels share this owner. No timers or events retain an unmounted resource.
 */
export class ThreadDisplayResourceStore {
  state: DisplayResourceState = {};
  private readonly listeners = new Set<() => void>();
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private lastStarted = -Infinity;
  private pages = 0;
  private firstPage?: ThreadDisplayData;
  private firstRevision?: string;

  constructor(private readonly api: DesktopApi, private readonly request: AppServerReadThreadRequest) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.refresh();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) { clearTimeout(this.timer); this.timer = undefined; this.dirty = false; }
    };
  };

  getSnapshot = (): DisplayResourceState => this.state;

  whenSettled = (): Promise<void> => this.pending ?? Promise.resolve();

  private publish(state: DisplayResourceState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  invalidate = (): void => {
    if (!this.listeners.size) return;
    this.dirty = true;
    this.schedule();
  };

  private schedule(): void {
    if (this.pending || this.timer || !this.dirty || !this.listeners.size) return;
    // Bound sustained invalidations as well as bursts. This is a shared demand
    // budget, not a retry: at most one automatic read starts per second.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.dirty) void this.refresh();
    }, Math.max(200, this.lastStarted + 1_000 - Date.now()));
  }

  refresh = (): Promise<void> => {
    if (this.pending) { this.dirty = true; return this.pending; }
    clearTimeout(this.timer); this.timer = undefined;
    this.dirty = false;
    return this.run(false);
  };

  loadMore = async (): Promise<void> => {
    if (this.pending) return this.pending;
    if (!this.listeners.size || !this.state.data?.nextCursor) return;
    return this.run(true);
  };

  private run(more: boolean): Promise<void> {
    this.lastStarted = Date.now();
    this.publish({ data: this.state.data, loading: true });
    // Defer execution until pending is installed, including synchronous mocks.
    this.pending = Promise.resolve().then(async () => {
      const previous = this.state.data;
      let data = more ? previous : undefined;
      let pages = more ? this.pages : 0;
      let firstPage = this.firstPage;
      let firstRevision = this.firstRevision;
      const pageCount = more ? 1 : this.pages || 1;
      for (let index = 0; index < pageCount; index += 1) {
        if (!this.listeners.size) return;
        const response = await this.api.readThread!({ ...this.request,
          display: { ...this.request.display!, cursor: data?.nextCursor },
          ...(!more && index === 0 ? { knownRevision: this.firstRevision ?? "" } : {}),
        });
        if (!more && index === 0 && response.unchanged) {
          if (!previous || !this.firstRevision || response.replayRevision !== this.firstRevision) {
            throw new Error("Thread owner acknowledged an unknown display baseline.");
          }
          this.publish({ data: previous });
          return;
        }
        if (!response.display) throw new Error("Thread owner did not return the requested display resource.");
        if (!more && index === 0) {
          // Older owners and local IPC may return full pages. A matching
          // collection revision AND first-page presentation retain later pages.
          if (previous && firstPage && response.display.revision === firstPage.revision
            && JSON.stringify(response.display) === JSON.stringify(firstPage)) {
            this.firstRevision = response.replayRevision;
            this.publish({ data: previous });
            return;
          }
          firstPage = response.display;
          firstRevision = response.replayRevision;
        }
        data = data ? appendPage(data, response.display) : response.display;
        if (new TextEncoder().encode(JSON.stringify(data)).byteLength > MAX_RETAINED_BYTES) {
          throw new Error("Thread display history exceeds its retained size budget.");
        }
        pages += 1;
        if (!data.nextCursor) break;
      }
      if (data) {
        this.pages = pages; this.firstPage = firstPage; this.firstRevision = firstRevision;
        this.publish({ data });
      }
    }).catch((error: unknown) => {
      this.publish({ data: this.state.data, error: error instanceof Error ? error.message : String(error) });
    }).finally(() => { this.pending = undefined; this.schedule(); });
    return this.pending;
  }
}

const stores = new WeakMap<DesktopApi, Map<string, { store: ThreadDisplayResourceStore; users: number }>>();

/** The map retains mounted demand only; closing the last consumer releases its pages. */
export function acquireThreadDisplayResource(api: DesktopApi, request: AppServerReadThreadRequest) {
  let resources = stores.get(api);
  if (!resources) { resources = new Map(); stores.set(api, resources); }
  const key = JSON.stringify(request);
  let entry = resources.get(key);
  if (!entry) { entry = { store: new ThreadDisplayResourceStore(api, request), users: 0 }; resources.set(key, entry); }
  entry.users += 1;
  return { store: entry.store, release: () => {
    if (--entry.users === 0) {
      // A close/reopen must adopt the still-running owner rather than launch a
      // second wire read. Idle, unmounted pages are released after it settles.
      void entry.store.whenSettled().then(() => {
        if (entry.users === 0 && resources.get(key) === entry) resources.delete(key);
      });
    }
  } };
}
