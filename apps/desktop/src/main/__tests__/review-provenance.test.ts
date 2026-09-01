import type { LinkedDirectorySummary, PrSummary } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import { resolveReviewProvenance } from "../app-server/review-provenance";

const WORKSPACE = "/Users/dev/pwrdrvr/PwrAgent";
const WORKTREE = "/Users/dev/.codex/worktrees/mti5p133/PwrAgent";

function directory(
  overrides: Partial<LinkedDirectorySummary> = {},
): LinkedDirectorySummary {
  return {
    id: "dir-1",
    kind: "local",
    label: "PwrAgent",
    path: WORKSPACE,
    ...overrides,
  };
}

function pullRequest(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number: 1918,
    org: "pwrdrvr",
    repo: "PwrAgent",
    state: "passing",
    lifecycleState: "open",
    headRefName: "fix/macos-dock-icon-safe-area",
    baseRefName: "main",
    linkedDirectoryPaths: [WORKSPACE],
    url: "https://github.com/pwrdrvr/PwrAgent/pull/1918",
    ...overrides,
  };
}

function gitRunner(branch: string | undefined) {
  return async (_cwd: string, args: string[]): Promise<{ stdout: string }> => {
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
      if (branch === undefined) {
        throw new Error("not a git repository");
      }
      return { stdout: `${branch}\n` };
    }
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  };
}

const noRepos = async () => [];

