import { describe, expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import {
  classifyGithubMergeMethod,
  fallbackTerminalDetails,
  formatTerminalDetailsLines,
  parseGithubTerminalDetails,
  parseGitLabTerminalDetails,
  type GithubTerminalNode,
} from "../pr-status/pr-terminal-details";

const HEAD = "a".repeat(40);
const LANDED = "b".repeat(40);

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    org: "pwrdrvr",
    repo: "PwrAgent",
    number: 42,
    url: "https://github.com/pwrdrvr/PwrAgent/pull/42",
    title: "Wake on merge",
    state: "passing",
    checkState: "passing",
    lifecycleState: "merged",
    reviewState: "ready_for_review",
    mergeState: "unknown",
    baseRefName: "main",
    headSha: HEAD,
    mergedAt: Date.parse("2026-10-25T12:00:00.000Z"),
    ...overrides,
  };
}

const lastPrCommit = {
  oid: HEAD,
  message: "Wake the thread on merge\n\nBody text.",
  authoredDate: "2026-10-24T09:00:00Z",
};

function mergedNode(overrides: Partial<GithubTerminalNode> = {}): GithubTerminalNode {
  return {
    number: 42,
    url: "https://github.com/pwrdrvr/PwrAgent/pull/42",
    state: "MERGED",
    merged: true,
    mergedAt: "2026-10-25T12:00:00Z",
    baseRefName: "main",
    headRefOid: HEAD,
    mergedBy: { login: "octocat" },
    commits: { totalCount: 3, nodes: [{ commit: lastPrCommit }] },
    ...overrides,
  };
}

describe("classifyGithubMergeMethod", () => {
  it("reads a two-parent commit as a merge commit", () => {
    expect(classifyGithubMergeMethod(mergedNode({
      mergeCommit: {
        oid: LANDED,
        message: "Merge pull request #42 from pwrdrvr/wake",
        authoredDate: "2026-10-25T12:00:00Z",
        parents: { totalCount: 2 },
      },
    }))).toMatchObject({ method: "merge" });
  });

  it("reads a new single-parent commit as a squash", () => {
    expect(classifyGithubMergeMethod(mergedNode({
      mergeCommit: {
        oid: LANDED,
        message: "Wake on merge (#42)\n\n* Wake the thread on merge",
        authoredDate: "2026-10-25T12:00:00Z",
        parents: { totalCount: 1 },
      },
    }))).toMatchObject({
      method: "squash",
      evidence: expect.stringContaining("replacing the PR's 3 commits"),
    });
  });

  it("reads a squash of one commit that kept its message as a squash by its new author date", () => {
    expect(classifyGithubMergeMethod(mergedNode({
      commits: { totalCount: 1, nodes: [{ commit: lastPrCommit }] },
      mergeCommit: {
        oid: LANDED,
        message: lastPrCommit.message,
        authoredDate: "2026-10-25T12:00:00Z",
        parents: { totalCount: 1 },
      },
    }))).toMatchObject({
      method: "squash",
      evidence: expect.stringContaining("author date differs"),
    });
  });

  it("reads a replayed last commit with a new SHA as a rebase", () => {
    expect(classifyGithubMergeMethod(mergedNode({
      mergeCommit: {
        oid: LANDED,
        message: "Wake the thread on merge\r\n\r\nBody text.\n",
        authoredDate: "2026-10-24T09:00:00.000Z",
        parents: { totalCount: 1 },
      },
    }))).toMatchObject({ method: "rebase" });
  });

  it("reports unknown when the PR head itself landed", () => {
    expect(classifyGithubMergeMethod(mergedNode({
      mergeCommit: {
        oid: HEAD,
        message: lastPrCommit.message,
        authoredDate: lastPrCommit.authoredDate,
        parents: { totalCount: 1 },
      },
    }))).toMatchObject({
      method: "unknown",
      evidence: expect.stringContaining("fast-forward or manual push"),
    });
  });

  it("reports unknown without a merge commit or the PR's last commit", () => {
    expect(classifyGithubMergeMethod(mergedNode({ mergeCommit: null })).method)
      .toBe("unknown");
    expect(classifyGithubMergeMethod(mergedNode({
      commits: { totalCount: 3, nodes: [] },
      mergeCommit: {
        oid: LANDED,
        message: "x",
        authoredDate: "2026-10-25T12:00:00Z",
        parents: { totalCount: 1 },
      },
    })).method).toBe("unknown");
  });
});

