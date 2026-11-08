import { expect, it } from "vitest";
import fc from "fast-check";
import type { NavigationDirectoryRow, NavigationQueryEntry, NavigationQueryRequest, NavigationRow } from "@pwragent/shared";
import { buildFederatedThreadRef } from "@pwragent/shared";
import { createNavigationPageState, navigationIdentityKey } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";
import { buildPagedDirectoryChildren, buildPagedDirectoryPresentation } from "../paged-directory-presentation";
import { createSubthreadTrays } from "../subthread-trays";

function fixture(projects: number[], parents: number[]) {
  const rows: NavigationRow[] = projects.map((project, index) => ({
    id: `thread-${index}`, source: "codex", title: `Thread ${index}`, titleSource: "explicit",
    ref: { backend: "codex", threadId: `thread-${index}` }, rowRevision: "r",
    linkedDirectories: [{ id: `project-${project}`, kind: "local", label: `Project ${project}`, path: `/project-${project}` }],
    inbox: { inInbox: false }, ordinaryChildCount: parents.filter((parent) => parent === index).length,
    nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown",
    ...(parents[index]! >= 0 ? { parentThreadId: `thread-${parents[index]}` } : {}),
  }));
  const resources = new Map<string, NavigationWindowResource>();
  const add = (id: string, query: NavigationQueryRequest["query"], entries: NavigationQueryEntry[]) => {
    resources.set(id, { id, loading: false, state: { ...createNavigationPageState({ protocol: 2, consumer: "main-sidebar", query }),
      page: { protocol: 2, queryKey: id, generation: "g", ownerEpoch: "owner", countsRevision: "r",
        coverage: { state: "complete" }, counts: { total: entries.length, active: 0, unread: 0, review: 0 }, entries, complete: true } } });
  };
  const directories: NavigationDirectoryRow[] = [...new Set(projects)].map((project) => ({
    key: `directory:/project-${project}`, kind: "directory", label: `Project ${project}`,
    counts: { total: projects.filter((value) => value === project).length, active: 0, unread: 0, review: 0 },
    pinnedRootCount: 0, unpinnedRootCount: 1, launchpadPresent: false,
  }));
  for (const directory of directories) {
    const member = (index: number) => directory.key === `directory:/project-${projects[index]}`;
    const roots = rows.filter((_, index) => member(index) && (parents[index]! < 0 || !member(parents[index]!)));
    add(`directory:${directory.key}`, { kind: "directory", directoryKey: directory.key }, roots.map((row, index) => ({
      row: { ...row, ordinaryChildCount: rows.filter((_, child) => member(child) && parents[child] === rows.indexOf(row)).length },
      placement: { kind: "root" }, orderKey: String(index),
    })));
  }
  for (const [index, row] of rows.entries()) {
    const descendants = rows.filter((_, child) => parents[child] === index);
    const entries = (children: NavigationRow[]): NavigationQueryEntry[] => children.map((child, order) => ({
      row: child, placement: { kind: "child", parent: row.ref }, orderKey: String(order),
    }));
    // A global lens's retained pages must never add rows to a directory tray.
    add(`global:${index}`, { kind: "children", parent: row.ref }, entries(descendants));
    const query = { kind: "children" as const, parent: row.ref, directoryKey: `directory:/project-${projects[index]}` };
    add(`children:${navigationIdentityKey(row.ref)}`, query,
      entries(descendants.filter((child) => projects[rows.indexOf(child)] === projects[index])));
  }
  return { rows, directories, resources, threadsByKey: new Map(rows.map((row) => [`codex:${row.id}`, row])) };
}

function offPageSelection(childCount: number, selectedIndex: number, remote: boolean) {
  const data = fixture(Array(childCount + 1).fill(0), [-1, ...Array(childCount).fill(0)]);
  const directory = data.directories[0]!;
  const parent = data.rows[0]!;
  const children = data.rows.slice(1);
  const selected = children[selectedIndex]!;
  const collection = data.resources.get(`directory:${directory.key}`)!;
  const childResource = data.resources.get(`children:${navigationIdentityKey(parent.ref)}`)!;
  if (remote) {
    for (const row of data.rows) {
      row.ref.ownerInstanceId = "peer";
      row.federation = { ref: buildFederatedThreadRef({ backend: row.source, instanceId: "peer", threadId: row.id }),
        instanceLabel: "Peer", capabilities: [] };
    }
    data.threadsByKey = new Map(data.rows.map((row) => [`remote:peer:codex:${row.id}`, row]));
  }
  // Only this directory's independently paged siblings are loaded. A retained
  // global child page would give the selected child an existing slot.
  data.resources.clear();
  data.resources.set(collection.id, collection);
  data.resources.set(childResource.id, childResource);
  const childPage = childResource.state.page!;
  const allEntries = childPage.entries;
  childResource.state.page = { ...childPage, complete: false, nextCursor: "next",
    entries: allEntries.filter((entry) => entry.row !== selected) };
  const selection: NavigationWindowResource = { ...collection, id: "selected-context", state: { ...collection.state,
    request: { protocol: 2, inventory: "owner", consumer: "main-sidebar",
      ...(remote ? { federationTarget: { scope: "remote", instanceId: "peer" } as const } : {}),
      query: { kind: "exact", identities: [selected.ref], includeAncestry: true, ancestryScope: "directory" } },
    page: { ...childPage, selectionDirectory: directory, entries: [
      collection.state.page!.entries[0]!,
      { row: selected, placement: { kind: "child", parent: parent.ref }, orderKey: "1", siblingOrder: selectedIndex },
    ] } } };
  data.resources.set(selection.id, selection);
  const render = () => {
    const model = buildPagedDirectoryPresentation({ ...data, directory });
    const trays = createSubthreadTrays(model.childThreadsByParentKey, model.unpinnedThreads, model.ownerChildOrder);
    return trays.subtree(`${remote ? "remote:peer:" : ""}codex:${parent.id}`).map((row) => row.id);
  };
  return { children, childResource, allEntries, render };
}

