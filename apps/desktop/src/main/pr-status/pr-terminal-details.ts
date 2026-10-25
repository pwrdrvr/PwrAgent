import {
  buildPullRequestStatusKey,
  type PrSummary,
  type PullRequestMergeMethod,
  type PullRequestTerminalDetails,
} from "@pwragent/shared";

/**
 * Merge details for a PR that has merged or closed.
 *
 * Neither GitHub nor GitLab records which merge method a PR used, so it is
 * inferred from the commit that landed on the base branch:
 *
 * - Two or more parents: a merge commit. This is conclusive.
 * - One parent and the commit IS the PR head: the head reached the base
 *   unchanged (a fast-forward or a manual push). GitHub's own rebase always
 *   rewrites the committer, so this is not a GitHub rebase merge. `unknown`.
 * - One parent and the commit matches the PR's last commit by message and
 *   author date: a rebase merge. Rebasing replays each commit with a new SHA
 *   but keeps its message and author date.
 * - One parent and the commit differs from the PR's last commit: a squash.
 *   Squashing writes one new commit with its own message and date.
 *
 * Without a merge commit, or without the PR's last commit to compare, the
 * method is `unknown`. Limits: a squash whose author date and message both
 * equal the PR's last commit (one-commit PR, message kept verbatim, date
 * preserved) reads as a rebase; GitHub's squash writes a new author date, so
 * that should not occur on github.com.
 */

export type GithubTerminalCommit = {
  oid?: string | null;
  message?: string | null;
  authoredDate?: string | null;
};

export type GithubTerminalNode = {
  number?: number | null;
  url?: string | null;
  title?: string | null;
  state?: string | null;
  merged?: boolean | null;
  mergedAt?: string | null;
  closedAt?: string | null;
  baseRefName?: string | null;
  headRefOid?: string | null;
  mergedBy?: { login?: string | null } | null;
  mergeCommit?: (GithubTerminalCommit & {
    parents?: {
      totalCount?: number | null;
    } | null;
  }) | null;
  commits?: {
    totalCount?: number | null;
    nodes?: ({ commit?: GithubTerminalCommit | null } | null)[] | null;
  } | null;
  timelineItems?: {
    nodes?: ({
      actor?: { login?: string | null } | null;
      createdAt?: string | null;
    } | null)[] | null;
  } | null;
};

export function classifyGithubMergeMethod(node: GithubTerminalNode): {
  method: PullRequestMergeMethod;
  evidence: string;
} {
  const mergeCommit = node.mergeCommit;
  if (!mergeCommit?.oid) {
    return {
      method: "unknown",
      evidence: "GitHub reported no merge commit.",
    };
  }
  const parentCount = mergeCommit.parents?.totalCount;
  if (typeof parentCount !== "number") {
    return {
      method: "unknown",
      evidence: "GitHub did not report the merge commit's parents.",
    };
  }
  if (parentCount >= 2) {
    return {
      method: "merge",
      evidence: `The merge commit has ${parentCount} parents.`,
    };
  }
  const headSha = node.headRefOid?.trim();
  if (headSha && mergeCommit.oid === headSha) {
    return {
      method: "unknown",
      evidence:
        "The merged commit is the PR head itself, so the branch reached the base unchanged (a fast-forward or manual push).",
    };
  }
  const lastCommit = node.commits?.nodes?.at(-1)?.commit;
  if (!lastCommit?.oid || !lastCommit.message || !lastCommit.authoredDate) {
    return {
      method: "unknown",
      evidence:
        "The merge commit has one parent, and the PR's last commit was unavailable to tell a squash from a rebase.",
    };
  }
  if (!mergeCommit.message || !mergeCommit.authoredDate) {
    return {
      method: "unknown",
      evidence:
        "The merge commit has one parent, and its message or author date was unavailable to tell a squash from a rebase.",
    };
  }
  const sameMessage =
    normalizeCommitMessage(mergeCommit.message)
    === normalizeCommitMessage(lastCommit.message);
  const sameAuthorDate =
    Date.parse(mergeCommit.authoredDate) === Date.parse(lastCommit.authoredDate);
  if (sameMessage && sameAuthorDate) {
    return {
      method: "rebase",
      evidence:
        "The merge commit has one parent and replays the PR's last commit with a new SHA, keeping its message and author date.",
    };
  }
  const commitCount = node.commits?.totalCount;
  return {
    method: "squash",
    evidence:
      `The merge commit has one parent and is a new commit${
        typeof commitCount === "number"
          ? ` replacing the PR's ${commitCount} commit${commitCount === 1 ? "" : "s"}`
          : ""
      }: its ${sameMessage ? "author date" : "message"} differs from the PR's last commit.`,
  };
}

