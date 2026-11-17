import { expect, it } from "vitest";
import fc from "fast-check";
import type { NavigationIdentity, NavigationQueryRequest } from "@pwragent/shared";
import { createNavigationPageState, navigationThreadSelectionKey } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";
import type { NavigationPresentedThread } from "../../../lib/navigation-loaded-rows";
import { projectPagedDirectoryChildren } from "../usePagedDirectoryChildren";
import { hydrateHoverStableSidebarSnapshot } from "../hover-stable-sidebar-snapshot";
import {
  readOwnerChildOrder,
  type NavigationPresentationEntry,
} from "../navigation-presentation-order";

function fixture(ownerOrder: number[], remote: boolean, crossProvider = false) {
  const parent: NavigationIdentity = { backend: crossProvider ? "claude" : "codex", threadId: "parent",
    ...(remote ? { ownerInstanceId: "peer" } : {}) };
  const parentKey = navigationThreadSelectionKey(parent);
  const children: NavigationPresentationEntry[] = ownerOrder.map((id) => ({
    key: navigationThreadSelectionKey({ ...parent, backend: "codex", threadId: `child-${id}` }),
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
    identities: indices.map((index) => ({ ...parent, backend: "codex", threadId: `child-${ownerOrder[index]}` })) },
    indices.map((index) => ({ ...children[index]!, siblingOrder: index })));
  return { mounted, read, select, resources, presentation, parent, parentKey };
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

it("retains only admitted owner positions and invalidates the child plan when positions or relationships change", () => {
  fc.assert(fc.property(fc.uniqueArray(fc.integer(), { minLength: 4, maxLength: 24 }), fc.boolean(), (ids, crossProvider) => {
    const data = fixture(ids, true, crossProvider);
    const expected = data.mounted.map((entry) => entry.key);
    // Viewer placement is complete but differs from native owner order.
    data.presentation.set("children", [...data.mounted].reverse());
    class CountedRows extends Map<string, NavigationPresentedThread> {
      reads = 0;
      override get(key: string) { this.reads += 1; return super.get(key); }
    }
    const rows = new CountedRows(data.mounted.map((entry, position) => {
      const id = entry.key.split(":").at(-1)!;
      return [entry.key, { id, source: "codex", title: id, titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
        parentThreadId: data.parent.threadId, parentThreadBackend: crossProvider ? undefined : "codex",
        federation: { ref: { backend: "codex", threadId: id, target: { scope: "remote", instanceId: "peer" } }, instanceLabel: "Peer" },
        ownerSiblingPosition: { parentKey: data.parentKey, position },
      }];
    }));
    const params = { resources: data.resources, presentationOrder: data.presentation, threadsByKey: rows };
    let plan = projectPagedDirectoryChildren(undefined, params);
    const order = () => plan.keys.get("directory:repo")!.ownerChildOrder.get(data.parentKey);
    expect(order()).toEqual(expected);
    expect(rows.reads).toBe(3 * expected.length);
    rows.reads = 0;
    expect(projectPagedDirectoryChildren(plan, params)).toBe(plan);
    expect(rows.reads).toBe(2 * expected.length);
    // A fresh owner reorder changes only the accepted scalar positions.
    for (const [key, row] of rows) rows.set(key, { ...row, ownerSiblingPosition: {
      parentKey: data.parentKey, position: expected.length - 1 - row.ownerSiblingPosition!.position,
    } });
    rows.reads = 0;
    plan = projectPagedDirectoryChildren(plan, params);
    expect(rows.reads).toBeLessThanOrEqual(4 * expected.length);
    expect(order()).toEqual([...expected].reverse());
    // Move to another parent (or owner) while carrying old display metadata.
    // Old positions must not rank this new relationship.
    for (const mismatch of ["parent", "owner"] as const) {
      for (const [key, row] of rows) rows.set(key, { ...row,
        ownerSiblingPosition: { parentKey: data.parentKey, position: expected.indexOf(key) },
        ...(mismatch === "parent" ? { parentThreadId: "other-parent" }
          : { parentThreadId: data.parent.threadId, parentThreadInstanceId: "other-owner" }),
      });
      plan = projectPagedDirectoryChildren(plan, params);
      expect(order()).toEqual([...expected].reverse());
    }
    // A current owner can explicitly withdraw a position. Cached exact
    // metadata cannot restore it after acceptance.
    for (const [key, row] of rows) rows.set(key, { ...row, parentThreadId: data.parent.threadId,
      parentThreadInstanceId: undefined, ownerSiblingPosition: null });
    data.select(ids.map((_, index) => index).filter((index) => index % 3 !== 2));
    plan = projectPagedDirectoryChildren(plan, params);
    expect(order()).toEqual([...expected].reverse());
    // Collection membership remains the oracle, including after removal.
    data.presentation.set("children", data.presentation.get("children")!.slice(1));
    plan = projectPagedDirectoryChildren(plan, params);
    expect(order()).toEqual([...expected].reverse().slice(1));
    // Reusing the thread id on another owner cannot carry its old position.
    const parent = { ...data.parent, ownerInstanceId: "other" };
    const parentKey = navigationThreadSelectionKey(parent);
    const current = data.presentation.get("children")!;
    const moved = current.map((entry) => ({ ...entry, key: entry.key.replace("remote:peer:", "remote:other:"),
      placement: { kind: "child" as const, parent } }));
    data.presentation.set("children", moved);
    const resource = data.resources.get("children")!;
    data.resources.set("children", { ...resource, state: { ...resource.state,
      request: { ...resource.state.request, query: { kind: "children", parent, directoryKey: "directory:repo" } } } });
    const previous = new Map(rows);
    rows.clear();
    moved.forEach((entry, index) => {
      const row = previous.get(current[index]!.key)!;
      rows.set(entry.key, { ...row, ownerSiblingPosition: { parentKey: data.parentKey, position: index },
        federation: { ...row.federation!, ref: { ...row.federation!.ref, target: { scope: "remote", instanceId: "other" } } } });
    });
    plan = projectPagedDirectoryChildren(plan, params);
    expect(plan.keys.get("directory:repo")!.ownerChildOrder.get(parentKey)).toEqual(moved.map((entry) => entry.key));
  }));
});

it("holds accepted sibling positions while hover hydration updates live row content", () => {
  const position = fc.oneof(fc.constant(undefined), fc.constant(null), fc.record({ parentKey: fc.string(), position: fc.nat() }));
  fc.assert(fc.property(position, fc.array(position), (initial, changes) => {
    const thread: NavigationPresentedThread = { id: "child", source: "codex", title: "Child", titleSource: "explicit",
      linkedDirectories: [], inbox: { inInbox: false }, ownerSiblingPosition: initial };
    const frozen = { threads: [thread], directories: [], order: new Map(), visibleKeys: ["codex:child"] };
    for (const [index, next] of changes.entries()) {
      const title = `Update ${index}`;
      const hydrated = hydrateHoverStableSidebarSnapshot(frozen, { ...frozen,
        threads: [{ ...thread, title, ownerSiblingPosition: next }] });
      expect(hydrated.threads[0]!.ownerSiblingPosition).toBe(initial);
      expect(hydrated.threads[0]!.title).toBe(title);
    }
  }));
});