// Oracle: the owner's complete sibling order. Selecting a child missing from
// an otherwise current page inserts it in that order, and a refreshed page
// admitting the same child must preserve the displayed order.
it("positions an exact-only selection before and after its child page admits it", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 24 }), fc.nat(), fc.boolean(), (count, index, remote) => {
    const data = offPageSelection(count, index % count, remote);
    const expected = data.children.map((row) => row.id);
    expect(data.render()).toEqual(expected);
    expect(data.childResource.state.page!.nextCursor).toBe("next");
    expect(data.childResource.state.page!.entries).toHaveLength(count - 1);
    data.childResource.state.page = { ...data.childResource.state.page!, entries: data.allEntries, complete: true, nextCursor: undefined };
    expect(data.render()).toEqual(expected);
  }));
});

it("places selected A at position zero when only B and C are on the child page", () => {
  expect(offPageSelection(3, 0, true).render()).toEqual(["thread-1", "thread-2", "thread-3"]);
});

it("uses the owner's complete unpinned population even when no thread pages are loaded", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 1000 }), fc.integer({ min: 1, max: 100 }), (total, roots) => {
    const data = fixture([0], [-1]);
    const directory = { ...data.directories[0]!, directoryThreadsCollapsed: true,
      unpinnedRootCount: Math.min(total - 1, roots), unpinnedThreadCount: total };
    data.resources.clear();
    const presentation = buildPagedDirectoryPresentation({ ...data, directory });
    expect(presentation.directoryUnpinnedThreadCount).toBe(total);
  }));
});

it("retains the root count when an older serving instance omits the descendant count", () => {
  const data = fixture([0], [-1]);
  expect(buildPagedDirectoryPresentation({ ...data, directory: data.directories[0]! }).directoryUnpinnedThreadCount).toBe(1);
});

// Oracle: the serving instance's directory and scoped-child pages. Global
// relationship metadata and pages from another lens cannot change membership.
it("renders each thread exactly once in the directory its pages assign", () => {
  fc.assert(fc.property(fc.array(fc.record({ project: fc.integer({ min: 0, max: 2 }), parent: fc.nat(30) }),
    { minLength: 2, maxLength: 16 }), (nodes) => {
    const projects = nodes.map((node) => node.project);
    const parents = nodes.map((node, index) => index === 0 ? -1 : node.parent % (index + 1) - 1);
    const data = fixture(projects, parents);
    const children = buildPagedDirectoryChildren(data);
    for (const directory of data.directories) {
      const model = buildPagedDirectoryPresentation({ ...data, directory, children });
      const roots = [...model.directoryPinnedThreads, ...model.unpinnedThreads];
      const trays = createSubthreadTrays(model.childThreadsByParentKey, roots, model.ownerChildOrder);
      const rendered = roots.flatMap((row) => [row.id, ...trays.subtree(`codex:${row.id}`).map((child) => child.id)]);
      const expected = data.rows.filter((_, index) => directory.key === `directory:/project-${projects[index]}`).map((row) => row.id);
      expect(rendered.sort()).toEqual(expected.sort());
    }
  }));
});

it("does not pull another project's audit or fixes into its global parent's tray", () => {
  const data = fixture([0, 1, 1], [-1, 0, 1]);
  const parentProject = buildPagedDirectoryPresentation({ ...data, directory: data.directories[0]! });
  expect(parentProject.childThreadsByParentKey.get("codex:thread-0") ?? []).toEqual([]);
  const ownProject = buildPagedDirectoryPresentation({ ...data, directory: data.directories[1]! });
  expect(ownProject.unpinnedThreads.map((row) => row.id)).toEqual(["thread-1"]);
  expect(ownProject.childThreadsByParentKey.get("codex:thread-1")?.map((row) => row.id)).toEqual(["thread-2"]);
});

