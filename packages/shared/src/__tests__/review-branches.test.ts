import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "../contracts/navigation";
import { findPreferredReviewWorkspaceCwd } from "../review-branches";

describe("findPreferredReviewWorkspaceCwd", () => {
  it("selects the changed primary project from multiple linked workspaces", () => {
    expect(
      findPreferredReviewWorkspaceCwd(
        reviewThread({
          gitWorkingState: {
            dirtyFiles: 0,
            dirtyAdditions: 0,
            dirtyDeletions: 0,
            untrackedFiles: 0,
            unpushedCommits: 0,
            baseBranch: "main",
            baseAheadCommitCount: 2,
          },
        }),
      ),
    ).toBe("/worktrees/app");
  });

  it("selects a dirty primary project even before its changes are committed", () => {
    expect(
      findPreferredReviewWorkspaceCwd(
        reviewThread({
          gitWorkingState: {
            dirtyFiles: 1,
            dirtyAdditions: 12,
            dirtyDeletions: 0,
            untrackedFiles: 0,
            unpushedCommits: 0,
            baseBranch: "main",
            baseAheadCommitCount: 0,
          },
        }),
      ),
    ).toBe("/worktrees/app");
  });

  it("keeps a clean primary project ambiguous", () => {
    expect(
      findPreferredReviewWorkspaceCwd(
        reviewThread({
          gitWorkingState: {
            dirtyFiles: 0,
            dirtyAdditions: 0,
            dirtyDeletions: 0,
            untrackedFiles: 0,
            unpushedCommits: 1,
            baseBranch: "main",
            baseAheadCommitCount: 0,
          },
        }),
      ),
    ).toBeUndefined();
  });
});

function reviewThread(
  overrides: Pick<NavigationThreadSummary, "gitWorkingState">,
): Pick<
  NavigationThreadSummary,
  "gitWorkingState" | "linkedDirectories" | "projectKey"
> {
  return {
    projectKey: "/worktrees/app/packages/api",
    linkedDirectories: [
      {
        id: "directory:infra",
        kind: "worktree",
        label: "Infra",
        path: "/repo/infra",
        worktreePath: "/worktrees/infra",
      },
      {
        id: "directory:app",
        kind: "worktree",
        label: "App",
        path: "/repo/app",
        worktreePath: "/worktrees/app",
      },
    ],
    ...overrides,
  };
}
