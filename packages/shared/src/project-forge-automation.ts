import type {
  AppServerBackendKind,
  ThreadIdentifier,
} from "./contracts/normalized-app-server";
import type { ThreadPrAutoDispatchEventKind } from "./contracts/navigation";
import type { FederationTarget } from "./contracts/federation";

/**
 * Per-project control over turns that the forge, other threads, and
 * wake-ups start automatically. Owned by the instance that owns the
 * project's threads, stored in that project's directory overlay, and keyed
 * by the Directories project (`directory:<path>`).
 *
 * Pausing is deliberately not thread Lock: the operator's own composer and
 * messaging apps are never blocked. Design: Claude Design, PwrAgent project,
 * "Project Forge Automation UX Review".
 */
export type ProjectForgeAutomation = {
  /**
   * Stop checking the project's pull requests. No forge status is fetched,
   * so no forge event exists to start or queue a turn.
   */
  paused: boolean;
  /** Epoch milliseconds when `paused` last became true. */
  pausedAt?: number;
  /** Auto-fix may repair a PR that can no longer merge. */
  autoFixMergeConflicts: boolean;
  /** Auto-fix may repair failed CI on the PR head. */
  autoFixCiFailures: boolean;
  /**
   * Agent-requested PR watches (`watch_thread_pull_request`) and Continue
   * After conditions on a PR may wake threads.
   */
  prWatches: boolean;
  /**
   * Whether a merged PR's thread watches its merge build. `default` follows
   * `[git] watch_merge_builds` on the project's machine, and is left out,
   * as an older owner leaves it.
   */
  mergeBuildWatches?: ProjectMergeBuildWatches;
  /**
   * PwrAgent raises "Review #N" and "Merge #N" to-do cards as a PR's CI turns
   * green (docs/pr-review-readiness.md). Off, it raises neither, does not
   * gate merge cards on review, and gives no readiness guidance. An older
   * owner never stored it; reads fill it as on.
   */
  prOffers: boolean;
  /**
   * The project's pull requests land elsewhere, as a contribution fork's
   * do: it sends them upstream and never merges them itself. PwrAgent then
   * raises no "Merge #N" cards, PR cards offer no merge, and agents are told
   * not to merge and refused when they try. Review offers are unaffected.
   * Present only when on; an older owner never stores it.
   */
  neverMerge?: true;
  /**
   * With `neverMerge` on, the base branches whose pull requests still merge:
   * the fork's own integration branches, such as `pwrdrvr`. Exact names.
   * Present only with `neverMerge` and at least one branch. An owner that
   * predates it drops it and merges none, so it never merges more.
   */
  mergeBranches?: string[];
  /** While paused, refuse agent messages from other threads. */
  refuseThreadMessages: boolean;
  /**
   * While paused, what happens to wake-ups that do not come from polling:
   * a finished task monitor, or Continue After another thread.
   */
  wakeupPolicy: ProjectForgeAutomationWakeupPolicy;
};

export type ProjectForgeAutomationWakeupPolicy = "hold" | "discard";

export type ProjectMergeBuildWatches = "default" | "on" | "off";

export const DEFAULT_PROJECT_FORGE_AUTOMATION: Readonly<ProjectForgeAutomation> = {
  paused: false,
  autoFixMergeConflicts: true,
  autoFixCiFailures: true,
  prWatches: true,
  prOffers: true,
  refuseThreadMessages: true,
  wakeupPolicy: "hold",
};

/** Error code agent tools return when a project pause refuses a call. */
export const PROJECT_PAUSED_ERROR_CODE = "project_paused";

/**
 * Reads a stored or requested value, filling every missing or malformed
 * field from the defaults. Never throws.
 */
export function resolveProjectForgeAutomation(value: unknown): ProjectForgeAutomation {
  const record = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const flag = (key: "paused" | "autoFixMergeConflicts" | "autoFixCiFailures" | "prWatches" | "prOffers" | "refuseThreadMessages"): boolean => {
    const raw = record[key];
    return typeof raw === "boolean"
      ? raw
      : DEFAULT_PROJECT_FORGE_AUTOMATION[key] as boolean;
  };
  const paused = flag("paused");
  const pausedAt = typeof record.pausedAt === "number"
    && Number.isFinite(record.pausedAt)
    && record.pausedAt > 0
    ? record.pausedAt
    : undefined;
  return {
    paused,
    ...(paused && pausedAt !== undefined ? { pausedAt } : {}),
    autoFixMergeConflicts: flag("autoFixMergeConflicts"),
    autoFixCiFailures: flag("autoFixCiFailures"),
    prWatches: flag("prWatches"),
    ...(record.mergeBuildWatches === "on" || record.mergeBuildWatches === "off"
      ? { mergeBuildWatches: record.mergeBuildWatches }
      : {}),
    prOffers: flag("prOffers"),
    ...(record.neverMerge === true ? { neverMerge: true as const } : {}),
    ...(record.neverMerge === true ? resolveMergeBranchesField(record.mergeBranches) : {}),
    refuseThreadMessages: flag("refuseThreadMessages"),
    wakeupPolicy: record.wakeupPolicy === "discard" ? "discard" : "hold",
  };
}

