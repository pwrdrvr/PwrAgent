import type {
  FederationTarget,
  MoveQueuedTurnResponse,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { threadSupportsFederationCapability } from "../../lib/federated-thread-events";
import type { QueuedReorderRow } from "./useQueuedRowReorder";

type MovableQueuedTurn = {
  id: string;
  backendQueuePending?: boolean;
  errorMessage?: string;
  manualReleaseRequired?: boolean;
  pendingMove?: { beforeQueueEntryId?: string; requestId?: number };
  queueEntryId?: string;
  reviewCommand?: unknown;
  scheduledActionId?: string;
  scheduledSendAt?: number;
  steerDelivery?: "sending" | "accepted";
  waitingForScheduledActionId?: string;
};

/**
 * Whether the instance that owns `thread`'s queue can move its entries. A
 * peer on an older build does not advertise `turn_queue_reorder`, and its
 * rows offer no drag rather than one that snaps back.
 */
export function queuedTurnOwnerCanMove(
  desktopApi: DesktopApi | undefined,
  thread: NavigationThreadSummary | undefined,
): boolean {
  if (!desktopApi?.moveQueuedTurn) return false;
  return !thread
    || (threadSupportsFederationCapability(thread, "turn_queue_reorder")
      && threadSupportsFederationCapability(thread, "turn_control"));
}

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
 * The row that `id` lands in front of when the band `ids` drops it at
 * `toIndex`, or undefined for the end. A move names its neighbor rather than
 * an index, so it applies to the draft store's list even where that list
 * and the rendered band differ by a row.
 */
export function queuedMoveAnchor(
  ids: readonly string[],
  id: string,
  toIndex: number,
): string | undefined {
  return ids.filter((candidate) => candidate !== id)[toIndex];
}

/** The owner FIFO entries among `turns`, in the order the band shows them. */
function ownerQueueOrder(turns: readonly MovableQueuedTurn[]): string[] {
  return turns.flatMap((candidate) =>
    candidate.queueEntryId && !candidate.reviewCommand ? [candidate.queueEntryId] : []
  );
}

let nextQueuedTurnMoveRequestId = 0;

/**
 * The list with row `id` in front of row `beforeId` (at the end without
 * one). A row the owner's FIFO holds carries `pendingMove` until the owner
 * answers, and lands in front of the next owner entry after it: mirrors of
 * the FIFO are one run in its order. `ownerOrder` is the FIFO order before
 * the move, to put back if the owner refuses it; `plannedOrder` is the order
 * the move asks for. `requestId` tells this move's answer from a later
 * move's of the same row.
 */
export function planQueuedTurnMove<T extends MovableQueuedTurn>(
  turns: readonly T[],
  id: string,
  beforeId: string | undefined,
): {
  next: T[];
  queueEntryId?: string;
  beforeQueueEntryId?: string;
  ownerOrder: string[];
  plannedOrder: string[];
  requestId: number;
} | undefined {
  const from = turns.findIndex((candidate) => candidate.id === id);
  const moved = turns[from];
  if (!moved || beforeId === id) return undefined;
  const next = turns.filter((candidate) => candidate.id !== id);
  const to = beforeId === undefined
    ? next.length
    : next.findIndex((candidate) => candidate.id === beforeId);
  if (to < 0 || to === from) return undefined;
  const beforeQueueEntryId = moved.queueEntryId
    ? next
        .slice(to)
        .find((candidate) => candidate.queueEntryId && !candidate.reviewCommand)
        ?.queueEntryId
    : undefined;
  const requestId = ++nextQueuedTurnMoveRequestId;
  next.splice(
    to,
    0,
    moved.queueEntryId ? { ...moved, pendingMove: { beforeQueueEntryId, requestId } } : moved,
  );
  return {
    next,
    queueEntryId: moved.queueEntryId,
    beforeQueueEntryId,
    ownerOrder: ownerQueueOrder(turns),
    plannedOrder: ownerQueueOrder(next),
    requestId,
  };
}

/**
 * Puts the owner FIFO entries among `turns` back in `queueEntryIds` order,
 * each into one of the places those entries already hold. Every other row
 * stays where it is.
 */
export function withOwnerQueueOrder<T extends MovableQueuedTurn>(
  turns: readonly T[],
  queueEntryIds: readonly string[],
): T[] {
  const rank = new Map(queueEntryIds.map((entryId, index) => [entryId, index]));
  const places = turns.flatMap((candidate, index) =>
    candidate.queueEntryId !== undefined && rank.has(candidate.queueEntryId) ? [index] : []
  );
  const ordered = places
    .map((place) => turns[place]!)
    .sort((a, b) => rank.get(a.queueEntryId!)! - rank.get(b.queueEntryId!)!);
  const next = [...turns];
  places.forEach((place, index) => {
    next[place] = ordered[index]!;
  });
  return next;
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

/** How many times a move re-aims after the entry it was aimed at left. */
const QUEUED_TURN_MOVE_RETARGETS = 2;

/**
 * Asks the owner to move its entry. Resolves to the reason it refused, if
 * any, and the order its FIFO is in when it answered.
 *
 * The entry the move lands in front of can start, or be cancelled, while the
 * request is in transit. The owner then answers `anchor_not_found` with its
 * current order, and the move re-aims at the next entry of `plannedOrder`
 * that is still queued, or the end.
 */
export async function requestOwnerQueuedTurnMove(params: {
  desktopApi?: DesktopApi;
  federationTarget?: FederationTarget;
  queueEntryId: string;
  beforeQueueEntryId?: string;
  plannedOrder?: readonly string[];
}): Promise<{ failure?: string; queueEntryIds?: string[] }> {
  if (!params.desktopApi?.moveQueuedTurn) {
    return { failure: "Reordering queued messages is unavailable." };
  }
  let beforeQueueEntryId = params.beforeQueueEntryId;
  try {
    for (let attempt = 0; ; attempt += 1) {
      const response = await params.desktopApi.moveQueuedTurn({
        ...(params.federationTarget ? { federationTarget: params.federationTarget } : {}),
        queueEntryId: params.queueEntryId,
        ...(beforeQueueEntryId ? { beforeQueueEntryId } : {}),
      });
      const queued = response.queueEntryIds;
      if (
        response.disposition === "anchor_not_found"
        && attempt < QUEUED_TURN_MOVE_RETARGETS
        && queued
        && params.plannedOrder
      ) {
        const planned = params.plannedOrder;
        const after = planned.slice(planned.indexOf(params.queueEntryId) + 1);
        const retarget = after.find((entryId) => queued.includes(entryId));
        if (retarget !== beforeQueueEntryId) {
          beforeQueueEntryId = retarget;
          continue;
        }
      }
      return {
        failure: queuedTurnMoveFailureMessage(response.disposition),
        queueEntryIds: queued,
      };
    }
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The list once the owner answered move `requestId`: its marker dropped
 * and, when the owner refused, its FIFO entries back in the owner's order.
 * Nothing re-reads the queue after a refusal, so the band must not keep an
 * order the owner does not have.
 *
 * Undefined when the answer no longer applies: the row has left the band (it
 * started, or was removed), or the operator moved it again and that later
 * move's answer settles it.
 */
export function settleQueuedTurnMove<T extends MovableQueuedTurn>(
  turns: readonly T[],
  id: string,
  requestId: number,
  answer: { failure?: string; queueEntryIds?: string[] },
  ownerOrder: readonly string[],
): T[] | undefined {
  const row = turns.find((candidate) => candidate.id === id);
  if (row?.pendingMove?.requestId !== requestId) return undefined;
  const cleared = withoutPendingMove(turns, id) ?? [...turns];
  if (!answer.failure) return cleared;
  return withOwnerQueueOrder(cleared, answer.queueEntryIds ?? ownerOrder);
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
