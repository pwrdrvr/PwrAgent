import fc from "fast-check";
import { expect, it } from "vitest";
import { buildThreadIdentityKey, type AppServerBackendKind, type AppServerThreadSummary } from "@pwragent/shared";
import { projectNavigationQuery } from "@pwragent/owner-core/navigation-query-projection";
import { readNavigationArchiveGroup } from "../../renderer/src/lib/navigation-archive-group";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

async function archiveTree(parents: number[], backends: AppServerBackendKind[], targetIndex = 0) {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  const threads: AppServerThreadSummary[] = parents.map((_, index) => ({
    id: `thread-${index}`, source: backends[index]!, title: `Thread ${index}`, titleSource: "explicit", linkedDirectories: [],
  }));
  const archived = new Set<string>();
  const key = (thread: AppServerThreadSummary) => buildThreadIdentityKey(thread.source, thread.id);
  try {
    for (const [index, parent] of parents.entries()) {
      if (parent < 0) continue;
      await store.setThreadParent({ backend: threads[index]!.source, threadId: threads[index]!.id,
        parentThreadBackend: threads[parent]!.source, parentThreadId: threads[parent]!.id });
    }
    const index = store.readNavigationQueryIndex({ backend: "all", threads });
    const plan = await readNavigationArchiveGroup({ thread: index.threads[targetIndex]!, api: {
      getNavigationQueryPage: async (request) => {
        const projected = projectNavigationQuery({ index, request });
        const offset = Number(request.cursor ?? 0);
        const entries = projected.entries.slice(offset, offset + request.pageSize!);
        const next = offset + entries.length;
        return { ...projected, entries, protocol: 2, generation: "fixture", ownerEpoch: "fixture", countsRevision: "fixture",
          complete: next === projected.entries.length,
          ...(next < projected.entries.length ? { nextCursor: String(next) } : {}) };
      },
    } });
    // Oracle: replay the persisted parent edges, independent of display placement.
    const belongs = (candidate: number): boolean => {
      for (let cursor = candidate; cursor >= 0; cursor = parents[cursor]!) {
        if (cursor === targetIndex) return true;
      }
      return false;
    };
    expect(new Set(plan.map((member) => buildThreadIdentityKey(member.source, member.id))))
      .toEqual(new Set(threads.filter((_, candidate) => belongs(candidate)).map(key)));
    expect(plan.at(-1)?.id).toBe(threads[targetIndex]!.id);
    for (const member of plan) {
      const overlay = await store.getThreadOverlayState({ backend: member.source, threadId: member.id });
      const row = index.threads.find((thread) => thread.id === member.id && thread.source === member.source)!;
      expect([row.parentThreadId, row.parentThreadBackend, row.parentThreadInstanceId])
        .toEqual([overlay?.parentThreadId, overlay?.parentThreadBackend, overlay?.parentThreadInstanceId]);
      const position = threads.findIndex((thread) => key(thread) === buildThreadIdentityKey(member.source, member.id));
      // Every direct child must already be archived before its parent's mutation.
      for (const [child, parent] of parents.entries()) {
        if (parent === position) expect(archived.has(key(threads[child]!))).toBe(true);
      }
      await store.observeArchivedThreads([{ backend: member.source, threadId: member.id }], 1000, { promoteSubthreads: true });
      archived.add(buildThreadIdentityKey(member.source, member.id));
    }
    expect(archived.size).toBe(plan.length);
  } finally { db.close(); }
}

it("archives a six-thread Claude group with nested children against their immediate saved parents", async () => {
  await archiveTree([-1, 0, 1, 0, 1, 2], Array.from({ length: 6 }, () => "claude"));
});

it("archives a grandchild before its parent in the smallest nested group", async () => {
  await archiveTree([-1, 0, 1], ["codex", "codex", "codex"]);
});

it("plans exactly the requested subtree and archives descendants before unchanged saved parents", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({ parent: fc.nat(), backend: fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:kimi") }),
      { minLength: 3, maxLength: 16, size: "max" }), fc.nat(),
    async (nodes, target) => {
      const parents = nodes.map((node, index) => index === 0 ? -1 : index === 2 ? 1 : node.parent % index);
      await archiveTree(parents, nodes.map((node) => node.backend), target % nodes.length);
    },
  ), { numRuns: 25 });
});
