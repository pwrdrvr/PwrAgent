import { expect, it } from "vitest";
import fc from "fast-check";
import {
  buildDirectorySummaries,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { projectNavigationQuery } from "../navigation-query-projection";

function checkProject(checkoutCount: number, preferredIndex: number, reverse: boolean) {
  const paths = Array.from({ length: checkoutCount }, (_, index) => `/fixture/checkout-${index}`);
  const preferredPath = paths[preferredIndex % checkoutCount]!;
  const projectKey = `directory:${preferredPath}`;
  const separatePath = "/fixture/intentional-duplicate";
  const threads: NavigationThreadSummary[] = [...paths, separatePath].map((path, index) => ({
    id: String(index),
    source: "codex",
    title: `Thread ${index}`,
    titleSource: "derived",
    createdAt: index + 1,
    updatedAt: index + 1,
    gitOriginUrl: "git@github.com:fixture/example.git",
    linkedDirectories: [{
      id: path, kind: "worktree", path, label: path.split("/").at(-1)!,
      worktreePath: `/fixture/worktrees/${index}`,
    }],
    inbox: { inInbox: false },
  }));
  if (reverse) threads.reverse();
  const directories = buildDirectorySummaries({
    threads,
    checkoutGroups: [{ preferredPath, paths }],
  });
  expect(directories.map((directory) => directory.key).sort()).toEqual(
    [projectKey, `directory:${separatePath}`].sort(),
  );
  const index = { threads, directories };
  const page = projectNavigationQuery({
    index,
    request: { protocol: 2, inventory: "owner", consumer: "agent-tool", query: { kind: "directory-index" } },
  });
  const project = page.directories?.find((directory) => directory.key === projectKey);
  expect(project?.path).toBe(preferredPath);
  expect(project?.counts.total).toBe(checkoutCount);
  const geometry = projectNavigationQuery({
    index,
    request: { protocol: 2, inventory: "owner", consumer: "star-map", query: { kind: "star-map-geometry" } },
  });
  expect(geometry.directories?.map((directory) => directory.key).sort()).toEqual(
    [projectKey, `directory:${separatePath}`].sort(),
  );
  const cards = projectNavigationQuery({
    index,
    request: { protocol: 2, inventory: "owner", consumer: "star-map", query: { kind: "star-map", projectKey, filters: {} } },
  });
  expect(cards.entries).toHaveLength(checkoutCount);
  for (const { row } of cards.entries) {
    const original = threads.find((thread) => thread.id === row.ref.threadId);
    expect(row.linkedDirectories).toEqual(original?.linkedDirectories);
    expect(row.checkoutProject?.key).toBe(projectKey);
  }
}

it("groups renamed clones and keeps an intentional third clone separate", () => {
  checkProject(2, 1, false);
});

it("agrees across owner queries for every preferred checkout and input order", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 6 }), fc.nat(), fc.boolean(), checkProject));
});
