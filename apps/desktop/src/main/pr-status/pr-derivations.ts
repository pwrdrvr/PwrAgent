import type {
  PrChipState,
  PrLifecycleState,
  PrMergeState,
  PrReviewState,
  PrSummary,
} from "@pwragent/shared";
import { DEFAULT_PULL_REQUEST_PROVIDER } from "@pwragent/shared";

/**
 * Shared PR-status derivations.
 *
 * Two transports produce a `PrSummary`:
 *
 *  - `github-pr-fetcher.ts` — the `gh pr list --json …` subprocess, used for
 *    on-selection / hover / post-turn detail fetches. Its `statusCheckRollup`
 *    is an ARRAY of individual check runs.
 *  - `github-graphql-client.ts` — the in-process batched poller. Its
 *    `statusCheckRollup` is GitHub's single pre-aggregated rollup ENUM.
 *
 * The lifecycle/review/merge derivations are shape-compatible and shared
 * verbatim. Only the check-state derivation differs, so it has one function
 * per transport (`deriveChipState` vs `deriveChipStateFromRollup`) and they
 * are held to the same outputs by a parity test.
 */

/** Subset of fields returned by `gh pr list --json …` that we actually read. */
export type GhPrPayload = {
  number: number;
  title?: string;
  url: string;
  state: string;
  isDraft: boolean;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  mergedAt: string | null;
  commits?: { oid?: string | null }[] | null;
  headRefName: string;
  headRepository: { name?: string } | null;
  headRepositoryOwner: { login?: string } | null;
  statusCheckRollup: GhCheckRunPayload[] | null;
};

export type GhCheckRunPayload = {
  __typename?: string;
  conclusion?: string | null;
  status?: string;
  name?: string;
};

/**
 * Map a `gh pr list` row to our PrSummary. Exported for direct testing
 * without invoking the subprocess.
 */
export function parseGhPrPayload(row: GhPrPayload): PrSummary {
  const checkState = deriveChipState(row);
  return {
    provider: parsePullRequestProvider(row.url),
    number: row.number,
    org: row.headRepositoryOwner?.login ?? "",
    repo: row.headRepository?.name ?? "",
    ...(row.title?.trim() ? { title: row.title.trim() } : {}),
    state: checkState,
    checkState,
    lifecycleState: deriveLifecycleState(row),
    reviewState: deriveReviewState(row),
    mergeState: deriveMergeState(row),
    ...parseCommitShas(row.commits),
    url: row.url,
  };
}

export function parseCommitShas(
  commits: { oid?: string | null }[] | null | undefined,
): Pick<PrSummary, "commitShas"> {
  const commitShas = normalizeCommitShas(
    (commits ?? []).map((commit) => commit.oid),
  );
  return commitShas.length > 0 ? { commitShas } : {};
}

export function normalizeCommitShas(
  oids: (string | null | undefined)[],
): string[] {
  return [
    ...new Set(
      oids
        .map((oid) => oid?.trim().toLowerCase())
        .filter((oid): oid is string => Boolean(oid && /^[0-9a-f]{40}$/.test(oid))),
    ),
  ].sort();
}

/**
 * Union two commit-SHA sets.
 *
 * The batched poller only fetches the PR's HEAD commit (`commits(last: 1)`) —
 * that is all `statusCheckRollup` needs, and widening it to the full commit
 * list would multiply the GraphQL node cost of every batch. But `commitShas`
 * is load-bearing for merged-PR "pushed" detection, and the `gh` path DOES
 * populate the full list. So the poller unions its head SHA into whatever is
 * already known rather than replacing (and shrinking) the set.
 */
export function mergeCommitShas(
  previous: string[] | undefined,
  next: string[] | undefined,
): string[] {
  return normalizeCommitShas([...(previous ?? []), ...(next ?? [])]);
}

export function parsePullRequestProvider(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase() || DEFAULT_PULL_REQUEST_PROVIDER;
  } catch {
    return DEFAULT_PULL_REQUEST_PROVIDER;
  }
}

/** A PR whose lifecycle can no longer change — polling it again is wasted budget. */
export function isTerminalPullRequest(
  pr: Pick<PrSummary, "lifecycleState">,
): boolean {
  return pr.lifecycleState === "merged" || pr.lifecycleState === "closed";
}

/** Derive the chip state from `gh`'s array of individual check runs. */
export function deriveChipState(row: GhPrPayload): PrChipState {
  const checks = row.statusCheckRollup ?? [];
  if (checks.length === 0) return "unknown";

  const failingConclusions = new Set([
    "FAILURE",
    "CANCELLED",
    "TIMED_OUT",
    "STARTUP_FAILURE",
    "ACTION_REQUIRED",
  ]);
  const passingConclusions = new Set([
    "SUCCESS",
    "SKIPPED",
    "NEUTRAL",
    "STALE",
  ]);

  let pendingCount = 0;
  for (const check of checks) {
    if (check.conclusion && failingConclusions.has(check.conclusion)) {
      return "failing";
    }
    if (check.conclusion && passingConclusions.has(check.conclusion)) {
      continue;
    }
    if (!check.conclusion) {
      pendingCount += 1;
      continue;
    }
    // Conclusion we don't recognize as either pass or fail — be conservative.
    return "unknown";
  }
  if (pendingCount > 0) return "pending";
  return "passing";
}

/**
 * GitHub's `StatusState` enum, returned by `statusCheckRollup { state }`.
 * This is the rollup GitHub itself computes across every check run and commit
 * status on the head commit — the same aggregate the PR page shows.
 */
export type StatusCheckRollupState =
  | "EXPECTED"
  | "ERROR"
  | "FAILURE"
  | "PENDING"
  | "SUCCESS";

/**
 * Derive the chip state from GitHub's pre-aggregated rollup enum.
 *
 * A `null` rollup means the head commit has no checks or statuses at all,
 * which maps to `unknown` — matching `deriveChipState`'s empty-array case.
 * `EXPECTED` (a required check that has not reported yet) is pending, not
 * failing: the check is owed, not broken.
 */
export function deriveChipStateFromRollup(
  rollupState: StatusCheckRollupState | string | null | undefined,
): PrChipState {
  switch (rollupState) {
    case "SUCCESS":
      return "passing";
    case "FAILURE":
    case "ERROR":
      return "failing";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      // No rollup (no checks configured) or an enum GitHub added since —
      // be conservative rather than claiming a pass.
      return "unknown";
  }
}

export function deriveLifecycleState(
  row: Pick<GhPrPayload, "state">,
): PrLifecycleState {
  if (row.state === "MERGED") return "merged";
  if (row.state === "CLOSED") return "closed";
  return "open";
}

export function deriveReviewState(
  row: Pick<GhPrPayload, "isDraft">,
): PrReviewState {
  return row.isDraft ? "draft" : "ready_for_review";
}

export function deriveMergeState(
  row: Pick<GhPrPayload, "mergeable" | "mergeStateStatus" | "state">,
): PrMergeState {
  if (deriveLifecycleState(row) !== "open") {
    return "unknown";
  }
  if (row.mergeStateStatus === "DIRTY" || row.mergeable === "CONFLICTING") {
    return "conflicting";
  }
  if (row.mergeStateStatus === "CLEAN" || row.mergeable === "MERGEABLE") {
    return "mergeable";
  }
  return "unknown";
}
