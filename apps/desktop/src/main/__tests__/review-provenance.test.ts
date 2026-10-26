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

const HEAD_COMMIT = "489d16ff09abcdef0123456789abcdef01234567";
const MERGE_BASE = "0f12ab34cd56ef7890abcdef1234567890abcdef";

/**
 * Answers only what the caller asked for. Anything left undefined fails the
 * way Git fails, so a test that expects a field to be absent proves the
 * resolver survives that failure rather than that the question went unasked.
 */
function gitRunner(
  branch: string | undefined,
  commits: { head?: string; mergeBase?: string } = {},
  seen?: string[][],
) {
  return async (_cwd: string, args: string[]): Promise<{ stdout: string }> => {
    seen?.push(args);
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
      if (branch === undefined) {
        throw new Error("not a git repository");
      }
      return { stdout: `${branch}\n` };
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      if (commits.head === undefined) {
        throw new Error("not a git repository");
      }
      return { stdout: `${commits.head}\n` };
    }
    if (args[0] === "merge-base") {
      if (commits.mergeBase === undefined) {
        throw new Error(`no merge base with ${args[1]}`);
      }
      return { stdout: `${commits.mergeBase}\n` };
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
    // Navigation's remembered branch is all there is; there is no local
    // checkout to read a commit out of.
    expect(context?.headCommit).toBeUndefined();
    expect(context?.baseCommit).toBeUndefined();
  });

  it("records the commit reviewed and the commit the diff started from", async () => {
    const seen: string[][] = [];
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      prs: [pullRequest()],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner(
        "fix/macos-dock-icon-safe-area",
        { head: HEAD_COMMIT, mergeBase: MERGE_BASE },
        seen,
      ),
      target: { type: "baseBranch", branch: "origin/main" },
    });

    expect(context?.headCommit).toBe(HEAD_COMMIT);
    expect(context?.baseCommit).toBe(MERGE_BASE);
    // The managed review prompt asks for the merge base, so the recorded base
    // has to be that and not the base branch's own tip.
    expect(seen).toContainEqual(["merge-base", "origin/main", "HEAD"]);
  });

  it("records the reviewed commit on a detached HEAD, which has no branch to name", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      prs: [pullRequest()],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner("HEAD", { head: HEAD_COMMIT }),
      target: { type: "uncommittedChanges" },
    });

    expect(context?.headCommit).toBe(HEAD_COMMIT);
    expect(context?.gitBranch).toBeUndefined();
  });

  it("names no base commit for a review with no base to diff from", async () => {
    const seen: string[][] = [];
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner(
        "fix/macos-dock-icon-safe-area",
        { head: HEAD_COMMIT, mergeBase: MERGE_BASE },
        seen,
      ),
      target: { type: "uncommittedChanges" },
    });

    // An uncommitted-changes review diffs against HEAD itself. A second commit
    // here would invent a range the reviewer never looked at.
    expect(context?.headCommit).toBe(HEAD_COMMIT);
    expect(context?.baseCommit).toBeUndefined();
    expect(seen.some((args) => args[0] === "merge-base")).toBe(false);
  });

  it("keeps the reviewed commit when the base branch was never fetched", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner("fix/macos-dock-icon-safe-area", { head: HEAD_COMMIT }),
      target: { type: "baseBranch", branch: "origin/main" },
    });

    expect(context?.headCommit).toBe(HEAD_COMMIT);
    expect(context?.baseCommit).toBeUndefined();
  });

  it("refuses text that is not a commit hash", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      resolveGitHubRepos: noRepos,
      // Some wrappers answer a failure on stdout with a zero exit. Freezing
      // that onto the card as a commit is worse than the absent field.
      runGit: gitRunner("fix/macos-dock-icon-safe-area", {
        head: "fatal: not a valid object name",
      }),
      target: { type: "baseBranch", branch: "origin/main" },
    });

    expect(context?.headCommit).toBeUndefined();
    expect(context?.gitBranch).toBe("fix/macos-dock-icon-safe-area");
  });

  it("records the 64-character hash a SHA-256 repository prints", async () => {
    const sha256Head = "a".repeat(64);
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner("fix/macos-dock-icon-safe-area", { head: sha256Head }),
      target: { type: "baseBranch", branch: "origin/main" },
    });

    // Capping the hash at SHA-1's width would leave every review in such a
    // repository with no commit at all.
    expect(context?.headCommit).toBe(sha256Head);
  });

  it("makes no commit claim for a commit target", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner("fix/macos-dock-icon-safe-area", { head: HEAD_COMMIT }),
      target: { type: "commit", sha: "8117be6f9", title: null },
    });

    // The target already names its own subject; the workspace's HEAD is beside
    // the point and would read as the thing that was reviewed.
    expect(context?.headCommit).toBeUndefined();
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

