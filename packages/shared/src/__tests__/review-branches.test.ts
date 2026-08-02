import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "../contracts/navigation";
import {
  buildReviewBranchOptions,
  findPreferredReviewWorkspaceCwd,
} from "../review-branches";

describe("buildReviewBranchOptions", () => {
  it("prefers an open PR's target branch over the conventional Git base", () => {
    expect(
      buildReviewBranchOptions({
        thread: {
          gitBranch: "agent/pr-auto-dispatch-budget",
          observedGitBranch: "agent/pr-auto-dispatch-budget",
          prs: [
            pullRequest({
              baseRefName: "agent/github-pr-auto-fix-settings",
              headRefName: "agent/pr-auto-dispatch-budget",
            }),
          ],
        } as NavigationThreadSummary,
      }),
    ).toEqual([
      "agent/github-pr-auto-fix-settings",
      "main",
    ]);
  });

  it("does not select an unrelated open PR when several are attached", () => {
    expect(
      buildReviewBranchOptions({
        thread: {
          gitBranch: "agent/pr-auto-dispatch-budget",
          prs: [
            pullRequest({
              baseRefName: "agent/github-pr-auto-fix-settings",
              headRefName: "agent/pr-auto-dispatch-budget",
            }),
            pullRequest({
              number: 1144,
              baseRefName: "main",
              headRefName: "agent/other-work",
            }),
          ],
        } as NavigationThreadSummary,
      }),
    ).toEqual([
      "agent/github-pr-auto-fix-settings",
      "main",
    ]);
  });
});

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

function pullRequest(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number: 1143,
    org: "pwrdrvr",
    repo: "PwrAgent",
    state: "passing",
    lifecycleState: "open",
    url: "https://github.com/pwrdrvr/PwrAgent/pull/1143",
    ...overrides,
  };
}
