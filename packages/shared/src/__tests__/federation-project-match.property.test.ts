import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findPeerCounterpartDirectory } from "../federation-project-match";
import { setConfiguredWorktreeFolder } from "../worktree-paths";

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
  it("keeps unrelated same-name checkouts ambiguous when the source has no origin", () => {
    const source = { ...project, repositoryKey: undefined };
    const unrelated = { ...worktree, repositoryKey: "github.com/other/project" };
    expect(findPeerCounterpartDirectory(source, [unrelated, checkout])).toBeUndefined();
  });

  it("ignores the viewer's Worktree folder when choosing among the owner's checkouts", () => {
    fc.assert(fc.property(
      fc.stringMatching(/^[a-z]{1,10}$/),
      fc.boolean(),
      (folder, reverse) => {
        const root = `/Volumes/${folder}`;
        const preferred = { ...checkout, path: `${root}/checkouts/Project` };
        const second = { ...checkout, label: "Other", path: "/owner/Other" };
        const rows = reverse ? [second, preferred] : [preferred, second];
        try {
          setConfiguredWorktreeFolder(root);
          expect(findPeerCounterpartDirectory(project, rows)).toBe(preferred);
        } finally {
          setConfiguredWorktreeFolder(undefined);
        }
      },
    ));
  });

  it("treats a tool-shaped path as a separate row without owner proof", () => {
    fc.assert(fc.property(
      fc.constantFrom(undefined, repositoryKey, "github.com/other/project"),
      fc.constantFrom(".codex/worktrees", ".pwragent/worktrees"),
      fc.boolean(),
      (origin, root, reverse) => {
        const source = { ...project, repositoryKey: undefined };
        const other = { ...worktree, repositoryKey: origin, path: `/owner/${root}/fix/Project` };
        const rows = reverse ? [checkout, other] : [other, checkout];
        expect(findPeerCounterpartDirectory(source, rows)).toBeUndefined();
      },
    ));
  });
});
