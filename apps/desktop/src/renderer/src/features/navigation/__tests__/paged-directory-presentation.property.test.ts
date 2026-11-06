import { expect, it } from "vitest";
import fc from "fast-check";
import type { NavigationDirectoryRow, NavigationQueryEntry, NavigationQueryRequest, NavigationRow } from "@pwragent/shared";
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
