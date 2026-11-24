import { isThreadLockRefusal } from "@pwragent/shared/thread-lock";
import type {
  AgentFollowUpProtection,
  AgentNotificationLimits,
  ListScheduledThreadActionsRequest,
  ListScheduledThreadActionsResponse,
  ScheduledThreadAction,
  ScheduledThreadActionHoldCause,
  ScheduledThreadActionKind,
  ScheduledThreadActionOrigin,
  ScheduledThreadNotificationPayload,
  ScheduledThreadReviewPayload,
  ScheduledThreadTurnPayload,
} from "@pwragent/shared/contracts/scheduled-thread-actions";
import type { PendingWakeScheduledActions } from "@pwragent/shared/contracts/thread-pending-wakes";

const SCHEDULED_TURN_QUEUE_PREFIX = "scheduled-turn:";

export function scheduledTurnQueueEntryId(actionId: string): string {
  return SCHEDULED_TURN_QUEUE_PREFIX + actionId;
}

export function scheduledActionIdFromTurnQueueEntry(queueEntryId: string): string | undefined {
  return queueEntryId.startsWith(SCHEDULED_TURN_QUEUE_PREFIX)
    ? queueEntryId.slice(SCHEDULED_TURN_QUEUE_PREFIX.length)
    : undefined;
}

/** A lock hold written by an older scheduler may only have the refusal text. */
export function isScheduledThreadLockHold(action: ScheduledThreadAction | undefined): boolean {
  if (!action) return false;
  if (action.holdCause !== undefined) return action.holdCause === "thread_lock";
  return action.errorMessage !== undefined && isThreadLockRefusal(action.errorMessage);
}

export type CreateScheduledThreadActionRecord = {
  id: string;
  backend: ScheduledThreadAction["backend"];
  threadId: string;
  kind: ScheduledThreadActionKind;
  origin: ScheduledThreadActionOrigin;
  scheduledFor: number;
  displayText: string;
  imageAttachments?: ScheduledThreadAction["imageAttachments"];
  fileAttachments?: ScheduledThreadAction["fileAttachments"];
  manualReleaseRequired?: boolean;
  turn?: ScheduledThreadTurnPayload;
  review?: ScheduledThreadReviewPayload;
  notification?: ScheduledThreadNotificationPayload;
  now: number;
};

/** Which operator bound refused an agent's notice. */
export type AgentNotificationRefusal = "scheduled_limit" | "thread_limit" | "profile_limit";

/** What the notice bounds count for one thread at one time. */
export type AgentNotificationUsage = {
  /** Notices agents on this thread created in the rolling window. */
  threadInWindow: number;
  /** Notices agents on every thread created in the rolling window. */
  profileInWindow: number;
  /** This thread's notices that have not been delivered or ended. */
  scheduledOnThread: number;
};

export type UpdateScheduledThreadActionRecord = {
  scheduledFor?: number;
  displayText?: string;
  imageAttachments?: ScheduledThreadAction["imageAttachments"];
  fileAttachments?: ScheduledThreadAction["fileAttachments"];
  turn?: ScheduledThreadTurnPayload;
  review?: ScheduledThreadReviewPayload;
  now: number;
};

export type ScheduledThreadActionClaim = {
  now: number;
  ownerId: string;
  leaseExpiresAt: number;
};

/** A held action and the scheduler whose in-memory queue holds its entry. */
export type ScheduledThreadActionHold = {
  id: string;
  /** Changes whenever the row does, so a decision about it can be cached. */
  updatedAt: number;
  /** Absent when no live queue can hold it, such as after recovery. */
  holderId?: string;
  errorMessage?: string;
};

