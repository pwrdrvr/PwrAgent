import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AUTO_COMPACTION_MAX_REFUSALS,
  INITIAL_AUTO_COMPACTION_STATE,
  stepAutoCompaction,
  type AutoCompactionCommand,
  type AutoCompactionContext,
  type AutoCompactionInput,
  type AutoCompactionState,
} from "../auto-compaction-lifecycle";

const TRIGGER = 1_000;
const REARM = 900;

/**
 * Operations as the owner observes them. The world model below turns each
 * into the inputs the monitor would feed, so generated runs never contain a
 * state the system cannot produce (a turn ending that never started, an
 * answer to a request nobody made). Late and duplicate signals are possible
 * and are generated on purpose: a provider compaction at any time, a settle
 * timeout at any time, and a turn ending while a steer is unanswered.
 */
type Op =
  | { kind: "fill"; used: number }
  | { kind: "start-turn" }
  | { kind: "end-turn"; outcome: "completed" | "failed" | "cancelled" }
  | { kind: "provider-compaction" }
  | { kind: "accept" }
  | { kind: "refuse" }
  | { kind: "defer" }
  | { kind: "settle-timeout" }
  | { kind: "set-steer"; canSteer: boolean }
  | { kind: "set-start"; canStart: AutoCompactionContext["canStart"] }
  | { kind: "set-during-turn"; duringTurn: "steer" | "wait" }
  | { kind: "set-deferred-fill"; reportsFillOnNextTurn: boolean };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 0, max: 2_000 }).map((used) => ({ kind: "fill" as const, used })) },
  { weight: 3, arbitrary: fc.constant({ kind: "start-turn" as const }) },
  {
    weight: 3,
    arbitrary: fc.constantFrom("completed", "completed", "completed", "failed", "cancelled").map((outcome) => ({
      kind: "end-turn" as const,
      outcome: outcome as "completed" | "failed" | "cancelled",
    })),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "provider-compaction" as const }) },
  { weight: 3, arbitrary: fc.constant({ kind: "accept" as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: "refuse" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "defer" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "settle-timeout" as const }) },
  { weight: 1, arbitrary: fc.boolean().map((canSteer) => ({ kind: "set-steer" as const, canSteer })) },
  {
    weight: 1,
    arbitrary: fc.constantFrom("yes", "blocked", "unsupported").map((canStart) => ({
      kind: "set-start" as const,
      canStart: canStart as AutoCompactionContext["canStart"],
    })),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom("steer", "wait").map((duringTurn) => ({
      kind: "set-during-turn" as const,
      duringTurn: duringTurn as "steer" | "wait",
    })),
  },
  {
    weight: 1,
    arbitrary: fc.boolean().map((reportsFillOnNextTurn) => ({
      kind: "set-deferred-fill" as const,
      reportsFillOnNextTurn,
    })),
  },
);

type World = {
  turnRunning: boolean;
  turnId?: string;
  nextTurn: number;
  canSteer: boolean;
  canStart: AutoCompactionContext["canStart"];
  duringTurn: "steer" | "wait";
  reportsFillOnNextTurn: boolean;
  /** The request the reducer made and the world has not answered. */
  open?: AutoCompactionCommand & { kind: "steer-compact" | "start-compact" };
};

type Trace = {
  input: AutoCompactionInput;
  before: AutoCompactionState;
  after: AutoCompactionState;
  command?: AutoCompactionCommand;
  world: World;
};

function context(world: World): AutoCompactionContext {
  return {
    turnRunning: world.turnRunning,
    ...(world.turnId ? { turnId: world.turnId } : {}),
    canSteer: world.canSteer,
    canStart: world.canStart,
    ...(world.reportsFillOnNextTurn ? { reportsFillOnNextTurn: true } : {}),
  };
}

