import type { ResourceAuthority, ResourceDomain } from "@pwragent/shared/contracts/resource-checkouts";
import { checkoutCatalogView } from "./checkout-catalog-view";
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

type Destination = { owner: string; epoch: number; reachable: boolean; counted: boolean };
type Owner = {
  connected: boolean;
  emptyUntil: number;
  observation: number;
  destinations: Map<string, Destination>;
  views: CheckoutView[];
};
export type CheckoutRoute = { owner: string; view: CheckoutView };

/** The directory supplies permission and reachability. Only the addressed owner supplies resource rows. */
export class CheckoutPeerCatalog {
  private readonly owners = new Map<string, Owner>();
  private observation = 0;
  private index?: { destinations: Map<string, Destination>; operator: Map<string, CheckoutRoute> };

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
        this.index = undefined;
      } else if (owner.connected && peers.get(id) !== "connected") {
        // Replace the object so a late response from this session cannot repopulate it.
        this.index = undefined;
        this.owners.set(id, { ...owner, connected: false, views: owner.views.map((view) => stale(view)), emptyUntil: 0 });
        for (const route of owner.destinations.values()) route.reachable = false;
      }
    }
    for (const [id, status] of peers) {
      if (status !== "connected") continue;
      const old = this.owners.get(id);
      if (!old?.connected) this.owners.set(id, { connected: true, views: old?.views ?? [],
        destinations: old?.destinations ?? new Map(), observation: 0, emptyUntil: 0 });
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
        this.index = undefined;
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
      for (const row of page.views) {
        const view = checkoutCatalogView.parse(row);
        const key = canonicalKey(view.resource.canonicalKey);
        if (view.resource.resourceId !== key || keys.has(key)
          || view.resource.authorityId !== view.authority.authorityId
          || view.authority.authorityId !== `checkout:${id}:${key}`) throw new Error("Invalid checkout catalog owner.");
        keys.add(key);
        views.push(view);
      }
      if (!page.more) return views;
    }
    throw new Error("Invalid checkout catalog page.");
  }

  async refresh(subject?: unknown): Promise<Map<string, CheckoutRoute>> {
    this.reconcile();
    const observation = ++this.observation;
    const results = new Map<Owner, CheckoutView[]>();
    const answered = new Set<Owner>();
    const pending = [...this.owners].values();
    await Promise.all(Array.from({ length: Math.min(4, this.owners.size) }, async () => {
      for (const [id, owner] of pending) {
        if (!owner.connected || owner.emptyUntil > this.now()) continue;
        try {
          results.set(owner, await this.readOwner(id, subject));
          answered.add(owner);
        } catch {
          results.set(owner, owner.views.map((view) => stale(view, !!subject)));
        }
      }
    }));
    this.reconcile();
    for (const [id, owner] of this.owners) {
      const views = results.get(owner);
      if (!views || observation < owner.observation) continue;
      if (answered.has(owner)) {
        // Routing is identical for all viewers. Ownership and action gates belong to the viewer who asked.
        owner.destinations = new Map(views.map(({ authority, resource }) => [resource.resourceId, {
          owner: id, epoch: authority.epoch, reachable: authority.status === "reachable", counted: resource.sharing.mode === "counted",
        }]));
        owner.emptyUntil = views.length ? 0 : this.now() + EMPTY_CATALOG_TTL_MS;
      } else if (!subject) {
        for (const route of owner.destinations.values()) route.reachable = false;
      } else continue;
      owner.observation = observation;
      if (!subject) owner.views = views;
      else owner.views = owner.views.filter(view => owner.destinations.get(view.resource.resourceId)?.epoch === view.authority.epoch);
      this.index = undefined;
    }
    const index = this.routeIndex();
    if (!subject) return index.operator;
    const routes = new Map<string, CheckoutRoute>();
    for (const [id, owner] of this.owners) {
      for (const view of results.get(owner) ?? owner.views.map(item => stale(item, true))) {
        const key = view.resource.resourceId;
        const destination = index.destinations.get(key);
        if (destination?.owner === id && destination.epoch === view.authority.epoch) {
          routes.set(key, { owner: id, view: destination.reachable ? view : stale(view, true) });
        }
      }
    }
    return routes;
  }

  current(): Map<string, CheckoutRoute> {
    this.reconcile();
    return this.routeIndex().operator;
  }

  destination(key: string): Destination | undefined {
    this.reconcile();
    return this.routeIndex().destinations.get(key);
  }

  private routeIndex() {
    if (this.index) return this.index;
    const destinations = new Map<string, Destination>();
    const operator = new Map<string, CheckoutRoute>();
    const conflicts = new Set<string>();
    for (const [id, owner] of this.owners) {
      for (const [key, route] of owner.destinations) {
        if (destinations.has(key)) conflicts.add(key);
        destinations.set(key, route);
      }
      for (const view of owner.views) operator.set(view.resource.resourceId, { owner: id, view });
    }
    for (const key of conflicts) {
      destinations.delete(key);
      operator.delete(key);
    }
    return this.index = { destinations, operator };
  }
}
