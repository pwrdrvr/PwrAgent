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
  retire?: { entry: Entry; outcome: QueueNoticeOutcome };
};

/** Commit state before running retire: duplicate deliveries must not repeat effects. */
export function transitionQueueNotice<Entry>(
  state: QueueNoticeState<Entry> | undefined,
  event: QueueNoticeEvent<Entry>,
): QueueNoticeTransition<Entry> {
  if (event.type === "accepted") {
    return !state || state.phase === "observed"
      ? { state: { phase: "announcing", entry: event.entry, outcome: state?.outcome } }
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
  if (state.phase === "announcing") return { state: { ...state, outcome: event.outcome } };
  return { state: { phase: "settled", outcome: event.outcome }, retire: { entry: state.entry, outcome: event.outcome } };
}
