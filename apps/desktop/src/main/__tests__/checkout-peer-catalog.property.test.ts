import fc from "fast-check";
import { DesktopResourceCheckoutService } from "../resource-checkouts/resource-checkout-service";
import { expect, it } from "vitest";
import { CheckoutPeerCatalog, catalogPage, type CheckoutPeers, type CheckoutView } from "../resource-checkouts/checkout-peer-catalog";
import { projectCheckoutDomain } from "../resource-checkouts/checkout-projection";

function view(owner: string, key: string): CheckoutView {
  const authority = { authorityId: `checkout:${owner}:${key}`, epoch: 1, kind: "federation_coordinator" as const,
    status: "reachable" as const, label: owner, endpointLabel: owner };
  const resource = projectCheckoutDomain({
    definition: { resourceId: key, canonicalKey: key, authorityId: authority.authorityId, epoch: 1,
      displayName: key, kindLabel: "Lab", scope: "federation", capacity: 1, counted: false,
      publication: "published", revision: 1, updatedAt: 1, maxHoldMs: 1000 },
    generation: 0, grants: [], queue: [],
  }, { key: "viewer", manage: false, holder: { kind: "operator", label: "Viewer" } }, authority);
  return { resource, authority };
}

it("makes a disconnected owner's last answer stale and forgets it when membership ends", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("connected" as const, "disconnected" as const, "denied" as const), { maxLength: 16 }), async (steps) => {
    let peers: CheckoutPeers = new Map();
    const entry = view("owner", "lab:one");
    const catalog = new CheckoutPeerCatalog(() => peers, async <T>() =>
      catalogPage("session", [entry], 0, (item) => item) as T, () => 1);
    let observed = false;
    for (const status of steps) {
      peers = new Map(status === "denied" ? [] : [["owner", status]]);
      if (status === "connected") observed = true;
      if (status === "denied") observed = false;
      await catalog.refresh();
      expect(catalog.current().get("lab:one")?.view.authority.status)
        .toBe(observed ? status === "connected" ? "reachable" : "unreachable" : undefined);
    }
  }));
});

it("discards a response that arrives after revocation and rejects competing owner claims", async () => {
  const peers = new Map<string, "connected">([["one", "connected"]]);
  const pending = Promise.withResolvers<void>();
  const catalog = new CheckoutPeerCatalog(() => peers, async <T>(id: string) => {
    await pending.promise;
    return catalogPage("session", [view(id, "lab:one")], 0, (item) => item) as T;
  }, () => 1);
  const first = catalog.refresh();
  peers.clear();
  expect(catalog.current().size).toBe(0);
  peers.set("two", "connected");
  pending.resolve();
  await first;
  expect(catalog.current().size).toBe(0);
  await catalog.refresh();
  expect(catalog.current().get("lab:one")?.owner).toBe("two");
  peers.set("one", "connected");
  await catalog.refresh();
  expect(catalog.current().size).toBe(0);
});

it("fetches each owner in bounded pages, and caches a confirmed empty catalog", async () => {
  const peers = new Map<string, "connected">([["one", "connected"], ["two", "connected"], ["empty", "connected"]]);
  const calls = new Map<string, number>();
  const catalog = new CheckoutPeerCatalog(() => peers, async <T>(id: string, request: unknown) => {
    calls.set(id, (calls.get(id) ?? 0) + 1);
    const rows = Array.from({ length: id === "empty" ? 0 : 9 }, (_, i) => `lab:${id}-${i}`);
    return catalogPage("session", rows, (request as { offset: number }).offset, (key) => view(id, key)) as T;
  }, () => 1);
  for (let i = 0; i < 2; i++) expect((await catalog.refresh()).size).toBe(18);
  expect(Object.fromEntries(calls)).toEqual({ one: 6, two: 6, empty: 1 });
});

it("erases a cached catalog when the authority withdraws access on a live connection", async () => {
  let denied = false;
  const peers: CheckoutPeers = new Map([["owner", "connected"]]);
  const catalog = new CheckoutPeerCatalog(() => peers, async <T>() => {
    if (denied) throw Object.assign(new Error("Denied"), { code: "capability_denied" });
    return catalogPage("session", [view("owner", "lab:one")], 0, (item) => item) as T;
  }, () => 1);
  expect((await catalog.refresh()).size).toBe(1);
  denied = true;
  await expect(catalog.request("owner", { operation: "status" })).rejects.toThrow("Denied");
  expect(catalog.current().size).toBe(0);
});

it("keeps the previous complete owner page when a peer returns a malformed projection", async () => {
  const peers: CheckoutPeers = new Map([["owner", "connected"], ["other", "connected"]]);
  let bad: Record<string, unknown> | undefined;
  const catalog = new CheckoutPeerCatalog(() => peers, async <T>(owner: string) => {
    const row = view(owner, `lab:${owner}`);
    if (owner === "owner" && bad) Object.assign(row.resource, bad);
    return catalogPage("session", [row], 0, (item) => item) as T;
  }, () => 1);
  await catalog.refresh();
  for (bad of [
    { allocations: [null] }, { allocations: [{ holder: { kind: "thread" } }] },
    { queue: [{ requester: { kind: "thread", thread: {} } }] }, { queue: [null] },
    { allocations: [{ holder: { kind: "operator", label: "Fixture" }, delegatedExecutor: {} }] },
    { sharing: null },
  ]) {
    const rows = await catalog.refresh();
    expect(rows.get("lab:owner")?.view.resource).toMatchObject({ condition: "unreachable", allocations: [], queue: [] });
    expect(rows.get("lab:other")?.view.authority.status).toBe("reachable");
  }
});

