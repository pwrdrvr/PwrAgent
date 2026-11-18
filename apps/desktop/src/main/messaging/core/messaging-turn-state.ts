import type { MessagingActiveTurnSummary, MessagingBindingRecord } from "@pwragent/messaging-interface";
import { threadKeyForBinding } from "./messaging-turn-admission";

export type MessagingTurnState = {
  readonly phase: "open" | "disposed";
  readonly activeTurn?: MessagingActiveTurnSummary;
};

export type MessagingTurnEvent =
  | { readonly type: "observed" | "accepted"; readonly turn: MessagingActiveTurnSummary }
  | { readonly type: "backend"; readonly lifecycle?: MessagingActiveTurnSummary; readonly automation: boolean; readonly idle: boolean; readonly now: number }
  | { readonly type: "dispose" };

export type MessagingTurnEffect =
  | { readonly type: "turnChanged"; readonly previous?: MessagingActiveTurnSummary; readonly turn: MessagingActiveTurnSummary };

export function transitionMessagingTurn(
  previous: MessagingTurnState | undefined,
  event: MessagingTurnEvent,
): { readonly state: MessagingTurnState; readonly effects: readonly MessagingTurnEffect[]; readonly observedTurn?: MessagingActiveTurnSummary } {
  const state: MessagingTurnState = previous ?? { phase: "open" };
  const unchanged = { state, effects: [] };
  switch (event.type) {
    case "backend": {
      const previousTurn = state.activeTurn;
      const turn = event.lifecycle && !event.automation ? event.lifecycle
        : event.idle && previousTurn ? { ...previousTurn, status: "completed" as const, updatedAt: event.now } : previousTurn;
      const changed = turn && (turn.turnId !== previousTurn?.turnId || turn.status !== previousTurn.status);
      return { state: changed ? { ...state, activeTurn: turn } : state, observedTurn: turn,
        effects: changed ? [{ type: "turnChanged", previous: previousTurn, turn }] : [] };
    }
    case "observed":
      return { state: { ...state, activeTurn: event.turn }, effects: [] };
    case "accepted":
      // The bus can report completion while startTurn is still awaiting its
      // acknowledgement. Acceptance confirms input, not renewed liveness.
      if (state.activeTurn?.turnId === event.turn.turnId
        && state.activeTurn.status !== "working" && state.activeTurn.status !== "waiting") return unchanged;
      return { state: { ...state, activeTurn: event.turn }, effects: [] };
    case "dispose":
      return { state: { ...state, phase: "disposed" }, effects: [] };
  }
}

// Messaging projects bus activity; the owner's ThreadTurnQueue owns all
// admission and draining. No messaging timer or drain receipt can submit work.
export class MessagingTurns {
  private readonly states = new Map<string, MessagingTurnState>();
  private phase: "open" | "disposed" = "open";

  get(binding: MessagingBindingRecord): MessagingActiveTurnSummary | undefined {
    return this.states.get(threadKeyForBinding(binding))?.activeTurn;
  }

  observe(binding: MessagingBindingRecord, turn: MessagingActiveTurnSummary): void {
    this.commit(threadKeyForBinding(binding), { type: "observed", turn });
  }

  accept(binding: MessagingBindingRecord, turn: MessagingActiveTurnSummary): void {
    this.commit(threadKeyForBinding(binding), { type: "accepted", turn });
  }

  observeBackend(binding: MessagingBindingRecord, event: Extract<MessagingTurnEvent, { type: "backend" }>): {
    readonly activeTurn?: MessagingActiveTurnSummary;
    readonly previous?: MessagingActiveTurnSummary;
    readonly changed: boolean;
  } {
    const result = this.commit(threadKeyForBinding(binding), event);
    const change = result.effects.find(effect => effect.type === "turnChanged");
    return { activeTurn: result.observedTurn, previous: change?.previous, changed: Boolean(change) };
  }

  snapshot(): ReadonlyMap<string, MessagingActiveTurnSummary> {
    return new Map([...this.states].flatMap(([key, state]) => state.activeTurn ? [[key, state.activeTurn] as const] : []));
  }

  dispose(): void {
    this.phase = "disposed";
    for (const key of this.states.keys()) this.commit(key, { type: "dispose" });
  }

  private commit(key: string, event: MessagingTurnEvent): ReturnType<typeof transitionMessagingTurn> {
    const previous = this.states.get(key) ?? (this.phase === "disposed"
      ? { phase: "disposed" as const } : undefined);
    const result = transitionMessagingTurn(previous, event);
    this.states.set(key, result.state);
    return result;
  }
}
