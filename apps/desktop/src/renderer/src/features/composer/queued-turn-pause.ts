import type {
  FederationTarget,
  NavigationThreadSummary,
  SetQueuedTurnPausedResponse,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { threadSupportsFederationCapability } from "../../lib/federated-thread-events";

type PausableQueuedTurn = {
  backendQueuePending?: boolean;
  errorMessage?: string;
  manualReleaseRequired?: boolean;
  paused?: boolean;
  queueEntryId?: string;
  reviewCommand?: unknown;
  scheduledActionId?: string;
  scheduledSendAt?: number;
  steerDelivery?: "sending" | "accepted";
  waitingForScheduledActionId?: string;
};

/**
 * Whether the instance that owns `thread`'s queue can pause its entries. A
 * peer on an older build does not advertise `turn_queue_pause`, would
 * dispatch a paused entry anyway, and its rows offer no pause.
 */
export function queuedTurnOwnerCanPause(
  desktopApi: DesktopApi | undefined,
  thread: NavigationThreadSummary | undefined,
): boolean {
  if (!desktopApi?.setQueuedTurnPaused) return false;
  return !thread
    || (threadSupportsFederationCapability(thread, "turn_queue_pause")
      && threadSupportsFederationCapability(thread, "turn_control"));
}

/**
 * Whether a queued row offers Pause. Only a message plainly waiting its turn
 * pauses: a held row already waits on Retry, a scheduled one on its time, a
 * steering one is with the agent, and a review waits outside the turn FIFO.
 */
export function canPauseQueuedTurn(
  queued: PausableQueuedTurn,
  now: number,
  ownerCanPause: boolean,
): boolean {
  if (
    queued.paused
    || queued.steerDelivery
    || queued.waitingForScheduledActionId
    || queued.manualReleaseRequired
    || queued.errorMessage
    || queued.backendQueuePending
    || queued.reviewCommand
    || (queued.scheduledSendAt !== undefined && queued.scheduledSendAt > now)
  ) {
    return false;
  }
  if (queued.queueEntryId) return ownerCanPause;
  // A scheduled action that has not reached the FIFO has nothing to pause.
  return !queued.scheduledActionId;
}

/** Whether a paused row can resume from this window. */
export function canResumeQueuedTurn(
  queued: PausableQueuedTurn,
  ownerCanPause: boolean,
): boolean {
  if (!queued.paused || queued.backendQueuePending) return false;
  return queued.queueEntryId ? ownerCanPause : true;
}

function queuedTurnPauseFailureMessage(
  disposition: SetQueuedTurnPausedResponse["disposition"],
): string | undefined {
  switch (disposition) {
    case "updated":
    case "unchanged":
      return undefined;
    case "not_found":
      return "That message already started or was removed.";
    case "held":
      return "A message held for retry can’t pause. Retry or delete it first.";
  }
}

/**
 * Asks the owner to pause or resume its entry. Resolves to the reason it
 * refused, if any, and whether the entry is paused once it answered.
 */
export async function requestOwnerQueuedTurnPause(params: {
  desktopApi?: DesktopApi;
  federationTarget?: FederationTarget;
  queueEntryId: string;
  paused: boolean;
}): Promise<{ failure?: string; paused?: boolean }> {
  if (!params.desktopApi?.setQueuedTurnPaused) {
    return { failure: "Pausing queued messages is unavailable." };
  }
  try {
    const response = await params.desktopApi.setQueuedTurnPaused({
      ...(params.federationTarget ? { federationTarget: params.federationTarget } : {}),
      queueEntryId: params.queueEntryId,
      paused: params.paused,
    });
    return {
      failure: queuedTurnPauseFailureMessage(response.disposition),
      ...(response.paused !== undefined ? { paused: response.paused } : {}),
    };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

/** `turn` paused or not, with no `paused` key at all when it is not. */
export function withPausedFlag<T extends { paused?: boolean }>(turn: T, paused: boolean): T {
  const { paused: _previous, ...rest } = turn;
  return (paused ? { ...rest, paused: true } : rest) as T;
}

/**
 * The list with the row for `queueEntryId` paused as the owner answered, or
 * undefined when no row disagrees: the owner's queue event usually lands
 * first.
 */
export function withOwnerPauseState<T extends PausableQueuedTurn>(
  turns: readonly T[],
  queueEntryId: string,
  paused: boolean,
): T[] | undefined {
  if (!turns.some((turn) => turn.queueEntryId === queueEntryId && Boolean(turn.paused) !== paused)) {
    return undefined;
  }
  return turns.map((turn) => turn.queueEntryId === queueEntryId ? withPausedFlag(turn, paused) : turn);
}

/**
 * Pauses or resumes `queued`, as every queued band does. A row only this
 * composer holds changes at once, before the first await. A row in the
 * owner's FIFO changes when the owner answers; every window hears it from the
 * owner's queue event, and the answer settles this one if that event has not
 * landed yet. Resolves to the owner's reason for refusing, if any.
 */
export async function setQueuedTurnPausedIn<T extends PausableQueuedTurn & { id: string }>(params: {
  queued: T;
  paused: boolean;
  read: () => readonly T[];
  write: (turns: T[]) => void;
  desktopApi?: DesktopApi;
  federationTarget?: FederationTarget;
}): Promise<string | undefined> {
  const queueEntryId = params.queued.queueEntryId;
  if (!queueEntryId) {
    params.write(params.read().map((turn) =>
      turn.id === params.queued.id ? withPausedFlag(turn, params.paused) : turn
    ));
    return undefined;
  }
  const answer = await requestOwnerQueuedTurnPause({
    desktopApi: params.desktopApi,
    federationTarget: params.federationTarget,
    queueEntryId,
    paused: params.paused,
  });
  if (answer.paused !== undefined) {
    const settled = withOwnerPauseState(params.read(), queueEntryId, answer.paused);
    if (settled) params.write(settled);
  }
  return answer.failure;
}
