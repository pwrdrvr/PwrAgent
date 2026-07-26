import type {
  PrChipState,
  PrLifecycleState,
  PrMergeState,
  PrReviewState,
  PrSummary,
} from "@pwragent/shared";
import { buildPullRequestStatusKey } from "@pwragent/shared";

/**
 * A PR status transition — the typed record of a meaningful field flipping
 * between two observations of the same PR.
 *
 * This is the SEAM for the future "CI event → start a turn" feature (see the
 * brainstorm). Today the only consumer logs it. Tomorrow an ingestor can
 * subscribe and, on `checkState: pending → failing`, synthesize an inbound
 * thread event that starts a turn — WITHOUT the poller changing, and with the
 * source swappable from polling to real webhooks. Everything a webhook payload
 * would need (which field flipped, from/to, the PR, its commits, the threads it
 * touches) is captured here so the future feature does not have to re-fetch.
 */

export type PrStatusFieldChange<T> = {
  from: T;
  to: T;
};

/**
 * Which fields flipped. Only changed fields are present — an absent key means
 * that field did not move. At least one key is always present (a transition
 * with no changes is never emitted).
 */
export type PrStatusTransitionChanges = {
  checkState?: PrStatusFieldChange<PrChipState | undefined>;
  lifecycleState?: PrStatusFieldChange<PrLifecycleState | undefined>;
  mergeState?: PrStatusFieldChange<PrMergeState | undefined>;
  reviewState?: PrStatusFieldChange<PrReviewState | undefined>;
  title?: PrStatusFieldChange<string | undefined>;
};

export type PrStatusTransition = {
  /** `provider/org/repo#number` — the same key the status registry uses. */
  prKey: string;
  url: string;
  title?: string;
  /**
   * Commits known for this PR. The poller only fetches the head commit, so
   * this is usually a single SHA; the `gh` path can carry more. The future CI
   * ingestor will widen the GraphQL fragment to per-check detail when it needs
   * the exact head SHA the checks ran on (brainstorm Open Decision 5).
   */
  commitShas?: string[];
  changed: PrStatusTransitionChanges;
  /** Thread keys (`backend:threadId`) that display this PR. May be empty. */
  threadKeys: string[];
};

/**
 * The PR fields a transition tracks. `commitShas` is deliberately NOT here: a
 * new commit with unchanged status is not a status transition (the fast poll
 * fetches only the head commit anyway, and the sha rides along as context).
 */
const TRACKED_FIELDS = [
  "checkState",
  "lifecycleState",
  "mergeState",
  "reviewState",
  "title",
] as const;

/**
 * Read the canonical check state. `PrSummary.state` is a deprecated alias that
 * can still hold legacy chip values (`merged`/`draft`/`closed`) on old rows, so
 * prefer `checkState` and never treat a legacy `state` as a check value.
 */
function readCheckState(pr: PrSummary): PrChipState | undefined {
  if (pr.checkState) {
    return pr.checkState;
  }
  if (pr.state === "failing" || pr.state === "passing" || pr.state === "pending" || pr.state === "unknown") {
    return pr.state;
  }
  return undefined;
}

function readField(
  pr: PrSummary,
  field: (typeof TRACKED_FIELDS)[number],
): PrChipState | PrLifecycleState | PrMergeState | PrReviewState | string | undefined {
  if (field === "checkState") {
    return readCheckState(pr);
  }
  return pr[field];
}

/**
 * Compute the transition between a previous and next observation of one PR, or
 * `undefined` if nothing meaningful changed.
 *
 * Returns `undefined` when `previous` is missing: a PR appearing for the first
 * time (initial load, discovery) has no "from" and is not a CI event, so this
 * never fires a flood of transitions on boot.
 */
export function computePrStatusTransition(
  previous: PrSummary | undefined,
  next: PrSummary,
  threadKeys: string[] = [],
): PrStatusTransition | undefined {
  if (!previous) {
    return undefined;
  }

  const changed: PrStatusTransitionChanges = {};
  for (const field of TRACKED_FIELDS) {
    const from = readField(previous, field);
    const to = readField(next, field);
    if (from !== to) {
      // The union type is safe here: `field` selects matching from/to types.
      (changed as Record<string, PrStatusFieldChange<unknown>>)[field] = { from, to };
    }
  }

  if (Object.keys(changed).length === 0) {
    return undefined;
  }

  return {
    prKey: buildPullRequestStatusKey(next),
    url: next.url,
    ...(next.title ? { title: next.title } : {}),
    ...(next.commitShas && next.commitShas.length > 0
      ? { commitShas: next.commitShas }
      : {}),
    changed,
    threadKeys,
  };
}

/** Compact one-line description of a transition for structured logs. */
export function summarizePrStatusTransition(
  transition: PrStatusTransition,
): Record<string, unknown> {
  const changes: Record<string, string> = {};
  for (const [field, change] of Object.entries(transition.changed)) {
    if (change) {
      changes[field] = `${String(change.from ?? "∅")}→${String(change.to ?? "∅")}`;
    }
  }
  return {
    prKey: transition.prKey,
    threadCount: transition.threadKeys.length,
    changes,
  };
}
