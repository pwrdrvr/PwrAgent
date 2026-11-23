import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findPeerCounterpartDirectory } from "../federation-project-match";

const repositoryKey = "github.com/example/project";
const project = {
  kind: "directory" as const,
  label: "Project",
  path: "/viewer/github/Project",
  repositoryKey,
};
const checkout = { ...project, path: "/owner/src/Project" };
const worktree = { ...checkout, path: "/owner/.codex/worktrees/fix/Project" };

describe("federated project destinations", () => {
  it("keeps the owner's primary checkout when its Codex worktree is also listed", () => {
    expect(findPeerCounterpartDirectory(project, [worktree, checkout])).toBe(checkout);
  });

  it("is invariant to additional same-project worktree rows and owner index order", () => {
    fc.assert(fc.property(
      fc.constantFrom("origin", "shared-remote", "name"),
      fc.constantFrom("/owner/src", "D:\\src"),
      fc.uniqueArray(fc.record({
        id: fc.nat(),
        root: fc.constantFrom(".codex/worktrees", ".pwragent/worktrees"),
        preferExactLabel: fc.boolean(),
      }), { minLength: 1, maxLength: 5, selector: ({ id }) => id }),
      fc.boolean(),
      (identity, parent, worktrees, reverse) => {
        const source = identity === "origin" ? project
          : { ...project, repositoryKey: undefined, repositoryKeys: identity === "shared-remote" ? [repositoryKey] : [] };
        const primary = {
          ...source,
          path: `${parent}/Project`,
        };
        const aliases = worktrees.map(({ id, root, preferExactLabel }) => ({
          ...primary,
          label: preferExactLabel ? project.label : `Worktree ${id}`,
          path: `${parent}/${root}/${id}/Project`,
        }));
        const ownerIndex = [primary, ...aliases];
        const oracle = findPeerCounterpartDirectory(source, [primary]);
        expect(oracle).toBe(primary);
        expect(findPeerCounterpartDirectory(source, reverse ? ownerIndex.toReversed() : ownerIndex)).toBe(oracle);
      },
    ));
  });

  it("keeps independent, equally good checkouts ambiguous even with a listed worktree", () => {
    const anotherCheckout = { ...checkout, path: "/owner/other/Project" };
    expect(findPeerCounterpartDirectory(project, [worktree, checkout, anotherCheckout])).toBeUndefined();
  });
});
