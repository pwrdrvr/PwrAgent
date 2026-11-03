import type { FederationTarget } from "./federation";
import type { AppServerBackendKind, AppServerBackendWake, AppServerBackgroundTask } from "./normalized-app-server";
import type { ScheduledThreadAction, ScheduledThreadActionKind } from "./scheduled-thread-actions";
import type { ThreadDependency } from "./thread-dependencies";
import type { ThreadPrAutoFixState } from "./thread-pr-watches";
import type { ThreadPullRequestWatchSummary } from "./thread-tools";

/**
 * The operator's one list of what will start a turn on a thread later: PR
 * watches, Auto-fix, dependencies on other threads, monitor delegations,
 * scheduled messages and reviews, the backend's own background tasks and
 * scheduled wake-ups, and wake-ups a lock or a paused project holds in the
 * thread's queue.
 * Main builds it on request from each source's own state and stores nothing.
 * A stop goes to the source that owns the wake, through its own cancel path.
 */
export const THREAD_PENDING_WAKES_CHANNEL = "thread:pendingWakes";

/** Most recently ended wakes one list returns. */
export const THREAD_PENDING_WAKES_ENDED_MAX_LIMIT = 20;

/** Longest continuation text a dependency row carries. */
export const THREAD_PENDING_WAKE_TEXT_MAX_CHARS = 600;

/** Source-owned compact scheduled rows; execution inputs never enter this list. */
export type PendingWakeScheduledAction = Pick<ScheduledThreadAction,
  "id" | "kind" | "origin" | "status" | "scheduledFor" | "displayText" | "createdAt" | "updatedAt" | "queueEntryId">;
export type PendingWakeScheduledActions = { actions: PendingWakeScheduledAction[]; incomplete?: true };

export const THREAD_PENDING_WAKE_SOURCE_METHODS: ReadonlySet<string> = new Set([
  "thread/prAutoDispatch/updated", "thread/prWatches/updated", "thread/dependencies/updated",
  "thread/scheduledAction/updated", "thread/subAgents/updated", "thread/backgroundTasks/updated",
  "thread/sessionWakes/updated", "thread/lock/updated", "thread/turnQueue/updated",
  "directory/forgeAutomation/updated",
]);

/** A source mutation, or the compact invalidation an owner sends a peer. */
export function isThreadPendingWakeInvalidation(method: string, params: unknown): boolean {
  const fields = params && typeof params === "object" ? params as Record<string, unknown> : undefined;
  if (method === "navigation/invalidated") return typeof fields?.sourceMethod === "string" && THREAD_PENDING_WAKE_SOURCE_METHODS.has(fields.sourceMethod);
  if (method === "thread/subAgents/updated" && fields?.navigationChanged === false) return false;
  return THREAD_PENDING_WAKE_SOURCE_METHODS.has(method);
}

export type ThreadPendingWakeKind =
  | "pr_watch"
  | "pr_auto_fix"
  | "dependency"
  | "monitor"
  | "scheduled_action"
  | "backend_task"
  | "backend_wake"
  | "held_message";

/**
 * What keeps a wake from starting a turn now. A lock holds every source; a
 * paused project stops its PR polling and holds, or drops, the wake-ups a
 * monitor or a dependency would send. A queue is also held after a turn or
 * a start fails, until the operator sends it again.
 */
export type ThreadPendingWakeHold =
  | { kind: "thread_locked"; note?: string }
  | { kind: "queue_held"; reason: string }
  | {
      kind: "project_paused";
      projectLabel: string;
      /** `directory:<path>` key of the paused project. */
      directoryKey: string;
      /** The project drops monitor and dependency wake-ups instead of holding them. */
      discardsWakeups?: true;
    };

/** Where a held queue entry came from. */
export type ThreadPendingHeldMessageSource =
  | "monitor"
  | "dependency"
  | "operator"
  | "automation"
  | "messaging"
  | "other";