it("fences an older operator response after a subject discovers the owner's new epoch", async () => {
  const peers: CheckoutPeers = new Map([["owner", "connected"]]);
  const pending = Promise.withResolvers<void>();
  let epoch = 1;
  let delayOperator = false;
  const catalog = new CheckoutPeerCatalog(() => peers, async <T>(id: string, input: unknown) => {
    const row = view(id, "lab:one");
    row.authority.epoch = epoch;
    if ((input as { subject?: unknown }).subject) row.resource.actions.release = { allowed: true };
    else if (delayOperator) await pending.promise;
    return catalogPage("session", [row], 0, item => item) as T;
  }, () => 1);
  await catalog.refresh();
  delayOperator = true;
  const old = catalog.refresh();
  epoch++;
  const subject = await catalog.refresh({ backend: "codex", threadId: "worker" });
  expect(subject.get("lab:one")?.view.resource.actions.release).toEqual({ allowed: true });
  pending.resolve();
  await old;
  expect(catalog.destination("lab:one")).toMatchObject({ owner: "owner", epoch, reachable: true });
  expect(catalog.current().has("lab:one")).toBe(false);
  await catalog.refresh();
  expect(catalog.current().get("lab:one")?.view.authority.epoch).toBe(epoch);
  expect(catalog.current().get("lab:one")?.view.resource.actions.release).toBeUndefined();
});

it("refreshes only newly connected checkout owners after a peer status change", async () => {
  const peers = new Map<string, "connected" | "disconnected">([["one", "connected"], ["two", "connected"]]);
  const reads: string[] = [];
  const service = new DesktopResourceCheckoutService({
    viewer: { instanceId: "viewer", instanceLabel: "Viewer", profile: "dev" }, bindings: [],
    now: () => 1, warn: () => {}, checkoutPeers: () => peers,
    requestPeer: async <T>(id: string) => {
      reads.push(id);
      return catalogPage("session", [view(id, `lab:${id}`)], 0, item => item) as T;
    },
  });
  try {
    await service.refreshPeers();
    reads.length = 0;
    peers.set("one", "disconnected");
    await service.refreshPeers({ instanceId: "one", connected: false });
    expect(service.read().resources.find(row => row.resourceId === "lab:one")?.condition).toBe("unreachable");
    expect(reads).toEqual([]);
    peers.set("one", "connected");
    const reconnect = { instanceId: "one", connected: true };
    await Promise.all([service.refreshPeers(reconnect), service.refreshPeers(reconnect)]);
    expect(reads).toEqual(["one"]);
    expect(service.read().resources.find(row => row.resourceId === "lab:one")?.condition).toBe("available");
    reads.length = 0;
    await service.refreshPeers();
    expect(reads.sort()).toEqual(["one", "two"]);
    // A connected notification cannot supply missing membership.
    peers.delete("one");
    reads.length = 0;
    await service.refreshPeers(reconnect);
    expect(service.read().resources.some(row => row.resourceId === "lab:one")).toBe(false);
    expect(reads).toEqual([]);
  } finally { await service.close(); }
});

it("re-reads a reconnected owner once when its previous session still owes a catalog page", async () => {
  const peers = new Map<string, "connected" | "disconnected">([["one", "connected"]]);
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const pages: string[] = [];
  let session = "old";
  const service = new DesktopResourceCheckoutService({
    viewer: { instanceId: "viewer", instanceLabel: "Viewer", profile: "dev" }, bindings: [],
    now: () => 1, warn: () => {}, checkoutPeers: () => peers,
    requestPeer: async <T>(id: string, input: unknown) => {
      const generation = session;
      const { offset } = input as { offset: number };
      pages.push(`${generation}:${offset}`);
      if (generation === "old") {
        started.resolve();
        await resume.promise;
      }
      const keys = Array.from({ length: 5 }, (_, i) => `lab:${generation}-${i}`);
      return catalogPage(generation, keys, offset, key => view(id, key)) as T;
    },
  });
  try {
    const first = service.refreshPeers();
    await started.promise;
    peers.set("one", "disconnected");
    const disconnect = service.refreshPeers({ instanceId: "one", connected: false });
    session = "new";
    peers.set("one", "connected");
    const reconnect = service.refreshPeers({ instanceId: "one", connected: true });
    resume.resolve();
    await Promise.all([first, disconnect, reconnect]);
    expect(pages).toEqual(["old:0", "new:0", "new:4"]);
    const rows = service.read().resources.filter(row => row.placement === "external");
    expect(rows.map(row => row.resourceId)).toEqual(Array.from({ length: 5 }, (_, i) => `lab:new-${i}`));
  } finally { resume.resolve(); await service.close(); }
});
