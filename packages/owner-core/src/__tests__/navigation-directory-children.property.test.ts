import { expect, it } from "vitest";
import fc from "fast-check";
import type { NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared";
import { projectNavigationQuery, type NavigationQueryIndex } from "../navigation-query-projection";
import { NavigationQueryStore } from "../navigation-query-store";

function inventory(projects: number[], parents: number[]): NavigationQueryIndex {
  const threads: NavigationThreadSummary[] = projects.map((project, index) => ({
    id: `thread-${index}`, source: "codex", title: `Thread ${index}`, titleSource: "explicit",
    linkedDirectories: [{ id: `project-${project}`, kind: "local", label: `Project ${project}`, path: `/project-${project}` }],
    inbox: { inInbox: false },
    ...(parents[index]! >= 0 ? { parentThreadId: `thread-${parents[index]}`, parentThreadBackend: "codex" as const } : {}),
  }));
  return { threads, directories: [...new Set(projects)].map((project) => ({
    key: `directory:/project-${project}`, kind: "directory", label: `Project ${project}`, path: `/project-${project}`,
    threadKeys: threads.filter((_, index) => projects[index] === project).map((thread) => `codex:${thread.id}`),
    needsAttentionCount: 0,
  })) };
}

function project(index: NavigationQueryIndex, query: NavigationQueryRequest["query"]) {
  return projectNavigationQuery({ index, request: { protocol: 2, consumer: "main-sidebar", query } });
}

// The inventory owns directory membership. Grouping must neither duplicate a
// thread into another directory nor remove the relationship from global lenses.
it("directory roots and child pages partition each project's membership", () => {
  fc.assert(fc.property(fc.array(fc.record({ project: fc.integer({ min: 0, max: 2 }),
    parent: fc.nat(30) }), { minLength: 2, maxLength: 16 }), (nodes) => {
    const projects = nodes.map((node) => node.project);
    const parents = nodes.map((node, index) => index === 0 ? -1 : node.parent % (index + 1) - 1);
    const index = inventory(projects, parents);
    for (const directory of index.directories) {
      const memberIds = new Set(directory.threadKeys.map((key) => key.slice("codex:".length)));
      const roots = project(index, { kind: "directory", directoryKey: directory.key });
      const rendered = roots.entries.map(({ row }) => row.id);
      for (const parent of index.threads) {
        const query = { kind: "children" as const, parent: { backend: parent.source, threadId: parent.id },
          directoryKey: directory.key };
        const children = project(index, query);
        const expected = memberIds.has(parent.id)
          ? index.threads.filter((thread) => memberIds.has(thread.id) && thread.parentThreadId === parent.id) : [];
        expect(children.entries.map(({ row }) => row.id).sort()).toEqual(expected.map((thread) => thread.id).sort());
        rendered.push(...children.entries.map(({ row }) => row.id));
      }
      expect(rendered.sort()).toEqual([...memberIds].sort());
      for (const { row } of roots.entries) {
        expect(row.ordinaryChildCount).toBe(index.threads.filter((thread) => memberIds.has(thread.id)
          && thread.parentThreadId === row.id).length);
      }
      for (const row of index.threads.filter((thread) => memberIds.has(thread.id))) {
        const selection = project(index, { kind: "exact", identities: [{ backend: row.source, threadId: row.id }],
          includeAncestry: true, ancestryScope: "directory" });
        expect(selection.entries.every((entry) => memberIds.has(entry.row.id))).toBe(true);
        expect(selection.selectionDirectory?.key).toBe(directory.key);
        expect(selection.entries.at(-1)?.row.id).toBe(row.id);
      }
    }
    for (const parent of index.threads) {
      expect(project(index, { kind: "children", parent: { backend: parent.source, threadId: parent.id } }).entries
        .map(({ row }) => row.id).sort()).toEqual(index.threads.filter((thread) => thread.parentThreadId === parent.id)
        .map((thread) => thread.id).sort());
    }
  }));
});

it("pages scoped children independently from the global group", async () => {
  const index = inventory([0, 0, 1, 0, 1], [-1, 0, 0, 0, 0]);
  const store = new NavigationQueryStore();
  const scoped: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", pageSize: 1,
    query: { kind: "children", parent: { backend: "codex", threadId: "thread-0" }, directoryKey: "directory:/project-0" } };
  const read = (request: NavigationQueryRequest) => store.readPage({ scopeKey: "viewer", request, loadIndex: async () => index });
  const first = await read(scoped);
  const global = await read({ ...scoped, pageSize: 10,
    query: { kind: "children", parent: { backend: "codex", threadId: "thread-0" } } });
  const next = await read({ ...scoped, cursor: first.nextCursor });
  expect(global.entries.map(({ row }) => row.id).sort()).toEqual(["thread-1", "thread-2", "thread-3", "thread-4"]);
  expect([...first.entries, ...next.entries].map(({ row }) => row.id).sort()).toEqual(["thread-1", "thread-3"]);
  expect(first.queryKey).not.toBe(global.queryKey);
  expect(first.selectionDirectory?.key).toBe("directory:/project-0");
  expect(next.complete).toBe(true);
  expect(next.nextCursor).toBeUndefined();
});

it("keeps a cross-project audit and its fixes in their own directory", () => {
  const index = inventory([0, 1, 1], [-1, 0, 1]);
  const root = { backend: "codex" as const, threadId: "thread-0" };
  const query = { kind: "children" as const, parent: root, directoryKey: "directory:/project-0" };
  expect(project(index, query).entries).toEqual([]);
  expect(project(index, { kind: "directory", directoryKey: "directory:/project-0" }).entries[0]?.row.ordinaryChildCount).toBe(0);
  const ownRoots = project(index, { kind: "directory", directoryKey: "directory:/project-1" });
  expect(ownRoots.entries.map(({ row }) => row.id)).toEqual(["thread-1"]);
  expect(ownRoots.entries[0]?.row.parentThreadId).toBe("thread-0");
  expect(project(index, { kind: "children", parent: root }).entries.map(({ row }) => row.id)).toEqual(["thread-1"]);
});

// The native owner's complete child query is the ordering oracle. Exact
// metadata batches must retain that order even when most siblings are absent.
it("gives exact owner rows their position in the native parent's complete child order", () => {
  fc.assert(fc.property(fc.uniqueArray(fc.integer(), { minLength: 2, maxLength: 32 }), (permutation) => {
    const index = inventory(Array(permutation.length + 1).fill(0), [-1, ...permutation.map(() => 0)]);
    const parent = index.threads[0]!;
    index.threads.slice(1).forEach((thread, position) => { thread.createdAt = position; });
    parent.subthreadOrder = permutation.map((value, position) => ({ value, id: index.threads[position + 1]!.id }))
      .sort((a, b) => a.value - b.value).filter((_, position) => position % 3 !== 0).map(({ id }) => id);
    const oracle = project(index, { kind: "children", parent: { backend: "codex", threadId: parent.id } });
    for (let offset = 1; offset < index.threads.length; offset += 3) {
      const query = { kind: "exact" as const, identities: index.threads.slice(offset, offset + 3)
        .map((thread) => ({ backend: thread.source, threadId: thread.id })) };
      const owner = projectNavigationQuery({ index, request: { protocol: 2, inventory: "owner", consumer: "main-sidebar", query } });
      for (const entry of owner.entries) {
        expect(entry.siblingOrder).toBe(oracle.entries.findIndex(({ row }) => row.id === entry.row.id));
      }
      expect(project(index, query).entries.every((entry) => entry.siblingOrder === undefined)).toBe(true);
    }
  }));
});