export type ThreadPendingWakeSource =
  | { kind: "pr_watch"; watch: ThreadPullRequestWatchSummary }
  | {
      kind: "pr_auto_fix";
      prKey: string;
      prNumber?: number;
      state: ThreadPrAutoFixState["state"];
      handledBy?: ThreadPrAutoFixState["handledBy"];
    }
  | {
      kind: "dependency";
      /** `continuation` is cut to `THREAD_PENDING_WAKE_TEXT_MAX_CHARS`. */
      dependency: Pick<ThreadDependency,
        "id" | "conditions" | "mode" | "onFailure" | "continuation" | "deliver" | "status" | "evidence">;
    }
  | {
      kind: "monitor";
      monitorId: string;
      task: string;
      monitorBackend: AppServerBackendKind;
      monitorThreadId?: string;
      model?: string;
      pollIntervalSeconds: number;
      lastActivityAt: number;
    }
  | {
      kind: "scheduled_action";
      actionId: string;
      actionKind: ScheduledThreadActionKind;
      /** `held` waits for the operator to release it, not for a time. */
      status: "held" | "scheduled";
      displayText: string;
    }
  | { kind: "backend_task"; task: AppServerBackgroundTask }
  | {
      /**
       * A turn the backend scheduled in its own session, such as Claude's
       * /loop. `prompt` is cut to `THREAD_PENDING_WAKE_TEXT_MAX_CHARS`.
       */
      kind: "backend_wake";
      wake: AppServerBackendWake;
    }
  | {
      /**
       * A message already in the thread's queue that a hold keeps from
       * starting: a finished monitor, a met dependency, or a queued send.
       */
      kind: "held_message";
      /** Thread turn queue entry id. */
      entryId: string;
      source: ThreadPendingHeldMessageSource;
      /** Cut to `THREAD_PENDING_WAKE_TEXT_MAX_CHARS`. */
      displayText: string;
    };

export type ThreadPendingWakeStop = "stop" | "cancel" | "turn_off" | "discard";

export type ThreadPendingWake = ThreadPendingWakeSource & {
  /** `${kind}:${sourceId}`, stable across reads. */
  key: string;
  createdAt?: number;
  /** A known fire time: scheduled actions and backend wakes. */
  wakesAt?: number;
  createdBy?: "agent" | "operator" | "messaging";
  /** False: the wake ends if the thread's owner quits. */
  durable: boolean;
  /** How this window can end it. Absent: it cannot be stopped from here. */
  stop?: ThreadPendingWakeStop;
  /** What holds it now. Always set on a held message. */
  held?: ThreadPendingWakeHold;
};

export type ThreadPendingWakeEnded = {
  key: string;
  kind: Exclude<ThreadPendingWakeKind, "pr_auto_fix" | "backend_task" | "backend_wake" | "held_message">;
  endedAt: number;
  /** One short line: what ended it, as the source recorded. */
  summary: string;
  /** Short context, such as a PR number or a monitor's task. */
  detail?: string;
};

export type ThreadPendingWakesList = {
  /** Soonest first: a known time, then what the thread watches, then running work. */
  wakes: ThreadPendingWake[];
  /** Newest first. */
  ended: ThreadPendingWakeEnded[];
  /** A source could not be read, or projection bounds omitted rows or text. */
  incomplete?: true;
};

export type ThreadPendingWakesRequest =
  | {
      action: "list";
      backend: AppServerBackendKind;
      threadId: string;
      /** Set for a peer's thread; the list is the owner's projection. */
      federationTarget?: FederationTarget;
      /** At most `THREAD_PENDING_WAKES_ENDED_MAX_LIMIT`. */
      endedLimit?: number;
    }
  | {
      action: "stop";
      backend: AppServerBackendKind;
      threadId: string;
      /** Set for a peer's thread; its owner stops the wake. */
      federationTarget?: FederationTarget;
      key: string;
    };

export type ThreadPendingWakesErrorCode =
  | "not_found"
  | "invalid_arguments"
  | "federation_unsupported"
  | "failed";

export type ThreadPendingWakesResponse =
  | ({ ok: true } & Partial<ThreadPendingWakesList> & { stopped?: boolean })
  | { ok: false; error: { code: ThreadPendingWakesErrorCode; message: string } };

/** The key a wake's source gives it. */
export function buildThreadPendingWakeKey(kind: ThreadPendingWakeKind, sourceId: string): string {
  return `${kind}:${sourceId}`;
}

/** The kind and source id a key names, or undefined for a malformed key. */
export function parseThreadPendingWakeKey(
  key: string,
): { kind: ThreadPendingWakeKind; sourceId: string } | undefined {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) return undefined;
  const kind = key.slice(0, separator);
  const sourceId = key.slice(separator + 1);
  return isThreadPendingWakeKind(kind) ? { kind, sourceId } : undefined;
}

function isThreadPendingWakeKind(value: string): value is ThreadPendingWakeKind {
  return value === "pr_watch" || value === "pr_auto_fix" || value === "dependency"
    || value === "monitor" || value === "scheduled_action" || value === "backend_task"
    || value === "backend_wake" || value === "held_message";
}