export function parseGithubTerminalDetails(
  node: GithubTerminalNode,
  pr: PrSummary,
): PullRequestTerminalDetails | undefined {
  const merged = node.merged === true || node.state === "MERGED";
  const closed = !merged && node.state === "CLOSED";
  if (!merged && !closed) return undefined;
  const base = baseTerminalDetails(pr, merged ? "merged" : "closed");
  const baseBranch = node.baseRefName?.trim() || base.baseBranch;
  const headSha = node.headRefOid?.trim() || base.headSha;
  if (merged) {
    const { method, evidence } = classifyGithubMergeMethod(node);
    return {
      ...base,
      ...(baseBranch ? { baseBranch } : {}),
      ...(headSha ? { headSha } : {}),
      mergeMethod: method,
      mergeMethodEvidence: evidence,
      ...(node.mergeCommit?.oid ? { mergeCommitSha: node.mergeCommit.oid } : {}),
      ...(node.mergedBy?.login ? { mergedBy: node.mergedBy.login } : {}),
      ...(isoTimestamp(node.mergedAt) ?? base.mergedAt
        ? { mergedAt: isoTimestamp(node.mergedAt) ?? base.mergedAt }
        : {}),
    };
  }
  const closeEvent = node.timelineItems?.nodes?.at(-1);
  const closedAt = isoTimestamp(node.closedAt)
    ?? isoTimestamp(closeEvent?.createdAt)
    ?? base.closedAt;
  return {
    ...base,
    ...(baseBranch ? { baseBranch } : {}),
    ...(headSha ? { headSha } : {}),
    ...(closeEvent?.actor?.login ? { closedBy: closeEvent.actor.login } : {}),
    ...(closedAt ? { closedAt } : {}),
  };
}

export type GitLabTerminalPayload = {
  state?: string;
  target_branch?: string;
  sha?: string;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  squash?: boolean | null;
  merged_by?: { username?: string | null } | null;
  merge_user?: { username?: string | null } | null;
  merged_at?: string | null;
  closed_by?: { username?: string | null } | null;
  closed_at?: string | null;
};

/**
 * GitLab records whether it squashed and which merge commit it wrote. A
 * squash can still be followed by a merge commit; it reports `squash`, the
 * method that shaped the PR's commits, with the merge commit's SHA. With no
 * merge commit and no squash, GitLab fast-forwarded the source branch, which
 * may or may not have been rebased first, so that reports `unknown`.
 */
export function parseGitLabTerminalDetails(
  payload: GitLabTerminalPayload,
  pr: PrSummary,
): PullRequestTerminalDetails | undefined {
  const merged = payload.state === "merged";
  const closed = payload.state === "closed";
  if (!merged && !closed) return undefined;
  const base = baseTerminalDetails(pr, merged ? "merged" : "closed");
  const baseBranch = payload.target_branch?.trim() || base.baseBranch;
  const headSha = payload.sha?.trim() || base.headSha;
  if (!merged) {
    const closedAt = isoTimestamp(payload.closed_at) ?? base.closedAt;
    return {
      ...base,
      ...(baseBranch ? { baseBranch } : {}),
      ...(headSha ? { headSha } : {}),
      ...(payload.closed_by?.username ? { closedBy: payload.closed_by.username } : {}),
      ...(closedAt ? { closedAt } : {}),
    };
  }
  const squashed = payload.squash === true || Boolean(payload.squash_commit_sha);
  const mergeCommitSha = payload.merge_commit_sha?.trim()
    || payload.squash_commit_sha?.trim()
    || undefined;
  const { method, evidence }: { method: PullRequestMergeMethod; evidence: string } = squashed
    ? {
        method: "squash",
        evidence: payload.merge_commit_sha
          ? "GitLab squashed the source commits, then wrote a merge commit."
          : "GitLab squashed the source commits.",
      }
    : payload.merge_commit_sha
      ? { method: "merge", evidence: "GitLab wrote a merge commit." }
      : {
          method: "unknown",
          evidence:
            "GitLab wrote no merge commit and did not squash, so it fast-forwarded the source branch; it may have been rebased first.",
        };
  const mergedBy = payload.merge_user?.username ?? payload.merged_by?.username;
  const mergedAt = isoTimestamp(payload.merged_at) ?? base.mergedAt;
  return {
    ...base,
    ...(baseBranch ? { baseBranch } : {}),
    ...(headSha ? { headSha } : {}),
    mergeMethod: method,
    mergeMethodEvidence: evidence,
    ...(mergeCommitSha ? { mergeCommitSha } : {}),
    ...(mergedBy ? { mergedBy } : {}),
    ...(mergedAt ? { mergedAt } : {}),
  };
}

