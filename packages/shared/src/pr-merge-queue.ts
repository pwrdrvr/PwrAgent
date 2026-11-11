import type { PrMergeQueueStatus } from "./contracts/navigation";

/**
 * Wording for a PR's merge queue (GitHub) or merge train (GitLab) status.
 * The chip, its hover card, the to-do card, the agent tools and the watch
 * wake all say the same thing through these.
 */

export function mergeQueueNoun(kind: PrMergeQueueStatus["kind"] | undefined): string {
  return kind === "merge_train" ? "merge train" : "merge queue";
}

/** The PR is in the queue now: waiting, being tested, or landing. */
export function isMergeQueueActive(status: PrMergeQueueStatus | undefined): boolean {
  return status?.state === "queued"
    || status?.state === "group_checks_running"
    || status?.state === "merging"
    || status?.state === "unmergeable";
}

/** The removal reason, as a few words after "removed from queue · ". */
function removalReasonPhrase(status: PrMergeQueueStatus): string | undefined {
  const train = status.kind === "merge_train";
  switch (status.removedReason) {
    case "checks_failed": return train ? "merge train pipeline failed" : "merge group checks failed";
    case "checks_timed_out": return train ? "merge train pipeline timed out" : "merge group checks timed out";
    case "merge_conflict": return "merge conflict";
    default: return undefined;
  }
}

/**
 * A short phrase for the PR's status sentence, or undefined when the queue
 * has nothing to say (no queue, or the PR is simply not in it). The wording
 * is PwrGit's (pwrdrvr/PwrGit#586): "queued #2", "queued #1 · merge group
 * checks running", "removed from queue · merge group checks failed",
 * "merged by queue".
 */
export function describeMergeQueueState(status: PrMergeQueueStatus | undefined): string | undefined {
  if (!status) return undefined;
  const queued = status.position ? `queued #${status.position}` : "queued";
  const train = status.kind === "merge_train";
  switch (status.state) {
    case "not_queued":
      return undefined;
    case "queued":
      return queued;
    case "group_checks_running":
      return `${queued} · ${train ? "merge train pipeline running" : "merge group checks running"}`;
    case "merging":
      return `${queued} · merging`;
    case "unmergeable":
      return `${queued} · ${train ? "merge train pipeline failing" : "merge group checks failing"}`;
    case "removed": {
      const reason = removalReasonPhrase(status);
      return reason ? `removed from queue · ${reason}` : "removed from queue";
    }
    case "merged_by_queue":
      return train ? "merged by merge train" : "merged by queue";
  }
}

const REMOVAL_TEXT_MAX = 200;

/** One sentence saying why the forge removed the PR from its queue. */
export function describeMergeQueueRemoval(status: PrMergeQueueStatus | undefined): string | undefined {
  if (status?.state !== "removed") return undefined;
  const train = status.kind === "merge_train";
  switch (status.removedReason) {
    case "checks_failed":
      return train ? "The merge train pipeline failed." : "The merge group's checks failed.";
    case "checks_timed_out":
      return train ? "The merge train pipeline timed out." : "The merge group's checks timed out.";
    case "merge_conflict":
      return "It conflicts with the base branch.";
    default: {
      const text = status.removedReasonText?.replace(/\s+/g, " ").trim().slice(0, REMOVAL_TEXT_MAX);
      const forge = train ? "GitLab" : "GitHub";
      return text
        ? `${forge} removed it: ${text.replace(/_/g, " ")}.`
        : `${forge} removed it from the ${mergeQueueNoun(status.kind)}.`;
    }
  }
}
