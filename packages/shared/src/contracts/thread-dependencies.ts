import type { FederationCapability, FederationTarget } from "./federation";
import { isAppServerBackendKind } from "./navigation";
import type { AppServerBackendKind } from "./normalized-app-server";

export const THREAD_DEPENDENCIES_CHANNEL = "thread:dependencies";
/**
 * `marked_done` is a judgement, not a milestone PwrAgent observes: it ends
 * only when the prerequisite thread, the operator, or an agent marks it done.
 */
export const THREAD_DEPENDENCY_CONDITIONS = [
  "turn_completed", "pr_attached", "ci_passed", "pr_merged", "marked_done", "compaction_completed", "ci_run", "local_file", "resource_checkout",
  "merge_build",
] as const;

/**
 * `merge_build`: the prerequisite thread's PR merges, then the checks on its
 * merge commit, on the branch it merged into, finish. PwrAgent finds the merge
 * commit and checks it from the main process; no model polls it.
 */
export type ThreadDependencyMergeBuildObservation = {
  /** The commit the merge put on the target branch (the squash commit for a squash merge). */
  mergeCommitSha?: string;
  baseBranch?: string;
  /** Epoch milliseconds. */
  mergedAt?: number;
  /**
   * `no_checks`: nothing has reported on the merge commit yet. `running`:
   * at least one check has not finished. `completed`: every check finished.
   */
  status: "unknown" | "no_checks" | "running" | "completed";
  /** `cancelled` when nothing failed but a check was cancelled, as a newer push to the branch does. */
  conclusion?: "success" | "failure" | "cancelled";
  checks?: { total: number; passed: number; failed: number; cancelled: number; running: number; queued: number; skipped: number };
  failedChecks?: { name: string; url: string }[];
  /**
   * Set once a newer push to the target branch cancelled the merge build:
   * the checks above are then the build of this later commit on the branch,
   * which contains the merge.
   */
  followedSha?: string;
  /** When the owner moved to `followedSha`, epoch milliseconds. Its windows count from here. */
  followedAt?: number;
  /** How many cancelled builds were followed, at most `THREAD_DEPENDENCY_MERGE_BUILD_MAX_FOLLOWS`. */
  follows?: number;
  /** The check failed; the wait keeps the last good observation's meaning. */
  error?: string;
  errorCode?: string;
  errorChecks?: number;
  failingSince?: number;
  checkedAt: number;
};

/**
 * A merge build cancelled by a newer push is followed to the branch's next
 * build at most this many times; a build still cancelled after that counts
 * as a pass, as an unfollowed one does.
 */
export const THREAD_DEPENDENCY_MERGE_BUILD_MAX_FOLLOWS = 3;

/** A merged PR's waiting evidence while its build runs. Constant, so checks write nothing. */
export const THREAD_DEPENDENCY_MERGE_BUILD_WAITING_REASON = "PR merged; waiting for its merge build";

/** Merge build checks fold into one line: "Running · 4 passed, 2 running". */
export function summarizeThreadDependencyMergeBuild(observation: ThreadDependencyMergeBuildObservation): string {
  const state = observation.status === "completed"
    ? `Finished: ${observation.conclusion ?? "unknown"}`
    : observation.status === "no_checks" ? "No checks yet"
      : observation.status === "running" ? "Running" : "Could not read the build";
  const followed = observation.followedSha ? `Following ${observation.followedSha.slice(0, 7)}` : "";
  const checks = observation.checks;
  const counts = checks
    ? ([["passed", checks.passed], ["failed", checks.failed], ["cancelled", checks.cancelled], ["running", checks.running], ["queued", checks.queued]] as const)
      .filter(([, count]) => count > 0).map(([name, count]) => `${count} ${name}`).join(", ")
    : "";
  return [followed, state, counts, observation.error ? "last check failed" : ""].filter(Boolean).join(" · ");
}

