import type {
  PrChipState,
  PrLifecycleState,
  PrMergeState,
  PrReviewState,
  PrSummary,
} from "@pwragent/shared";
import { DEFAULT_PULL_REQUEST_PROVIDER, resolvePullRequestIdentity } from "@pwragent/shared";
import { isSafeExternalOpenUrl } from "../external-url-policy";

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
  /** ISO-8601; check runs only. */
  completedAt?: string | null;
  detailsUrl?: string | null;
  status?: string | null;
  state?: string | null;
  name?: string;
  targetUrl?: string | null;
};

/** A head commit's check suite, as the GraphQL poller reads it. */
export type GhCheckSuitePayload = {
  status?: string | null;
  /** Present only for a GitHub Actions workflow run. */
  workflowRun?: { id?: string | null } | null;
};

/**
 * How long a head whose every check was skipped keeps counting as still
 * running, measured from the newest skipped check's completion.
 */
export const SKIPPED_ONLY_CHECKS_SETTLE_MS = 2 * 60_000;

/** Conclusions that report no test result: the check did not judge the head. */
const NO_RESULT_CHECK_CONCLUSIONS = new Set(["SKIPPED", "NEUTRAL", "STALE"]);

const FAILING_CHECK_CONCLUSIONS = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);

/**
 * Map a `gh pr list` row to our PrSummary. Exported for direct testing
 * without invoking the subprocess.
 */
export function parseGhPrPayload(row: GhPrPayload): PrSummary {
  const checkState = deriveChipState(row);
  const checksStillRunning = hasChecksStillRunning(row.statusCheckRollup ?? []);
  const failedCheckUrl = findFailedCheckUrl(row.statusCheckRollup ?? []);
  const headSha = normalizeCommitShas([
    row.commits?.[row.commits.length - 1]?.oid,
  ])[0];
  return {
    ...resolvePullRequestIdentity({
      provider: parsePullRequestProvider(row.url),
      number: row.number,
      org: row.headRepositoryOwner?.login ?? "",
      repo: row.headRepository?.name ?? "",
      url: row.url,
    }),
    ...(row.title?.trim() ? { title: row.title.trim() } : {}),
    ...(row.baseRefName?.trim() ? { baseRefName: row.baseRefName.trim() } : {}),
    ...(row.headRefName?.trim() ? { headRefName: row.headRefName.trim() } : {}),
    state: checkState,
    checkState,
    ...(checksStillRunning ? { checksStillRunning: true } : {}),
    ...(failedCheckUrl ? { failedCheckUrl } : {}),
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
    if (conclusion && FAILING_CHECK_CONCLUSIONS.has(conclusion)) {
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

/**
 * True while a GitHub Actions workflow run on the head commit has not
 * finished. A run waiting on a concurrency group has a check suite but no
 * check runs yet, so the status rollup cannot see it and reports SUCCESS for
 * whatever finished first (pwrdrvr/PwrAgent#3346: three skipped jobs).
 *
 * Suites without a workflow run are ignored. GitHub creates a suite for every
 * installed app with checks access on each push, and an app that never
 * reports (the Claude app, here) leaves its suite QUEUED forever.
 */
export function hasWorkflowRunsStillRunning(
  suites: readonly GhCheckSuitePayload[],
): boolean {
  return suites.some((suite) => {
    const status = suite.status?.trim();
    return Boolean(suite.workflowRun && status && status !== "COMPLETED");
  });
}

/**
 * True when every check on the head was skipped or neutral and the newest
 * finished less than `SKIPPED_ONLY_CHECKS_SETTLE_MS` before `now`. A skipped
 * job tests nothing, and the workflow that does may not have registered yet.
 * After the settle window the head counts as passing, so a PR whose
 * workflows are all filtered out still resolves.
 */
export function isSkippedOnlyCheckSetSettling(
  checks: readonly GhCheckRunPayload[],
  now: number,
): boolean {
  let newestCompletedAt: number | undefined;
  for (const check of checks) {
    const conclusion = check.conclusion?.trim();
    // A commit status (`state`) is a reported result, never a skip.
    if (check.state || !conclusion || !NO_RESULT_CHECK_CONCLUSIONS.has(conclusion)) {
      return false;
    }
    const completedAt = Date.parse(check.completedAt ?? "");
    if (Number.isFinite(completedAt)) {
      newestCompletedAt = Math.max(newestCompletedAt ?? completedAt, completedAt);
    }
  }
  // No checks, or no completion time to measure from: nothing to wait out.
  return newestCompletedAt !== undefined
    && now - newestCompletedAt < SKIPPED_ONLY_CHECKS_SETTLE_MS;
}

/** Return the first safe destination attached to a failed check or status. */
export function findFailedCheckUrl(
  checks: readonly GhCheckRunPayload[],
): string | undefined {
  for (const check of checks) {
    const conclusion = check.conclusion?.trim();
    const state = check.state?.trim();
    if (
      !(
        (conclusion && FAILING_CHECK_CONCLUSIONS.has(conclusion))
        || state === "FAILURE"
        || state === "ERROR"
      )
    ) {
      continue;
    }
    const candidate = check.detailsUrl?.trim() || check.targetUrl?.trim();
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (
        (parsed.protocol === "https:" || parsed.protocol === "http:")
        && isSafeExternalOpenUrl(parsed.toString())
      ) {
        return parsed.toString();
      }
    } catch {
      // Ignore malformed provider data instead of exposing an unsafe link.
    }
  }
  return undefined;
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
