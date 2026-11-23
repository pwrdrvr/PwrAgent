import fc from "fast-check";
import { expect, it } from "vitest";
import { projectNavigationQuery } from "../navigation-query-projection";
import { buildNavigationSnapshot } from "@pwragent/shared/navigation-state";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";

function checkWorkspaceMembership(home: string, activeCount: number, legacyCount: number, reverse: boolean) {
  const workspaceRoots = [`${home}/profiles/default/projects`, `${home}/projects`];
  const threads = workspaceRoots.flatMap((root, rootIndex) =>
    Array.from({ length: rootIndex === 0 ? activeCount : legacyCount }, (_, i): AppServerThreadSummary => {
      const id = `scratch-${rootIndex}-${i}`;
      const path = `${root}/${id}`;
      return { id, source: "codex", title: id, titleSource: "explicit",
        linkedDirectories: [{ id: path, kind: "local", label: id, path }] };
    }));
  if (reverse) threads.reverse();
  const index = buildNavigationSnapshot({
    backend: "all", fetchedAt: 1, firstSnapshot: true, unchanged: false,
    threads, workspaceRoots, overlayByThreadKey: {}, previousKnownThreadKeys: [],
  });
  const [workspace] = index.directories;
  expect(index.directories).toHaveLength(1);
  expect(workspace?.kind).toBe("workspace");
  const request = { protocol: 2, inventory: "owner", consumer: "star-map" } as const;
  const geometry = projectNavigationQuery({ index, request: { ...request, query: { kind: "star-map-geometry" } } });
  expect(geometry.directories).toMatchObject([{
    key: workspace!.key, kind: "workspace", counts: { total: workspace!.threadKeys.length },
  }]);
  // A card must also carry the same key for the renderer's project-page check.
  const cards = projectNavigationQuery({ index, request: {
    ...request, query: { kind: "star-map", projectKey: workspace!.key, filters: {} },
  } });
  expect(cards.entries.map(({ row }) => `${row.source}:${row.id}`).sort()).toEqual([...workspace!.threadKeys].sort());
  expect(cards.entries.map(({ row }) => row.checkoutProject?.key)).toEqual(cards.entries.map(() => workspace!.key));
}

it("shows one Star Map body for current and legacy Workspaces", () => {
  checkWorkspaceMembership("/state", 1, 1, false);
});

it("agrees with Directories on Workspaces geometry and card membership", () => {
  fc.assert(fc.property(
    fc.constantFrom("/state", "C:/Outpost", "/Users/fixture/.pwragent"),
    fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 4 }), fc.boolean(),
    checkWorkspaceMembership,
  ));
});
