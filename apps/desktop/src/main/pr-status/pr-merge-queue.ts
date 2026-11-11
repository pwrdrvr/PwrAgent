import type {
  PrLifecycleState,
  PrMergeQueueRemovalReason,
  PrMergeQueueState,
  PrMergeQueueStatus,
} from "@pwragent/shared";

/**
 * Reading a forge's merge queue (GitHub) or merge train (GitLab) into
 * `PrMergeQueueStatus`. Each reading uses one observation only: the forge
 * keeps the queue's history (GitHub's timeline events, GitLab's train cars),
 * so a restart, a peer, or a cache miss reads the same state.
 */

/** GitHub's `MergeQueueEntryState`. */
export type GithubMergeQueueEntryState =
  | "QUEUED"
  | "AWAITING_CHECKS"
  | "MERGEABLE"
  | "UNMERGEABLE"
  | "LOCKED";

export type GithubMergeQueueObservation = {
  lifecycle: PrLifecycleState;
  /** `PullRequest.isMergeQueueEnabled`: the base branch requires the queue. */
  enabled: boolean;
  entry?: {
    state?: string | null;
    position?: number | null;
    enqueuedAt?: string | null;
  } | null;
  /**
   * The newest of the PR's `AddedToMergeQueueEvent` and
   * `RemovedFromMergeQueueEvent` timeline items. GitHub records a removal
   * with reason `merged` when the queue lands the PR, and that is the only
   * evidence of a queue merge: a trailing `added` can outlive a close and a
   * later direct merge.
   */
  lastEvent?: {
    type: "added" | "removed";
    createdAt?: string | null;
    reason?: string | null;
  } | null;
};

const ENTRY_STATES: Record<GithubMergeQueueEntryState, PrMergeQueueState> = {
  QUEUED: "queued",
  AWAITING_CHECKS: "group_checks_running",
  MERGEABLE: "merging",
  LOCKED: "merging",
  UNMERGEABLE: "unmergeable",
};

/** Reasons seen on public repositories' `RemovedFromMergeQueueEvent`s. */
const GITHUB_REMOVAL_REASONS: Record<string, PrMergeQueueRemovalReason> = {
  failed_checks: "checks_failed",
  checks_timed_out: "checks_timed_out",
  merge_conflict: "merge_conflict",
};

const REASON_TEXT_MAX = 120;

function epoch(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function removal(
  kind: PrMergeQueueStatus["kind"],
  reason: string | null | undefined,
  removedAt: number | undefined,
  table: Record<string, PrMergeQueueRemovalReason>,
): PrMergeQueueStatus {
  const raw = reason?.trim().toLowerCase() ?? "";
  const known = table[raw];
  const text = raw && !known ? raw.slice(0, REASON_TEXT_MAX) : undefined;
  return {
    kind,
    state: "removed",
    ...(removedAt !== undefined ? { removedAt } : {}),
    removedReason: known ?? "other",
    ...(text ? { removedReasonText: text } : {}),
  };
}

/**
 * The queue status of a GitHub PR, or undefined when its base branch has no
 * queue and it is not in one.
 */
export function githubMergeQueueStatus(
  observation: GithubMergeQueueObservation,
): PrMergeQueueStatus | undefined {
  const kind = "merge_queue" as const;
  const entry = observation.entry;
  if (entry) {
    const state = ENTRY_STATES[entry.state as GithubMergeQueueEntryState] ?? "queued";
    const position = typeof entry.position === "number" && Number.isSafeInteger(entry.position) && entry.position > 0
      ? entry.position
      : undefined;
    const enqueuedAt = epoch(entry.enqueuedAt);
    // A merged or closed PR has left the queue, whatever a stale entry says.
    if (observation.lifecycle === "open") {
      return {
        kind,
        state,
        ...(position !== undefined ? { position } : {}),
        ...(enqueuedAt !== undefined ? { enqueuedAt } : {}),
      };
    }
  }
  if (!observation.enabled && !entry) return undefined;
  const event = observation.lastEvent;
  if (observation.lifecycle === "merged") {
    const byQueue = event?.type === "removed" && event.reason?.trim().toLowerCase() === "merged";
    return { kind, state: byQueue ? "merged_by_queue" : "not_queued" };
  }
  if (observation.lifecycle === "closed") return { kind, state: "not_queued" };
  if (event?.type === "removed" && event.reason?.trim().toLowerCase() !== "merged") {
    return removal(kind, event.reason, epoch(event.createdAt), GITHUB_REMOVAL_REASONS);
  }
  return { kind, state: "not_queued" };
}

/** GitLab's merge train car status. */
export type GitlabMergeTrainCarStatus =
  | "idle"
  | "stale"
  | "fresh"
  | "merging"
  | "merged"
  | "skip_merged";

export type GitlabMergeTrainObservation = {
  lifecycle: PrLifecycleState;
  /** The project's `merge_trains_enabled`. */
  enabled: boolean;
  /**
   * The MR's car, from `merge_trains/merge_requests/:iid`. GitLab keeps a
   * car after it leaves the train; absent when the MR never joined one.
   */
  car?: {
    status?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
    pipelineStatus?: string | null;
  } | null;
  /** 1-based, from the train's active cars, when known. */
  position?: number;
};

/**
 * The train status of a GitLab MR. GitLab marks a car `idle` while it waits,
 * `fresh` while its pipeline runs against the train, `merging` while it
 * lands, and keeps it `merged` afterwards. A car that left the train with the
 * MR still open was dropped: GitLab drops a car when its pipeline fails or
 * the MR can no longer merge.
 */
export function gitlabMergeTrainStatus(
  observation: GitlabMergeTrainObservation,
): PrMergeQueueStatus | undefined {
  const kind = "merge_train" as const;
  const car = observation.car;
  if (!observation.enabled && !car) return undefined;
  const status = car?.status?.trim().toLowerCase();
  if (observation.lifecycle === "merged") {
    return { kind, state: status === "merged" || status === "skip_merged" ? "merged_by_queue" : "not_queued" };
  }
  if (observation.lifecycle === "closed" || !car) return { kind, state: "not_queued" };
  const enqueuedAt = epoch(car.createdAt);
  const position = observation.position && observation.position > 0 ? observation.position : undefined;
  const base = {
    kind,
    ...(position !== undefined ? { position } : {}),
    ...(enqueuedAt !== undefined ? { enqueuedAt } : {}),
  };
  switch (status) {
    case "idle":
    case "stale":
      return { ...base, state: "queued" };
    case "fresh":
      return { ...base, state: "group_checks_running" };
    case "merging":
      return { ...base, state: "merging" };
    default: {
      // Merged or skip_merged with the MR open, or a status GitLab added
      // later: the car is no longer on the train.
      const pipeline = car.pipelineStatus?.trim().toLowerCase();
      return removal(
        kind,
        pipeline === "failed" ? "failed_checks" : pipeline === "canceled" ? "canceled" : status,
        epoch(car.updatedAt),
        { failed_checks: "checks_failed" },
      );
    }
  }
}
