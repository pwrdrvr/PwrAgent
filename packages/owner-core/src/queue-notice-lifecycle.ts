export type QueueNoticeOutcome = {
  status: "started" | "cancelled" | "failed";
  turnId?: string;
};

/** Owner admission, notice delivery, and owner outcomes can arrive independently. */
export type QueueNoticeState<Entry> =
  | { phase: "observed"; outcome: QueueNoticeOutcome }
  | { phase: "announcing"; entry: Entry; outcome?: QueueNoticeOutcome }
  | { phase: "queued"; entry: Entry }
  | { phase: "settled"; outcome: QueueNoticeOutcome };

export type QueueNoticeEvent<Entry> =
  | { type: "accepted"; entry: Entry }
  | { type: "noticeReady" }
  | { type: "ownerOutcome"; outcome: QueueNoticeOutcome };

export type QueueNoticeTransition<Entry> = {
  state?: QueueNoticeState<Entry>;
  /** Turn resources become usable as soon as acceptance and owner start agree. */
  started?: { entry: Entry; turnId: string };
  retire?: { entry: Entry; outcome: QueueNoticeOutcome };
};

function startedEntry<Entry>(entry: Entry, outcome?: QueueNoticeOutcome): QueueNoticeTransition<Entry>["started"] {
  return outcome?.status === "started" && outcome.turnId ? { entry, turnId: outcome.turnId } : undefined;
}

/** Commit state before running effects: duplicate deliveries must not repeat them. */
export function transitionQueueNotice<Entry>(
  state: QueueNoticeState<Entry> | undefined,
  event: QueueNoticeEvent<Entry>,
): QueueNoticeTransition<Entry> {
  if (event.type === "accepted") {
    return !state || state.phase === "observed"
      ? { state: { phase: "announcing", entry: event.entry, outcome: state?.outcome }, started: startedEntry(event.entry, state?.outcome) }
      : { state };
  }
  if (event.type === "noticeReady") {
    if (state?.phase !== "announcing") return { state };
    return state.outcome
      ? { state: { phase: "settled", outcome: state.outcome }, retire: { entry: state.entry, outcome: state.outcome } }
      : { state: { phase: "queued", entry: state.entry } };
  }
  if (!state) return { state: { phase: "observed", outcome: event.outcome } };
  if (state.phase === "observed" || state.phase === "settled" || (state.phase === "announcing" && state.outcome)) return { state };
  if (state.phase === "announcing") return { state: { ...state, outcome: event.outcome }, started: startedEntry(state.entry, event.outcome) };
  return { state: { phase: "settled", outcome: event.outcome }, retire: { entry: state.entry, outcome: event.outcome }, started: startedEntry(state.entry, event.outcome) };
}
