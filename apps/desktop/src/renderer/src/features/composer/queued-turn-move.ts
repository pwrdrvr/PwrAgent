import type { FederationTarget, MoveQueuedTurnResponse } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import type { QueuedReorderRow } from "./useQueuedRowReorder";

type MovableQueuedTurn = {
  id: string;
  backendQueuePending?: boolean;
  errorMessage?: string;
  manualReleaseRequired?: boolean;
  pendingMove?: { beforeQueueEntryId?: string };
  queueEntryId?: string;
  reviewCommand?: unknown;
  scheduledActionId?: string;
  scheduledSendAt?: number;
  steerDelivery?: "sending" | "accepted";
  waitingForScheduledActionId?: string;
};

/**
 * Which run of the band a queued row can move within, or none. Rows the
 * owner's FIFO dispatches move among themselves, and rows that live only in
 * this composer (the launchpad's) among themselves. A held, steering,
 * scheduled or still-submitting row, or a queued review, stays where it is.
 */
export function queuedReorderGroup(
  queued: MovableQueuedTurn,
  now: number,
  ownerCanMove: boolean,
): QueuedReorderRow["group"] {
  if (
    queued.steerDelivery
    || queued.waitingForScheduledActionId
    || queued.manualReleaseRequired
    || queued.errorMessage
    || queued.backendQueuePending
    || queued.reviewCommand
    || (queued.scheduledSendAt !== undefined && queued.scheduledSendAt > now)
  ) {
    return undefined;
  }
  if (queued.queueEntryId) return ownerCanMove ? "owner" : undefined;
  // A scheduled action that has not reached the FIFO has nothing to move yet.
  return queued.scheduledActionId ? undefined : "local";
}

/**
 * The list with row `id` at `toIndex`. A row the owner's FIFO holds carries
 * `pendingMove` until the owner answers, and lands in front of the next
 * owner entry after it: mirrors of the FIFO are one run in its order.
 */
export function planQueuedTurnMove<T extends MovableQueuedTurn>(
  turns: readonly T[],
  id: string,
  toIndex: number,
): { next: T[]; queueEntryId?: string; beforeQueueEntryId?: string } | undefined {
  const from = turns.findIndex((candidate) => candidate.id === id);
  const moved = turns[from];
  if (!moved || from === toIndex || toIndex < 0 || toIndex >= turns.length) {
    return undefined;
  }
  const next = turns.filter((candidate) => candidate.id !== id);
  const beforeQueueEntryId = moved.queueEntryId
    ? next
        .slice(toIndex)
        .find((candidate) => candidate.queueEntryId && !candidate.reviewCommand)
        ?.queueEntryId
    : undefined;
  next.splice(
    toIndex,
    0,
    moved.queueEntryId ? { ...moved, pendingMove: { beforeQueueEntryId } } : moved,
  );
  return { next, queueEntryId: moved.queueEntryId, beforeQueueEntryId };
}

export function queuedTurnMoveFailureMessage(
  disposition: MoveQueuedTurnResponse["disposition"],
): string | undefined {
  switch (disposition) {
    case "moved":
    case "unchanged":
      return undefined;
    case "not_found":
      return "That message already started or was removed.";
    case "anchor_not_found":
      return "The queue changed while that message moved. Try again.";
    case "held":
      return "A message can’t move past one that is held for retry.";
  }
}

/** Asks the owner to move its entry. Resolves to the reason it refused, if any. */
export async function requestOwnerQueuedTurnMove(params: {
  desktopApi?: DesktopApi;
  federationTarget?: FederationTarget;
  queueEntryId: string;
  beforeQueueEntryId?: string;
}): Promise<string | undefined> {
  if (!params.desktopApi?.moveQueuedTurn) {
    return "Reordering queued messages is unavailable.";
  }
  try {
    const response = await params.desktopApi.moveQueuedTurn({
      ...(params.federationTarget ? { federationTarget: params.federationTarget } : {}),
      queueEntryId: params.queueEntryId,
      ...(params.beforeQueueEntryId
        ? { beforeQueueEntryId: params.beforeQueueEntryId }
        : {}),
    });
    return queuedTurnMoveFailureMessage(response.disposition);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Drops a settled move's marker, so the next queue read is the owner's order. */
export function withoutPendingMove<T extends MovableQueuedTurn>(
  turns: readonly T[],
  id: string,
): T[] | undefined {
  if (!turns.some((candidate) => candidate.id === id && candidate.pendingMove)) {
    return undefined;
  }
  return turns.map((candidate) => {
    if (candidate.id !== id) return candidate;
    const { pendingMove: _settled, ...rest } = candidate;
    return rest as T;
  });
}
