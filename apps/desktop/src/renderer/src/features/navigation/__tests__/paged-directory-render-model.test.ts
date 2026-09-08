import { expect, it } from "vitest";
import type { NavigationDirectoryRow, NavigationQueryEntry } from "@pwragent/shared";
import { createNavigationPageState, navigationIdentityKey } from "../../../lib/navigation-query-state";
import { buildPagedDirectoryRenderModel } from "../paged-directory-render-model";

const descriptor: NavigationDirectoryRow = { key: "directory:repo", kind: "directory", label: "Repo",
  counts: { total: 1000, active: 25, unread: 50, review: 30 }, pinnedRootCount: 125, unpinnedRootCount: 800, launchpadPresent: false };
const parent = { backend: "codex" as const, threadId: "parent", ownerInstanceId: "owner" };
function entry(id: string, placement: NavigationQueryEntry["placement"] = { kind: "root" }): NavigationQueryEntry {
  return { orderKey: id, placement, row: { ref: { ...parent, threadId: id }, id, source: "codex", rowRevision: "r", title: id,
    titleSource: "derived", inbox: { inInbox: false }, linkedDirectories: [], ordinaryChildCount: 0, nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown" } };
}
function range(entries: NavigationQueryEntry[]) {
  return { ...createNavigationPageState({ protocol: 2, consumer: "main-sidebar", query: { kind: "directory", directoryKey: descriptor.key } }),
    page: { protocol: 2 as const, queryKey: "q", generation: "g", ownerEpoch: "e", countsRevision: "r", counts: descriptor.counts,
      coverage: { state: "complete" as const }, entries, complete: false, nextCursor: "more" },
  };
}

it("collapsed directory counts do not require any member row", () => {
  const model = buildPagedDirectoryRenderModel({ descriptor });
  expect(model.counts).toEqual(descriptor.counts);
  expect(model.pinnedRootCount).toBe(125);
  expect(model.unpinnedRootCount).toBe(800);
  expect(model.roots).toEqual([]);
  expect(model.rootPage).toBeUndefined();
});

it("does not turn an early child into a root while its parent is on a later page", () => {
  const child = entry("child", { kind: "child", parent });
  const childPages = new Map([[navigationIdentityKey(parent), range([child])]]);
  const before = buildPagedDirectoryRenderModel({ descriptor, rootPage: range([entry("first")]), childPages });
  expect(before.roots.map(({ row }) => row.id)).toEqual(["first"]);
  expect([...before.unloadedParentKeys]).toEqual([navigationIdentityKey(parent)]);
  const after = buildPagedDirectoryRenderModel({ descriptor, rootPage: range([entry("first"), entry("parent")]), childPages });
  expect(after.roots.map(({ row }) => row.id)).toEqual(["first", "parent"]);
  expect(after.childrenByParent.get(navigationIdentityKey(parent))).toEqual([child]);
  expect(after.unloadedParentKeys.size).toBe(0);
  expect(after.counts.total).toBe(1000);
});

it("preserves owner page order and never attaches a same-id foreign child", () => {
  const foreign = entry("foreign", { kind: "child", parent: { ...parent, ownerInstanceId: "another-owner" } });
  const model = buildPagedDirectoryRenderModel({ descriptor, rootPage: range([entry("z"), entry("a")]),
    childPages: new Map([[navigationIdentityKey(parent), range([foreign])]]),
  });
  expect(model.roots.map(({ row }) => row.id)).toEqual(["z", "a"]);
  expect(model.childrenByParent.size).toBe(0);
});
