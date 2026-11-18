import type { MessagingActiveTurnSummary, MessagingBindingRecord } from "@pwragent/messaging-interface";
import type { MessagingControllerLogger } from "./messaging-backend-event-helpers";
import { threadKeyForBinding, type MessagingTurnAdmission } from "./messaging-turn-admission";

export type MessagingDrainReceipt = {
  readonly token: symbol;
  readonly settled: Promise<void>;
  readonly settle: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type Drain =
  | { readonly phase: "idle" }
  | { readonly phase: "arming"; readonly token: symbol }
  | { readonly phase: "scheduled" | "running" | "settling"; readonly receipt: MessagingDrainReceipt };

export type MessagingTurnState = {
  readonly phase: "open" | "disposed";
  readonly activeTurn?: MessagingActiveTurnSummary;
  readonly drainRequested: boolean;
  readonly drain: Drain;
};

export type MessagingTurnEvent =
  | { readonly type: "observed" | "accepted"; readonly turn: MessagingActiveTurnSummary }
  | { readonly type: "backend"; readonly lifecycle?: MessagingActiveTurnSummary; readonly automation: boolean; readonly idle: boolean; readonly now: number }
  | { readonly type: "requestDrain" }
  | { readonly type: "takeDrainRequest" }
  | { readonly type: "schedule"; readonly token: symbol; readonly eligible: boolean; readonly dispatching: boolean }
  | { readonly type: "armed"; readonly receipt: MessagingDrainReceipt }
  | { readonly type: "fired" | "settled"; readonly token: symbol }
  | { readonly type: "dispose" };

export type MessagingTurnEffect =
  | { readonly type: "turnChanged"; readonly previous?: MessagingActiveTurnSummary; readonly turn: MessagingActiveTurnSummary }
  | { readonly type: "arm"; readonly token: symbol }
  | { readonly type: "dispatch" | "cancel"; readonly receipt: MessagingDrainReceipt }
  | { readonly type: "resume" };

export function transitionMessagingTurn(
  previous: MessagingTurnState | undefined,
  event: MessagingTurnEvent,
): { readonly state: MessagingTurnState; readonly effects: readonly MessagingTurnEffect[]; readonly observedTurn?: MessagingActiveTurnSummary } {
  const state: MessagingTurnState = previous ?? { phase: "open", drainRequested: false, drain: { phase: "idle" } };
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
    case "requestDrain":
      return state.phase === "disposed" ? unchanged : { state: { ...state, drainRequested: true }, effects: [] };
    case "takeDrainRequest":
      return { state: { ...state, drainRequested: false }, effects: state.drainRequested && state.phase === "open" ? [{ type: "resume" }] : [] };
    case "schedule": {
      if (state.phase === "disposed") return unchanged;
      const next = event.dispatching ? { ...state, drainRequested: true } : state;
      if (!event.eligible || next.drain.phase !== "idle") return { state: next, effects: [] };
      return { state: { ...next, drain: { phase: "arming", token: event.token } }, effects: [{ type: "arm", token: event.token }] };
    }
    case "armed":
      if (state.drain.phase !== "arming" || state.drain.token !== event.receipt.token) return unchanged;
      return { state: { ...state, drain: { phase: "scheduled", receipt: event.receipt } }, effects: [] };
    case "fired":
      if (state.drain.phase !== "scheduled" || state.drain.receipt.token !== event.token) return unchanged;
      return { state: { ...state, drain: { phase: "running", receipt: state.drain.receipt } }, effects: [{ type: "dispatch", receipt: state.drain.receipt }] };
    case "settled":
      if (!("receipt" in state.drain) || state.drain.receipt.token !== event.token) return unchanged;
      return { state: { ...state, drain: { phase: "idle" } }, effects: [] };
    case "dispose":
      return {
        state: { ...state, phase: "disposed", drainRequested: false,
          drain: state.drain.phase === "scheduled" ? { phase: "settling", receipt: state.drain.receipt } : state.drain },
        effects: state.drain.phase === "scheduled" ? [{ type: "cancel", receipt: state.drain.receipt }] : [],
      };
  }
}

export interface MessagingTurnStateContext {
  readonly logger: MessagingControllerLogger;
  readonly host: () => {
    readonly turnAdmission: Pick<MessagingTurnAdmission, "peekNextQueued" | "hasDispatchingEntry">;
    readonly startNextQueuedTurn: (binding: MessagingBindingRecord) => Promise<void>;
  };
}

// One value per owner/thread identity replaces the status map, pending drain
// set, timer map and drain-promise map. Handles belong to the receipt carried
// by the scheduled/running state; callbacks cannot retire another receipt.
export class MessagingTurns {
  private readonly states = new Map<string, MessagingTurnState>();
  private phase: "open" | "disposed" = "open";

  constructor(private readonly context: MessagingTurnStateContext) {}

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

  requestDrain(key: string): void {
    this.commit(key, { type: "requestDrain" });
  }

  takeDrainRequest(key: string): boolean {
    return this.commit(key, { type: "takeDrainRequest" }).effects.some(effect => effect.type === "resume");
  }

  schedule(binding: MessagingBindingRecord): void {
    const key = threadKeyForBinding(binding);
    const admission = this.context.host().turnAdmission;
    const entry = admission.peekNextQueued(key);
    const { effects } = this.commit(key, { type: "schedule", token: Symbol(), eligible: Boolean(entry && !entry.manualRetryRequired),
      dispatching: !entry && admission.hasDispatchingEntry(key) });
    for (const effect of effects) {
      if (effect.type !== "arm") continue;
      const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
      void settled.finally(() => this.commit(key, { type: "settled", token: effect.token }));
      const timer = setTimeout(() => {
        for (const next of this.commit(key, { type: "fired", token: effect.token }).effects) {
          if (next.type !== "dispatch") continue;
          void this.context.host().startNextQueuedTurn(binding).catch(error => {
            this.context.logger.warn?.("messaging queued turn dispatch failed", {
              threadId: binding.threadId,
              error: error instanceof Error ? error.message : String(error),
            });
          }).finally(next.receipt.settle);
        }
      }, 0);
      this.commit(key, { type: "armed", receipt: { token: effect.token, settled, settle, timer } });
    }
  }

  dispose(): void {
    this.phase = "disposed";
    for (const key of this.states.keys()) {
      for (const effect of this.commit(key, { type: "dispose" }).effects) {
        if (effect.type !== "cancel") continue;
        clearTimeout(effect.receipt.timer);
        effect.receipt.settle();
      }
    }
  }

  async whenDrainsSettled(): Promise<void> {
    const drains = [...this.states.values()].flatMap(state => "receipt" in state.drain ? [state.drain.receipt.settled] : []);
    await Promise.allSettled(drains);
  }

  private commit(key: string, event: MessagingTurnEvent): ReturnType<typeof transitionMessagingTurn> {
    const previous = this.states.get(key) ?? (this.phase === "disposed"
      ? { phase: "disposed" as const, drainRequested: false, drain: { phase: "idle" as const } } : undefined);
    const result = transitionMessagingTurn(previous, event);
    this.states.set(key, result.state);
    return result;
  }
}
