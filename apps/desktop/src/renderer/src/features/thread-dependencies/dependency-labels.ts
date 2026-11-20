import type { ThreadDependency, ThreadDependencyCondition, ThreadDependencyEvidence } from "@pwragent/shared";
import { isRepairableDependencyFailure, threadDependencyConditionName } from "@pwragent/shared";

export const ACTIVE_DEPENDENCY_STATUSES = new Set<ThreadDependency["status"]>(["waiting", "ready", "dispatching"]);

export const dependencyThreadKey = (value: { backend: string; threadId: string }): string =>
  JSON.stringify([value.backend, value.threadId]);

/** Evidence is stored in condition order; ignore a slot that names another thread. */
export function evidenceFor(dependency: ThreadDependency, index: number): ThreadDependencyEvidence | undefined {
  const evidence = dependency.evidence[index];
  const condition = dependency.conditions[index];
  return evidence && condition && dependencyThreadKey(evidence.condition) === dependencyThreadKey(condition)
    && evidence.condition.when === condition.when
    ? evidence : undefined;
}

/** An admitted continuation whose delivery cannot be confirmed; only the operator can retire it. */
export const needsDeliveryReview = (dependency: ThreadDependency): boolean =>
  dependency.status === "dispatching" && Boolean(dependency.error);

/** Uncertain deliveries that share one exact error, which is how the operator reviews them. */
export type DeliveryReviewGroup = {
  error: string;
  /** The error without the "needs review" lead every claim carries. */
  cause: string;
  items: ThreadDependency[];
};

const REVIEW_LEAD = "Continuation delivery needs review: ";

/** Groups uncertain deliveries by exact error: the largest group first, then the oldest. */
export function groupDeliveryReviews(dependencies: readonly ThreadDependency[]): DeliveryReviewGroup[] {
  const groups = new Map<string, ThreadDependency[]>();
  for (const dependency of dependencies) {
    if (!needsDeliveryReview(dependency)) continue;
    const items = groups.get(dependency.error!);
    if (items) items.push(dependency);
    else groups.set(dependency.error!, [dependency]);
  }
  return [...groups].map(([error, items]) => ({
    error,
    cause: error.startsWith(REVIEW_LEAD) ? error.slice(REVIEW_LEAD.length) : error,
    items: [...items].sort((left, right) => left.createdAt - right.createdAt),
  })).sort((left, right) => right.items.length - left.items.length
    || left.items[0]!.createdAt - right.items[0]!.createdAt);
}

export const isRepairWait = (dependency: ThreadDependency): boolean =>
  dependency.status === "ready" && dependency.outcome === "failure" && isRepairableDependencyFailure(dependency);

/** Ready to resume only to report a failed prerequisite; dependent work stays blocked. */
export const isFailureReport = (dependency: ThreadDependency): boolean =>
  dependency.status === "ready" && dependency.outcome === "failure" && !isRepairableDependencyFailure(dependency);

/** A prerequisite's display name: its subject, its saved title, its CI run, or its id. */
export function conditionName(condition: Pick<ThreadDependencyCondition, "subject" | "title" | "threadId" | "ciRun" | "localFile">): string {
  return threadDependencyConditionName(condition) || condition.threadId;
}
