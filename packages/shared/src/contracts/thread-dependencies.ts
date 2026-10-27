import type { AppServerBackendKind } from "./normalized-app-server";

export const THREAD_DEPENDENCIES_CHANNEL = "thread:dependencies";
export const THREAD_DEPENDENCY_CONDITIONS = [
  "turn_completed", "pr_attached", "ci_passed", "pr_merged",
] as const;

/** How a prerequisite reads after its thread's name: "Foundation passes CI". */
export const THREAD_DEPENDENCY_CONDITION_PHRASES: Readonly<Record<(typeof THREAD_DEPENDENCY_CONDITIONS)[number], string>> = {
  turn_completed: "finishes its turn",
  pr_attached: "has a reviewable PR",
  ci_passed: "passes CI",
  pr_merged: "is merged",
};

/**
 * Who acts when a dependency fires. `agent` resumes the waiting thread with a
 * new turn. `operator` raises a to-do card on that thread instead and starts
 * no turn, for follow-ups only the human can do.
 */
export const THREAD_DEPENDENCY_DELIVERY_TARGETS = ["agent", "operator"] as const;
export type ThreadDependencyDeliveryTarget = (typeof THREAD_DEPENDENCY_DELIVERY_TARGETS)[number];

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
  /** Trusted host provenance captured at registration, independent of later traffic. */
  causalMessagingSource?: import("./normalized-app-server").MessagingCausalSourceRef;
  causalMessagingAmbiguous?: boolean;
  id: string;
  backend: AppServerBackendKind;
  threadId: string;
  conditions: ThreadDependencyCondition[];
  mode: "all" | "any";
  onFailure: "notify" | "wait";
  continuation?: string;
  /** Absent on registrations made before operator delivery: `agent`. */
  deliver?: ThreadDependencyDeliveryTarget;
  /** Operator delivery only: the card offers Start thread with the continuation. */
  handoff?: boolean;
  status: "waiting" | "ready" | "dispatching" | "delivered" | "cancelled" | "dismissed";
  outcome?: "success" | "failure";
  evidence: ThreadDependencyEvidence[];
  createdAt: number;
  updatedAt: number;
  turnId?: string;
  /** The to-do card an operator delivery raised. */
  todoId?: string;
  error?: string;
  dispatchOwnerPid?: number;
};

export function threadDependencyDeliveryTarget(dependency: Pick<ThreadDependency, "deliver">): ThreadDependencyDeliveryTarget {
  return dependency.deliver ?? "agent";
}

/** The stable to-do key for a dependency's operator card. */
export function threadDependencyTodoKey(dependencyId: string): string {
  return `dependency:${dependencyId}`;
}

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
  /**
   * `active` lists every active registration on this instance, for sidebar
   * status. It is a desktop-window read only, never an agent tool action.
   */
  action: "create" | "list" | "cancel" | "dismiss" | "active";
  backend?: AppServerBackendKind;
  threadId?: string;
  conditions?: ThreadDependencyCondition[];
  mode?: "all" | "any";
  /** Notify once on failure, or wait through CI repair. Closed PRs remain terminal. */
  onFailure?: "notify" | "wait";
  continuation?: string;
  /** Resume the waiting thread (`agent`, the default) or remind the operator. */
  deliver?: ThreadDependencyDeliveryTarget;
  /** With `deliver: "operator"`, offer Start thread on the card. */
  handoff?: boolean;
  dependencyId?: string;
};

export type ManageThreadDependenciesResponse = {
  dependencies: ThreadDependency[];
  /** Active registrations on other threads that wait on this thread. */
  dependents?: ThreadDependency[];
};
