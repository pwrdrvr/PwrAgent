import { expect, it } from "vitest";
import type { NavigationDirectoryRow } from "@pwragent/shared";
import { buildNavigationWindowDemand } from "../navigation-window-demand";

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
