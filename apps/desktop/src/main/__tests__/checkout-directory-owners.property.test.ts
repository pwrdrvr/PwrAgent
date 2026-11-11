import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { LinkedDirectorySummary } from "@pwragent/shared";
import type { ThreadArchiveCandidate } from "../app-server/thread-archive-sweeper";
import { CheckoutDirectoryOwners, candidateCheckoutDirectories } from "../app-server/thread-owned-checkouts";

/**
 * Oracle test. `ownersByFilter` is how Thread Maintenance's hibernate step
 * found the threads using a checkout before the index: filter every
 * candidate, keeping those with a directory equal to the checkout or inside
 * it, by plain string comparison. The index must return the same candidate
 * objects in the same order for every list and checkout.
 */
function ownersByFilter(candidates: readonly ThreadArchiveCandidate[], target: string): ThreadArchiveCandidate[] {
  return candidates.filter((owner) =>
    candidateCheckoutDirectories(owner).some((cwd) => cwd === target || cwd.startsWith(target + path.sep)));
}

// Sibling-prefix traps (`/w/repo` and `/w/repo2`, `/w/re`), nesting at
// several depths, a trailing separator, spellings `path.normalize` rewrites
// (`.`, `..`, doubled separators), a relative path the owners list drops,
// and the filesystem root.
const PATHS = [
  "/w/repo", "/w/repo2", "/w/re", "/w/repo/sub", "/w/repo/sub/deep", "/w/repo2/sub", "/w/repo/",
  "/w/./repo/sub", "/w/x/../repo", "//w//repo", "/w", "/", "w/repo",
];
// Checkouts asked about, unnormalized ones included: the step passes the
// thread's raw worktree path.
const TARGETS = [...PATHS, "/w/repo/sub/", "/w/./repo", "", "/x"];

const directory = fc.record({
  path: fc.constantFrom(...PATHS),
  worktreePath: fc.option(fc.constantFrom(...PATHS), { nil: undefined }),
});
const row = fc.record({
  linked: fc.array(directory, { maxLength: 3 }),
  extra: fc.option(fc.array(directory, { maxLength: 2 }), { nil: undefined }),
  retained: fc.option(fc.array(directory, { maxLength: 2 }), { nil: undefined }),
  // Used only when the thread lists no directory at all.
  projectKey: fc.option(fc.constantFrom(...PATHS), { nil: undefined }),
});

function build(input: typeof row extends fc.Arbitrary<infer T> ? T : never, index: number): ThreadArchiveCandidate {
  const linked = (items: typeof input.linked): LinkedDirectorySummary[] => items.map((item, position) => ({
    id: `d${position}`, label: "repo", kind: item.worktreePath ? "worktree" : "local", path: item.path,
    ...(item.worktreePath ? { worktreePath: item.worktreePath } : {}),
  }));
  return {
    thread: {
      id: `t${index}`, title: `Thread ${index}`, titleSource: "explicit", source: "codex",
      linkedDirectories: linked(input.linked),
      ...(input.projectKey ? { projectKey: input.projectKey } : {}),
    },
    overlay: {
      backend: "codex", threadId: `t${index}`,
      ...(input.extra ? { extraLinkedDirectories: linked(input.extra) } : {}),
      ...(input.retained ? { retainedWorktrees: linked(input.retained) } : {}),
    } as ThreadArchiveCandidate["overlay"],
  };
}

describe("CheckoutDirectoryOwners", () => {
  it("returns exactly the candidates the filter returned, for every list and checkout", () => {
    fc.assert(fc.property(
      fc.array(row, { maxLength: 12 }),
      fc.array(fc.nat(), { maxLength: 3 }),
      (rows, repeats) => {
        const candidates = rows.map(build);
        // The same candidate object can appear twice in a list.
        for (const position of repeats) if (candidates.length) candidates.push(candidates[position % candidates.length]!);
        const owners = new CheckoutDirectoryOwners(candidates);
        for (const target of TARGETS) {
          const expected = ownersByFilter(candidates, target);
          const actual = owners.owners(target);
          expect(actual).toHaveLength(expected.length);
          actual.forEach((owner, index) => expect(owner).toBe(expected[index]));
        }
      },
    ), { numRuns: 3000 });
  });

  it("keeps a sibling with a shared name prefix out, and a nested directory in", () => {
    const repo = build({ linked: [{ path: "/w/repo", worktreePath: undefined }], extra: undefined, retained: undefined, projectKey: undefined }, 0);
    const sibling = build({ linked: [{ path: "/w/repo2", worktreePath: undefined }], extra: undefined, retained: undefined, projectKey: undefined }, 1);
    const nested = build({ linked: [{ path: "/w/repo/sub", worktreePath: undefined }], extra: undefined, retained: undefined, projectKey: undefined }, 2);
    const owners = new CheckoutDirectoryOwners([repo, sibling, nested]);
    expect(owners.owners("/w/repo")).toEqual([repo, nested]);
    expect(owners.owners("/w/repo2")).toEqual([sibling]);
    expect(owners.owners("/w/re")).toEqual([]);
  });

  it("reads each candidate's directories once, the first time a checkout is asked about", () => {
    const candidates = Array.from({ length: 40 }, (_, index) => build({
      linked: [{ path: "/projects/app", worktreePath: `/worktrees/k${index}/app` }], extra: undefined, retained: undefined, projectKey: undefined,
    }, index));
    let normalized = 0;
    const normalize = path.normalize;
    path.normalize = ((value: string) => { normalized += 1; return normalize(value); }) as typeof path.normalize;
    try {
      const owners = new CheckoutDirectoryOwners(candidates);
      expect(normalized).toBe(0);
      for (let index = 0; index < candidates.length; index++) owners.owners(`/worktrees/k${index}/app`);
    } finally {
      path.normalize = normalize;
    }
    expect(normalized).toBe(candidates.length);
  });
});
