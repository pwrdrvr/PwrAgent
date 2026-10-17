import type { ThreadDependency, ThreadDependencyCondition, ThreadDependencyEvidence } from "@pwragent/shared";
import { isRepairableDependencyFailure } from "@pwragent/shared";

type When = ThreadDependencyCondition["when"];

export const CONDITION_PHRASES: Record<When, string> = {
  turn_completed: "finishes its turn",
  pr_attached: "has a reviewable PR",
  ci_passed: "passes CI",
  pr_merged: "is merged",
};

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

export const isRepairWait = (dependency: ThreadDependency): boolean =>
  dependency.status === "ready" && dependency.outcome === "failure" && isRepairableDependencyFailure(dependency);
