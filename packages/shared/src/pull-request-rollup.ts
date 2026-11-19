import type { PrSummary } from "./contracts/navigation";

export function resolveLifecycleState(pr: PrSummary): NonNullable<PrSummary["lifecycleState"]> {
  return pr.lifecycleState ?? (pr.state === "merged" || pr.state === "closed" ? pr.state : "open");
}

export function resolveCheckState(pr: PrSummary): NonNullable<PrSummary["checkState"]> {
  if (pr.checkState) return pr.checkState;
  const state = pr.state;
  return state === "passing" || state === "failing" || state === "pending" ? state : "unknown";
}

/** A fresh attachment with no status signal. */
export function isPrStatusUnknown(pr: PrSummary): boolean {
  return pr.state === "unknown" && !pr.checkState && !pr.lifecycleState && !pr.reviewState && !pr.mergeState;
}

/** Least-ready open PR first, then merged before closed. */
export function pullRequestRollupPriority(pr: PrSummary): number {
  const lifecycle = resolveLifecycleState(pr);
  if (lifecycle === "merged") return 6;
  if (lifecycle === "closed") return 7;
  const draft = pr.reviewState === "draft" ? 0 : 0.5;
  if (pr.mergeState === "conflicting") return draft;
  switch (resolveCheckState(pr)) {
    case "failing":
      return (pr.checksStillRunning ? 2 : 1) + draft;
    case "pending":
      return 3 + draft;
    case "passing":
      return 4 + draft;
    case "unknown":
      return 5 + draft;
  }
}

/** Newest open PRs first, then newest finished PRs. The caller breaks ties by attachment order. */
export function comparePullRequestStack(left: PrSummary, right: PrSummary): number {
  const leftOpen = resolveLifecycleState(left) === "open";
  const rightOpen = resolveLifecycleState(right) === "open";
  if (leftOpen !== rightOpen) return leftOpen ? -1 : 1;
  const leftTime = leftOpen ? left.createdAt ?? Infinity : left.mergedAt ?? left.closedAt ?? -Infinity;
  const rightTime = rightOpen ? right.createdAt ?? Infinity : right.mergedAt ?? right.closedAt ?? -Infinity;
  return (rightTime - leftTime) || 0;
}