/** Replays operations, returning every reducer step with the world it saw. */
function run(ops: readonly Op[]): Trace[] {
  const world: World = {
    turnRunning: false,
    nextTurn: 1,
    canSteer: true,
    canStart: "yes",
    duringTurn: "steer",
    reportsFillOnNextTurn: false,
  };
  let state = INITIAL_AUTO_COMPACTION_STATE;
  const traces: Trace[] = [];
  const feed = (input: AutoCompactionInput) => {
    const before = state;
    const snapshot = { ...world };
    const step = stepAutoCompaction(state, input);
    state = step.state;
    traces.push({ input, before, after: state, command: step.command, world: snapshot });
    const command = step.command;
    if (command?.kind === "steer-compact" || command?.kind === "start-compact") {
      world.open = command;
    }
  };
  const startTurn = () => {
    world.turnRunning = true;
    world.turnId = `turn-${world.nextTurn++}`;
    feed({ kind: "turn-started", turnId: world.turnId });
  };
  for (const op of ops) {
    switch (op.kind) {
      case "fill":
        feed({
          kind: "fill",
          usedTokens: op.used,
          threshold: { triggerTokens: TRIGGER, rearmTokens: REARM, duringTurn: world.duringTurn },
          context: context(world),
        });
        break;
      case "start-turn":
        if (!world.turnRunning && !world.open) startTurn();
        break;
      case "end-turn":
        if (world.turnRunning) {
          const turnId = world.turnId;
          world.turnRunning = false;
          world.turnId = undefined;
          feed({
            kind: "turn-ended",
            ...(turnId ? { turnId } : {}),
            outcome: op.outcome,
            context: context(world),
          });
        }
        break;
      case "provider-compaction":
        feed({ kind: "compaction-observed", context: context(world) });
        break;
      case "accept": {
        const open = world.open;
        if (!open) break;
        world.open = undefined;
        if (open.kind === "start-compact") {
          // The provider starts the compaction turn, then answers with its id.
          if (world.turnRunning) {
            // A queued message won the race: the start is refused instead.
            feed({ kind: "dispatch-refused", context: context(world) });
            break;
          }
          startTurn();
          feed({ kind: "dispatch-accepted", turnId: world.turnId, context: context(world) });
        } else if (world.turnRunning && world.turnId === open.turnId) {
          feed({ kind: "dispatch-accepted", context: context(world) });
        } else {
          // The turn ended before the steer landed.
          feed({ kind: "dispatch-refused", context: context(world) });
        }
        break;
      }
      case "refuse":
        if (!world.open) break;
        world.open = undefined;
        feed({ kind: "dispatch-refused", context: context(world) });
        break;
      case "defer":
        if (!world.open) break;
        world.open = undefined;
        feed({ kind: "dispatch-deferred" });
        break;
      case "settle-timeout":
        feed({ kind: "settle-timeout", context: context(world) });
        break;
      case "set-steer":
        world.canSteer = op.canSteer;
        break;
      case "set-start":
        world.canStart = op.canStart;
        break;
      case "set-during-turn":
        world.duringTurn = op.duringTurn;
        break;
      case "set-deferred-fill":
        world.reportsFillOnNextTurn = op.reportsFillOnNextTurn;
        break;
    }
  }
  return traces;
}

const opsArb = fc.array(opArb, { minLength: 10, maxLength: 80, size: "max" });

function isDispatch(command: AutoCompactionCommand | undefined): boolean {
  return command?.kind === "steer-compact" || command?.kind === "start-compact";
}

