import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  AppServerThreadStatus,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  codexThreadHasActiveTurn,
  activeCodexOperation,
  idleCodexThreadActivity,
  transition,
  type CodexStartReservation,
  type CodexStatusObservation,
  type CodexThreadActivity,
  type CodexThreadActivityEvent,
} from "../app-server/codex-thread-activity";
import type { CodexRetryableCompaction } from "../app-server/backend-registry-types";

/**
 * Compatibility oracle: the old collection projection, with the terminal
 * ownership rule from #3593. The known bad late-mode write is not an oracle.
 * No production reducer or phase classification is used to compute expected
 * observations. Requests and protocol deliveries below form valid sessions.
 */
class LegacyProjection {
  reservation?: CodexStartReservation;
  compact = false;
  registered = new Map<string, number>();
  modes = new Map<string, ThreadExecutionMode>();
  collaboration = new Map<string, "default" | "plan">();
  reviews = new Set<string>();
  interrupts = new Map<string, string>();
  providerActive = false;
  observation?: CodexStatusObservation;
  watermark = 0;

  busy(ignoreReservation: boolean): boolean {
    return this.compact || (!ignoreReservation && Boolean(this.reservation)) || this.providerActive || this.modes.size > 0;
  }
}

function projection(state: CodexThreadActivity) {
  return {
    busy: codexThreadHasActiveTurn(state), ignoringReservation: codexThreadHasActiveTurn(state, true),
    registered: state.turns.filter(turn => turn.phase === "announced")
      .sort((left, right) => left.registration! - right.registration!).map(turn => [turn.turnId, turn.registration]),
    modes: state.turns.filter(turn => turn.execution).sort((left, right) => left.execution!.order - right.execution!.order)
      .map(turn => [turn.turnId, turn.execution!.mode]),
    collaboration: state.turns.filter(turn => turn.collaboration !== undefined).map(turn => [turn.turnId, turn.collaboration]).sort(),
    reviews: state.turns.filter(turn => turn.review?.phase === "active").map(turn => turn.turnId).sort(),
    interrupts: state.turns.filter(turn => turn.review?.interruptTurnId).map(turn => [turn.turnId, turn.review!.interruptTurnId]).sort(),
    reserved: Boolean(state.reservation), compact: activeCodexOperation(state)?.kind === "compact",
    observation: state.observation, watermark: state.statusWatermark, providerActive: state.providerStatus === "active",
  };
}

function expectProjection(model: LegacyProjection, state: CodexThreadActivity) {
  expect(projection(state)).toEqual({
    busy: model.busy(false), ignoringReservation: model.busy(true),
    registered: [...model.registered], modes: [...model.modes],
    collaboration: [...model.collaboration].sort(), reviews: [...model.reviews].sort(), interrupts: [...model.interrupts].sort(),
    reserved: Boolean(model.reservation), compact: model.compact,
    observation: model.observation, watermark: model.watermark, providerActive: model.providerActive,
  });
}

type Session = {
  kind: CodexStartReservation["kind"];
  mode: ThreadExecutionMode;
  collaboration: "default" | "plan";
  delayedMode: boolean;
  acceptedWithoutNotification: boolean;
  earlyTerminal: boolean;
  repeatTerminal: boolean;
  staleRead: boolean;
};

