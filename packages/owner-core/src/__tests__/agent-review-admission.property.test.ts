import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGENT_REVIEW_LIMIT,
  canClaimAgentReview,
  claimAgentReviewBudget,
  rearmAgentReviewBudget,
  type AgentReviewBudget,
  type AgentReviewRefusal,
} from "../agent-review-admission.js";

/**
 * Model-based test of the agent review admission guard across:
 * - Genuine operator turns (desktop / federation / messaging)
 * - Review-fix turns (automatic Auto-fix and Review card Auto-fix / Fix)
 * - Automated wakes (PR watch wakes, agent handoffs)
 * - Multiple processes sharing one persisted profile budget
 * - Process restarts (clearing per-process in-memory caches)
 * - Wall-clock ties (+0 ms) and backward NTP steps (-5 ms)
 * - Transient rearm persistence failures before a same-turn claim
 *
 * Rules (from docs/thread-reviews.md):
 * 1. Between genuine non-review-fix operator turns, at most AGENT_REVIEW_LIMIT
 *    agent-requested reviews are admitted — regardless of new commits/diffs,
 *    CI wakes, review-fix turns, restarts, shared-profile peers, or clock jitter.
 * 2. Review-fix turns never reset the allowance and never admit `start_review`.
 * 3. Duplicate review in the same turn is always refused (`duplicate_turn`).
 * 4. Duplicate immutable diff across turns since the last genuine operator turn
 *    is always refused (`duplicate_diff`).
 * 5. A genuine non-review-fix operator turn always rearms the allowance, even
 *    on a same-millisecond clock tie or backward wall-clock step.
 */

const THREAD = { backend: "codex" as const, threadId: "thread-1" };

type ProcessId = 0 | 1;
type TurnKind = "operator" | "review-fix-card" | "auto-fix" | "pr-watch" | "agent-handoff";

type Model = {
  nextTurnId: number;
  clock: number;
  currentTurnId: string;
  currentTurnKind: TurnKind;
  /** True when the current operator turn's eager rearm failed transiently and will retry on same-turn claim. */
  currentOperatorPendingRearm: boolean;
  admittedSinceOperator: number;
  claimedTurns: Set<string>;
  claimedDiffs: Set<string>;
};

type Real = {
  /** Shared persisted budget in profile state.db. */
  persisted: AgentReviewBudget | undefined;
  /** Per-process observed operator turn cache mirroring ManagedReviewService.observedOperatorTurns. */
  observedOperatorTurnId: [string | undefined, string | undefined];
};

function observeOperatorOnReal(
  real: Real,
  proc: ProcessId,
  turnId: string,
  observedAt: number,
  skipPersist = false,
): void {
  if (real.observedOperatorTurnId[proc] === turnId) return;
  if (skipPersist) return;
  const next = rearmAgentReviewBudget(real.persisted, { turnId, observedAt });
  if (next) real.persisted = next;
  real.observedOperatorTurnId[proc] = turnId;
}

function claimOnReal(
  real: Real,
  proc: ProcessId,
  turnId: string,
  turnKind: TurnKind,
  diff: string | undefined,
  observedAt: number,
): AgentReviewRefusal | undefined {
  if (turnKind === "review-fix-card" || turnKind === "auto-fix") {
    return "review_fix_turn";
  }
  const isOperatorTurn = turnKind === "operator";
  if (isOperatorTurn) {
    observeOperatorOnReal(real, proc, turnId, observedAt);
  }
  const precheck = canClaimAgentReview(real.persisted, { turnId, diff, isOperatorTurn });
  const claimed = claimAgentReviewBudget(real.persisted, {
    ...THREAD,
    turnId,
    diff,
    isOperatorTurn,
  });
  const refusal = typeof claimed === "string" ? claimed : undefined;
  // Precheck and atomic claim must agree on the same persisted state.
  expect(precheck).toBe(refusal);
  if (typeof claimed !== "string") {
    real.persisted = claimed;
  }
  return refusal;
}

