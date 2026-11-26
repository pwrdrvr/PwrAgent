import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_PROJECT_MERGE_BRANCHES,
  buildProjectNeverMergeRefusal,
  isDefaultProjectForgeAutomation,
  projectMergeBranches,
  projectMergesPullRequest,
  resolveProjectForgeAutomation,
  resolveProjectNeverMergePolicy,
} from "../project-forge-automation";

/**
 * A contribution fork never merges its pull requests, except into the
 * integration branches it lists (`mergeBranches`). The rule every merge
 * gate applies: a pull request may merge exactly when its project merges,
 * or its base branch is one the project lists. A base not read yet is not
 * listed.
 */
const BRANCHES = ["main", "pwrdrvr", "release/2.0", "feat/x", "Main"] as const;
const branchArb = fc.constantFrom(...BRANCHES);

/** What an owner might have stored or a peer might send: valid, junk, or absent. */
const storedArb = fc.record({
  neverMerge: fc.constantFrom(undefined, true, false, "yes"),
  mergeBranches: fc.oneof(
    fc.constant(undefined),
    fc.array(fc.oneof(
      { weight: 4, arbitrary: branchArb },
      { weight: 1, arbitrary: branchArb.map((branch) => ` ${branch} `) },
      { weight: 1, arbitrary: fc.constantFrom("", "  ", "two words", "tab\there", 7, null) },
    ), { maxLength: 6 }),
    fc.constant("pwrdrvr"),
  ),
}, { requiredKeys: [] });

/** The rule, stated without the module's helpers. */
function oracle(stored: { neverMerge?: unknown; mergeBranches?: unknown }, base: string | undefined): boolean {
  if (stored.neverMerge !== true) return true;
  if (base === undefined) return false;
  const listed = Array.isArray(stored.mergeBranches)
    ? stored.mergeBranches.flatMap((entry) =>
      typeof entry === "string" && entry.trim() && !/\s/.test(entry.trim()) ? [entry.trim()] : [])
    : [];
  return listed.includes(base);
}

describe("never-merge projects that still merge into listed branches (property)", () => {
  it("allows a merge exactly when the project merges or the PR's base is listed", () => {
    fc.assert(fc.property(storedArb, fc.option(branchArb, { nil: undefined }), (stored, base) => {
      const automation = resolveProjectForgeAutomation(stored);
      expect(projectMergesPullRequest(automation, base)).toBe(oracle(stored, base));
    }));
  });

  // Shrunk counterexample against the pre-change gate, which refused it.
  it("merges a PR into release/2.0 when the never-merge project lists release/2.0", () => {
    const automation = resolveProjectForgeAutomation({ neverMerge: true, mergeBranches: ["release/2.0"] });
    expect(projectMergesPullRequest(automation, "release/2.0")).toBe(true);
    expect(projectMergesPullRequest(automation, "main")).toBe(false);
  });

  it("keeps a valid list through the owner's read, so the setting survives storage and federation", () => {
    fc.assert(fc.property(
      fc.uniqueArray(branchArb, { minLength: 1, maxLength: BRANCHES.length }),
      (branches) => {
        const automation = resolveProjectForgeAutomation({ neverMerge: true, mergeBranches: branches });
        expect(automation.mergeBranches).toEqual(branches);
        expect(resolveProjectForgeAutomation(automation)).toEqual(automation);
        expect(isDefaultProjectForgeAutomation(automation)).toBe(false);
        for (const branch of BRANCHES) {
          expect(projectMergesPullRequest(automation, branch)).toBe(branches.includes(branch));
        }
      },
    ));
  });

  it("merges every pull request when Never merge is off, whatever list was left behind", () => {
    fc.assert(fc.property(fc.array(branchArb), fc.option(branchArb, { nil: undefined }), (branches, base) => {
      const automation = resolveProjectForgeAutomation({ mergeBranches: branches });
      expect(automation.mergeBranches).toBeUndefined();
      expect(projectMergesPullRequest(automation, base)).toBe(true);
      expect(resolveProjectNeverMergePolicy({ label: "canvas", automation })).toBeUndefined();
    }));
  });

  it("an owner that predates the list merges nothing in a never-merge project", () => {
    // What #4397 stored: no list.
    const automation = resolveProjectForgeAutomation({ neverMerge: true });
    for (const base of [...BRANCHES, undefined]) {
      expect(projectMergesPullRequest(automation, base)).toBe(false);
    }
    expect(projectMergeBranches(automation)).toEqual([]);
  });

  it("caps the list and drops repeats", () => {
    const many = Array.from({ length: MAX_PROJECT_MERGE_BRANCHES + 5 }, (_, index) => `b${index}`);
    const automation = resolveProjectForgeAutomation({ neverMerge: true, mergeBranches: ["b0", ...many] });
    expect(automation.mergeBranches).toEqual(many.slice(0, MAX_PROJECT_MERGE_BRANCHES));
  });

  it("names the branches that still merge in the agent refusal", () => {
    expect(buildProjectNeverMergeRefusal({ projectLabel: "canvas", pullRequest: "#2", mergeBranches: ["pwrdrvr"] }))
      .toBe("#2 is in canvas, where Forge Automation merges only pull requests into pwrdrvr: the rest land upstream. Do not merge #2, offer a merge, or raise a merge card. The operator can change this from the project menu: Forge Automation.");
    expect(buildProjectNeverMergeRefusal({ projectLabel: "canvas", mergeBranches: ["a", "b", "c"] }))
      .toBe("This thread is in canvas, where Forge Automation merges only pull requests into a, b or c: the rest land upstream. Do not merge a pull request into any other branch, offer a merge, or raise a merge card. The operator can change this from the project menu: Forge Automation.");
    // A base not read yet counts as unlisted, and the refusal says so.
    expect(buildProjectNeverMergeRefusal({ projectLabel: "canvas", pullRequest: "#7", mergeBranches: ["pwrdrvr"], baseUnknown: true }))
      .toContain("PwrAgent has not read #7's base branch yet, so it counts as another branch. Do not merge #7");
    expect(buildProjectNeverMergeRefusal({ projectLabel: "canvas" }))
      .toContain("is set to never merge pull requests");
  });
});
