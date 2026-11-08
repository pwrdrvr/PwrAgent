import type { FederationCapability, FederationTarget } from "./federation";
import type { AppServerBackendKind } from "./normalized-app-server";

export const THREAD_DEPENDENCIES_CHANNEL = "thread:dependencies";
/**
 * `marked_done` is a judgement, not a milestone PwrAgent observes: it ends
 * only when the prerequisite thread, the operator, or an agent marks it done.
 */
export const THREAD_DEPENDENCY_CONDITIONS = [
  "turn_completed", "pr_attached", "ci_passed", "pr_merged", "marked_done",
] as const;

/** Advertised by owners that serve `backend.manageThreadDependencies` to peers. */
export const THREAD_DEPENDENCIES_FEDERATION_CAPABILITY = "thread_dependencies_v1" satisfies FederationCapability;

/** Reminder steps one registration may carry, and the length of each. */
export const THREAD_DEPENDENCY_MAX_STEPS = 12;
export const THREAD_DEPENDENCY_STEP_MAX_LENGTH = 200;
/** "Something else": a prerequisite that is not a thread. */
export const THREAD_DEPENDENCY_SUBJECT_MAX_LENGTH = 200;
export const THREAD_DEPENDENCY_MARK_DONE_NOTE_MAX_LENGTH = 2000;

/** How a prerequisite reads after its thread's name: "Foundation passes CI". */
export const THREAD_DEPENDENCY_CONDITION_PHRASES: Readonly<Record<(typeof THREAD_DEPENDENCY_CONDITIONS)[number], string>> = {
  turn_completed: "finishes its turn",
  pr_attached: "has a reviewable PR",
  ci_passed: "passes CI",
  pr_merged: "is merged",
  marked_done: "is marked done",
};

/**
 * Who acts when a dependency fires. `agent` resumes the waiting thread with a
 * new turn. `operator` raises a to-do card on that thread instead and starts
 * no turn, for follow-ups only the human can do.
 */
export const THREAD_DEPENDENCY_DELIVERY_TARGETS = ["agent", "operator"] as const;
export type ThreadDependencyDeliveryTarget = (typeof THREAD_DEPENDENCY_DELIVERY_TARGETS)[number];

export type ThreadDependencyCondition = {
  /** For a `subject`, the waiting thread's backend. */
  backend: AppServerBackendKind;
  /** Empty for a `subject`, which names no thread. */
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
  /**
   * "Something else": what is awaited, when it is not a thread. Always
   * `marked_done`, with an empty `threadId`.
   */
  subject?: string;
  /**
   * The prerequisite thread's machine when it is not the waiting thread's
   * owner. Only `marked_done` can be watched across machines.
   */
  target?: Extract<FederationTarget, { scope: "remote" }>;
};

/** True for a prerequisite that names a thread, on any machine. */
export function isThreadDependencyThreadCondition(condition: Pick<ThreadDependencyCondition, "subject">): boolean {
  return condition.subject === undefined;
}

/** True for a thread prerequisite on the waiting thread's own machine. */
export function isThreadDependencyLocalThreadCondition(condition: Pick<ThreadDependencyCondition, "subject" | "target">): boolean {
  return condition.subject === undefined && condition.target === undefined;
}

export type ThreadDependencyEvidence = {
  condition: ThreadDependencyCondition;
  state: "waiting" | "satisfied" | "failed";
  reason: string;
  prUrl?: string;
  headSha?: string;
  observedAt: number;
  /** `marked_done` only: who marked it done ("operator", "agent:…", "peer:…"). */
  markedDoneBy?: string;
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
  /** Operator delivery only: a checklist on the reminder card. */
  steps?: string[];
  /** Merge cards and agent merges of this thread refuse while it waits. */
  holdMerge?: boolean;
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
  action: "create" | "list" | "cancel" | "dismiss" | "active" | "mark_done";
  backend?: AppServerBackendKind;
  threadId?: string;
  /** The waiting thread's owner, when it is not this window's machine. */
  federationTarget?: FederationTarget;
  conditions?: ThreadDependencyCondition[];
  mode?: "all" | "any";
  /** Notify once on failure, or wait through CI repair. Closed PRs remain terminal. */
  onFailure?: "notify" | "wait";
  continuation?: string;
  /** Resume the waiting thread (`agent`, the default) or remind the operator. */
  deliver?: ThreadDependencyDeliveryTarget;
  /** With `deliver: "operator"`, offer Start thread on the card. */
  handoff?: boolean;
  /** With `deliver: "operator"`, a checklist on the reminder card. */
  steps?: string[];
  holdMerge?: boolean;
  dependencyId?: string;
  /** `mark_done`: which `marked_done` prerequisite; the first open one when omitted. */
  conditionIndex?: number;
  /** `mark_done`: what finished. Optional; the card says "Marked done" without it. */
  note?: string;
  /**
   * `list`: a pull request this thread would merge. The response then
   * carries `mergeHolds`, the waits the owner would refuse that merge for.
   */
  pullRequest?: string;
};

export type ManageThreadDependenciesResponse = {
  dependencies: ThreadDependency[];
  /** Active registrations on other threads that wait on this thread. */
  dependents?: ThreadDependency[];
  /** Registrations on other machines that wait on this thread, with their owner. */
  peerDependents?: Array<{ dependency: ThreadDependency; owner: FederationTarget }>;
  /** `active` from a window: connected peers' active registrations, with their owner. */
  peerActive?: Array<{ dependency: ThreadDependency; owner: FederationTarget }>;
  /**
   * `list` with `pullRequest`: the owner's merge check for it, including holds
   * on other threads with that PR attached. Owners that predate it omit it.
   */
  mergeHolds?: ThreadDependency[];
};

/** The first `marked_done` prerequisite still open, or the requested one. */
export function threadDependencyMarkDoneIndex(dependency: Pick<ThreadDependency, "conditions" | "evidence">, requested?: number): number | undefined {
  const open = (index: number) => dependency.conditions[index]?.when === "marked_done"
    && dependency.evidence.find((entry) => JSON.stringify(entry.condition) === JSON.stringify(dependency.conditions[index]))?.state !== "satisfied";
  if (requested !== undefined) return open(requested) ? requested : undefined;
  const index = dependency.conditions.findIndex((_, candidate) => open(candidate));
  return index >= 0 ? index : undefined;
}
