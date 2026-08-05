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
 *  - `github-graphql-client.ts` — the in-process batched poller. It reads
 *    GitHub's pre-aggregated rollup ENUM plus minimal per-context activity so
 *    a failed check can remain visibly in flight while sibling checks run.
 *
 * The lifecycle/review/merge derivations are shape-compatible and shared
 * verbatim. The check-state derivation differs by transport
 * (`deriveChipState` vs `deriveChipStateFromRollup`), while
 * `hasChecksStillRunning` reads the individual contexts both transports
 * expose.
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
  baseRefName?: string | null;
  headRefName: string;
  headRepository: { name?: string } | null;
  headRepositoryOwner: { login?: string } | null;
  statusCheckRollup: GhCheckRunPayload[] | null;
};

export type GhCheckRunPayload = {
  __typename?: string;
  conclusion?: string | null;
  status?: string | null;
  state?: string | null;
  name?: string;
};

/**
 * Map a `gh pr list` row to our PrSummary. Exported for direct testing
 * without invoking the subprocess.
 */
export function parseGhPrPayload(row: GhPrPayload): PrSummary {
  const checkState = deriveChipState(row);
  const checksStillRunning = hasChecksStillRunning(row.statusCheckRollup ?? []);
  const headSha = normalizeCommitShas([
    row.commits?.[row.commits.length - 1]?.oid,
  ])[0];
  return {
    provider: parsePullRequestProvider(row.url),
    number: row.number,
    org: row.headRepositoryOwner?.login ?? "",
    repo: row.headRepository?.name ?? "",
    ...(row.title?.trim() ? { title: row.title.trim() } : {}),
    ...(row.baseRefName?.trim() ? { baseRefName: row.baseRefName.trim() } : {}),
    ...(row.headRefName?.trim() ? { headRefName: row.headRefName.trim() } : {}),
    state: checkState,
    checkState,
    ...(checksStillRunning ? { checksStillRunning: true } : {}),
    lifecycleState: deriveLifecycleState(row),
    reviewState: deriveReviewState(row),
    mergeState: deriveMergeState(row),
    ...(headSha ? { headSha } : {}),
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
 * The in-process GraphQL client fetches the PR's HEAD commit
 * (`commits(last: 1)`) — that is all `statusCheckRollup` needs, and widening it
 * to the full commit list would multiply the node cost of every batch. The Git
 * working-state probe treats a merged head and its ancestors as pushed, while
 * this union preserves any richer commit set retained from an older snapshot.
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

  let hasFailure = false;
  let hasPending = false;
  let hasUnknown = false;
  for (const check of checks) {
    const conclusion = check.conclusion?.trim();
    if (conclusion && failingConclusions.has(conclusion)) {
      hasFailure = true;
      continue;
    }
    if (conclusion && passingConclusions.has(conclusion)) {
      continue;
    }
    if (check.state) {
      const state = deriveChipStateFromRollup(check.state);
      if (state === "failing") {
        hasFailure = true;
      } else if (state === "pending") {
        hasPending = true;
      } else if (state === "unknown") {
        hasUnknown = true;
      }
      continue;
    }
    if (isCheckStillRunning(check)) {
      hasPending = true;
      continue;
    }
    // Conclusion we don't recognize as either pass or fail — be conservative.
    hasUnknown = true;
  }
  if (hasFailure) return "failing";
  if (hasPending) return "pending";
  if (hasUnknown) return "unknown";
  return "passing";
}

/**
 * True only when a rollup context is still non-terminal. A check conclusion
 * wins over a stale `status` value — GitHub can transiently return a completed
 * conclusion alongside an old IN_PROGRESS status.
 */
export function hasChecksStillRunning(
  checks: readonly GhCheckRunPayload[],
): boolean {
  return checks.some(isCheckStillRunning);
}

function isCheckStillRunning(check: GhCheckRunPayload): boolean {
  if (check.conclusion?.trim()) {
    return false;
  }
  if (check.state) {
    return check.state === "PENDING" || check.state === "EXPECTED";
  }
  return check.status !== "COMPLETED";
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