class GenuineOperatorTurn implements fc.Command<Model, Real> {
  constructor(
    readonly proc: ProcessId,
    readonly clockDelta: number,
    readonly transientPersistFailure: boolean,
  ) {}
  check(): boolean { return true; }
  run(model: Model, real: Real): void {
    model.clock = Math.max(1, model.clock + this.clockDelta);
    const turnId = `op-${model.nextTurnId++}`;
    model.currentTurnId = turnId;
    model.currentTurnKind = "operator";
    // When eager rearm persistence fails transiently, the guard fails closed
    // (preserving prior persisted attempts) unless the same operator turn later
    // calls start_review and retries persistence atomically.
    if (this.transientPersistFailure) {
      model.currentOperatorPendingRearm = true;
    } else {
      model.currentOperatorPendingRearm = false;
      model.admittedSinceOperator = 0;
      model.claimedTurns.clear();
      model.claimedDiffs.clear();
    }
    observeOperatorOnReal(real, this.proc, turnId, model.clock, this.transientPersistFailure);
  }
  toString(): string {
    return `genuineOperatorTurn(proc=${this.proc}, dt=${this.clockDelta}, skipPersist=${this.transientPersistFailure})`;
  }
}

class NonResettingTurn implements fc.Command<Model, Real> {
  constructor(
    readonly kind: Exclude<TurnKind, "operator">,
    readonly clockDelta: number,
  ) {}
  check(): boolean { return true; }
  run(model: Model): void {
    model.clock = Math.max(1, model.clock + this.clockDelta);
    model.currentTurnId = `${this.kind}-${model.nextTurnId++}`;
    model.currentTurnKind = this.kind;
    model.currentOperatorPendingRearm = false;
  }
  toString(): string {
    return `turn(${this.kind}, dt=${this.clockDelta})`;
  }
}

class RestartProcess implements fc.Command<Model, Real> {
  constructor(readonly proc: ProcessId) {}
  check(): boolean { return true; }
  run(_model: Model, real: Real): void {
    real.observedOperatorTurnId[this.proc] = undefined;
  }
  toString(): string {
    return `restart(proc=${this.proc})`;
  }
}

class AgentStartReview implements fc.Command<Model, Real> {
  constructor(
    readonly proc: ProcessId,
    readonly diff: string | undefined,
  ) {}
  check(): boolean { return true; }
  run(model: Model, real: Real): void {
    const turnId = model.currentTurnId;
    if (model.currentTurnKind === "operator" && model.currentOperatorPendingRearm) {
      model.currentOperatorPendingRearm = false;
      model.admittedSinceOperator = 0;
      model.claimedTurns.clear();
      model.claimedDiffs.clear();
    }
    let expected: AgentReviewRefusal | undefined;
    if (model.currentTurnKind === "review-fix-card" || model.currentTurnKind === "auto-fix") {
      expected = "review_fix_turn";
    } else if (model.claimedTurns.has(turnId)) {
      expected = "duplicate_turn";
    } else if (this.diff !== undefined && model.claimedDiffs.has(this.diff)) {
      expected = "duplicate_diff";
    } else if (model.admittedSinceOperator >= AGENT_REVIEW_LIMIT) {
      expected = "limit";
    }

    const actual = claimOnReal(real, this.proc, turnId, model.currentTurnKind, this.diff, model.clock);
    expect(actual).toBe(expected);

    if (expected === undefined) {
      model.admittedSinceOperator += 1;
      model.claimedTurns.add(turnId);
      if (this.diff !== undefined) model.claimedDiffs.add(this.diff);
    }
    expect(model.admittedSinceOperator).toBeLessThanOrEqual(AGENT_REVIEW_LIMIT);
  }
  toString(): string {
    return `startReview(proc=${this.proc}, diff=${this.diff ?? "none"})`;
  }
}

const procArb = fc.constantFrom<ProcessId>(0, 1);
const clockDeltaArb = fc.constantFrom(-5, 0, 1, 100);
const diffArb = fc.constantFrom<string | undefined>(
  undefined,
  "diff-1",
  "diff-2",
  "diff-3",
  "diff-4",
  "diff-5",
);