/**
 * What wakes a `ci_run` prerequisite: the run pausing at a deployment
 * approval gate, a job failing while others still run, or the run finishing.
 */
export const THREAD_DEPENDENCY_CI_RUN_OUTCOMES = ["approval_gate", "job_failed", "finished"] as const;
export type ThreadDependencyCiRunOutcome = (typeof THREAD_DEPENDENCY_CI_RUN_OUTCOMES)[number];
export const THREAD_DEPENDENCY_CI_RUN_MAX_ENVIRONMENTS = 8;

/** A CI run prerequisite. PwrAgent checks the run itself; no model polls it. */
export type ThreadDependencyCiRun = {
  /**
   * A GitHub Actions run, `https://github.com/<owner>/<repo>/actions/runs/<id>`
   * (or the same path on an authorized GitHub Enterprise host), or a GitLab
   * pipeline, `https://gitlab.com/<group>/<project>/-/pipelines/<id>`.
   */
  url: string;
  /** Omit for all three outcomes. */
  on?: ThreadDependencyCiRunOutcome[];
  /**
   * `approval_gate` only for these gates; omit for any gate. A gate is named
   * by its environment, or on GitLab by a manual job's name.
   */
  environments?: string[];
};

/** One check of a CI run, kept in memory while waiting and saved when the wait fires. */
export type ThreadDependencyCiRunObservation = {
  runId: number;
  name?: string;
  /**
   * The run status in GitHub's words, whatever the forge: queued,
   * in_progress, waiting, completed, …
   */
  status: string;
  conclusion?: string;
  attempt?: number;
  headSha?: string;
  branch?: string;
  /**
   * What waits for a person: GitHub's pending deployments, or GitLab's
   * blocked deployments and playable manual jobs. `environmentId` is
   * GitHub's environment id, which a deployment review must name.
   */
  gates?: { environment: string; environmentId?: number; reviewers: string[]; waitTimerMinutes?: number }[];
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
  return url.match(/\/(?:actions\/runs|-\/pipelines)\/(\d+)(?:\/attempts\/\d+)?\/?$/)?.[1];
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
export function threadDependencyConditionName(condition: Pick<ThreadDependencyCondition, "subject" | "title" | "ciRun" | "localFile" | "resourceCheckout">): string | undefined {
  const label = condition.subject?.trim() || condition.title?.trim();
  if (label) return label;
  if (condition.localFile) return "Local watcher";
  if (condition.resourceCheckout) return "Resource checkout";
  if (!condition.ciRun) return undefined;
  const id = threadDependencyCiRunId(condition.ciRun.url);
  return id ? `Run ${id}` : "CI run";
}

/** Advertised by owners that serve `backend.manageThreadDependencies` to peers. */
export const THREAD_DEPENDENCIES_FEDERATION_CAPABILITY = "thread_dependencies_v1" satisfies FederationCapability;

/** Advertised by owners that keep a peer create's messaging contact. */
export const THREAD_DEPENDENCY_PROVENANCE_FEDERATION_CAPABILITY = "thread_dependency_provenance_v1" satisfies FederationCapability;

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
  local_file: "writes its result marker",
  resource_checkout: "is granted",
  merge_build: "merges and its merge build finishes",
};

/**
 * Who acts when a dependency fires. `agent` resumes the waiting thread with a
 * new turn. `operator` raises a to-do card on that thread instead and starts
 * no turn, for follow-ups only the human can do.
 */
export const THREAD_DEPENDENCY_DELIVERY_TARGETS = ["agent", "operator"] as const;
export type ThreadDependencyDeliveryTarget = (typeof THREAD_DEPENDENCY_DELIVERY_TARGETS)[number];