function exerciseSession(model: LegacyProjection, real: { state: CodexThreadActivity; order: number }, session: Session) {
  const send = (event: CodexThreadActivityEvent) => {
    real.state = transition(real.state, event);
    expectProjection(model, real.state);
  };
  const observe = (status: AppServerThreadStatus, sequence: number) => {
    const observation = { status, sequence };
    if (sequence >= model.watermark) {
      model.watermark = sequence;
      model.observation = observation;
      model.providerActive = status === "active";
    }
    send({ type: "observe", observation, order: ++real.order });
  };
  const retire = (turnId: string) => {
    if (model.registered.delete(turnId)) model.collaboration.delete(turnId);
    send({ type: "unregistered", turnId });
    model.modes.delete(turnId);
    send({ type: "executionForgotten", turnId });
    model.collaboration.delete(turnId);
    send({ type: "collaboration", turnId });
    model.reviews.delete(turnId);
    send({ type: "review", turnId, active: false, order: ++real.order });
    model.interrupts.delete(turnId);
    send({ type: "reviewInterrupt", turnId, order: ++real.order });
  };
  const owner = {};
  model.reservation = { owner, kind: session.kind };
  send({ type: "reserve", reservation: model.reservation });
  // A borrowed voice reservation must not replace its owner or release it.
  send({ type: "reserve", reservation: { owner: {}, kind: "voice" } });
  send({ type: "release", owner: {} });
  const turnId = `turn-${++real.order}`;
  let compaction: CodexRetryableCompaction | undefined;
  if (session.kind === "compact") {
    model.compact = true;
    compaction = { kind: "compact", params: { backend: "codex", threadId: "thread" }, turnId };
    send({ type: "retry", operation: compaction });
  }
  const producesTurn = session.kind === "turn" || session.kind === "worker" || session.kind === "review" || session.kind === "compact";
  const receipts: Array<{ turnId: string; registration: number }> = [];
  if (producesTurn) {
    if (session.kind === "turn") {
      model.collaboration.set(turnId, session.collaboration);
      send({ type: "collaboration", turnId, mode: session.collaboration });
    }
    observe("active", ++real.order);
    if (!session.acceptedWithoutNotification) {
      const registration = ++real.order;
      model.registered.set(turnId, registration);
      send({ type: "announced", turnId, order: registration });
      receipts.push({ turnId, registration });
      // Repeated delivery retains the existing receipt and insertion order.
      send({ type: "announced", turnId, order: ++real.order });
    }
    if (!session.delayedMode || session.acceptedWithoutNotification) {
      model.modes.set(turnId, session.mode);
      send({ type: "executionAccepted", turnId, mode: session.mode, order: ++real.order });
    }
    if (session.kind === "review") {
      // Native review response and inner notification can name different IDs.
      const innerId = `${turnId}-inner`;
      const registration = ++real.order;
      model.registered.set(innerId, registration);
      send({ type: "announced", turnId: innerId, order: registration });
      receipts.push({ turnId: innerId, registration });
      model.modes.set(turnId, session.mode);
      send({ type: "executionAccepted", turnId, mode: session.mode, order: ++real.order });
      model.reviews.add(turnId);
      send({ type: "review", turnId, active: true, order: ++real.order });
      model.interrupts.set(turnId, innerId);
      send({ type: "reviewInterrupt", turnId, interruptTurnId: innerId, order: ++real.order });
    }
    const resolve = () => {
      for (const receipt of receipts) {
        if (model.registered.get(receipt.turnId) === receipt.registration && !model.modes.has(receipt.turnId)) {
          model.modes.set(receipt.turnId, session.mode);
        }
        send({ type: "executionResolved", ...receipt, mode: session.mode, order: ++real.order });
      }
    };
    if (!session.earlyTerminal) resolve();
    // The same ownership cleanup follows completion, failure, cancellation,
    // and the terminal failures synthesized after a process exit.
    for (const id of [turnId, ...(session.kind === "review" ? [`${turnId}-inner`] : [])]) retire(id);
    observe("idle", ++real.order);
    if (session.repeatTerminal) retire(turnId);
    resolve();
    if (session.staleRead) observe("active", real.order - 20);
    if (model.observation) {
      const acknowledged = model.observation;
      model.observation = undefined;
      send({ type: "acknowledgeObservation", observation: acknowledged });
      // A delayed read remains stale even after list acknowledges idle.
      observe("active", model.watermark - 1);
    }
  }
  if (model.compact) {
    model.compact = false;
    send({ type: "retry" });
  }
  model.reservation = undefined;
  send({ type: "release", owner });
  if (compaction) send({ type: "retryReleased", owner: compaction });
}

const sessions = fc.record({
  kind: fc.constantFrom<CodexStartReservation["kind"]>("turn", "review", "compact", "revert", "voice", "worker", "workspace", "agent"),
  mode: fc.constantFrom<ThreadExecutionMode>("default", "auto", "full-access"),
  collaboration: fc.constantFrom<"default" | "plan">("default", "plan"),
  delayedMode: fc.boolean(), acceptedWithoutNotification: fc.boolean(), earlyTerminal: fc.boolean(),
  repeatTerminal: fc.boolean(), staleRead: fc.boolean(),
});

describe("Codex thread activity model", () => {
  it("matches the intended legacy projection through valid ownership sessions", () => {
    fc.assert(fc.property(fc.array(sessions, { minLength: 1, maxLength: 24, size: "max" }), traces => {
      const model = new LegacyProjection();
      const real = { state: idleCodexThreadActivity(), order: 0 };
      for (const trace of traces) exerciseSession(model, real, trace);
      expect(codexThreadHasActiveTurn(real.state)).toBe(false);
      expect(real.state.operations).toEqual([]);
    }));
  });

  it("rejects the known terminal-before-mode counterexample", () => {
    const started = transition(idleCodexThreadActivity(), { type: "announced", turnId: "turn", order: 1 });
    const ended = transition(started, { type: "unregistered", turnId: "turn" });
    const late = transition(ended, { type: "executionResolved", turnId: "turn", registration: 1, mode: "default", order: 2 });
    expect(late.turns).toEqual([]);
    expect(codexThreadHasActiveTurn(late)).toBe(false);
  });

  it("correlates a delayed mode resolution with its registration receipt", () => {
    fc.assert(fc.property(fc.constantFrom<ThreadExecutionMode>("default", "auto", "full-access"), mode => {
      let state = transition(idleCodexThreadActivity(), { type: "announced", turnId: "turn", order: 1 });
      state = transition(state, { type: "unregistered", turnId: "turn" });
      state = transition(state, { type: "announced", turnId: "turn", order: 2 });
      state = transition(state, { type: "executionResolved", turnId: "turn", registration: 1, mode, order: 3 });
      expect(state.turns[0]?.execution).toBeUndefined();
      state = transition(state, { type: "executionResolved", turnId: "turn", registration: 2, mode, order: 4 });
      expect(state.turns[0]?.execution?.mode).toBe(mode);
    }));
  });
});
