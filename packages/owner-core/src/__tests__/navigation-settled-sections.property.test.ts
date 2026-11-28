import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  NavigationQuery,
  NavigationQueryRequest,
  NavigationSnapshot,
  NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import { listNavigationDirectoryUnpinnedRoots, projectNavigationQuery } from "../navigation-query-projection";

/**
 * A project's roots are drawn in exactly one section: pins, Unpinned or
 * Settled. The owner answers each section as its own query, so the three
 * answers must partition the roots, and the counts on the project row must
 * match them. A profile that never settles must read exactly what it read
 * before Settle existed.
 */

type RootSpec = { pinned: boolean; settled: boolean; children: number; childSettled: boolean };

const rootSpec = fc.record({
  pinned: fc.boolean(),
  settled: fc.boolean(),
  children: fc.integer({ min: 0, max: 2 }),
  // A child's own settle never moves it out of its root's section.
  childSettled: fc.boolean(),
});

function buildThreads(specs: readonly RootSpec[], allowSettled: boolean): NavigationThreadSummary[] {
  const threads: NavigationThreadSummary[] = [];
  specs.forEach((spec, index) => {
    const id = `r${index}`;
    threads.push({
      id, source: "codex", title: `Root ${index}`, titleSource: "derived",
      createdAt: index + 1, updatedAt: index + 1,
      linkedDirectories: [{ id: "repo", kind: "local", label: "repo", path: "/repo" }],
      inbox: { inInbox: false },
      ...(spec.pinned ? { pinnedRank: String(1_000 + index) } : {}),
      ...(allowSettled && spec.settled ? { settledAt: 50 + index } : {}),
    });
    for (let child = 0; child < spec.children; child += 1) {
      threads.push({
        id: `${id}c${child}`, source: "codex", title: `Child ${index}.${child}`, titleSource: "derived",
        createdAt: 1_000 + index * 10 + child, updatedAt: 1_000 + index * 10 + child,
        linkedDirectories: [{ id: "repo", kind: "local", label: "repo", path: "/repo" }],
        inbox: { inInbox: false }, parentThreadId: id,
        ...(allowSettled && spec.childSettled ? { settledAt: 7 } : {}),
      });
    }
  });
  return threads;
}

function index(threads: NavigationThreadSummary[]): NavigationSnapshot {
  return {
    backend: "all", fetchedAt: 1, unchanged: false, threads, inboxThreadKeys: [],
    directories: [{
      key: "directory:/repo", kind: "directory", label: "repo", path: "/repo",
      threadKeys: threads.map((thread) => `${thread.source}:${thread.id}`),
      needsAttentionCount: 0,
    }],
    launchpadDefaults: { backend: "codex", executionMode: "default" },
  };
}

function request(query: NavigationQuery): NavigationQueryRequest {
  return { protocol: 2, consumer: "main-sidebar", pageSize: 100, query };
}

function rootIds(snapshot: NavigationSnapshot, query: NavigationQuery): string[] {
  return projectNavigationQuery({ index: snapshot, request: request(query) }).entries
    .filter((entry) => entry.placement.kind === "root")
    .map((entry) => entry.row.id);
}

function directoryRow(snapshot: NavigationSnapshot) {
  const page = projectNavigationQuery({ index: snapshot, request: request({ kind: "directory-index" }) });
  return page.directories!.find((directory) => directory.key === "directory:/repo")!;
}

const directory = { kind: "directory", directoryKey: "directory:/repo" } as const;
const specs = fc.array(rootSpec, { minLength: 1, maxLength: 40, size: "max" });

describe("Settled sections in a project", () => {
  it("draws each root in exactly one of pins, Unpinned and Settled", () => {
    fc.assert(fc.property(specs, (roots) => {
      const snapshot = index(buildThreads(roots, true));
      const pinned = rootIds(snapshot, { ...directory, roots: "pinned" });
      const unpinned = rootIds(snapshot, { ...directory, roots: "unpinned", settled: "exclude" });
      const settled = rootIds(snapshot, { ...directory, roots: "unpinned", settled: "only" });
      const drawn = [...pinned, ...unpinned, ...settled];
      expect(new Set(drawn).size).toBe(drawn.length);
      expect(new Set(drawn)).toEqual(new Set(roots.map((_, i) => `r${i}`)));
      // A pin wins: a pinned root is never in Settled, whatever is stored.
      expect(settled).toEqual(roots.flatMap((spec, i) => !spec.pinned && spec.settled ? [`r${i}`] : [])
        .sort((left, right) => settled.indexOf(left) - settled.indexOf(right)));
      expect(unpinned.every((id) => !roots[Number(id.slice(1))]!.settled || roots[Number(id.slice(1))]!.pinned)).toBe(true);
    }));
  });

  it("counts Settled from the owner's roots, with each subtree filed under its root", () => {
    fc.assert(fc.property(specs, (roots) => {
      const row = directoryRow(index(buildThreads(roots, true)));
      const settledRoots = roots.filter((spec) => !spec.pinned && spec.settled);
      const unpinnedRoots = roots.filter((spec) => !spec.pinned);
      expect(row.unpinnedRootCount).toBe(unpinnedRoots.length);
      expect(row.unpinnedThreadCount).toBe(unpinnedRoots.reduce((sum, spec) => sum + 1 + spec.children, 0));
      if (settledRoots.length === 0) {
        expect(row).not.toHaveProperty("settledRootCount");
        expect(row).not.toHaveProperty("settledThreadCount");
      } else {
        expect(row.settledRootCount).toBe(settledRoots.length);
        expect(row.settledThreadCount).toBe(settledRoots.reduce((sum, spec) => sum + 1 + spec.children, 0));
      }
      // Settle Unpinned… lists exactly the Unpinned section's roots.
      expect(listNavigationDirectoryUnpinnedRoots(index(buildThreads(roots, true)), "directory:/repo")
        .map((thread) => thread.id))
        .toEqual(rootIds(index(buildThreads(roots, true)), { ...directory, roots: "unpinned", settled: "exclude" }));
    }));
  });

  it("changes nothing for a profile that never settled (upgrade oracle)", () => {
    fc.assert(fc.property(specs, (roots) => {
      const snapshot = index(buildThreads(roots, false));
      for (const rootsQuery of ["all", "pinned", "unpinned"] as const) {
        const before = rootIds(snapshot, { ...directory, roots: rootsQuery });
        if (rootsQuery !== "pinned") {
          expect(rootIds(snapshot, { ...directory, roots: rootsQuery, settled: "exclude" })).toEqual(before);
          expect(rootIds(snapshot, { ...directory, roots: rootsQuery, settled: "only" })).toEqual([]);
        }
      }
      const row = directoryRow(snapshot);
      expect(row).not.toHaveProperty("settledRootCount");
      expect(row).not.toHaveProperty("settledCollapsed");
      expect(row.unpinnedRootCount).toBe(roots.filter((spec) => !spec.pinned).length);
    }));
  });
});