/** True when nothing differs from the defaults, so nothing needs storing. */
export function isDefaultProjectForgeAutomation(value: ProjectForgeAutomation): boolean {
  return !value.paused
    && value.autoFixMergeConflicts === DEFAULT_PROJECT_FORGE_AUTOMATION.autoFixMergeConflicts
    && value.autoFixCiFailures === DEFAULT_PROJECT_FORGE_AUTOMATION.autoFixCiFailures
    && value.prWatches === DEFAULT_PROJECT_FORGE_AUTOMATION.prWatches
    && (value.mergeBuildWatches ?? "default") === "default"
    && value.prOffers !== false
    && value.neverMerge !== true
    && value.refuseThreadMessages === DEFAULT_PROJECT_FORGE_AUTOMATION.refuseThreadMessages
    && value.wakeupPolicy === DEFAULT_PROJECT_FORGE_AUTOMATION.wakeupPolicy;
}

/** Whether the project lets Auto-fix act on this kind of incident. */
export function projectAllowsAutoFixKind(
  value: ProjectForgeAutomation | undefined,
  kind: ThreadPrAutoDispatchEventKind,
): boolean {
  if (!value) return true;
  if (value.paused) return false;
  return kind === "merge-conflict"
    ? value.autoFixMergeConflicts
    : value.autoFixCiFailures;
}

/** Whether PR watches and PR Continue After conditions may wake threads. */
export function projectAllowsPrWatches(value: ProjectForgeAutomation | undefined): boolean {
  return !value || (!value.paused && value.prWatches);
}

/**
 * Whether PwrAgent watches the merge build of a PR that merges in this
 * project. A paused project, or one with PR watches off, watches none;
 * otherwise the project's choice beats `[git] watch_merge_builds`.
 */
export function projectWatchesMergeBuilds(value: ProjectForgeAutomation | undefined, globalDefault: boolean): boolean {
  if (!projectAllowsPrWatches(value)) return false;
  const choice = value?.mergeBuildWatches ?? "default";
  return choice === "default" ? globalDefault : choice === "on";
}

/**
 * Whether PwrAgent may raise review and merge offer cards for the project's
 * pull requests. A paused project raises none. A value without the field,
 * from an owner that predates it, counts as on.
 */
export function projectAllowsPrOffers(value: ProjectForgeAutomation | undefined): boolean {
  return !value || (!value.paused && value.prOffers !== false);
}

/**
 * Whether the project's pull requests are never merged from PwrAgent: no
 * merge card, PR card button, or agent merge. Pausing does not change it.
 * A value without the field, from an owner that predates it, merges.
 */
export function projectNeverMerges(value: Pick<ProjectForgeAutomation, "neverMerge"> | undefined): boolean {
  return value?.neverMerge === true;
}

/** Most branches one project lists; more is a mistake, not a workflow. */
export const MAX_PROJECT_MERGE_BRANCHES = 20;

const MAX_MERGE_BRANCH_LENGTH = 255;

/**
 * A branch name as the Merging list stores it, trimmed; undefined when it
 * cannot be a Git branch name the forge reports as a base: empty, too long,
 * or holding whitespace or control characters.
 */
export function normalizeProjectMergeBranch(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const branch = value.trim();
  if (!branch || branch.length > MAX_MERGE_BRANCH_LENGTH) return undefined;
  if (/\s/.test(branch) || [...branch].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) {
    return undefined;
  }
  return branch;
}

/** The stored list, cleaned: valid names, each once, in order, capped. */
function resolveMergeBranchesField(value: unknown): { mergeBranches?: string[] } {
  if (!Array.isArray(value)) return {};
  const branches: string[] = [];
  for (const entry of value) {
    const branch = normalizeProjectMergeBranch(entry);
    if (branch && !branches.includes(branch)) branches.push(branch);
    if (branches.length === MAX_PROJECT_MERGE_BRANCHES) break;
  }
  return branches.length ? { mergeBranches: branches } : {};
}