describe("auto-compaction lifecycle", () => {
  it("starts a compaction turn only on an idle thread and steers only into the running turn", () => {
    fc.assert(fc.property(opsArb, (ops) => {
      for (const trace of run(ops)) {
        if (trace.command?.kind === "start-compact") {
          expect(trace.world.turnRunning).toBe(false);
          expect(trace.world.canStart).toBe("yes");
        }
        if (trace.command?.kind === "steer-compact") {
          expect(trace.world.turnRunning).toBe(true);
          expect(trace.command.turnId).toBe(trace.world.turnId);
          expect(trace.world.canSteer).toBe(true);
          expect(trace.world.duringTurn).toBe("steer");
        }
      }
    }));
  });

  it("never opens a second request while one is unanswered", () => {
    fc.assert(fc.property(opsArb, (ops) => {
      let open = false;
      for (const trace of run(ops)) {
        if (
          trace.input.kind === "dispatch-accepted"
          || trace.input.kind === "dispatch-refused"
          || trace.input.kind === "dispatch-deferred"
        ) open = false;
        if (trace.input.kind === "reset") open = false;
        if (isDispatch(trace.command)) {
          expect(open).toBe(false);
          open = true;
        }
      }
    }));
  });

  it("compacts only at or above the trigger", () => {
    fc.assert(fc.property(opsArb, (ops) => {
      for (const trace of run(ops)) {
        if (isDispatch(trace.command)) {
          expect(trace.after.lastFill ?? 0).toBeGreaterThanOrEqual(TRIGGER);
        }
      }
    }));
  });

  it("asks each episode for at most one accepted steer, one accepted compaction turn and one continuation", () => {
    fc.assert(fc.property(opsArb, (ops) => {
      let steers = 0;
      let starts = 0;
      let continuations = 0;
      let refusals = 0;
      for (const trace of run(ops)) {
        // An episode starts when the thread leaves `armed`.
        if (trace.before.phase === "armed") {
          steers = 0;
          starts = 0;
          continuations = 0;
          refusals = 0;
        }
        if (trace.input.kind === "dispatch-accepted") {
          if (trace.before.via === "steer") steers += 1;
          if (trace.before.via === "start") starts += 1;
        }
        if (trace.input.kind === "dispatch-refused" && isInFlightRequest(trace.before)) refusals += 1;
        if (trace.command?.kind === "start-continuation") continuations += 1;
        expect(steers).toBeLessThanOrEqual(1);
        expect(starts).toBeLessThanOrEqual(1);
        expect(continuations).toBeLessThanOrEqual(1);
        expect(refusals).toBeLessThanOrEqual(AUTO_COMPACTION_MAX_REFUSALS);
      }
    }));
  });

  it("sends a continuation only after a steered compaction worked", () => {
    fc.assert(fc.property(opsArb, (ops) => {
      let steeredAndAccepted = false;
      for (const trace of run(ops)) {
        if (trace.before.via === "steer" && (trace.input.kind === "dispatch-accepted" || trace.input.kind === "compaction-observed")) {
          steeredAndAccepted = true;
        }
        if (trace.command?.kind === "start-continuation") {
          expect(steeredAndAccepted).toBe(true);
          expect(trace.world.turnRunning).toBe(false);
          steeredAndAccepted = false;
        }
      }
    }));
  });

  it("leaves held only when the fill falls below the re-arm mark or the provider compacts", () => {
    fc.assert(fc.property(opsArb, (ops) => {
      for (const trace of run(ops)) {
        if (trace.before.phase !== "held" || trace.after.phase === "held") continue;
        if (trace.input.kind === "fill") {
          expect(trace.input.usedTokens).toBeLessThan(REARM);
        } else {
          expect(["compaction-observed", "reset"]).toContain(trace.input.kind);
        }
      }
    }));
  });

  it("dispatches as soon as an armed, idle, startable thread reports a fill at the trigger", () => {
    fc.assert(fc.property(opsArb, fc.integer({ min: TRIGGER, max: 2_000 }), (ops, used) => {
      const traces = run(ops);
      const last = traces.at(-1)?.after ?? INITIAL_AUTO_COMPACTION_STATE;
      fc.pre(last.phase === "armed");
      const step = stepAutoCompaction(last, {
        kind: "fill",
        usedTokens: used,
        threshold: { triggerTokens: TRIGGER, rearmTokens: REARM, duringTurn: "steer" },
        context: { turnRunning: false, canSteer: true, canStart: "yes" },
      });
      expect(step.command?.kind).toBe("start-compact");
    }));
  });

  it("never sends a continuation when a steered turn was cancelled or failed", () => {
    fc.assert(fc.property(opsArb, (ops) => {
      let abortedSteer = false;
      for (const trace of run(ops)) {
        if (trace.before.phase === "armed") {
          abortedSteer = false;
        }
        if (
          trace.before.via === "steer"
          && trace.input.kind === "turn-ended"
          && trace.input.outcome !== "completed"
          && (trace.input.turnId === undefined || trace.before.turnId === undefined || trace.input.turnId === trace.before.turnId)
        ) {
          abortedSteer = true;
        }
        if (abortedSteer) {
          expect(trace.command?.kind).not.toBe("start-continuation");
        }
      }
    }));
  });

  it("clears compacting immediately without retry or false no-shrink hold when a compaction turn is cancelled or fails", () => {
    fc.assert(fc.property(opsArb, (ops) => {
      for (const trace of run(ops)) {
        if (
          trace.before.phase === "compacting"
          && trace.input.kind === "turn-ended"
          && trace.input.outcome !== "completed"
          && (trace.input.turnId === undefined || trace.before.turnId === undefined || trace.input.turnId === trace.before.turnId)
        ) {
          expect(trace.after.phase).toBe("armed");
          expect(trace.command).toBeUndefined();
        }
      }
    }));
  });

  it("continues immediately on a deferred-fill provider when a steered compaction completes cleanly", () => {
    fc.assert(fc.property(opsArb, (ops) => {
      for (const trace of run(ops)) {
        if (
          trace.before.phase === "compacting"
          && trace.before.via === "steer"
          && trace.input.kind === "turn-ended"
          && trace.input.outcome === "completed"
          && trace.input.context.reportsFillOnNextTurn === true
          && (trace.input.turnId === undefined || trace.before.turnId === undefined || trace.input.turnId === trace.before.turnId)
        ) {
          expect(trace.command).toEqual({ kind: "start-continuation" });
          expect(trace.after.phase).toBe("verifying");
        }
      }
    }));
  });

  it("never holds a deferred-fill compaction on settle timeout before the next turn reports", () => {
    fc.assert(fc.property(opsArb, (ops) => {
      for (const trace of run(ops)) {
        if (trace.before.phase === "verifying" && trace.input.kind === "settle-timeout") {
          expect(trace.after.phase).toBe("verifying");
          expect(trace.command).toBeUndefined();
        }
      }
    }));
  });
});

