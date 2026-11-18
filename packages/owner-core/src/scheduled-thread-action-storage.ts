import type {
  AgentFollowUpProtection,
  ListScheduledThreadActionsRequest,
  ListScheduledThreadActionsResponse,
  PendingWakeScheduledActions,
  ScheduledThreadAction,
  ScheduledThreadActionHoldCause,
  ScheduledThreadActionKind,
  ScheduledThreadActionOrigin,
  ScheduledThreadReviewPayload,
  ScheduledThreadTurnPayload,
} from "@pwragent/shared";

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
  now: number;
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