/**
 * The base branches that still merge in a never-merge project; empty when
 * the project merges everything or nothing is listed.
 */
export function projectMergeBranches(
  value: Pick<ProjectForgeAutomation, "neverMerge" | "mergeBranches"> | undefined,
): string[] {
  return projectNeverMerges(value) ? resolveMergeBranchesField(value?.mergeBranches).mergeBranches ?? [] : [];
}

/**
 * Whether PwrAgent may merge, or offer to merge, a pull request into
 * `baseRefName` in this project: always when the project merges, and in a
 * never-merge project only into a listed branch. A base not read yet is not
 * listed.
 */
export function projectMergesPullRequest(
  value: Pick<ProjectForgeAutomation, "neverMerge" | "mergeBranches"> | undefined,
  baseRefName: string | undefined,
): boolean {
  if (!projectNeverMerges(value)) return true;
  const base = baseRefName?.trim();
  return Boolean(base) && projectMergeBranches(value).includes(base!);
}

/** A never-merge project as a merge path reports it. */
export type ProjectNeverMergePolicy = {
  projectLabel: string;
  /** Base branches it still merges into; empty merges none. */
  mergeBranches: string[];
};

/** The project's never-merge policy; undefined when it merges. */
export function resolveProjectNeverMergePolicy(
  project: { label: string; automation: Pick<ProjectForgeAutomation, "neverMerge" | "mergeBranches"> } | undefined,
): ProjectNeverMergePolicy | undefined {
  return project && projectNeverMerges(project.automation)
    ? { projectLabel: project.label, mergeBranches: projectMergeBranches(project.automation) }
    : undefined;
}

/** `a`, `a or b`, `a, b or c`. */
export function formatProjectMergeBranches(branches: readonly string[]): string {
  if (branches.length <= 1) return branches[0] ?? "";
  return `${branches.slice(0, -1).join(", ")} or ${branches.at(-1)}`;
}

/**
 * Why an agent may not merge, or raise a merge card for, a pull request in
 * a never-merge project. Used as the tool refusal and the readiness line.
 * With `mergeBranches`, it names the branches that still merge, and with
 * `baseUnknown` it says the PR's base has not been read, which counts as a
 * branch the project does not list.
 */
export function buildProjectNeverMergeRefusal(params: {
  projectLabel: string;
  pullRequest?: string;
  mergeBranches?: readonly string[];
  baseUnknown?: boolean;
}): string {
  const listed = Boolean(params.mergeBranches?.length);
  const subject = params.pullRequest ? `${params.pullRequest} is in` : "This thread is in";
  const object = params.pullRequest ?? (listed ? "a pull request into any other branch" : "it");
  const rule = listed
    ? `merges only pull requests into ${formatProjectMergeBranches(params.mergeBranches!)}: the rest land upstream`
    : "is set to never merge pull requests: they land upstream";
  const unread = listed && params.pullRequest && params.baseUnknown
    ? ` PwrAgent has not read ${params.pullRequest}'s base branch yet, so it counts as another branch.`
    : "";
  return `${subject} ${params.projectLabel}, where Forge Automation ${rule}.${unread} Do not merge ${object}, offer a merge, or raise a merge card. The operator can change this from the project menu: Forge Automation.`;
}

/**
 * The owner's refusal for a merge from a PR card or a merge card in a
 * never-merge project.
 */
export function buildProjectNeverMergeError(params: {
  projectLabel: string;
  mergeBranches?: readonly string[];
}): string {
  return params.mergeBranches?.length
    ? `${params.projectLabel} merges only pull requests into ${formatProjectMergeBranches(params.mergeBranches)}. Change it from the project menu: Forge Automation.`
    : `${params.projectLabel} never merges its pull requests. Change it from the project menu: Forge Automation.`;
}

/** Whether the project's pull requests should be polled at all. */
export function projectAllowsForgePolling(value: ProjectForgeAutomation | undefined): boolean {
  return !value?.paused;
}

/** Whether an agent message from another thread should be refused. */
export function projectRefusesThreadMessages(value: ProjectForgeAutomation | undefined): boolean {
  return Boolean(value?.paused && value.refuseThreadMessages);
}