/** One existing local watcher, identified by its marker path and start time. */
export type ThreadDependencyLocalFile = {
  path: string;
  /** Ignore files older than this watcher start time (epoch milliseconds). */
  since: number;
  /** Optional file written if the watch command exits before producing a result. */
  exitPath?: string;
};

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
  /** `local_file` only, with an empty `threadId`. */
  localFile?: ThreadDependencyLocalFile;
  /** Owner tool registration for an actor-scoped checkout receipt. */
  resourceCheckout?: { resourceId: string; requestKey: string };
};

/**
 * True for a prerequisite that waits on a PR rather than on its thread's
 * work. A `merge_build` wait may name the waiting thread itself: the PR
 * merges on the forge, so it can never wait on its own progress.
 */
export function isThreadDependencyMergeBuildCondition(condition: Pick<ThreadDependencyCondition, "when">): boolean {
  return condition.when === "merge_build";
}

/** True for a prerequisite that names a thread, on any machine. */
export function isThreadDependencyThreadCondition(condition: Pick<ThreadDependencyCondition, "subject" | "ciRun" | "localFile" | "resourceCheckout">): boolean {
  return condition.subject === undefined && condition.ciRun === undefined && condition.localFile === undefined && condition.resourceCheckout === undefined;
}

/** True for a thread prerequisite on the waiting thread's own machine. */
export function isThreadDependencyLocalThreadCondition(condition: Pick<ThreadDependencyCondition, "subject" | "target" | "ciRun" | "localFile" | "resourceCheckout">): boolean {
  return condition.subject === undefined && condition.target === undefined && condition.ciRun === undefined && condition.localFile === undefined && condition.resourceCheckout === undefined;
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
  /** `merge_build` only, kept the same way as `ciRun`. */
  mergeBuild?: ThreadDependencyMergeBuildObservation;
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
  /**
   * `failure`: only a failed prerequisite wakes the thread; success ends the
   * wait quietly as delivered, with no turn. Absent: both outcomes wake it.
   */
  wakeOn?: "failure";
  /** Armed by PwrAgent when it saw the PR merge, not by a person or an agent. */
  automatic?: boolean;
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
  /** Only a failure wakes the thread; a success ends the wait quietly. */
  wakeOn?: "failure";
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

/**
 * Prerequisite kinds a newly created thread (via `handoff_task` or a
 * `start_thread` to-do card) can register right from creation. Excludes
 * same-thread Codex compaction hooks, caller-workspace local file watchers,
 * and owner-internal resource checkouts.
 */
export const INITIAL_THREAD_DEPENDENCY_CONDITIONS = [
  "turn_completed",
  "pr_attached",
  "ci_passed",
  "pr_merged",
  "merge_build",
  "marked_done",
  "ci_run",
] as const;

export type InitialThreadDependencyConditionWhen =
  (typeof INITIAL_THREAD_DEPENDENCY_CONDITIONS)[number];

/**
 * One prerequisite passed on `handoff_task.continueAfter` or
 * `add_todo.action.continueAfter`. For a thread prerequisite, omitting both
 * `backend` and `threadId` targets the parent/raising thread.
 */
export type InitialThreadDependencyCondition = {
  backend?: AppServerBackendKind;
  threadId?: string;
  when: InitialThreadDependencyConditionWhen;
  turnId?: string;
  prUrl?: string;
  headSha?: string;
  title?: string;
  subject?: string;
  target?: Extract<FederationTarget, { scope: "remote" }>;
  ciRun?: ThreadDependencyCiRun;
};

/**
 * Continue After registration attached to a `handoff_task` call or a
 * `start_thread` to-do card so the child thread's follow-up wait is registered
 * durably when the child starts instead of living only in prompt prose.
 */
export type InitialThreadContinueAfter = {
  conditions: InitialThreadDependencyCondition[];
  mode?: "all" | "any";
  onFailure?: "notify" | "wait";
  continuation: string;
  deliver?: ThreadDependencyDeliveryTarget;
  handoff?: boolean;
  steps?: string[];
  holdMerge?: boolean;
  wakeOn?: "failure";
};

/** One resolved prerequisite condition on an initial Continue After registration. */
export type ResolvedInitialThreadDependencyCondition = InitialThreadDependencyCondition & {
  backend: AppServerBackendKind;
  threadId: string;
};

/** Initial Continue After after resolving defaulted parent thread references. */
export type ResolvedInitialThreadContinueAfter = Omit<InitialThreadContinueAfter, "conditions"> & {
  conditions: ResolvedInitialThreadDependencyCondition[];
};

const INITIAL_CONTINUE_AFTER_KEYS = new Set([
  "conditions",
  "mode",
  "onFailure",
  "continuation",
  "deliver",
  "handoff",
  "steps",
  "holdMerge",
  "wakeOn",
]);

const INITIAL_CONTINUE_AFTER_CONDITION_KEYS = new Set([
  "backend",
  "threadId",
  "when",
  "turnId",
  "prUrl",
  "headSha",
  "title",
  "subject",
  "target",
  "ciRun",
]);

const INITIAL_CONTINUE_AFTER_CI_RUN_KEYS = new Set(["url", "on", "environments"]);
const INITIAL_CONTINUE_AFTER_CONTINUATION_MAX_LENGTH = 8_000;
const INITIAL_CONTINUE_AFTER_MAX_CONDITIONS = 16;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPlausibleCiRunUrl(value: string): boolean {
  const match = /^https:\/\/([^/?#@\s]+)(\/[^?#\s]*)$/.exec(value);
  if (!match) return false;
  const host = match[1]!.toLowerCase();
  const pathname = match[2]!;
  if (host === "gitlab.com") {
    return /^\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\/-\/pipelines\/[1-9]\d{0,18}\/?$/.test(pathname);
  }
  return /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9]\d{0,18}(?:\/attempts\/\d+)?\/?$/.test(pathname);
}

/**
 * Validates and normalizes `continueAfter` on `handoff_task` or a
 * `start_thread` to-do card before any workspace or thread is created.
 */
export function parseInitialThreadContinueAfter(
  value: unknown,
  field = "continueAfter",
): { ok: true; value: InitialThreadContinueAfter } | { ok: false; message: string } {
  if (!isPlainRecord(value)) {
    return { ok: false, message: `${field} must be an object with conditions and continuation.` };
  }
  for (const key of Object.keys(value)) {
    if (!INITIAL_CONTINUE_AFTER_KEYS.has(key)) {
      return { ok: false, message: `Unknown ${field} field "${key}".` };
    }
  }
  if (typeof value.continuation !== "string" || !value.continuation.trim()) {
    return {
      ok: false,
      message: `${field}.continuation is required: concrete steps for when the prerequisites are met.`,
    };
  }
  const continuation = value.continuation.trim();
  if (continuation.length > INITIAL_CONTINUE_AFTER_CONTINUATION_MAX_LENGTH) {
    return {
      ok: false,
      message: `${field}.continuation must be at most ${INITIAL_CONTINUE_AFTER_CONTINUATION_MAX_LENGTH} characters.`,
    };
  }
  if (value.mode !== undefined && value.mode !== "all" && value.mode !== "any") {
    return { ok: false, message: `${field}.mode must be all or any.` };
  }
  if (value.onFailure !== undefined && value.onFailure !== "notify" && value.onFailure !== "wait") {
    return { ok: false, message: `${field}.onFailure must be notify or wait.` };
  }
  if (value.deliver !== undefined && !THREAD_DEPENDENCY_DELIVERY_TARGETS.includes(value.deliver as ThreadDependencyDeliveryTarget)) {
    return { ok: false, message: `${field}.deliver must be agent or operator.` };
  }
  if (value.handoff !== undefined && typeof value.handoff !== "boolean") {
    return { ok: false, message: `${field}.handoff must be true or false.` };
  }
  if (value.handoff && value.deliver !== "operator") {
    return { ok: false, message: `${field}.handoff requires deliver: "operator".` };
  }
  if (value.holdMerge !== undefined && typeof value.holdMerge !== "boolean") {
    return { ok: false, message: `${field}.holdMerge must be true or false.` };
  }
  if (value.wakeOn !== undefined && value.wakeOn !== "failure") {
    return { ok: false, message: `${field}.wakeOn must be "failure", or omitted to wake on either outcome.` };
  }
  if (value.wakeOn === "failure" && value.deliver === "operator") {
    return { ok: false, message: `${field}.wakeOn: "failure" cannot be used with deliver: "operator".` };
  }
  let steps: string[] | undefined;
  if (value.steps !== undefined) {
    if (value.deliver !== "operator") {
      return { ok: false, message: `${field}.steps require deliver: "operator".` };
    }
    if (
      !Array.isArray(value.steps)
      || value.steps.length > THREAD_DEPENDENCY_MAX_STEPS
      || value.steps.some((step) => typeof step !== "string" || !step.trim() || step.trim().length > THREAD_DEPENDENCY_STEP_MAX_LENGTH)
    ) {
      return {
        ok: false,
        message: `${field}.steps must be at most ${THREAD_DEPENDENCY_MAX_STEPS} nonempty lines of at most ${THREAD_DEPENDENCY_STEP_MAX_LENGTH} characters.`,
      };
    }
    steps = value.steps.map((step: string) => step.trim());
  }
  if (
    !Array.isArray(value.conditions)
    || value.conditions.length < 1
    || value.conditions.length > INITIAL_CONTINUE_AFTER_MAX_CONDITIONS
  ) {
    return {
      ok: false,
      message: `${field}.conditions must contain between 1 and ${INITIAL_CONTINUE_AFTER_MAX_CONDITIONS} prerequisite conditions.`,
    };
  }
  const conditions: InitialThreadDependencyCondition[] = [];
  for (const [index, raw] of value.conditions.entries()) {
    const parsed = parseInitialCondition(raw, `${field}.conditions[${index}]`, Boolean(value.holdMerge));
    if (!parsed.ok) return parsed;
    conditions.push(parsed.value);
  }
  return {
    ok: true,
    value: {
      conditions,
      continuation,
      ...(value.mode ? { mode: value.mode } : {}),
      ...(value.onFailure ? { onFailure: value.onFailure } : {}),
      ...(value.deliver ? { deliver: value.deliver as ThreadDependencyDeliveryTarget } : {}),
      ...(value.handoff ? { handoff: true } : {}),
      ...(steps && steps.length > 0 ? { steps } : {}),
      ...(value.holdMerge ? { holdMerge: true } : {}),
      ...(value.wakeOn === "failure" ? { wakeOn: "failure" as const } : {}),
    },
  };
}

function parseInitialCondition(
  raw: unknown,
  field: string,
  holdMerge: boolean,
): { ok: true; value: InitialThreadDependencyCondition } | { ok: false; message: string } {
  if (!isPlainRecord(raw)) {
    return { ok: false, message: `${field} must be a condition object.` };
  }
  for (const key of Object.keys(raw)) {
    if (!INITIAL_CONTINUE_AFTER_CONDITION_KEYS.has(key)) {
      return { ok: false, message: `Unknown ${field} field "${key}".` };
    }
  }
  if (typeof raw.when !== "string" || !(INITIAL_THREAD_DEPENDENCY_CONDITIONS as readonly string[]).includes(raw.when)) {
    return {
      ok: false,
      message: `${field}.when must be one of ${INITIAL_THREAD_DEPENDENCY_CONDITIONS.join(", ")}.`,
    };
  }
  const when = raw.when as InitialThreadDependencyConditionWhen;
  if (raw.backend !== undefined && (typeof raw.backend !== "string" || !isAppServerBackendKind(raw.backend.trim()))) {
    return { ok: false, message: `${field}.backend must name a known PwrAgent backend.` };
  }
  const backend = typeof raw.backend === "string" ? raw.backend.trim() as AppServerBackendKind : undefined;
  if (raw.threadId !== undefined && typeof raw.threadId !== "string") {
    return { ok: false, message: `${field}.threadId must be a string.` };
  }
  const threadId = typeof raw.threadId === "string" ? raw.threadId.trim() : undefined;
  if (raw.title !== undefined && (typeof raw.title !== "string" || raw.title.trim().length > 200)) {
    return { ok: false, message: `${field}.title must be text of at most 200 characters.` };
  }
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : undefined;

  if (when === "ci_run" || raw.ciRun !== undefined) {
    if (when !== "ci_run" || !isPlainRecord(raw.ciRun)) {
      return { ok: false, message: `${field} with ci_run requires ciRun: { url, on?, environments? }.` };
    }
    if ((threadId !== undefined && threadId !== "") || raw.subject !== undefined || raw.target !== undefined
      || raw.turnId !== undefined || raw.prUrl !== undefined || raw.headSha !== undefined) {
      return { ok: false, message: `${field} ci_run names no thread and takes no turn, PR, subject or target fields.` };
    }
    for (const key of Object.keys(raw.ciRun)) {
      if (!INITIAL_CONTINUE_AFTER_CI_RUN_KEYS.has(key)) {
        return { ok: false, message: `Unknown ${field}.ciRun field "${key}".` };
      }
    }
    if (typeof raw.ciRun.url !== "string" || !raw.ciRun.url.trim() || raw.ciRun.url.trim().length > 2000) {
      return { ok: false, message: `${field}.ciRun.url must be a nonempty URL of at most 2000 characters.` };
    }
    const ciRunUrl = raw.ciRun.url.trim();
    if (!isPlausibleCiRunUrl(ciRunUrl)) {
      return {
        ok: false,
        message: `${field}.ciRun.url must be an https:// GitHub Actions run (/actions/runs/<id>) or GitLab pipeline (/-/pipelines/<id>) URL.`,
      };
    }
    let on: ThreadDependencyCiRunOutcome[] | undefined;
    if (raw.ciRun.on !== undefined) {
      if (
        !Array.isArray(raw.ciRun.on)
        || raw.ciRun.on.length < 1
        || raw.ciRun.on.some((outcome) => !(THREAD_DEPENDENCY_CI_RUN_OUTCOMES as readonly unknown[]).includes(outcome))
      ) {
        return { ok: false, message: `${field}.ciRun.on lists one or more of ${THREAD_DEPENDENCY_CI_RUN_OUTCOMES.join(", ")}.` };
      }
      on = raw.ciRun.on as ThreadDependencyCiRunOutcome[];
    }
    let environments: string[] | undefined;
    if (raw.ciRun.environments !== undefined) {
      if (
        !Array.isArray(raw.ciRun.environments)
        || raw.ciRun.environments.length > THREAD_DEPENDENCY_CI_RUN_MAX_ENVIRONMENTS
        || raw.ciRun.environments.some((name) => typeof name !== "string" || !name.trim() || name.trim().length > 100)
      ) {
        return {
          ok: false,
          message: `${field}.ciRun.environments lists at most ${THREAD_DEPENDENCY_CI_RUN_MAX_ENVIRONMENTS} nonempty environment names.`,
        };
      }
      if (on && !on.includes("approval_gate")) {
        return { ok: false, message: `${field}.ciRun.environments narrows approval_gate; include approval_gate in ciRun.on.` };
      }
      environments = raw.ciRun.environments.map((name: string) => name.trim());
    }
    return {
      ok: true,
      value: {
        when: "ci_run",
        ...(backend ? { backend } : {}),
        ...(raw.threadId !== undefined ? { threadId: "" } : {}),
        ...(title ? { title } : {}),
        ciRun: {
          url: raw.ciRun.url.trim(),
          ...(on ? { on } : {}),
          ...(environments ? { environments } : {}),
        },
      },
    };
  }

  if (raw.subject !== undefined) {
    if (typeof raw.subject !== "string" || !raw.subject.trim() || raw.subject.trim().length > THREAD_DEPENDENCY_SUBJECT_MAX_LENGTH) {
      return { ok: false, message: `${field}.subject must be nonempty text of at most ${THREAD_DEPENDENCY_SUBJECT_MAX_LENGTH} characters.` };
    }
    if (when !== "marked_done" || (threadId !== undefined && threadId !== "") || raw.target !== undefined
      || raw.turnId !== undefined || raw.prUrl !== undefined || raw.headSha !== undefined) {
      return { ok: false, message: `${field} with subject names no thread and must use when: "marked_done".` };
    }
    return {
      ok: true,
      value: {
        when: "marked_done",
        ...(backend ? { backend } : {}),
        ...(raw.threadId !== undefined ? { threadId: "" } : {}),
        subject: raw.subject.trim(),
        ...(title ? { title } : {}),
      },
    };
  }

  // Thread prerequisite: omit both backend and threadId to wait on the parent/raising thread.
  const hasBackend = backend !== undefined;
  const hasThreadId = threadId !== undefined && threadId.length > 0;
  if (raw.threadId !== undefined && !hasThreadId) {
    return { ok: false, message: `${field}.threadId must be nonempty, or omit both backend and threadId to wait on this thread.` };
  }
  if (hasBackend !== hasThreadId) {
    return { ok: false, message: `${field} must provide both backend and threadId to wait on another thread, or omit both to wait on this thread.` };
  }

  let target: Extract<FederationTarget, { scope: "remote" }> | undefined;
  if (raw.target !== undefined) {
    if (
      !isPlainRecord(raw.target)
      || raw.target.scope !== "remote"
      || typeof raw.target.instanceId !== "string"
      || !raw.target.instanceId.trim()
      || raw.target.instanceId.trim().length > 200
    ) {
      return { ok: false, message: `${field}.target must be { scope: "remote", instanceId }.` };
    }
    if (when !== "marked_done") {
      return { ok: false, message: `${field} targeting another machine can only use when: "marked_done".` };
    }
    if (!hasBackend || !hasThreadId) {
      return { ok: false, message: `${field} targeting another machine must provide explicit backend and threadId.` };
    }
    target = { scope: "remote", instanceId: raw.target.instanceId.trim() };
  }

  const readIdentifier = (val: unknown, name: string): { ok: true; value?: string } | { ok: false; message: string } => {
    if (val === undefined) return { ok: true };
    if (typeof val !== "string" || !val.trim() || val.trim().length > 2000) {
      return { ok: false, message: `${field}.${name} must be nonempty text of at most 2000 characters.` };
    }
    return { ok: true, value: val.trim() };
  };
  const turnId = readIdentifier(raw.turnId, "turnId");
  if (!turnId.ok) return turnId;
  const prUrl = readIdentifier(raw.prUrl, "prUrl");
  if (!prUrl.ok) return prUrl;
  const headSha = readIdentifier(raw.headSha, "headSha");
  if (!headSha.ok) return headSha;

  if (when === "turn_completed" && (prUrl.value || headSha.value)) {
    return { ok: false, message: `${field} cannot use prUrl or headSha with turn_completed.` };
  }
  if (when === "marked_done" && (prUrl.value || headSha.value)) {
    return { ok: false, message: `${field} cannot use prUrl or headSha with marked_done.` };
  }
  if (when === "merge_build" && headSha.value) {
    return { ok: false, message: `${field} cannot use headSha with merge_build.` };
  }
  if (when === "merge_build" && holdMerge) {
    return { ok: false, message: `${field} merge_build cannot be combined with holdMerge.` };
  }
  if (when !== "turn_completed" && turnId.value) {
    return { ok: false, message: `${field}.turnId is only valid with turn_completed.` };
  }

  return {
    ok: true,
    value: {
      when,
      ...(backend && threadId ? { backend, threadId } : {}),
      ...(turnId.value ? { turnId: turnId.value } : {}),
      ...(prUrl.value ? { prUrl: prUrl.value } : {}),
      ...(headSha.value ? { headSha: headSha.value } : {}),
      ...(title ? { title } : {}),
      ...(target ? { target } : {}),
    },
  };
}

/**
 * Resolves omitted `backend`/`threadId` fields in `InitialThreadContinueAfter`
 * against the parent/raising thread so the result is ready to persist on a
 * to-do card or pass to `manage_thread_dependencies`.
 */
export function resolveInitialThreadContinueAfter(
  spec: InitialThreadContinueAfter,
  source: { backend: AppServerBackendKind; threadId: string; title?: string },
): ResolvedInitialThreadContinueAfter {
  const sourceTitle = source.title?.trim() ? source.title.trim().slice(0, 200) : undefined;
  return {
    ...spec,
    conditions: spec.conditions.map((condition): ResolvedInitialThreadDependencyCondition => {
      if (condition.when === "ci_run" || condition.subject !== undefined) {
        return {
          ...condition,
          backend: condition.backend ?? source.backend,
          threadId: "",
        };
      }
      const defaultedToSource = !condition.backend && !condition.threadId;
      const backend = condition.backend ?? source.backend;
      const threadId = condition.threadId ?? source.threadId;
      const matchesSource = defaultedToSource
        || (!condition.target && backend === source.backend && threadId === source.threadId);
      const title = condition.title ?? (matchesSource ? sourceTitle : undefined);
      return {
        ...condition,
        backend,
        threadId,
        ...(title ? { title } : {}),
      };
    }),
  };
}

/**
 * Human-readable one-line summary of one prerequisite condition, used on
 * `start_thread` to-do cards, Markdown copies, and child handoff prompt notes.
 */
export function describeInitialContinueAfterCondition(
  condition: Pick<ThreadDependencyCondition, "when" | "prUrl" | "subject" | "title" | "threadId" | "ciRun" | "localFile" | "resourceCheckout">,
): string {
  const prNumber = condition.when !== "turn_completed"
    ? condition.prUrl?.match(/\/(?:pull|merge_requests)\/(\d+)/)?.[1]
    : undefined;
  const label = prNumber
    ? `PR #${prNumber}`
    : threadDependencyConditionName(condition)
      || (condition.threadId ? `Thread ${condition.threadId.slice(0, 8)}` : "Prerequisite");
  return `${label} ${threadDependencyConditionPhrase(condition)}`;
}

/**
 * Note appended to a child thread's first prompt when PwrAgent registers an
 * initial Continue After wait for it, so the child does not poll or duplicate
 * the registration.
 */
export function formatInitialContinueAfterPromptNote(
  continueAfter: ResolvedInitialThreadContinueAfter,
): string {
  const lead = continueAfter.deliver === "operator"
    ? "PwrAgent is registering a Continue After reminder for the operator on this thread once its prerequisites are met:"
    : "PwrAgent is registering a Continue After wait on this thread so you will be resumed automatically once its prerequisites are met:";
  const modeNote = continueAfter.conditions.length > 1 && continueAfter.mode === "any"
    ? " (triggers when any prerequisite is met)"
    : "";
  const lines = [
    `${lead}${modeNote}`,
    ...continueAfter.conditions.map((condition) => `- ${describeInitialContinueAfterCondition(condition)}`),
    continueAfter.deliver === "operator"
      ? "Do not register a duplicate Continue After wait or poll these prerequisites."
      : "Finish your initial task here and end your turn. Do not register a duplicate Continue After wait or poll these prerequisites.",
  ];
  return lines.join("\n");
}