/** Scheduled-action persistence without host database or payload-file handles. */
export interface ScheduledThreadActionStorage {
  create(input: CreateScheduledThreadActionRecord): ScheduledThreadAction;
  /**
   * Stores an agent follow-up unless the thread already holds `maxActive`
   * agent follow-ups that have not started or ended. The count and the insert
   * are one transaction.
   */
  createAgentFollowUp(
    input: CreateScheduledThreadActionRecord,
    maxActive: number,
  ): { action: ScheduledThreadAction } | { refused: "active_limit"; active: number };
  countActiveAgentFollowUps(thread: { backend: string; threadId: string }): number;
  /**
   * Stores an agent's notice unless an operator bound refuses it; a zero
   * bound is off. The counts and the insert are one transaction.
   */
  createAgentNotification(
    input: CreateScheduledThreadActionRecord,
    limits: AgentNotificationLimits,
  ): { action: ScheduledThreadAction } | { refused: AgentNotificationRefusal; count: number };
  agentNotificationUsage(
    thread: { backend: string; threadId: string },
    now: number,
  ): AgentNotificationUsage;
  /** Waiting notices and those delivered since `deliveredSince`, newest first. */
  listAgentNotifications(request: {
    deliveredSince: number;
    limit: number;
    thread?: { backend: string; threadId: string };
  }): ScheduledThreadAction[];
  agentFollowUpProtection(
    thread: { backend: string; threadId: string },
    now: number,
  ): AgentFollowUpProtection;
  /** Clears the thread's loop guard. Only the local operator's action calls it. */
  rearmAgentFollowUps(thread: { backend: string; threadId: string }): void;
  /** Threads a claim suspended since the last call, for publication. */
  takeSuspendedAgentFollowUpThreads(): Array<{ backend: ScheduledThreadAction["backend"]; threadId: string }>;
  get(id: string): ScheduledThreadAction | undefined;
  getByQueueEntryId(queueEntryId: string): ScheduledThreadAction | undefined;
  list(request?: ListScheduledThreadActionsRequest): ScheduledThreadAction[];
  ownsPendingWake(thread: { backend: string; threadId: string }, id: string): boolean;
  listPendingWakes(thread: { backend: string; threadId: string; endedLimit: number }): PendingWakeScheduledActions;
  listProjectionPage(request: ListScheduledThreadActionsRequest): ListScheduledThreadActionsResponse;
  observeExternalProjectionChange(): boolean;
  nextScheduledAt(): number | undefined;
  update(
    id: string,
    patch: UpdateScheduledThreadActionRecord,
  ): ScheduledThreadAction | undefined;
  cancel(id: string, now: number): ScheduledThreadAction | undefined;
  dismissFailed(id: string, now: number): ScheduledThreadAction | undefined;
  claim(id: string, params: ScheduledThreadActionClaim): ScheduledThreadAction | undefined;
  claimNextDue(params: ScheduledThreadActionClaim): ScheduledThreadAction | undefined;
  /**
   * Claims a held action only while `holderId` still holds it, forgetting its
   * queue entry. `readmit` drops the manual release, so the action is
   * dispatched as when it came due.
   */
  claimHeld(
    id: string,
    holderId: string | undefined,
    params: ScheduledThreadActionClaim,
    options: { readmit: boolean },
  ): ScheduledThreadAction | undefined;
  /**
   * Held actions a claim could take, or the one with `id`. A suspended
   * thread's agent follow-ups are left out.
   */
  listHeldHolds(id?: string): ScheduledThreadActionHold[];
  markQueued(
    id: string,
    queueEntryId: string,
    now: number,
    ownerId?: string,
  ): ScheduledThreadAction | undefined;
  markStarted(
    id: string,
    turnId: string | undefined,
    now: number,
    ownerId?: string,
  ): ScheduledThreadAction | undefined;
  markHeld(
    id: string,
    queueEntryId: string,
    errorMessage: string,
    now: number,
    ownerId?: string,
    /**
     * `holderId`: the scheduler whose in-memory queue keeps the held entry.
     * `cause`: why it holds, stored so a later build need not parse text.
     */
    hold?: { holderId?: string; cause?: ScheduledThreadActionHoldCause },
  ): ScheduledThreadAction | undefined;
  /**
   * The queue is about to start an entry it had held, such as one an unlock
   * released. Taking a lease first means a crash before the start is recorded
   * fails the action instead of leaving it held after it ran.
   */
  markHeldQueued(
    id: string,
    queueEntryId: string,
    params: ScheduledThreadActionClaim,
  ): ScheduledThreadAction | undefined;
  /**
   * The queue started an entry it had held, such as one a lock released. The
   * held action has no claim, so the entry id is what ties the start to it.
   */
  markHeldStarted(
    id: string,
    queueEntryId: string,
    turnId: string | undefined,
    now: number,
  ): ScheduledThreadAction | undefined;
  markFailed(
    id: string,
    errorMessage: string,
    now: number,
    ownerId?: string,
  ): ScheduledThreadAction | undefined;
  markCancelled(
    id: string,
    now: number,
    ownerId?: string,
  ): ScheduledThreadAction | undefined;
  renewClaims(ownerId: string, now: number, leaseExpiresAt: number): void;
  expiredClaimOwnerIds(now: number): string[];
  recoverExpiredClaims(
    now: number,
    protectedOwnerIds?: ReadonlySet<string>,
  ): ScheduledThreadAction[];
  cleanupTerminalBefore(cutoff: number): void;
}