/** What cached status alone can say, used when the forge lookup fails. */
export function fallbackTerminalDetails(
  pr: PrSummary,
  reason: string,
): PullRequestTerminalDetails | undefined {
  const outcome = terminalOutcomeOf(pr);
  if (!outcome) return undefined;
  return {
    ...baseTerminalDetails(pr, outcome),
    ...(outcome === "merged"
      ? {
          mergeMethod: "unknown" as const,
          mergeMethodEvidence: "The forge lookup for merge details failed.",
        }
      : {}),
    detailsUnavailableReason: reason,
  };
}

export function terminalOutcomeOf(
  pr: Pick<PrSummary, "lifecycleState">,
): "merged" | "closed" | undefined {
  if (pr.lifecycleState === "merged") return "merged";
  if (pr.lifecycleState === "closed") return "closed";
  return undefined;
}

export function formatTerminalDetailsLines(
  details: PullRequestTerminalDetails,
): string[] {
  const lines = [
    `- Outcome: ${details.outcome === "merged" ? "merged" : "closed without merge"}`,
    `- PR: ${details.prKey}`,
    `- URL: ${details.prUrl}`,
    ...(details.prTitle ? [`- Title: ${details.prTitle}`] : []),
    `- Base branch: ${details.baseBranch ?? "unknown"}`,
  ];
  if (details.outcome === "merged") {
    lines.push(
      `- Merge method: ${details.mergeMethod ?? "unknown"}${
        details.mergeMethodEvidence ? ` (${details.mergeMethodEvidence})` : ""
      }`,
      `- Merge commit SHA: ${details.mergeCommitSha ?? "unknown"}`,
      `- Merged by: ${details.mergedBy ?? "unknown"}`,
      `- Merged at: ${details.mergedAt ?? "unknown"}`,
    );
  } else {
    lines.push(
      `- Closed by: ${details.closedBy ?? "unknown"}`,
      `- Closed at: ${details.closedAt ?? "unknown"}`,
    );
  }
  if (details.headSha) lines.push(`- Final head SHA: ${details.headSha}`);
  if (details.detailsUnavailableReason) {
    lines.push(`- Details lookup: ${details.detailsUnavailableReason}`);
  }
  return lines;
}

function baseTerminalDetails(
  pr: PrSummary,
  outcome: "merged" | "closed",
): PullRequestTerminalDetails {
  const headSha = pr.headSha?.trim();
  const mergedAt = outcome === "merged" ? isoTimestamp(pr.mergedAt) : undefined;
  const closedAt = outcome === "closed" ? isoTimestamp(pr.closedAt) : undefined;
  return {
    outcome,
    prKey: buildPullRequestStatusKey(pr),
    prUrl: pr.url,
    prNumber: pr.number,
    ...(pr.title ? { prTitle: pr.title } : {}),
    ...(pr.baseRefName ? { baseBranch: pr.baseRefName } : {}),
    ...(headSha ? { headSha } : {}),
    ...(mergedAt ? { mergedAt } : {}),
    ...(closedAt ? { closedAt } : {}),
  };
}

function isoTimestamp(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function normalizeCommitMessage(message: string): string {
  return message.replace(/\r\n/g, "\n").trim();
}
