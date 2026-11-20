import { expect, it } from "vitest";
import fc from "fast-check";
import type { NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import { navigationIdentityKey } from "../navigation-query-state";
import { buildNavigationWindowDemand, projectDisclosedNavigationParents, visibleDisclosedNavigationParents } from "../navigation-window-demand";

// The viewer mounts the root; its owner supplies the complete native tray.
// Viewer collection counts therefore cannot veto owner-backed child demand
// in Updated/Created, and loaded zero-child leaves must not create queries.
it.each(["inbox", "recents"] as const)("keeps the native tray of a singly mounted pin in %s", (lens) => {
  checkDemand(lens, true, 6, false);
});

it("models native child demand across collection counts, pin settings and disclosure changes", () => {
  fc.assert(fc.property(fc.constantFrom("inbox" as const, "recents" as const), fc.boolean(),
    fc.integer({ min: 0, max: 32 }), fc.boolean(), checkDemand));
});

it.each([6, 12])("bounds Q stable projections with %i native children and no mounted children", (count) => {
  for (let query = 0; query < 7; query++) checkDemand("inbox", true, count, false);
});

function checkDemand(lens: "inbox" | "recents", pinsOnTop: boolean, count: number, collapsed: boolean): void {
  const thread = (id: string, parent?: string): NavigationThreadSummary => ({ id, source: "codex", title: id,
    titleSource: "explicit", inbox: { inInbox: false }, linkedDirectories: [],
    ...(parent ? { parentThreadId: parent, parentThreadBackend: "codex" } : { pinnedRank: "1", subthreadsCollapsed: collapsed }),
    federation: { instanceLabel: "Peer", ref: { backend: "codex", threadId: id, target: { scope: "remote", instanceId: "peer" } } },
  });
  const parent = thread("parent");
  const population = [parent, ...Array.from({ length: count }, (_, index) => thread(`child-${index}`, parent.id))];
  const ref = { backend: "codex" as const, threadId: parent.id, ownerInstanceId: "peer" };
  const request: NavigationQueryRequest = { protocol: 2, inventory: "viewer", consumer: "main-sidebar", pageSize: 100,
    query: { kind: "lens", lens, ...(pinsOnTop ? { roots: "pinned" as const } : {}) } };
  const viewer = navigationQueryFixture(request, { threads: [parent] });
  const owner = navigationQueryFixture({ ...request, inventory: "owner", federationTarget: { scope: "remote", instanceId: "peer" },
    query: { kind: "exact", identities: population.map((row) => ({ ...ref, threadId: row.id })) } }, { threads: population });
  expect(viewer.entries[0]!.row.ordinaryChildCount).toBe(0);
  expect(owner.entries.find(({ row }) => row.id === parent.id)!.row.ordinaryChildCount).toBe(count);
  const admitted = new Map(owner.entries.map(({ row }) => [navigationIdentityKey(row.ref), row]));
  const candidates = projectDisclosedNavigationParents(admitted, []);
  const collection = pinsOnTop ? "lens-pins" : "lens";
  const disclosedParents = visibleDisclosedNavigationParents({ collectionIds: [collection], pages: new Map([[collection, viewer]]),
    disclosedParents: candidates });
  const expected = count > 0 && !collapsed;
  expect(disclosedParents).toEqual(expected ? [ref] : []);
  // Global metadata changes, including native child-count changes, still own
  // whether a non-directory tray exists. No leaf may become another demand.
  expect(candidates).toHaveLength(expected ? 1 : 0);
  const demand = buildNavigationWindowDemand({ browseMode: lens, attentionView: { id: "test", promoteOnTurnEnd: true },
    directories: [], expandedByKey: {}, unpinnedExpandedByKey: {}, pinnedThreadsOnTop: pinsOnTop, disclosedParents });
  const children = [...demand.values()].filter((value) => value.query.kind === "children");
  expect(children).toHaveLength(expected ? 2 : 0);
  if (expected) {
    expect(children).toContainEqual(expect.objectContaining({ inventory: "owner", federationTarget: { scope: "remote", instanceId: "peer" },
      query: { kind: "children", parent: ref } }));
    expect(children).toContainEqual(expect.objectContaining({ inventory: "viewer", query: { kind: "children", parent: ref } }));
  }
}