it("uses the selected exact page's scoped counts for off-page remote pins", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 1, max: 30 }), (scopedCount, otherChildren) => {
    const data = fixture([0], [-1]);
    const directory = data.directories[0]!;
    const row = data.rows[0]!;
    row.ref.ownerInstanceId = "peer";
    row.federation = { ref: buildFederatedThreadRef({ backend: row.source, instanceId: "peer", threadId: row.id }), instanceLabel: "Peer", capabilities: [] };
    row.pinnedRank = "1";
    row.ordinaryChildCount = scopedCount + otherChildren;
    const key = `remote:peer:codex:${row.id}`;
    data.threadsByKey = new Map([[key, row]]);
    const collection = data.resources.get(`directory:${directory.key}`)!;
    collection.state.page!.entries = [];
    data.resources.set(`directory-pins:${directory.key}`, { ...collection, id: `directory-pins:${directory.key}` });
    const selection: NavigationWindowResource = { ...collection, id: "selected-viewer-mount", state: { ...collection.state,
      request: { protocol: 2, inventory: "viewer", consumer: "main-sidebar", query: { kind: "exact", identities: [row.ref], ancestryScope: "directory" } },
      page: { ...collection.state.page!, selectionDirectory: directory,
        entries: [{ row: { ...row, ordinaryChildCount: scopedCount }, placement: { kind: "root" }, orderKey: "0" }] } } };
    data.resources.set(selection.id, selection);
    data.resources.set("selected-context", { ...selection, id: "selected-context", state: { ...selection.state,
      page: { ...selection.state.page!, entries: [{ ...selection.state.page!.entries[0]!, row }] } } });
    const model = buildPagedDirectoryPresentation({ ...data, directory });
    expect(model.directoryPinnedThreads).toEqual([row]);
    expect(model.ordinaryChildCounts.get(key)).toBe(scopedCount);
    const otherDirectory = { ...directory, key: "directory:/elsewhere" };
    expect(buildPagedDirectoryPresentation({ ...data, directory: otherDirectory }).ordinaryChildCounts.has(key)).toBe(false);
    // A retained selection cannot replace a count already admitted by the
    // directory's own collection page.
    collection.state.page!.entries = [{ ...selection.state.page!.entries[0]!, row: { ...row, ordinaryChildCount: scopedCount + 1 } }];
    expect(buildPagedDirectoryPresentation({ ...data, directory }).ordinaryChildCounts.get(key)).toBe(scopedCount + 1);
  }));
});

it("orders only mounted directory children by native owner ranks across exact batches", () => {
  fc.assert(fc.property(fc.uniqueArray(fc.integer(), { minLength: 3, maxLength: 32 }), (savedOrder) => {
    const data = fixture(Array(savedOrder.length + 1).fill(0), [-1, ...savedOrder.map(() => 0)]);
    const directory = data.directories[0]!;
    const parent = data.rows[0]!;
    const mounted = data.rows.slice(1).filter((_, index) => index % 3 !== 0);
    const rank = new Map(savedOrder.map((value, index) => ({ value, id: data.rows[index + 1]!.id }))
      .sort((a, b) => a.value - b.value).map(({ id }, index) => [id, index]));
    for (const row of data.rows) {
      row.ref.ownerInstanceId = "peer";
      row.federation = { ref: buildFederatedThreadRef({ backend: row.source, instanceId: "peer", threadId: row.id }), instanceLabel: "Peer", capabilities: [] };
      row.createdAt = Number(row.id.slice("thread-".length));
    }
    data.threadsByKey = new Map(data.rows.map((row) => [`remote:peer:codex:${row.id}`, row]));
    const collection = data.resources.get(`directory:${directory.key}`)!;
    const childId = `children:${navigationIdentityKey(parent.ref)}`;
    data.resources.clear();
    data.resources.set(collection.id, collection);
    data.resources.set(childId, { ...collection, id: childId, state: { ...collection.state,
      request: { protocol: 2, inventory: "viewer", consumer: "main-sidebar", query: { kind: "children", parent: parent.ref, directoryKey: directory.key } },
      page: { ...collection.state.page!, entries: [...mounted].reverse().map((row, index) => ({ row,
        placement: { kind: "child", parent: parent.ref }, orderKey: String(index) })) } } });
    for (let offset = 0; offset < mounted.length; offset += 3) {
      const batch = mounted.slice(offset, offset + 3);
      const id = `visible-owner:peer:${offset}`;
      data.resources.set(id, { ...collection, id, state: { ...collection.state,
        request: { protocol: 2, inventory: "owner", consumer: "main-sidebar", federationTarget: { scope: "remote", instanceId: "peer" },
          query: { kind: "exact", identities: batch.map((row) => row.ref) } },
        page: { ...collection.state.page!, entries: batch.map((row, index) => ({ row, siblingOrder: rank.get(row.id),
          placement: { kind: "child", parent: parent.ref }, orderKey: String(index) })) } } });
    }
    const model = buildPagedDirectoryPresentation({ ...data, directory });
    const trays = createSubthreadTrays(model.childThreadsByParentKey, model.unpinnedThreads, model.ownerChildOrder);
    expect(trays.subtree(`remote:peer:codex:${parent.id}`).map((row) => row.id))
      .toEqual([...mounted].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!).map((row) => row.id));
  }));
});