describe("resolveReviewProvenance for a review that named its pull requests", () => {
  const CHECKED_OUT = pullRequest();
  const OTHER = pullRequest({
    number: 1920,
    headRefName: "feat/rollup-chip",
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    title: "Lead the rollup chip",
    url: "https://github.com/pwrdrvr/PwrAgent/pull/1920",
  });
  const claudeTarget = { type: "custom", instructions: "/code-review" } as const;

  it("names the pull request the review named, not the one on the checked-out branch", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      namedPullRequests: [{ number: 1920 }],
      prs: [CHECKED_OUT, OTHER],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner(CHECKED_OUT.headRefName, { head: HEAD_COMMIT }),
      target: claudeTarget,
    });

    expect(context).toEqual({
      workspacePath: WORKSPACE,
      projectLabel: "PwrAgent",
      gitBranch: "feat/rollup-chip",
      baseBranch: "main",
      pullRequest: expect.objectContaining({ number: 1920, title: "Lead the rollup chip" }),
    });
    // The workspace's HEAD is another branch's commit, and the cached head of
    // the named pull request may not be the state the reviewer read.
    expect(context?.headCommit).toBeUndefined();
  });

  it("keeps the checked-out branch's provenance when it carries the named pull request", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      namedPullRequests: [{ number: 1918 }],
      prs: [CHECKED_OUT, OTHER],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner(CHECKED_OUT.headRefName, { head: HEAD_COMMIT }),
      target: claudeTarget,
    });

    expect(context).toMatchObject({
      gitBranch: CHECKED_OUT.headRefName,
      headCommit: HEAD_COMMIT,
      pullRequest: expect.objectContaining({ number: 1918 }),
    });
    expect(context).not.toHaveProperty("pullRequests");
  });

  it("names every pull request a review of several covered, in the order named", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      namedPullRequests: [{ number: 1920 }, { number: 1918 }],
      prs: [CHECKED_OUT, OTHER],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner(CHECKED_OUT.headRefName, { head: HEAD_COMMIT }),
      target: claudeTarget,
    });

    expect(context?.pullRequests?.map((pr) => pr.number)).toEqual([1920, 1918]);
    expect(context?.pullRequest?.number).toBe(1920);
    // One branch and one commit cannot describe two pull requests' diffs.
    expect(context?.gitBranch).toBeUndefined();
    expect(context?.headCommit).toBeUndefined();
  });

  it("matches a repository-qualified target to that repository's pull request", async () => {
    const elsewhere = pullRequest({ repo: "PwrSnap", url: "https://github.com/pwrdrvr/PwrSnap/pull/1918" });
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      namedPullRequests: [{ number: 1918, org: "pwrdrvr", repo: "pwrsnap" }],
      prs: [CHECKED_OUT, elsewhere],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner("some/other-branch"),
      target: claudeTarget,
    });

    expect(context?.pullRequest).toMatchObject({ repo: "PwrSnap", number: 1918 });
  });

  it("prefers the workspace's own pull request when a bare number matches several repositories", async () => {
    const elsewhere = pullRequest({
      repo: "PwrSnap",
      linkedDirectoryPaths: ["/Users/dev/pwrdrvr/PwrSnap"],
      url: "https://github.com/pwrdrvr/PwrSnap/pull/1918",
    });
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      namedPullRequests: [{ number: 1918 }],
      prs: [elsewhere, CHECKED_OUT],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner("some/other-branch"),
      target: claudeTarget,
    });

    expect(context?.pullRequest).toMatchObject({ repo: "PwrAgent", number: 1918 });
  });

  it("names a pull request given by URL even when the thread has not attached it", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      namedPullRequests: [{
        number: 77, provider: "github.com", org: "pwrdrvr", repo: "PwrSnap",
        url: "https://github.com/pwrdrvr/PwrSnap/pull/77",
      }],
      prs: [CHECKED_OUT],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner(CHECKED_OUT.headRefName),
      target: claudeTarget,
    });

    expect(context?.pullRequest).toEqual({
      provider: "github.com", org: "pwrdrvr", repo: "PwrSnap", number: 77,
      url: "https://github.com/pwrdrvr/PwrSnap/pull/77",
    });
  });

  it("makes no pull-request or branch claim when the named pull request is unknown", async () => {
    const context = await resolveReviewProvenance({
      cwd: WORKSPACE,
      linkedDirectories: [directory()],
      namedPullRequests: [{ number: 4242 }],
      prs: [CHECKED_OUT],
      resolveGitHubRepos: noRepos,
      runGit: gitRunner(CHECKED_OUT.headRefName, { head: HEAD_COMMIT }),
      target: claudeTarget,
    });

    // The checked-out branch's pull request is the one thing known not to be
    // what was reviewed.
    expect(context).toEqual({ workspacePath: WORKSPACE, projectLabel: "PwrAgent" });
  });
});
