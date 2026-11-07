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
  // Model: hibernation may take a thread's own worktree when it sits under
  // PwrAgent's or Codex's worktree root (optionally per profile) and is not
  // borrowed. Codex never cleans ~/.codex/worktrees itself.
  it("takes a checkout under PwrAgent's or Codex's worktree root, and nothing else", () => {
    const segment = fc.stringMatching(/^[a-z0-9-]{1,8}$/);
    fc.assert(fc.property(
      fc.constantFrom(".codex", ".pwragent", ".pwragnt", ".cache", "worktrees", "src"),
      fc.option(segment, { nil: undefined }),
      segment, segment, fc.boolean(),
      (rootName, profile, id, name, external) => {
        const worktreePath = ["/Users/someone", rootName, ...(profile ? ["profiles", profile] : []), "worktrees", id, name].join("/");
        const target = hibernationTarget(candidate({ worktreePath, ...(external ? { worktreeOwnership: "external" as const } : {}) }));
        const managed = [".codex", ".pwragent", ".pwragnt"].includes(rootName);
        if (external) expect(target).toEqual({ keep: HIBERNATION_KEEP_REASONS.borrowed });
        else if (!managed) expect(target).toEqual({ keep: HIBERNATION_KEEP_REASONS.outsideRoot });
        else expect(target).toMatchObject({ worktreePath, repositoryPath: "/src/repo" });
      },
    ), { numRuns: 300 });
  });

  it("takes a Codex checkout", () => {
    expect(hibernationTarget(candidate({ worktreePath: "/Users/someone/.codex/worktrees/a1b2/harbor-web" })))
      .toMatchObject({ worktreePath: "/Users/someone/.codex/worktrees/a1b2/harbor-web" });
  });
});
