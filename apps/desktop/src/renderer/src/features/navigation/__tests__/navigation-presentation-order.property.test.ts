import { expect, it } from "vitest";
import fc from "fast-check";
import type { NavigationIdentity, NavigationQueryRequest } from "@pwragent/shared";
import { createNavigationPageState, navigationThreadSelectionKey } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";
import {
  readOwnerChildOrder,
  type NavigationPresentationEntry,
} from "../navigation-presentation-order";

function fixture(ownerOrder: number[], remote: boolean) {
  const parent: NavigationIdentity = { backend: "codex", threadId: "parent",
    ...(remote ? { ownerInstanceId: "peer" } : {}) };
  const parentKey = navigationThreadSelectionKey(parent);
  const children: NavigationPresentationEntry[] = ownerOrder.map((id) => ({
    key: navigationThreadSelectionKey({ ...parent, threadId: `child-${id}` }),
    placement: { kind: "child", parent },
  }));
  const resources = new Map<string, NavigationWindowResource>();
  const presentation = new Map<string, NavigationPresentationEntry[]>();
  const add = (id: string, query: NavigationQueryRequest["query"], entries: NavigationPresentationEntry[]) => {
    resources.set(id, { id, loading: false, state: createNavigationPageState({
      protocol: 2, inventory: "owner", consumer: "main-sidebar", query,
      ...(remote ? { federationTarget: { scope: "remote", instanceId: "peer" } } : {}),
    }) });
    presentation.set(id, entries);
  };
  // Directory pages can omit siblings assigned to another project, leaving
  // gaps in the native owner's absolute sibling positions.
  const mounted = children.filter((_, index) => index % 3 !== 2);
  add("children", { kind: "children", parent, directoryKey: "directory:repo" }, mounted);
  const read = () => readOwnerChildOrder(resources, presentation).get(parentKey);
  const select = (indices: number[]) => add("selected-context", { kind: "exact", includeAncestry: true,
    identities: indices.map((index) => ({ ...parent, threadId: `child-${ownerOrder[index]}` })) },
    indices.map((index) => ({ ...children[index]!, siblingOrder: index })));
  return { mounted, read, select };
}

// Oracle: the owner's child page already lists the saved order. Learning
// positions for any subset of those same siblings cannot change that order.
it("keeps the owner's page order through partial exact reads and selection changes", () => {
  fc.assert(fc.property(
    fc.uniqueArray(fc.integer(), { minLength: 2, maxLength: 24 }),
    fc.array(fc.array(fc.nat(), { maxLength: 8 }), { minLength: 1, maxLength: 16 }),
    fc.boolean(),
    (ownerOrder, selections, remote) => {
      const data = fixture(ownerOrder, remote);
      const expected = data.mounted.map((entry) => entry.key);
      expect(data.read()).toEqual(expected);
      for (const selection of selections) {
        data.select([...new Set(selection.map((index) => index % ownerOrder.length))]
          .filter((index) => index % 3 !== 2));
        expect(data.read()).toEqual(expected);
      }
    },
  ));
});

it("does not promote the second child when opening it fetches its sibling position", () => {
  const data = fixture([0, 1], true);
  const before = data.read();
  data.select([1]);
  expect(data.read()).toEqual(before);
});
