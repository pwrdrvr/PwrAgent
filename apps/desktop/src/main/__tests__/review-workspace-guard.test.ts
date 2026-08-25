import { describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { assertReviewWorkspaceMatchesAttachedPullRequest } from "../app-server/review-workspace-guard";

const PR_HEAD = "e82f8783f994f429aa1624a7beaf1deeec9da0ca";
const CURRENT_HEAD = "970b7f2ff4f612b8e8cd340eb6b6d789d7141dd2";

describe("assertReviewWorkspaceMatchesAttachedPullRequest", () => {
  it("allows a checkout at or descended from the attached PR head", async () => {
    const runGit = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse") {
        return { stdout: PR_HEAD };
      }
      if (args[0] === "merge-base") {
        return { stdout: "" };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    await expect(
      assertReviewWorkspaceMatchesAttachedPullRequest({
        cwd: "/worktree",
        prs: [pullRequest()],
        runGit,
        target: { type: "baseBranch", branch: "pwragent" },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a base review from an unrelated checkout", async () => {
    const runGit = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        return { stdout: PR_HEAD };
      }
      if (args[0] === "merge-base") {
        throw new Error("not an ancestor");
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { stdout: CURRENT_HEAD };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    await expect(
      assertReviewWorkspaceMatchesAttachedPullRequest({
        cwd: "/worktree",
        prs: [pullRequest()],
        runGit,
        target: { type: "baseBranch", branch: "pwragent" },
      }),
    ).rejects.toThrow(
      "current checkout 970b7f2ff4 does not contain attached #9 head e82f8783f9",
    );
  });

  it("matches the origin-qualified spelling of an attached PR base", async () => {
    const runGit = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse") {
        return { stdout: PR_HEAD };
      }
      return { stdout: "" };
    });

    await assertReviewWorkspaceMatchesAttachedPullRequest({
      cwd: "/worktree",
      prs: [pullRequest()],
      runGit,
      target: { type: "baseBranch", branch: "origin/pwragent" },
    });

    expect(runGit).toHaveBeenCalledWith(
      "/worktree",
      ["merge-base", "--is-ancestor", PR_HEAD, "HEAD"],
    );
  });

  it("ignores an attached PR whose head object belongs to another workspace", async () => {
    const runGit = vi.fn(async () => {
      throw new Error("unknown revision");
    });

    await expect(
      assertReviewWorkspaceMatchesAttachedPullRequest({
        cwd: "/different-repository",
        prs: [pullRequest()],
        runGit,
        target: { type: "baseBranch", branch: "pwragent" },
      }),
    ).resolves.toBeUndefined();
    expect(runGit).toHaveBeenCalledTimes(1);
  });

  it("does not constrain non-base review targets", async () => {
    const runGit = vi.fn();

    await assertReviewWorkspaceMatchesAttachedPullRequest({
      cwd: "/worktree",
      prs: [pullRequest()],
      runGit,
      target: { type: "commit", sha: PR_HEAD, title: null },
    });

    expect(runGit).not.toHaveBeenCalled();
  });
});

function pullRequest(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number: 9,
    org: "pwrdrvr",
    repo: "codex",
    baseRefName: "pwragent",
    headRefName: "agent/pwragent-build-version",
    headSha: PR_HEAD,
    state: "passing",
    lifecycleState: "open",
    url: "https://github.com/pwrdrvr/codex/pull/9",
    ...overrides,
  };
}
