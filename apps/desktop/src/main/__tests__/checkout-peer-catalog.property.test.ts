import fc from "fast-check";
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