describe("parseGithubTerminalDetails", () => {
  it("returns the outcome, method, commit, merger, time, and base branch of a merge", () => {
    expect(parseGithubTerminalDetails(mergedNode({
      mergeCommit: {
        oid: LANDED,
        message: "Merge pull request #42",
        authoredDate: "2026-10-25T12:00:00Z",
        parents: { totalCount: 2 },
      },
    }), pr())).toEqual({
      outcome: "merged",
      prKey: "github.com/pwrdrvr/pwragent#42",
      prUrl: "https://github.com/pwrdrvr/PwrAgent/pull/42",
      prNumber: 42,
      prTitle: "Wake on merge",
      baseBranch: "main",
      headSha: HEAD,
      mergeMethod: "merge",
      mergeMethodEvidence: "The merge commit has 2 parents.",
      mergeCommitSha: LANDED,
      mergedBy: "octocat",
      mergedAt: "2026-10-25T12:00:00.000Z",
    });
  });

  it("returns who closed an unmerged PR and when, with no merge fields", () => {
    const details = parseGithubTerminalDetails({
      state: "CLOSED",
      merged: false,
      closedAt: "2026-10-25T13:00:00Z",
      baseRefName: "main",
      headRefOid: HEAD,
      mergeCommit: null,
      timelineItems: {
        nodes: [{ actor: { login: "maintainer" }, createdAt: "2026-10-25T13:00:00Z" }],
      },
    }, pr({ lifecycleState: "closed", mergedAt: undefined }));
    expect(details).toMatchObject({
      outcome: "closed",
      closedBy: "maintainer",
      closedAt: "2026-10-25T13:00:00.000Z",
      baseBranch: "main",
    });
    expect(details).not.toHaveProperty("mergeMethod");
    expect(formatTerminalDetailsLines(details!)).toContain(
      "- Outcome: closed without merge",
    );
  });

  it("returns undefined for a PR that is open again", () => {
    expect(parseGithubTerminalDetails({ state: "OPEN", merged: false }, pr()))
      .toBeUndefined();
  });
});

describe("parseGitLabTerminalDetails", () => {
  const mr = pr({
    provider: "gitlab.com",
    org: "group",
    repo: "project",
    url: "https://gitlab.com/group/project/-/merge_requests/42",
  });

  it("reads the squash flag as a squash, keeping the merge commit SHA", () => {
    expect(parseGitLabTerminalDetails({
      state: "merged",
      target_branch: "main",
      squash: true,
      squash_commit_sha: "c".repeat(40),
      merge_commit_sha: LANDED,
      merge_user: { username: "maintainer" },
      merged_at: "2026-10-25T12:00:00Z",
    }, mr)).toMatchObject({
      outcome: "merged",
      mergeMethod: "squash",
      mergeCommitSha: LANDED,
      mergedBy: "maintainer",
      baseBranch: "main",
    });
  });

  it("reads a merge commit without squash as a merge", () => {
    expect(parseGitLabTerminalDetails({
      state: "merged",
      squash: false,
      merge_commit_sha: LANDED,
    }, mr)).toMatchObject({ mergeMethod: "merge", mergeCommitSha: LANDED });
  });

  it("reports a fast-forward as unknown", () => {
    expect(parseGitLabTerminalDetails({
      state: "merged",
      squash: false,
      merge_commit_sha: null,
    }, mr)).toMatchObject({
      mergeMethod: "unknown",
      mergeMethodEvidence: expect.stringContaining("fast-forwarded"),
    });
  });

  it("reads a closed MR as closed without merge", () => {
    expect(parseGitLabTerminalDetails({
      state: "closed",
      closed_by: { username: "maintainer" },
      closed_at: "2026-10-25T13:00:00Z",
    }, { ...mr, lifecycleState: "closed" })).toMatchObject({
      outcome: "closed",
      closedBy: "maintainer",
      closedAt: "2026-10-25T13:00:00.000Z",
    });
  });
});

describe("fallbackTerminalDetails", () => {
  it("says what cached status knows and why the rest is missing", () => {
    expect(fallbackTerminalDetails(pr(), "gh is signed out")).toMatchObject({
      outcome: "merged",
      baseBranch: "main",
      mergedAt: "2026-10-25T12:00:00.000Z",
      mergeMethod: "unknown",
      detailsUnavailableReason: "gh is signed out",
    });
    expect(fallbackTerminalDetails(pr({ lifecycleState: "open" }), "x"))
      .toBeUndefined();
  });
});
