import { expect, it } from "vitest";
import type { NavigationDirectoryRow, NavigationIdentity, NavigationQueryPage } from "@pwragent/shared";
import { buildNavigationWindowDemand, visibleDisclosedNavigationParents } from "../navigation-window-demand";

const directories: NavigationDirectoryRow[] = Array.from({ length: 100 }, (_, index) => ({
  key: `directory:${index}`, kind: "directory", label: `Project ${index}`,
  counts: { total: 1000, active: 10, unread: 12, review: 2 }, pinnedRootCount: 3, unpinnedRootCount: 997,
  launchpadPresent: true,
}));
const base = { browseMode: "directories" as const, attentionView: { id: "window", promoteOnTurnEnd: true }, directories,
  expandedByKey: {}, unpinnedExpandedByKey: {} };

it("cold navigation fetches only visible membership and collapsed directories use counts only", () => {
  expect([...buildNavigationWindowDemand(base).keys()]).toEqual(["directory-index"]);
  const demand = buildNavigationWindowDemand({ ...base, expandedByKey: { "directory:42": true } });
  expect([...demand.keys()]).toEqual(["directory-index", "directory:directory:42"]);
  expect(demand.get("directory:directory:42")).toMatchObject({ pageSize: 10, query: { kind: "directory", directoryKey: "directory:42", roots: "all" } });
});

it("selection can survive an unloaded project and explicit collapse overrides automatic reveal", () => {
  const selectedRef = { backend: "codex" as const, threadId: "off-page" };
  const demand = buildNavigationWindowDemand({ ...base, selectedRef, selectedDirectoryKeys: ["directory:42"], expandedByKey: { "directory:42": false } });
  expect([...demand.keys()]).toEqual(["directory-index", "selected-context"]);
  expect(demand.get("selected-context")?.query).toEqual({ kind: "exact", identities: [selectedRef], includeAncestry: true });
});

it("unpinned disclosure and child disclosure create independent explicit demand", () => {
  const parent = { backend: "codex" as const, threadId: "parent" };
  const demand = buildNavigationWindowDemand({ ...base, expandedByKey: { "directory:42": true },
    unpinnedExpandedByKey: { "directory:42": false }, disclosedParents: [parent] });
  expect(demand.get("directory:directory:42")?.query).toMatchObject({ roots: "pinned" });
  expect([...demand.values()].find((value) => value.query.kind === "children")).toMatchObject({ pageSize: 10, query: { kind: "children", parent } });
});

it("changing lens removes directory membership demand while preserving owner Attention session", () => {
  const demand = buildNavigationWindowDemand({ ...base, browseMode: "attention", expandedByKey: { "directory:42": true } });
  expect([...demand.keys()]).toEqual(["directory-index", "lens"]);
  expect(demand.get("lens")).toMatchObject({ pageSize: 10, attentionView: base.attentionView, query: { kind: "lens", lens: "attention" } });
});


it("waits for selected ancestry before opening its root directory range", () => {
  const selectedRef = { backend: "codex" as const, threadId: "child" };
  const pending = { ...base, selectedRef, selectedDirectoryKeys: ["directory:42"], selectedContextReady: false };
  expect([...buildNavigationWindowDemand(pending).keys()]).toEqual(["directory-index", "selected-context"]);
  const root = { backend: "codex" as const, threadId: "off-page-root" };
  const ready = buildNavigationWindowDemand({ ...pending, selectedContextReady: true, selectedRootRef: root });
  expect(ready.get("directory:directory:42")).toMatchObject({ pageSize: 10, anchor: { kind: "thread", ref: root } });
});

it("routes disclosed children and viewer drafts to their explicit owners", () => {
  const remote = { backend: "codex" as const, threadId: "same-id", ownerInstanceId: "peer" };
  const local = { backend: "codex" as const, threadId: "same-id" };
  const demand = buildNavigationWindowDemand({ ...base, browseMode: "drafts", disclosedParents: [remote], draftRefs: [remote, local] });
  expect([...demand.values()].find((value) => value.query.kind === "children")).toMatchObject({ federationTarget: { scope: "remote", instanceId: "peer" } });
  expect(demand.get('drafts:"peer":0')).toMatchObject({ federationTarget: { scope: "remote", instanceId: "peer" }, query: { identities: [remote] } });
  expect(demand.get('drafts:"":0')?.federationTarget).toBeUndefined();
  expect(demand.get('drafts:"":0')?.query).toMatchObject({ identities: [local] });
});


it("does not demand children of off-page selections, collapsed ancestors, or inactive collections", () => {
  const ref = (threadId: string): NavigationIdentity => ({ backend: "codex", threadId });
  const page = (...ids: string[]): NavigationQueryPage => ({ protocol: 2, queryKey: "q", generation: "g", ownerEpoch: "o",
    countsRevision: "c", coverage: { state: "complete" }, counts: { total: 20, active: 0, unread: 0, review: 0 }, complete: true,
    entries: ids.map((id) => ({ row: { ref: ref(id), rowRevision: "r", id, source: "codex", title: id,
      titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false }, ordinaryChildCount: 1,
      nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "unknown" }, placement: { kind: "root" }, orderKey: id })),
  });
  const pages = new Map([
    ["lens", page("visible")], ["selected-context", page("off-page")],
    ["directory:hidden", page("hidden")], ['children:[null,"codex","visible"]', page("child")],
    ['children:[null,"codex","child"]', page("grandchild")],
  ]);
  const disclosedParents = [ref("visible"), ref("child"), ref("grandchild"), ref("off-page"), ref("hidden")];
  expect(visibleDisclosedNavigationParents({ collectionIds: ["lens", "selected-context"], pages, disclosedParents }))
    .toEqual([ref("visible"), ref("child"), ref("grandchild")]);
  expect(visibleDisclosedNavigationParents({ collectionIds: ["lens"], pages,
    disclosedParents: disclosedParents.filter((item) => item.threadId !== "child") })).toEqual([ref("visible")]);
  expect(visibleDisclosedNavigationParents({ collectionIds: ["directory:other", "selected-context"], pages, disclosedParents })).toEqual([]);
});
