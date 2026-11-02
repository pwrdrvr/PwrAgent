import type {
  AppServerBackendKind,
  ThreadIdentifier,
} from "./contracts/normalized-app-server";
import type { ThreadPrAutoDispatchEventKind } from "./contracts/navigation";

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
  /** While paused, refuse agent messages from other threads. */
  refuseThreadMessages: boolean;
  /**
   * While paused, what happens to wake-ups that do not come from polling:
   * a finished task monitor, or Continue After another thread.
   */
  wakeupPolicy: ProjectForgeAutomationWakeupPolicy;
};

export type ProjectForgeAutomationWakeupPolicy = "hold" | "discard";

export const DEFAULT_PROJECT_FORGE_AUTOMATION: Readonly<ProjectForgeAutomation> = {
  paused: false,
  autoFixMergeConflicts: true,
  autoFixCiFailures: true,
  prWatches: true,
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
  const flag = (key: keyof ProjectForgeAutomation): boolean => {
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
};

export type ResolveProjectHeldWakeupsResponse = {
  results: Array<{
    entryId: string;
    status: "sent" | "discarded" | "not_found" | "failed";
    error?: string;
  }>;
};