const commandsArb = fc.commands(
  [
    fc.tuple(procArb, clockDeltaArb, fc.boolean())
      .map(([proc, dt, skip]) => new GenuineOperatorTurn(proc, dt, skip)),
    fc.tuple(
      fc.constantFrom<Exclude<TurnKind, "operator">>("review-fix-card", "auto-fix", "pr-watch", "agent-handoff"),
      clockDeltaArb,
    ).map(([kind, dt]) => new NonResettingTurn(kind, dt)),
    procArb.map((proc) => new RestartProcess(proc)),
    fc.tuple(procArb, diffArb).map(([proc, diff]) => new AgentStartReview(proc, diff)),
  ],
  { maxCommands: 40, size: "max" },
);

function setup(): { model: Model; real: Real } {
  return {
    model: {
      nextTurnId: 1,
      clock: 1000,
      currentTurnId: "initial-auto-0",
      currentTurnKind: "agent-handoff",
      currentOperatorPendingRearm: false,
      admittedSinceOperator: 0,
      claimedTurns: new Set(),
      claimedDiffs: new Set(),
    },
    real: {
      persisted: undefined,
      observedOperatorTurnId: [undefined, undefined],
    },
  };
}

describe("agent review admission model", () => {
  it("enforces review cap, dedup, review-fix refusal, and operator rearm across restarts, peers, and clock jitter", () => {
    fc.assert(
      fc.property(commandsArb, (cmds) => {
        fc.modelRun(setup, cmds);
      }),
    );
  });

  it("does not let a peer's earlier unpersisted operator turn wipe later shared-profile attempts", () => {
    // Shrunk MBT counterexample: [genuineOperatorTurn(proc=0, dt=1), startReview(proc=1, diff=none), startReview(proc=0, diff=none)]
    const real: Real = { persisted: undefined, observedOperatorTurnId: [undefined, undefined] };
    observeOperatorOnReal(real, 0, "op-1", 1001);
    expect(real.persisted).toBeUndefined();
    expect(claimOnReal(real, 1, "op-1", "operator", undefined, 1001)).toBeUndefined();
    expect(claimOnReal(real, 0, "op-1", "operator", undefined, 1001)).toBe("duplicate_turn");
    expect(claimOnReal(real, 1, "auto-2", "pr-watch", "diff-2", 1002)).toBeUndefined();
    expect(claimOnReal(real, 1, "auto-3", "pr-watch", "diff-3", 1003)).toBeUndefined();
    expect(claimOnReal(real, 0, "auto-4", "pr-watch", "diff-4", 1004)).toBe("limit");
  });

  it("rearms on a new operator turn even under same-millisecond ties or backward wall-clock steps", () => {
    // Shrunk MBT counterexample: [genuineOperatorTurn(proc=0, dt=-5), startReview(proc=0, diff=diff-4), genuineOperatorTurn(proc=0, dt=-5), startReview(proc=0, diff=diff-4)]
    const real: Real = { persisted: undefined, observedOperatorTurnId: [undefined, undefined] };
    observeOperatorOnReal(real, 0, "op-1", 1000);
    expect(claimOnReal(real, 0, "op-1", "operator", "diff-4", 1000)).toBeUndefined();
    observeOperatorOnReal(real, 0, "op-2", 995);
    expect(claimOnReal(real, 0, "op-2", "operator", "diff-4", 995)).toBeUndefined();
    observeOperatorOnReal(real, 0, "op-3", 995);
    expect(claimOnReal(real, 0, "op-3", "operator", "diff-4", 995)).toBeUndefined();
  });

  it("reads legacy operatorInput rows written by older builds without resetting on replay", () => {
    const legacy: AgentReviewBudget = {
      operatorInput: { turnId: "op-legacy", observedAt: 1795709663728 },
      attempts: [
        { turnId: "op-legacy", diff: "d1" },
        { turnId: "auto-2", diff: "d2" },
        { turnId: "auto-3", diff: "d3" },
      ],
    };
    expect(rearmAgentReviewBudget(legacy, { turnId: "op-legacy" })).toBeUndefined();
    expect(canClaimAgentReview(legacy, { turnId: "auto-4", diff: "d4" })).toBe("limit");
    const rearmed = rearmAgentReviewBudget(legacy, { turnId: "op-next" });
    expect(rearmed).toEqual({ operatorTurnId: "op-next", attempts: [] });
  });
});
