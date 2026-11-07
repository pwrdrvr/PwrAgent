import type {
  ListScheduledThreadActionsRequest,
  ListScheduledThreadActionsResponse,
  PendingWakeScheduledActions,
  ScheduledThreadAction,
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

/** Scheduled-action persistence without host database or payload-file handles. */
export interface ScheduledThreadActionStorage {
  create(input: CreateScheduledThreadActionRecord): ScheduledThreadAction;
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
