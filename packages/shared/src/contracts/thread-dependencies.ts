import type { AppServerBackendKind } from "./normalized-app-server";

export const THREAD_DEPENDENCIES_CHANNEL = "thread:dependencies";
export const THREAD_DEPENDENCY_CONDITIONS = [
  "turn_completed", "pr_attached", "ci_passed", "pr_merged",
] as const;

export type ThreadDependencyCondition = {
  backend: AppServerBackendKind;
  threadId: string;
  when: (typeof THREAD_DEPENDENCY_CONDITIONS)[number];
  /** Turn completion is pinned to this turn, never a later unrelated turn. */
  turnId?: string;
  /** Omit only when the prerequisite has one primary-workspace PR. */
  prUrl?: string;
  /** Omit to follow the PR's current head; supply to require an exact head. */
  headSha?: string;
  /** Display-only title captured at registration; never part of identity. */
  title?: string;
};

export type ThreadDependencyEvidence = {
  condition: ThreadDependencyCondition;
  state: "waiting" | "satisfied" | "failed";
  reason: string;
  prUrl?: string;
  headSha?: string;
  observedAt: number;
};

export type ThreadDependency = {
  id: string;
  backend: AppServerBackendKind;
  threadId: string;
  conditions: ThreadDependencyCondition[];
  mode: "all" | "any";
  onFailure: "notify" | "wait";
  continuation?: string;
  status: "waiting" | "ready" | "dispatching" | "delivered" | "cancelled" | "dismissed";
  outcome?: "success" | "failure";
  evidence: ThreadDependencyEvidence[];
  createdAt: number;
  updatedAt: number;
  turnId?: string;
  error?: string;
  dispatchOwnerPid?: number;
};

/** Evidence reasons a repair can clear while the PR stays open. */
export const REPAIRABLE_THREAD_DEPENDENCY_FAILURES: readonly string[] = ["CI failed", "Merge conflict"];

/**
 * True when `onFailure: "wait"` keeps this failed registration waiting:
 * every failed prerequisite is a CI failure or conflict a repair can clear.
 */
export function isRepairableDependencyFailure(dependency: Pick<ThreadDependency, "onFailure" | "evidence">): boolean {
  return dependency.onFailure === "wait"
    && dependency.evidence
      .filter((entry) => entry.state === "failed")
      .every((entry) => REPAIRABLE_THREAD_DEPENDENCY_FAILURES.includes(entry.reason));
}

export type ManageThreadDependenciesRequest = {
  action: "create" | "list" | "cancel" | "dismiss";
  backend?: AppServerBackendKind;
  threadId?: string;
  conditions?: ThreadDependencyCondition[];
  mode?: "all" | "any";
  /** Notify once on failure, or wait through CI repair. Closed PRs remain terminal. */
  onFailure?: "notify" | "wait";
  continuation?: string;
  dependencyId?: string;
};

export type ManageThreadDependenciesResponse = {
  dependencies: ThreadDependency[];
  /** Active registrations on other threads that wait on this thread. */
  dependents?: ThreadDependency[];
};