describe("resolveReviewProvenance", () => {
  it("names the pull request open on the checked-out branch", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      prs: [pullRequest()],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner("fix/macos-dock-icon-safe-area"),
      target: { type: "baseBranch", branch: "origin/main" },
    });

    expect(context).toMatchObject({
      baseBranch: "origin/main",
      gitBranch: "fix/macos-dock-icon-safe-area",
      projectLabel: "PwrAgent",
      workspacePath: WORKSPACE,
    });
    expect(context?.pullRequest).toMatchObject({
      baseRefName: "main",
      number: 1918,
      org: "pwrdrvr",
      repo: "PwrAgent",
    });
  });

  it("carries no check, review, or merge status onto the frozen record", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      prs: [pullRequest({ checkState: "passing", mergeState: "mergeable" })],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner("fix/macos-dock-icon-safe-area"),
      target: { type: "baseBranch", branch: "origin/main" },
    });

    // A status frozen at review start is still painting that day's CI result
    // months later. Identity is the only thing safe to keep.
    expect(Object.keys(context?.pullRequest ?? {}).sort()).toEqual([
      "baseRefName",
      "headRefName",
      "number",
      "org",
      "provider",
      "repo",
      "url",
    ]);
  });

  it("keeps the pull request when the operator overrode its base", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      prs: [
        pullRequest({
          baseRefName: "feat/star-map-layer",
          headRefName: "feat/star-map-float",
          number: 1252,
        }),
      ],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner("feat/star-map-float"),
      target: { type: "baseBranch", branch: "origin/main" },
    });

    // The branch carried this PR; what the diff swept in from the PRs below it
    // is unknowable, so the record says nothing about them either way.
    expect(context?.pullRequest?.number).toBe(1252);
    expect(context?.baseBranch).toBe("origin/main");
    expect(context?.pullRequest?.baseRefName).toBe("feat/star-map-layer");
  });

  it("follows the selected project rather than the thread's other repositories", async () => {
    const context = await resolveReviewProvenance({
      cwd: "/Users/dev/pwrdrvr/PwrSuiteLab",
      linkedDirectories: [
        directory(),
        directory({
          id: "dir-2",
          label: "PwrSuiteLab",
          path: "/Users/dev/pwrdrvr/PwrSuiteLab",
        }),
      ],
      prs: [
        pullRequest(),
        pullRequest({
          headRefName: "agent/windows-warm-e2e",
          linkedDirectoryPaths: ["/Users/dev/pwrdrvr/PwrSuiteLab"],
          number: 21,
          repo: "PwrSuiteLab",
          url: "https://github.com/pwrdrvr/PwrSuiteLab/pull/21",
        }),
      ],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner("agent/windows-warm-e2e"),
      target: { type: "baseBranch", branch: "origin/main" },
    });

    expect(context?.projectLabel).toBe("PwrSuiteLab");
    expect(context?.pullRequest?.number).toBe(21);
  });

  it("reports null when the branch was checked and carried no pull request", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      // The thread holds a PR — for a different branch. It is not evidence
      // about this diff and must not be named here.
      prs: [pullRequest()],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner("main"),
      target: { type: "baseBranch", branch: "origin/main" },
    });

    expect(context?.gitBranch).toBe("main");
    expect(context?.pullRequest).toBeNull();
  });

  it("never crosses a shared branch name into another repository", async () => {
    const context = await resolveReviewProvenance({
      cwd: "/Users/dev/pwrdrvr/PwrSnap",
      linkedDirectories: [
        directory({
          id: "dir-3",
          label: "PwrSnap",
          path: "/Users/dev/pwrdrvr/PwrSnap",
        }),
      ],
      prs: [pullRequest({ headRefName: "main" })],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner("main"),
      target: { type: "baseBranch", branch: "origin/main" },
    });

    expect(context?.pullRequest).toBeNull();
  });

  it("makes no branch or pull-request claim for a commit target", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      prs: [pullRequest()],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner("fix/macos-dock-icon-safe-area"),
      target: { type: "commit", sha: "8117be6f9", title: null },
    });

    expect(context?.gitBranch).toBeUndefined();
    // Absent, not null: nothing was checked, so "there was none" would be a
    // claim we did not earn.
    expect(context?.pullRequest).toBeUndefined();
  });

  it("makes no pull-request claim on a detached HEAD", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      prs: [pullRequest()],
      resolveGitHubRepos: noRepos,
      // Git answers a detached HEAD with the literal string rather than failing.
      runGit: gitRunner("HEAD"),
      target: { type: "uncommittedChanges" },
    });

    expect(context?.gitBranch).toBeUndefined();
    expect(context?.pullRequest).toBeUndefined();
  });

  it("leaves the pull request unknown when no pull-request data was fetched", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner("fix/macos-dock-icon-safe-area"),
      target: { type: "baseBranch", branch: "origin/main" },
    });

    expect(context?.gitBranch).toBe("fix/macos-dock-icon-safe-area");
    expect(context?.pullRequest).toBeUndefined();
  });

  it("records the repository a worktree belongs to", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKTREE,
      linkedDirectories: [
        directory({ kind: "worktree", worktreePath: WORKTREE }),
      ],
      prs: [pullRequest({ linkedDirectoryPaths: [WORKTREE] })],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner("fix/macos-dock-icon-safe-area"),
      target: { type: "baseBranch", branch: "origin/main" },
    });

    expect(context?.workspacePath).toBe(WORKTREE);
    expect(context?.repositoryPath).toBe(WORKSPACE);
    expect(context?.projectLabel).toBe("PwrAgent");
  });

  it("prefers the open pull request when a branch carries more than one", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      prs: [
        pullRequest({ lifecycleState: "open", number: 1900 }),
        pullRequest({ lifecycleState: "closed", number: 1999 }),
      ],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner("fix/macos-dock-icon-safe-area"),
      target: { type: "baseBranch", branch: "origin/main" },
    });

    expect(context?.pullRequest?.number).toBe(1900);
  });

  it("does not read local Git for a remote workspace", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      executionTarget: "remote",
      linkedDirectories: [
        directory({ gitBranch: "fix/macos-dock-icon-safe-area" }),
      ],
      prs: [pullRequest()],
      resolveGitHubRepos: noRepos,
      runGit: async () => {
        throw new Error("local git must not run for a remote workspace");
      },
      target: { type: "baseBranch", branch: "origin/main" },
    });

    expect(context?.gitBranch).toBe("fix/macos-dock-icon-safe-area");
    expect(context?.pullRequest?.number).toBe(1918);
  });

  it("returns nothing at all when there is no workspace to name", async () => {
    await expect(
      resolveReviewProvenance({
        prs: [pullRequest()],
        target: { type: "uncommittedChanges" },
      }),
    ).resolves.toBeUndefined();
  });
});