/** Refusal text for `send_message_to_thread`, `steer_thread` and `handoff_task`. */
export function buildProjectPausedThreadMessageRefusal(params: {
  projectLabel: string;
  threadTitle?: string;
}): string {
  const subject = params.threadTitle ? `"${params.threadTitle}"` : "That thread";
  return `${subject} is in ${params.projectLabel}, ${PROJECT_PAUSED_REFUSAL_PHRASE}. The operator can resume it from the project menu. Do not retry. Raise a to-do card if the message matters.`;
}

const PROJECT_PAUSED_REFUSAL_PHRASE =
  "where forge activity is paused and messages from other threads are refused";

/**
 * Whether an error message is a paused project's refusal. A peer's refusal
 * reaches the sender as text only, so the sender recognizes it by its words.
 */
export function isProjectPausedThreadMessageRefusal(message: string): boolean {
  return message.includes(PROJECT_PAUSED_REFUSAL_PHRASE);
}

/** Result text when a PR watch or PR Continue After condition cannot be armed. */
export function buildProjectPrWatchRefusal(params: {
  projectLabel: string;
  pullRequest?: string;
  paused: boolean;
}): string {
  const subject = params.pullRequest ? `${params.pullRequest} is in` : "This thread is in";
  const reason = params.paused
    ? "where forge activity is paused"
    : "where PR watches are turned off in Forge Automation";
  return `No watch was armed: ${subject} ${params.projectLabel}, ${reason}. Nothing will wake this thread for CI, merge or close. Tell the operator if you need to wait on this PR.`;
}

/**
 * Notice returned with a Continue After dependency whose PR conditions wait
 * because the waiting thread's project holds PR watches.
 */
export function buildProjectPrDependencyNotice(params: {
  projectLabel: string;
  paused: boolean;
}): string {
  const reason = params.paused
    ? "forge activity is paused"
    : "PR watches are turned off in Forge Automation";
  return `The dependency is stored, but this thread is in ${params.projectLabel}, where ${reason}. Its PR conditions wait until the operator turns that back on from the project menu. Tell the operator if the wait matters.`;
}

/**
 * Hold reason on a wake-up queued while its project is paused. The thread's
 * Held chip and queued-message row show it.
 */
export function buildProjectPausedWakeupHoldReason(params: {
  projectLabel: string;
}): string {
  return `Held because forge activity in ${params.projectLabel} is paused. Send it or delete it here, or resume the project from its menu.`;
}

/** Thread note left when a paused project's policy discards a wake-up. */
export function buildProjectPausedWakeupDiscardNote(params: {
  projectLabel: string;
  summary: string;
}): string {
  return `PwrAgent discarded a wake-up (${params.summary}) because forge activity in ${params.projectLabel} is paused.`;
}

export type SetProjectForgeAutomationRequest = {
  /** `directory:<path>` key of a local Directories project. */
  directoryKey: string;
  automation: ProjectForgeAutomation;
  /** A peer window's owner. Main routes the request there; never sent on. */
  federationTarget?: FederationTarget;
};

export type SetProjectForgeAutomationResponse = {
  directoryKey: string;
  automation: ProjectForgeAutomation;
};

/** Where a held wake-up came from, for the resume list. */
export type ProjectHeldWakeupSource = "monitor" | "dependency" | "other";

/** One wake-up held in a thread's queue while its project was paused. */
export type ProjectHeldWakeup = {
  /** Thread turn queue entry id. */
  entryId: string;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  threadTitle?: string;
  source: ProjectHeldWakeupSource;
  /** One line, such as `Monitor finished: "Watch the nightly run"`. */
  summary: string;
  /** Epoch milliseconds when it was held. */
  createdAt: number;
};

export type ListProjectHeldWakeupsRequest = {
  directoryKey: string;
  /** As on `SetProjectForgeAutomationRequest`. */
  federationTarget?: FederationTarget;
};

export type ListProjectHeldWakeupsResponse = {
  directoryKey: string;
  wakeups: ProjectHeldWakeup[];
};

export type ResolveProjectHeldWakeupsRequest = {
  directoryKey: string;
  resolutions: Array<{
    entryId: string;
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
    action: "send" | "discard";
  }>;
  /** As on `SetProjectForgeAutomationRequest`. */
  federationTarget?: FederationTarget;
};

export type ResolveProjectHeldWakeupsResponse = {
  results: Array<{
    entryId: string;
    status: "sent" | "discarded" | "suppressed" | "not_found" | "failed";
    error?: string;
  }>;
};
