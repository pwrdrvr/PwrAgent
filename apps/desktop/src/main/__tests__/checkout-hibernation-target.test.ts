import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { LinkedDirectorySummary } from "@pwragent/shared";
import { HIBERNATION_KEEP_REASONS, hibernationTarget } from "../app-server/checkout-hibernation";
import type { ThreadArchiveCandidate } from "../app-server/thread-archive-sweeper";

function candidate(directory: Partial<LinkedDirectorySummary> & { worktreePath: string }): ThreadArchiveCandidate {
  return {
    thread: {
      id: "t", title: "Thread", titleSource: "explicit", source: "codex", threadStatus: "notLoaded", updatedAt: 1,
      linkedDirectories: [{ id: "d", label: "repo", path: "/src/repo", kind: "worktree", ...directory }],
    } as ThreadArchiveCandidate["thread"],
  };
}

describe("hibernationTarget", () => {
  // Property: location does not decide eligibility. The Git inspection proves
  // it is a linked checkout. Without fresh managed-root evidence, explicit
  // external ownership still protects it.
  it("considers owned worktrees independently of their directory layout", () => {
    const segment = fc.stringMatching(/^[a-z0-9-]{1,8}$/);
    fc.assert(fc.property(
      fc.constantFrom(".codex", ".pwragent", ".pwragnt", ".cache", "worktrees", "src"),
      fc.option(segment, { nil: undefined }),
      segment, segment, fc.boolean(),
      (rootName, profile, id, name, external) => {
        const worktreePath = ["/Users/someone", rootName, ...(profile ? ["profiles", profile] : []), "worktrees", id, name].join("/");
        const target = hibernationTarget(candidate({ worktreePath, ...(external ? { worktreeOwnership: "external" as const } : {}) }));
        if (external) expect(target).toEqual({ keep: HIBERNATION_KEEP_REASONS.borrowed });
        else expect(target).toMatchObject({ worktreePath, repositoryPath: "/src/repo" });
      },
    ), { numRuns: 300 });
  });

  it("takes a Codex checkout", () => {
    expect(hibernationTarget(candidate({ worktreePath: "/Users/someone/.codex/worktrees/a1b2/harbor-web" })))
      .toMatchObject({ worktreePath: "/Users/someone/.codex/worktrees/a1b2/harbor-web" });
  });
});
