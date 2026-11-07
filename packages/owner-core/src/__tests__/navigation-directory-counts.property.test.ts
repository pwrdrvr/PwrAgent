import { expect, it } from "vitest";
import fc from "fast-check";
import { buildFederatedThreadRef, type NavigationThreadSummary } from "@pwragent/shared";
import { projectNavigationQuery, type NavigationQueryIndex } from "../navigation-query-projection";

type Node = { project: number; parent: number; pinned: boolean; remote: boolean };

function checkCounts(nodes: Node[]) {
  const threads: NavigationThreadSummary[] = nodes.map((node, index) => ({
    id: `thread-${index}`, source: "codex", title: `Thread ${index}`, titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false },
    ...(node.pinned ? { pinnedRank: "1" } : {}),
    ...(node.remote ? { federation: { ref: buildFederatedThreadRef({ backend: "codex", threadId: `thread-${index}`,
      instanceId: "peer" }), instanceLabel: "Peer" } } : {}),
    ...(node.parent >= 0 ? { parentThreadId: `thread-${node.parent}`, parentThreadBackend: "codex" as const,
      ...(nodes[node.parent]!.remote ? { parentThreadInstanceId: "peer" } : {}) } : {}),
  }));
  const key = (index: number) => nodes[index]!.remote ? `remote:peer:codex:thread-${index}` : `codex:thread-${index}`;
  const index: NavigationQueryIndex = { threads, directories: [0, 1].map((project) => ({
    key: `project-${project}`, kind: "directory", label: `Project ${project}`, needsAttentionCount: 0,
    threadKeys: nodes.flatMap((node, index) => node.project === project ? [key(index)] : []),
  })) };
  const result = projectNavigationQuery({ index, request: { protocol: 2, consumer: "main-sidebar",
    query: { kind: "directory-index" }, pageSize: 1 } });
  for (const directory of result.directories) {
    const project = Number(directory.key.slice("project-".length));
    // Slow oracle: walk each member to its oldest ancestor in this directory.
    // A child's own pin cannot move it out of its root's section.
    const members = nodes.map((_, index) => index).filter((index) => nodes[index]!.project === project);
    const root = (index: number): number => {
      const parent = nodes[index]!.parent;
      return parent >= 0 && nodes[parent]!.project === project ? root(parent) : index;
    };
    expect(directory).toMatchObject({
      unpinnedThreadCount: members.filter((index) => !nodes[root(index)]!.pinned).length,
      unpinnedRootCount: members.filter((index) => root(index) === index && !nodes[index]!.pinned).length,
      pinnedRootCount: members.filter((index) => root(index) === index && nodes[index]!.pinned).length,
    });
  }
}

it("counts a directory root, child and grandchild even before their pages load", () => {
  checkCounts([
    { project: 0, parent: -1, pinned: true, remote: false },
    { project: 0, parent: -1, pinned: false, remote: false },
    { project: 0, parent: 1, pinned: false, remote: false },
    { project: 0, parent: 2, pinned: false, remote: false },
  ]);
});

it("counts exactly the directory forest under unpinned roots across owners and project boundaries", () => {
  fc.assert(fc.property(fc.array(fc.record({ project: fc.integer({ min: 0, max: 1 }), parent: fc.nat(),
    pinned: fc.boolean(), remote: fc.boolean() }), { minLength: 1, maxLength: 50 }), (generated) => {
    const nodes: Node[] = [];
    for (const [index, node] of generated.entries()) {
      const parent = index === 0 ? -1 : node.parent % (index + 1) - 1;
      nodes.push({ ...node, parent, remote: parent >= 0 ? nodes[parent]!.remote : node.remote });
    }
    checkCounts(nodes);
  }), { numRuns: 300 });
});
