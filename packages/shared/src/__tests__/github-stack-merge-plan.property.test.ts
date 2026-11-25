import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PrLifecycleState } from "../contracts/navigation";
import {
  githubStackMergeNote,
  listPullRequestNumbers,
  resolveGithubStackMergePlan,
} from "../pull-request-merge-offer";
import { compactStackMembership, MAX_GITHUB_STACK_OPEN_BELOW, type StackSummary } from "../stacks/stack-status";

/**
 * GitHub merges a layer of one of its stacks together with every open layer
 * below it. A card about to merge such a layer says so, names them, and
 * counts them: "Squash merge 3 PRs". A peer's thread cannot send that
 * consent, so it is told to merge the layers below first.
 */
const lifecycle = fc.constantFrom<PrLifecycleState | undefined>("open", "merged", "closed", undefined);

const arbitraryStack = fc.record({
  githubStack: fc.option(fc.integer({ min: 1, max: 99_999 }), { nil: undefined }),
  layers: fc.array(fc.record({ lifecycleState: lifecycle, hasPr: fc.boolean() }), { minLength: 1, maxLength: 8 }),
}).chain((input) => fc.record({
  input: fc.constant(input),
  position: fc.integer({ min: 1, max: input.layers.length }),
}));

function stackOf(input: { githubStack?: number; layers: { lifecycleState?: PrLifecycleState; hasPr: boolean }[] }): StackSummary {
  return {
    key: "stack:github.com:octo/app:main",
    name: "Stack",
    repository: "github.com:octo/app",
    inferred: false,
    trunk: "main",
    ...(input.githubStack === undefined ? {} : { githubStack: input.githubStack }),
    layers: input.layers.map((layer, index) => ({
      branch: `layer-${index + 1}`,
      parent: index ? `layer-${index}` : "main",
      health: "in_sync",
      role: "unbound",
      ...(layer.hasPr ? { pullRequest: {
        number: 100 + index,
        ...(layer.lifecycleState ? { lifecycleState: layer.lifecycleState } : {}),
      } } : {}),
    })),
  };
}

describe("a GitHub stack's open layers below a PR", () => {
  it("lists exactly the open PRs below the layer, bottom first, only for a GitHub stack", () => {
    fc.assert(fc.property(arbitraryStack, ({ input, position }) => {
      const member = compactStackMembership(stackOf(input), position)!;
      const expected = input.layers.slice(0, position - 1).flatMap((layer, index) =>
        layer.hasPr && layer.lifecycleState === "open" ? [100 + index] : []);
      if (input.githubStack === undefined) {
        expect(member.githubStack).toBeUndefined();
        expect(member.openBelow).toBeUndefined();
        return;
      }
      expect(member.githubStack).toBe(input.githubStack);
      expect(member.openBelow ?? []).toEqual(expected.length <= MAX_GITHUB_STACK_OPEN_BELOW ? expected : []);
      expect(member.openBelow?.length ?? 1).toBeGreaterThan(0);
    }));
  });
});

describe("the merge plan for a stacked PR", () => {
  const member = fc.record({
    githubStack: fc.option(fc.integer({ min: 1, max: 99_999 }), { nil: undefined }),
    openBelow: fc.option(fc.uniqueArray(fc.integer({ min: 1, max: 9_999 }), { maxLength: 6 }), { nil: undefined }),
    trunk: fc.option(fc.constantFrom("main", "trunk"), { nil: undefined }),
  }, { requiredKeys: [] });

  it("merges the open layers below with the PR locally and asks a peer to merge them first", () => {
    fc.assert(fc.property(fc.option(member, { nil: undefined }), fc.boolean(), (input, remote) => {
      const plan = resolveGithubStackMergePlan({ member: input, remote });
      const below = input?.githubStack !== undefined ? input.openBelow ?? [] : [];
      if (!below.length) {
        expect(plan).toBeUndefined();
        return;
      }
      expect(plan).toEqual(remote
        ? { kind: "merge_below_first", below }
        : { kind: "with_layers_below", below, count: below.length + 1, ...(input?.trunk ? { trunk: input.trunk } : {}) });
    }));
  });

  it("names every PR below and the PR merged", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.integer({ min: 1, max: 9_999 }), { minLength: 1, maxLength: 6 }),
      fc.integer({ min: 10_000, max: 20_000 }),
      fc.boolean(),
      (below, number, remote) => {
        const plan = resolveGithubStackMergePlan({ member: { githubStack: 1, openBelow: below }, remote })!;
        const note = githubStackMergeNote(plan, number);
        for (const lower of below) expect(note).toMatch(new RegExp(`#${lower}\\b`));
        expect(note).toContain(`below #${number} in its GitHub stack`);
        expect(note).toContain(below.length === 1 ? " is still open" : " are still open");
        expect(note).toContain(remote ? "Merge " : `first, then #${number}.`);
      },
    ));
  });

  it("lists numbers as prose", () => {
    expect(listPullRequestNumbers([])).toBe("");
    expect(listPullRequestNumbers([7])).toBe("#7");
    expect(listPullRequestNumbers([7, 8])).toBe("#7 and #8");
    expect(listPullRequestNumbers([7, 8, 9])).toBe("#7, #8 and #9");
  });
});
