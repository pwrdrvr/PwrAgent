import type { FederationCapability, FederationTarget } from "./federation";
import type { AppServerBackendKind } from "./normalized-app-server";

export const THREAD_DEPENDENCIES_CHANNEL = "thread:dependencies";
/**
 * `marked_done` is a judgement, not a milestone PwrAgent observes: it ends
 * only when the prerequisite thread, the operator, or an agent marks it done.
 */
export const THREAD_DEPENDENCY_CONDITIONS = [
  "turn_completed", "pr_attached", "ci_passed", "pr_merged", "marked_done", "compaction_completed", "ci_run",
] as const;

/**
 * What wakes a `ci_run` prerequisite: the run pausing at a deployment
 * approval gate, a job failing while others still run, or the run finishing.
 */
export const THREAD_DEPENDENCY_CI_RUN_OUTCOMES = ["approval_gate", "job_failed", "finished"] as const;
export type ThreadDependencyCiRunOutcome = (typeof THREAD_DEPENDENCY_CI_RUN_OUTCOMES)[number];
export const THREAD_DEPENDENCY_CI_RUN_MAX_ENVIRONMENTS = 8;

/** A CI run prerequisite. PwrAgent checks the run itself; no model polls it. */
export type ThreadDependencyCiRun = {
  /** A GitHub Actions run: https://github.com/<owner>/<repo>/actions/runs/<id>. */
  url: string;
  /** Omit for all three outcomes. */
  on?: ThreadDependencyCiRunOutcome[];
  /** `approval_gate` only for these environments; omit for any gate. */
  environments?: string[];
};

/** One check of a CI run, kept in memory while waiting and saved when the wait fires. */
export type ThreadDependencyCiRunObservation = {
  runId: number;
  name?: string;
  /** The provider's run status: queued, in_progress, waiting, completed, … */
  status: string;
  conclusion?: string;
  attempt?: number;
  headSha?: string;
  branch?: string;
  /** Deployments waiting for approval, from the run's pending deployments. */
  gates?: { environment: string; reviewers: string[]; waitTimerMinutes?: number }[];
  jobs?: { total: number; passed: number; failed: number; running: number; queued: number; waiting: number; skipped: number };
  failedJobs?: { name: string; url: string; failedStep?: string }[];
  /** The check failed; the wait keeps the last good observation's meaning. */
  error?: string;
  /** The forge's code for that failure, such as `not_found`. */
  errorCode?: string;
  /** Consecutive failed checks with this `errorCode`. */
  errorChecks?: number;
  /** When the current run of failed checks began, whatever their codes. */
  failingSince?: number;
  checkedAt: number;
};

export function threadDependencyCiRunOutcomes(ciRun: Pick<ThreadDependencyCiRun, "on">): ThreadDependencyCiRunOutcome[] {
  return ciRun.on?.length ? THREAD_DEPENDENCY_CI_RUN_OUTCOMES.filter((outcome) => ciRun.on!.includes(outcome)) : [...THREAD_DEPENDENCY_CI_RUN_OUTCOMES];
}

const CI_RUN_OUTCOME_PHRASES: Record<ThreadDependencyCiRunOutcome, string> = {
  approval_gate: "reaches an approval gate",
  job_failed: "has a failed job",
  finished: "finishes",
};

/** "reaches an approval gate, has a failed job, or finishes". */
export function threadDependencyCiRunPhrase(ciRun: Pick<ThreadDependencyCiRun, "on">): string {
  const phrases = threadDependencyCiRunOutcomes(ciRun).map((outcome) => CI_RUN_OUTCOME_PHRASES[outcome]);
  return phrases.length < 3 ? phrases.join(" or ") : `${phrases.slice(0, -1).join(", ")}, or ${phrases.at(-1)}`;
}

/** The run id in a CI run URL, for labels; undefined when the URL names none. */
export function threadDependencyCiRunId(url: string): string | undefined {
  return url.match(/\/actions\/runs\/(\d+)/)?.[1];
}

/** "Waiting for approval: windows-signing · 2 passed, 1 running" from one check. */
export function summarizeThreadDependencyCiRun(observation: ThreadDependencyCiRunObservation): string {
  const state = observation.status === "completed"
    ? `Finished: ${observation.conclusion ?? "unknown"}`
    : observation.status === "waiting" && observation.gates?.length
      ? `Waiting for approval: ${observation.gates.map((gate) => gate.environment).join(", ")}`
      : observation.status === "in_progress" ? "Running" : observation.status === "unknown" ? "Could not read the run" : observation.status.replace(/_/g, " ");
  const jobs = observation.jobs;
  const counts = jobs
    ? ([["passed", jobs.passed], ["failed", jobs.failed], ["running", jobs.running], ["waiting", jobs.waiting], ["queued", jobs.queued]] as const)
      .filter(([, count]) => count > 0).map(([name, count]) => `${count} ${name}`).join(", ")
    : "";
  return [state.charAt(0).toUpperCase() + state.slice(1), counts, observation.error ? "last check failed" : ""].filter(Boolean).join(" · ");
}

/** How a prerequisite reads after its name, including a CI run's chosen outcomes. */
export function threadDependencyConditionPhrase(condition: Pick<ThreadDependencyCondition, "when" | "ciRun">): string {
  return condition.when === "ci_run" && condition.ciRun
    ? threadDependencyCiRunPhrase(condition.ciRun)
    : THREAD_DEPENDENCY_CONDITION_PHRASES[condition.when];
}

