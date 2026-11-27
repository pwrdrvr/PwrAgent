import type { ResourceAuthority, ResourceDomain } from "@pwragent/shared/contracts/resource-checkouts";
import { canonicalKey, object, text } from "./checkout-input";
import { MAX_EXTERNAL_DOMAINS } from "./checkout-configuration";

export type CheckoutView = { authority: ResourceAuthority; resource: ResourceDomain };
export type CheckoutPeers = ReadonlyMap<string, "connected" | "disconnected">;
export type CheckoutRpc = <T>(owner: string, request: unknown) => Promise<T>;

const PAGE_SIZE = 4;
const EMPTY_CATALOG_TTL_MS = 60_000;

export function catalogPage<T>(generation: string, bindings: readonly T[], offset: unknown, project: (binding: T) => CheckoutView) {
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
    || offset > MAX_EXTERNAL_DOMAINS || offset % PAGE_SIZE !== 0) throw new Error("Invalid checkout catalog offset.");
  const views = bindings.slice(offset, offset + PAGE_SIZE).map(project);
  return { version: 1, generation, views, more: offset + views.length < bindings.length };
}

function stale(view: CheckoutView, agent = false): CheckoutView {
  return {
    authority: { ...view.authority, status: "unreachable" },
    resource: { ...view.resource, condition: "unreachable", actions: {},
      allocations: view.resource.allocations.map((grant) => ({ ...grant, lastKnown: true, viewerOwns: !agent && grant.viewerOwns })),
      queue: agent ? view.resource.queue.map((entry) => ({ ...entry, viewerOwns: false })) : view.resource.queue },
  };
}

type Owner = { pending?: symbol; views: CheckoutView[]; emptyUntil: number; connected: boolean };
export type CheckoutRoute = { owner: string; view: CheckoutView };

/** The directory supplies permission and reachability. Only the addressed owner supplies resource rows. */
export class CheckoutPeerCatalog {
  private readonly owners = new Map<string, Owner>();
  private cachedRoutes?: Map<string, CheckoutRoute>;

  constructor(
    private readonly peers: (known: Iterable<string>) => CheckoutPeers,
    private readonly rpc: CheckoutRpc,
    private readonly now: () => number,
  ) {}

  private reconcile(): void {
    const peers = this.peers(this.owners.keys());
    for (const [id, owner] of this.owners) {
      if (!peers.has(id)) {
        this.owners.delete(id);
        this.cachedRoutes = undefined;
      } else if (owner.connected && peers.get(id) !== "connected") {
        // Replace the object so a late response from this session cannot repopulate it.
        this.cachedRoutes = undefined;
        this.owners.set(id, { connected: false, views: owner.views.map((view) => stale(view)), emptyUntil: 0 });
      }
    }
    for (const [id, status] of peers) {
      if (status !== "connected") continue;
      const old = this.owners.get(id);
      if (!old?.connected) this.owners.set(id, { connected: true, views: old?.views ?? [], emptyUntil: 0 });
    }
  }

  async request<T>(id: string, request: unknown): Promise<T> {
    const previous = this.owners.get(id);
    try {
      return await this.rpc<T>(id, request);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (previous && this.owners.get(id) === previous
        && (code === "capability_denied" || code === "relay_not_authorized" || code === "method_not_found")) {
        this.owners.delete(id);
        this.cachedRoutes = undefined;
      }
      throw error;
    }
  }

  private async readOwner(id: string, subject?: unknown): Promise<CheckoutView[]> {
    const views: CheckoutView[] = [];
    const keys = new Set<string>();
    let generation: string | undefined;
    for (let offset = 0; offset < MAX_EXTERNAL_DOMAINS; offset += PAGE_SIZE) {
      const page = object(await this.request(id, { operation: "catalog", offset, subject }));
      const received = text(page.generation, "catalog generation");
      if (generation !== undefined && generation !== received) throw new Error("The checkout owner restarted during discovery.");
      generation = received;
      if (page.version !== 1 || !Array.isArray(page.views) || page.views.length > PAGE_SIZE
        || typeof page.more !== "boolean" || (page.more && page.views.length !== PAGE_SIZE)) break;
      for (const view of page.views as CheckoutView[]) {
        const key = canonicalKey(view.resource.canonicalKey);
        if (view.resource.resourceId !== key || keys.has(key) || view.resource.placement !== "external"
          || view.resource.visibility !== "federation" || view.resource.allocationScope !== "federation"
          || !Array.isArray(view.resource.allocations) || !Array.isArray(view.resource.queue)
          || view.authority.kind !== "federation_coordinator" || view.resource.authorityId !== view.authority.authorityId
          || view.authority.authorityId !== `checkout:${id}:${key}`) throw new Error("Invalid checkout catalog owner.");
        keys.add(key);
        views.push(view);
      }
      if (!page.more) return views;
    }
    throw new Error("Invalid checkout catalog page.");
  }

  async refresh(subject?: unknown, onlyOwner?: string): Promise<Map<string, CheckoutRoute>> {
    this.reconcile();
    const observation = Symbol();
    const results = new Map<Owner, CheckoutView[]>();
    const answered = new Set<Owner>();
    const read = async ([id, owner]: [string, Owner]) => {
      if (!owner.connected) {
        if (subject) results.set(owner, owner.views.map((view) => stale(view, true)));
        return;
      }
      if (owner.emptyUntil > this.now()) return;
      if (!subject) owner.pending = observation;
      try {
        results.set(owner, await this.readOwner(id, subject));
        answered.add(owner);
      } catch {
        results.set(owner, owner.views.map((view) => stale(view, !!subject)));
      }
    };
    const selected = onlyOwner && this.owners.get(onlyOwner);
    const entries: [string, Owner][] = onlyOwner ? (selected ? [[onlyOwner, selected]] : []) : [...this.owners];
    const pending = entries.values();
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
      for (const entry of pending) await read(entry);
    }));
    this.reconcile();
    // Commit a complete owner replacement. A role change or disconnect during a read fences that response.
    if (subject === undefined) {
      for (const owner of this.owners.values()) {
        const views = results.get(owner);
        if (!views || owner.pending !== observation) continue;
        this.cachedRoutes = undefined;
        owner.views = views;
        owner.emptyUntil = !views.length && answered.has(owner) ? this.now() + EMPTY_CATALOG_TTL_MS : 0;
      }
    }
    return subject ? this.routes(results) : this.operatorRoutes();
  }

  current(): Map<string, CheckoutRoute> {
    this.reconcile();
    return this.operatorRoutes();
  }

  private operatorRoutes(): Map<string, CheckoutRoute> {
    return this.cachedRoutes ??= this.routes();
  }

  private routes(results?: Map<Owner, CheckoutView[]>): Map<string, CheckoutRoute> {
    const routes = new Map<string, CheckoutRoute>();
    const conflicts = new Set<string>();
    for (const [id, owner] of this.owners) {
      for (const view of results ? results.get(owner) ?? [] : owner.views) {
        const key = view.resource.resourceId;
        if (routes.has(key)) conflicts.add(key);
        routes.set(key, { owner: id, view });
      }
    }
    // Two claiming owners give no unique destination. Never choose one by arrival order.
    for (const key of conflicts) routes.delete(key);
    return routes;
  }
}
