import fc from "fast-check";
import { expect, it } from "vitest";
import type {
  NavigationDirectorySummary,
  NavigationQueryRequest,
} from "@pwragent/shared/contracts/navigation";
import { NavigationQueryStore } from "../navigation-query-store";

function directory(label: string, latestUpdatedAt: number): NavigationDirectorySummary {
  const path = `/home/fixture/github/${label}`;
  return { key: path, kind: "directory", label, path, latestUpdatedAt, threadKeys: [], needsAttentionCount: 0 };
}

async function readFirstPage(directories: NavigationDirectorySummary[], filter: string) {
  const query = { kind: "directory-index", match: "mention", filter } as const;
  const request: NavigationQueryRequest = { protocol: 2, consumer: "mentions", pageSize: 10, query };
  return new NavigationQueryStore().readPage({
    request,
    scopeKey: "composer",
    loadIndex: async () => ({ directories, threads: [] }),
  });
}

it("includes git in the first @git page when ten projects match via the github parent folder", async () => {
  const pathMatches = Array.from({ length: 10 }, (_, index) => directory(`project-${index}`, index + 2));
  const page = await readFirstPage([...pathMatches, directory("git", 1)], "git");

  expect(page).toMatchObject({ directoryMatch: "mention" });
  expect(page.directories?.map((row) => row.label)).toEqual([
    "git", ...pathMatches.slice(1).reverse().map((row) => row.label),
  ]);
});

it("ranks exact names, then name prefixes, then path matches before filling the first page", async () => {
  const population = fc.record({
    prefixCount: fc.integer({ min: 0, max: 15 }),
    pathCount: fc.integer({ min: 10, max: 20 }),
    filter: fc.constantFrom("git", "GIT", " Git ", ""),
  }).chain(({ prefixCount, pathCount, filter }) => {
    const prefixes = Array.from({ length: prefixCount }, (_, index) => directory(`git-tool-${index}`, index + 2));
    const paths = Array.from({ length: pathCount }, (_, index) => directory(`project-${index}`, index + 100));
    const exact = directory("git", 1);
    const expected = filter
      ? [exact, ...prefixes.slice().reverse(), ...paths.slice().reverse()]
      : [...paths.slice().reverse(), ...prefixes.slice().reverse(), exact];
    const rows = [...paths, ...prefixes, exact, { ...directory("git-pathless", 300), path: undefined }];
    return fc.shuffledSubarray(rows, { minLength: rows.length, maxLength: rows.length })
      .map((directories) => ({ directories, filter, expected: expected.slice(0, 10).map((row) => row.key) }));
  });

  await fc.assert(fc.asyncProperty(population, async ({ directories, filter, expected }) => {
    const page = await readFirstPage(directories, filter);
    expect(page.directories?.map((row) => row.key)).toEqual(expected);
  }));
});