function isInFlightRequest(state: AutoCompactionState): boolean {
  return state.phase === "steering" || state.phase === "starting";
}

describe("auto-compaction lifecycle examples", () => {
  const idle: AutoCompactionContext = { turnRunning: false, canSteer: true, canStart: "yes" };
  const running: AutoCompactionContext = { turnRunning: true, turnId: "t1", canSteer: true, canStart: "yes" };
  const threshold = { triggerTokens: 409_600, rearmTokens: 368_640, duringTurn: "steer" as const };

  it("steers /compact into a running Neon turn at 80% of 512k, then continues after it ends", () => {
    let step = stepAutoCompaction(INITIAL_AUTO_COMPACTION_STATE, {
      kind: "fill", usedTokens: 412_000, threshold, context: running,
    });
    expect(step.command).toEqual({ kind: "steer-compact", turnId: "t1", usedTokens: 412_000, triggerTokens: 409_600 });
    step = stepAutoCompaction(step.state, { kind: "dispatch-accepted", context: running });
    expect(step.state.phase).toBe("compacting");
    step = stepAutoCompaction(step.state, { kind: "fill", usedTokens: 61_000, threshold, context: running });
    expect(step.state.phase).toBe("resume");
    step = stepAutoCompaction(step.state, { kind: "turn-ended", turnId: "t1", context: idle });
    expect(step.command).toEqual({ kind: "start-continuation" });
    expect(step.state.phase).toBe("armed");
  });

  it("retries a steered /compact that did nothing once as its own turn, then holds", () => {
    let step = stepAutoCompaction(INITIAL_AUTO_COMPACTION_STATE, {
      kind: "fill", usedTokens: 412_000, threshold, context: running,
    });
    step = stepAutoCompaction(step.state, { kind: "dispatch-accepted", context: running });
    step = stepAutoCompaction(step.state, { kind: "turn-ended", turnId: "t1", context: idle });
    step = stepAutoCompaction(step.state, { kind: "settle-timeout", context: idle });
    expect(step.command?.kind).toBe("start-compact");
    step = stepAutoCompaction(step.state, { kind: "turn-started", turnId: "t2" });
    step = stepAutoCompaction(step.state, { kind: "dispatch-accepted", turnId: "t2", context: { ...running, turnId: "t2" } });
    step = stepAutoCompaction(step.state, { kind: "turn-ended", turnId: "t2", context: idle });
    step = stepAutoCompaction(step.state, { kind: "fill", usedTokens: 412_500, threshold, context: idle });
    expect(step.state).toMatchObject({ phase: "held", heldReason: "no-shrink" });
    expect(step.command).toBeUndefined();
    step = stepAutoCompaction(step.state, { kind: "fill", usedTokens: 410_000, threshold, context: idle });
    expect(step.command).toBeUndefined();
    step = stepAutoCompaction(step.state, { kind: "fill", usedTokens: 300_000, threshold, context: idle });
    expect(step.state.phase).toBe("armed");
  });

  it("waits for the turn to end on a provider that cannot steer", () => {
    const noSteer = { ...running, canSteer: false };
    let step = stepAutoCompaction(INITIAL_AUTO_COMPACTION_STATE, {
      kind: "fill", usedTokens: 500_000, threshold, context: noSteer,
    });
    expect(step.state.phase).toBe("due");
    expect(step.command).toBeUndefined();
    step = stepAutoCompaction(step.state, { kind: "turn-ended", turnId: "t1", context: idle });
    expect(step.command?.kind).toBe("start-compact");
  });

  // Shrunk counterexamples from the model above, kept as named regressions.
  it("does not open a second request when the provider compacts before answering the first", () => {
    let step = stepAutoCompaction(INITIAL_AUTO_COMPACTION_STATE, {
      kind: "fill", usedTokens: 412_000, threshold, context: idle,
    });
    expect(step.command?.kind).toBe("start-compact");
    step = stepAutoCompaction(step.state, { kind: "compaction-observed", context: idle });
    step = stepAutoCompaction(step.state, { kind: "fill", usedTokens: 412_000, threshold, context: idle });
    expect(step.command).toBeUndefined();
    step = stepAutoCompaction(step.state, { kind: "dispatch-accepted", turnId: "t2", context: idle });
    expect(step.state.phase).toBe("armed");
  });

  it("does not compact again after a refusal once the fill has dropped", () => {
    let step = stepAutoCompaction(INITIAL_AUTO_COMPACTION_STATE, {
      kind: "fill", usedTokens: 412_000, threshold, context: idle,
    });
    step = stepAutoCompaction(step.state, { kind: "fill", usedTokens: 20_000, threshold, context: idle });
    step = stepAutoCompaction(step.state, { kind: "dispatch-refused", context: idle });
    expect(step.command).toBeUndefined();
    expect(step.state.phase).toBe("armed");
  });

  it("sends no continuation when a steered compaction is confirmed during the next turn", () => {
    let step = stepAutoCompaction(INITIAL_AUTO_COMPACTION_STATE, {
      kind: "fill", usedTokens: 412_000, threshold, context: running,
    });
    step = stepAutoCompaction(step.state, { kind: "dispatch-accepted", context: running });
    step = stepAutoCompaction(step.state, { kind: "turn-ended", turnId: "t1", context: idle });
    step = stepAutoCompaction(step.state, { kind: "turn-started", turnId: "t2" });
    step = stepAutoCompaction(step.state, {
      kind: "compaction-observed", context: { ...running, turnId: "t2" },
    });
    expect(step.command).toBeUndefined();
    expect(step.state.phase).toBe("armed");
  });

  it("holds a thread whose provider has no way to compact", () => {
    const step = stepAutoCompaction(INITIAL_AUTO_COMPACTION_STATE, {
      kind: "fill", usedTokens: 500_000, threshold, context: { ...idle, canStart: "unsupported" },
    });
    expect(step.state).toMatchObject({ phase: "held", heldReason: "unsupported" });
  });

  // Counterexamples from live Antigravity (agy 1.5.16) ACP protocol captures:
  // /compact emits the summarization call's higher usage_update at turn end and
  // reports the lowered context fill only on the next turn's first model call.
  it("continues immediately on Antigravity after steered /compact ends with a higher summarization fill, then re-arms on the continuation's fill", () => {
    const agyRunning: AutoCompactionContext = { ...running, reportsFillOnNextTurn: true };
    const agyIdle: AutoCompactionContext = { ...idle, reportsFillOnNextTurn: true };
    let step = stepAutoCompaction(INITIAL_AUTO_COMPACTION_STATE, {
      kind: "fill", usedTokens: 412_000, threshold, context: agyRunning,
    });
    expect(step.command).toEqual({ kind: "steer-compact", turnId: "t1", usedTokens: 412_000, triggerTokens: 409_600 });
    step = stepAutoCompaction(step.state, { kind: "dispatch-accepted", context: agyRunning });
    // Summarization call itself reports higher usage than pre-compaction context.
    step = stepAutoCompaction(step.state, { kind: "fill", usedTokens: 425_000, threshold, context: agyRunning });
    expect(step.state.phase).toBe("compacting");
    // Steered turn completes cleanly: continue immediately without retrying idle /compact.
    step = stepAutoCompaction(step.state, { kind: "turn-ended", turnId: "t1", outcome: "completed", context: agyIdle });
    expect(step.command).toEqual({ kind: "start-continuation" });
    expect(step.state.phase).toBe("verifying");
    // Continuation turn starts and reports the actual compacted context fill.
    step = stepAutoCompaction(step.state, { kind: "turn-started", turnId: "t2" });
    step = stepAutoCompaction(step.state, {
      kind: "fill", usedTokens: 21_436, threshold, context: { ...agyRunning, turnId: "t2" },
    });
    expect(step.command).toBeUndefined();
    expect(step.state.phase).toBe("armed");
  });

  it("holds instead of looping when Antigravity's continuation turn still reports a fill above trigger", () => {
    const agyRunning: AutoCompactionContext = { ...running, reportsFillOnNextTurn: true };
    const agyIdle: AutoCompactionContext = { ...idle, reportsFillOnNextTurn: true };
    let step = stepAutoCompaction(INITIAL_AUTO_COMPACTION_STATE, {
      kind: "fill", usedTokens: 412_000, threshold, context: agyRunning,
    });
    step = stepAutoCompaction(step.state, { kind: "dispatch-accepted", context: agyRunning });
    step = stepAutoCompaction(step.state, { kind: "fill", usedTokens: 425_000, threshold, context: agyRunning });
    step = stepAutoCompaction(step.state, { kind: "turn-ended", turnId: "t1", outcome: "completed", context: agyIdle });
    expect(step.command).toEqual({ kind: "start-continuation" });
    step = stepAutoCompaction(step.state, { kind: "turn-started", turnId: "t2" });
    step = stepAutoCompaction(step.state, {
      kind: "fill", usedTokens: 420_000, threshold, context: { ...agyRunning, turnId: "t2" },
    });
    expect(step.command).toBeUndefined();
    expect(step.state).toMatchObject({ phase: "held", heldReason: "no-shrink" });
  });

  it("keeps an idle Antigravity /compact verifying across settle timeouts until the next turn reports", () => {
    const agyRunning: AutoCompactionContext = { ...running, turnId: "t2", reportsFillOnNextTurn: true };
    const agyIdle: AutoCompactionContext = { ...idle, reportsFillOnNextTurn: true };
    let step = stepAutoCompaction(INITIAL_AUTO_COMPACTION_STATE, {
      kind: "fill", usedTokens: 412_000, threshold, context: agyIdle,
    });
    expect(step.command?.kind).toBe("start-compact");
    step = stepAutoCompaction(step.state, { kind: "turn-started", turnId: "t2" });
    step = stepAutoCompaction(step.state, { kind: "dispatch-accepted", turnId: "t2", context: agyRunning });
    step = stepAutoCompaction(step.state, { kind: "fill", usedTokens: 425_000, threshold, context: agyRunning });
    step = stepAutoCompaction(step.state, { kind: "turn-ended", turnId: "t2", outcome: "completed", context: agyIdle });
    expect(step.command).toBeUndefined();
    expect(step.state.phase).toBe("verifying");
    // Idle wait beyond 15s must not falsely hold as no-shrink.
    step = stepAutoCompaction(step.state, { kind: "settle-timeout", context: agyIdle });
    expect(step.state.phase).toBe("verifying");
    expect(step.command).toBeUndefined();
    // Next user turn drops below trigger -> re-armed.
    step = stepAutoCompaction(step.state, { kind: "turn-started", turnId: "t3" });
    step = stepAutoCompaction(step.state, {
      kind: "fill", usedTokens: 20_551, threshold, context: { ...agyRunning, turnId: "t3" },
    });
    expect(step.state.phase).toBe("armed");
  });

  it("does not send a continuation, retry idle /compact, or hold when a steered Antigravity /compact turn is cancelled or fails", () => {
    const agyRunning: AutoCompactionContext = { ...running, reportsFillOnNextTurn: true };
    const agyIdle: AutoCompactionContext = { ...idle, reportsFillOnNextTurn: true };
    for (const outcome of ["cancelled", "failed"] as const) {
      let step = stepAutoCompaction(INITIAL_AUTO_COMPACTION_STATE, {
        kind: "fill", usedTokens: 412_000, threshold, context: agyRunning,
      });
      step = stepAutoCompaction(step.state, { kind: "dispatch-accepted", context: agyRunning });
      step = stepAutoCompaction(step.state, { kind: "turn-ended", turnId: "t1", outcome, context: agyIdle });
      expect(step.command).toBeUndefined();
      expect(step.state.phase).toBe("armed");
      // Neither a settle timeout nor a later compaction signal sends a continuation or idle retry.
      step = stepAutoCompaction(step.state, { kind: "settle-timeout", context: agyIdle });
      expect(step.command).toBeUndefined();
      expect(step.state.phase).toBe("armed");
      step = stepAutoCompaction(step.state, { kind: "compaction-observed", context: agyIdle });
      expect(step.command).toBeUndefined();
      expect(step.state.phase).toBe("armed");
    }
  });

  it("suppresses start-continuation in completed() when evidence arrived before dispatch-accepted on a cancelled steered turn", () => {
    let step = stepAutoCompaction(INITIAL_AUTO_COMPACTION_STATE, {
      kind: "fill", usedTokens: 412_000, threshold, context: running,
    });
    step = stepAutoCompaction(step.state, { kind: "compaction-observed", context: running });
    step = stepAutoCompaction(step.state, { kind: "turn-ended", turnId: "t1", outcome: "cancelled", context: idle });
    step = stepAutoCompaction(step.state, { kind: "dispatch-accepted", context: idle });
    expect(step.command).toBeUndefined();
    expect(step.state.phase).toBe("armed");
  });

  it("does not inherit turnEnded from a different turn when dispatch-accepted arrives for an idle compaction", () => {
    const agyIdle: AutoCompactionContext = { ...idle, reportsFillOnNextTurn: true };
    const agyRunningT3: AutoCompactionContext = { ...running, turnId: "t3", reportsFillOnNextTurn: true };
    let step = stepAutoCompaction(INITIAL_AUTO_COMPACTION_STATE, {
      kind: "fill", usedTokens: 412_000, threshold, context: agyIdle,
    });
    expect(step.command?.kind).toBe("start-compact");
    // Unrelated turn t2 runs and completes while start-compact is still awaiting its turnId.
    step = stepAutoCompaction(step.state, { kind: "turn-started", turnId: "t2" });
    step = stepAutoCompaction(step.state, { kind: "turn-ended", turnId: "t2", outcome: "completed", context: agyIdle });
    // Now start-compact resolves with its own turnId t3 while t3 is running.
    step = stepAutoCompaction(step.state, { kind: "dispatch-accepted", turnId: "t3", context: agyRunningT3 });
    expect(step.state.phase).toBe("compacting");
    expect(step.state.turnId).toBe("t3");
    expect(step.state.turnEnded).toBe(false);
    // t3's own summarization fill must not falsely transition to held("no-shrink").
    step = stepAutoCompaction(step.state, { kind: "fill", usedTokens: 425_000, threshold, context: agyRunningT3 });
    expect(step.state.phase).toBe("compacting");
  });
});
