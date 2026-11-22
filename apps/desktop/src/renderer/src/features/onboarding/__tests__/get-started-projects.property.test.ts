import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  RecentProjectAgent,
  RecentProjectObservation,
} from "@pwragent/shared/contracts/settings";
import {
  checkedProjectPaths,
  isProjectChecked,
  PRECHECKED_PROJECT_COUNT,
  rankProjectCandidates,
  splitProjectCandidates,
  type ProjectCandidate,
} from "../get-started-projects";

/*
 * The rules are written at the top of get-started-projects.ts. The oracle
 * here is a slow restatement of them, kept separate from the module.
 */

const AGENTS: readonly RecentProjectAgent[] = ["codex", "claude", "acp:gemini", "acp:kimi"];

/** One folder, reported in any of the spellings agents and platforms use. */
function spell(base: string, variant: number): string {
  if (variant === 1) return `${base}/`;
  if (variant === 2) return base.replace(/\//g, "\\");
  if (variant === 3) return `${base.replace(/\//g, "\\")}\\`;
  return base;
}

// `size: "max"` so a run regularly has more folders than are prechecked;
// fast-check otherwise stays near 10 items and never crosses the bound.
const arbInput = fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,7}$/), {
  minLength: 1,
  maxLength: 30,
  size: "max",
}).chain((names) => {
  const folders = names.map((name) => `/home/dev/${name}`);
  const arbObservation: fc.Arbitrary<RecentProjectObservation> = fc.record({
    folder: fc.integer({ min: 0, max: folders.length - 1 }),
    variant: fc.integer({ min: 0, max: 3 }),
    agent: fc.constantFrom(...AGENTS),
    // A narrow range so ties and undated folders are common.
    lastActiveAt: fc.option(fc.integer({ min: 0, max: 50 }), { nil: undefined }),
  }).map(({ folder, variant, agent, lastActiveAt }) => ({
    path: spell(folders[folder]!, variant),
    agent,
    ...(lastActiveAt === undefined ? {} : { lastActiveAt }),
  }));
  return fc.record({
    folders: fc.constant(folders),
    observations: fc.array(arbObservation, { maxLength: 80, size: "max" }),
  });
});

type Expected = { key: string; lastActiveAt?: number; agents: Set<RecentProjectAgent> };

function oracle(observations: readonly RecentProjectObservation[]): Expected[] {
  const byFolder = new Map<string, Expected>();
  for (const observation of observations) {
    const key = observation.path.replace(/\\/g, "/").replace(/\/+$/, "");
    const entry = byFolder.get(key) ?? { key, agents: new Set<RecentProjectAgent>() };
    entry.agents.add(observation.agent);
    if (observation.lastActiveAt !== undefined) {
      entry.lastActiveAt = Math.max(entry.lastActiveAt ?? Number.NEGATIVE_INFINITY, observation.lastActiveAt);
    }
    byFolder.set(key, entry);
  }
  return [...byFolder.values()].sort((left, right) => {
    if (left.lastActiveAt !== right.lastActiveAt) {
      if (left.lastActiveAt === undefined) return 1;
      if (right.lastActiveAt === undefined) return -1;
      return right.lastActiveAt - left.lastActiveAt;
    }
    return left.key < right.key ? -1 : 1;
  });
}

function newerOrSame(left: ProjectCandidate, right: ProjectCandidate): boolean {
  if (right.lastActiveAt === undefined) return true;
  return left.lastActiveAt !== undefined && left.lastActiveAt >= right.lastActiveAt;
}

describe("Get started project rules", () => {
  it("has one row per folder, naming every agent that used it at its newest time", () => {
    fc.assert(fc.property(arbInput, ({ observations }) => {
      const candidates = rankProjectCandidates(observations);
      const expected = oracle(observations);
      expect(candidates.map((candidate) => candidate.key)).toEqual(expected.map((entry) => entry.key));
      for (const [index, candidate] of candidates.entries()) {
        expect(new Set(candidate.agents)).toEqual(expected[index]!.agents);
        expect(candidate.agents).toHaveLength(expected[index]!.agents.size);
        expect(candidate.lastActiveAt).toBe(expected[index]!.lastActiveAt);
        expect(candidate.rank).toBe(index);
      }
    }));
  });

  it("ranks the same whatever order the agents answered in", () => {
    fc.assert(fc.property(
      arbInput.chain(({ observations }) => fc.tuple(
        fc.constant(observations),
        fc.shuffledSubarray(observations, { minLength: observations.length, maxLength: observations.length }),
      )),
      ([observations, shuffled]) => {
        expect(rankProjectCandidates(shuffled)).toEqual(rankProjectCandidates(observations));
      },
    ));
  });

  it("prechecks exactly the most recent rows, and only those show before Review all", () => {
    fc.assert(fc.property(arbInput, ({ observations }) => {
      const candidates = rankProjectCandidates(observations);
      const none = new Map<string, boolean>();
      const checked = candidates.filter((candidate) => isProjectChecked(candidate, none));
      const unchecked = candidates.filter((candidate) => !isProjectChecked(candidate, none));
      expect(checked).toHaveLength(Math.min(PRECHECKED_PROJECT_COUNT, candidates.length));
      for (const left of checked) {
        for (const right of unchecked) expect(newerOrSame(left, right)).toBe(true);
      }
      const { shown, collapsed } = splitProjectCandidates(candidates);
      expect(shown).toEqual(checked);
      expect([...shown, ...collapsed]).toEqual(candidates);
      expect(checkedProjectPaths(candidates, none)).toEqual(checked.map((candidate) => candidate.path));
    }));
  });

  it("keeps the operator's toggle on a row whatever its rank", () => {
    fc.assert(fc.property(
      arbInput.chain(({ observations }) => {
        const keys = rankProjectCandidates(observations).map((candidate) => candidate.key);
        const toggles: fc.Arbitrary<Array<[string, boolean]>> = keys.length === 0
          ? fc.constant([])
          : fc.array(fc.tuple(fc.constantFrom(...keys), fc.boolean()), { maxLength: 20 });
        return fc.tuple(fc.constant(observations), toggles);
      }),
      ([observations, toggles]) => {
        const choices = new Map(toggles);
        const candidates = rankProjectCandidates(observations);
        for (const candidate of candidates) {
          const chosen = choices.get(candidate.key);
          expect(isProjectChecked(candidate, choices))
            .toBe(chosen ?? candidate.rank < PRECHECKED_PROJECT_COUNT);
        }
      },
    ));
  });

  it("merges the same folder from two agents into one row", () => {
    const candidates = rankProjectCandidates([
      { path: "/home/dev/shop", agent: "claude", lastActiveAt: 20 },
      { path: "/home/dev/blog", agent: "codex", lastActiveAt: 30 },
      { path: "/home/dev/shop/", agent: "codex", lastActiveAt: 40 },
    ]);
    expect(candidates.map((candidate) => [candidate.label, candidate.agents, candidate.lastActiveAt]))
      .toEqual([["shop", ["codex", "claude"], 40], ["blog", ["codex"], 30]]);
  });
});