/** A prerequisite's display name: its subject, its saved title, or its CI run. */
export function threadDependencyConditionName(condition: Pick<ThreadDependencyCondition, "subject" | "title" | "ciRun">): string | undefined {
  const label = condition.subject?.trim() || condition.title?.trim();
  if (label) return label;
  if (!condition.ciRun) return undefined;
  const id = threadDependencyCiRunId(condition.ciRun.url);
  return id ? `Run ${id}` : "CI run";
}

/** Advertised by owners that serve `backend.manageThreadDependencies` to peers. */
export const THREAD_DEPENDENCIES_FEDERATION_CAPABILITY = "thread_dependencies_v1" satisfies FederationCapability;

/** Reminder steps one registration may carry, and the length of each. */
export const THREAD_DEPENDENCY_MAX_STEPS = 12;
export const THREAD_DEPENDENCY_STEP_MAX_LENGTH = 200;
/** "Something else": a prerequisite that is not a thread. */
export const THREAD_DEPENDENCY_SUBJECT_MAX_LENGTH = 200;
export const THREAD_DEPENDENCY_MARK_DONE_NOTE_MAX_LENGTH = 2000;
export const COMPACTION_RECOVERY_COOLDOWN_MS = 5 * 60_000;
export const COMPACTION_RECOVERY_WINDOW_MS = 30 * 60_000;
export const COMPACTION_RECOVERY_MAX_ATTEMPTS = 3;
export const COMPACTION_RECOVERY_MAX_ATTEMPTS_PER_TURN = 8;

export type CompactionRecoveryProtection = {
  attemptsInWindow: number;
  attemptsInTurn?: number;
  cooldownUntil?: number;
  /** A durable circuit breaker, cleared only by the operator on the owning instance. */
  suspendedAt?: number;
};

/** How a prerequisite reads after its thread's name: "Foundation passes CI". */
export const THREAD_DEPENDENCY_CONDITION_PHRASES: Readonly<Record<(typeof THREAD_DEPENDENCY_CONDITIONS)[number], string>> = {
  turn_completed: "finishes its turn",
  pr_attached: "has a reviewable PR",
  ci_passed: "passes CI",
  pr_merged: "is merged",
  marked_done: "is marked done",
  compaction_completed: "finishes compaction",
  ci_run: "reaches an approval gate, has a failed job, or finishes",
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
  /** `ci_run` only, with an empty `threadId`: the run and what wakes the wait. */
  ciRun?: ThreadDependencyCiRun;
};

/** True for a prerequisite that names a thread, on any machine. */
export function isThreadDependencyThreadCondition(condition: Pick<ThreadDependencyCondition, "subject" | "ciRun">): boolean {
  return condition.subject === undefined && condition.ciRun === undefined;
}

/** True for a thread prerequisite on the waiting thread's own machine. */
export function isThreadDependencyLocalThreadCondition(condition: Pick<ThreadDependencyCondition, "subject" | "target" | "ciRun">): boolean {
  return condition.subject === undefined && condition.target === undefined && condition.ciRun === undefined;
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
  /**
   * `ci_run` only. Saved when the wait fires. While it waits, the owner adds
   * its latest check to list responses in memory; that copy is never stored.
   */
  ciRun?: ThreadDependencyCiRunObservation;
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
  /** Compaction only: keep this one subscription for future live completions. */
  repeat?: boolean;
  /** Last live completion, retained after delivery to reject redelivery. No transcript data. */
  compaction?: { itemId: string; turnId: string; completedItemIds: string[] };
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
  /**
   * A cancelled wait replaced by this newer registration of the same plan on
   * the same prerequisite threads, pinned to later turns.
   */
  supersededBy?: string;
};

export function threadDependencyDeliveryTarget(dependency: Pick<ThreadDependency, "deliver">): ThreadDependencyDeliveryTarget {
  return dependency.deliver ?? "agent";
}

/** The stable to-do key for a dependency's operator card. */
export function threadDependencyTodoKey(dependencyId: string): string {
  return `dependency:${dependencyId}`;
}

/** A recurring hook's receipt belongs to one actual completed protocol item. */
export function threadDependencyDeliveryKey(dependency: Pick<ThreadDependency, "id" | "compaction">): string {
  return dependency.compaction
    ? JSON.stringify([dependency.id, dependency.compaction.turnId, dependency.compaction.itemId])
    : dependency.id;
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
   * `rearm_compaction` is also desktop-only and requires the local operator.
   */
  action: "create" | "list" | "cancel" | "dismiss" | "active" | "mark_done" | "rearm_compaction";
  backend?: AppServerBackendKind;
  threadId?: string;
  /** The waiting thread's owner, when it is not this window's machine. */
  federationTarget?: FederationTarget;
  conditions?: ThreadDependencyCondition[];
  mode?: "all" | "any";
  /** Notify once on failure, or wait through CI repair. Closed PRs remain terminal. */
  onFailure?: "notify" | "wait";
  continuation?: string;
  /** Compaction only. Default false: the next future completion, without history catch-up. */
  repeat?: boolean;
  /** Resume the waiting thread (`agent`, the default) or remind the operator. */
  deliver?: ThreadDependencyDeliveryTarget;
  /** With `deliver: "operator"`, offer Start thread on the card. */
  handoff?: boolean;
  /** With `deliver: "operator"`, a checklist on the reminder card. */
  steps?: string[];
  holdMerge?: boolean;
  dependencyId?: string;
  /**
   * `dismiss` from the desktop's reviewed cleanup: several uncertain
   * deliveries on this thread, retired together in one transaction.
   */
  dependencyIds?: string[];
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
  recoveryProtection?: CompactionRecoveryProtection;
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
