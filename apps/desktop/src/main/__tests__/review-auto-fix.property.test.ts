import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ReviewAutoFixArming,
  type ReviewAutoFixStart,
} from "../thread-reviews/review-auto-fix";

/**
 * Rule: a landed review sends its auto-fix exactly when that review was
 * started with auto-fix, at most once, and never after its turn ended. A
 * refused start never changes what a running review does, and a review
 * PwrAgent did not start (a `/code-review` typed into the composer) never
 * fixes.
 *
 * Model: the reviews themselves. Each has the turn id the backend gives it,
 * whether it chose auto-fix, and its phase. The model never looks at arms:
 * the expected answer comes from the review that landed.
 *
 * Out of scope: two starts in flight on one thread with one landing before
 * either returns. Neither start has a turn id yet, so nothing can tell them
 * apart. The generator lets a pending review land early only while it is the
 * thread's only pending start.
 */

type Phase = "pending" | "running" | "over";
type Review = { id: number; thread: string; turnId: string; autoFix: boolean; phase: Phase };
type Model = { reviews: Review[]; nextId: number };
type Real = {
  arming: ReviewAutoFixArming;
  handles: Map<number, ReviewAutoFixStart>;
  /** Threads the arming reported a change for since the last check. */
  notified: Set<string>;
  /** Each thread's armed turns at the last check. */
  seen: Map<string, string>;
};

const thread = (id: string) => ({ backend: "codex" as const, threadId: id });
const onThread = (model: Model, id: string, phase: Phase) =>
  model.reviews.filter((review) => review.thread === id && review.phase === phase);

class Begin implements fc.Command<Model, Real> {
  constructor(readonly thread: string, readonly autoFix: boolean) {}
  check(): boolean { return true; }
  run(model: Model, real: Real): void {
    const id = model.nextId++;
    model.reviews.push({ id, thread: this.thread, turnId: `turn-${id}`, autoFix: this.autoFix, phase: "pending" });
    real.handles.set(id, real.arming.starting(thread(this.thread), this.autoFix ? "auto-fix" : "wait"));
  }
  toString(): string { return `begin(${this.thread}, ${this.autoFix ? "auto-fix" : "wait"})`; }
}

/** The backend accepts the oldest pending start, while no review runs there. */
class Accept implements fc.Command<Model, Real> {
  constructor(readonly thread: string) {}
  check(model: Readonly<Model>): boolean {
    return onThread(model, this.thread, "pending").length > 0
      && onThread(model, this.thread, "running").length === 0;
  }
  run(model: Model, real: Real): void {
    const review = onThread(model, this.thread, "pending")[0]!;
    review.phase = "running";
    real.handles.get(review.id)!.accepted(review.turnId);
  }
  toString(): string { return `accept(${this.thread})`; }
}

class Refuse implements fc.Command<Model, Real> {
  constructor(readonly thread: string) {}
  check(model: Readonly<Model>): boolean { return onThread(model, this.thread, "pending").length > 0; }
  run(model: Model, real: Real): void {
    const review = onThread(model, this.thread, "pending")[0]!;
    review.phase = "over";
    real.handles.get(review.id)!.refused();
  }
  toString(): string { return `refuse(${this.thread})`; }
}

/** The running review lands, or the sole pending one lands before its start returns. */
class Land implements fc.Command<Model, Real> {
  constructor(readonly thread: string) {}
  private target(model: Readonly<Model>): Review | undefined {
    const pending = onThread(model as Model, this.thread, "pending");
    return onThread(model as Model, this.thread, "running")[0]
      ?? (pending.length === 1 ? pending[0] : undefined);
  }
  check(model: Readonly<Model>): boolean { return this.target(model) !== undefined; }
  run(model: Model, real: Real): void {
    const review = this.target(model)!;
    const expected = review.autoFix;
    // It landed: whatever follows, it never fixes again.
    review.autoFix = false;
    expect(real.arming.takeOnCompletion(thread(this.thread), review.turnId)).toBe(expected);
  }
  toString(): string { return `land(${this.thread})`; }
}

/** The running review's turn ends, with or without an artifact. */
class EndTurn implements fc.Command<Model, Real> {
  constructor(readonly thread: string) {}
  check(model: Readonly<Model>): boolean { return onThread(model as Model, this.thread, "running").length > 0; }
  run(model: Model, real: Real): void {
    const review = onThread(model, this.thread, "running")[0]!;
    review.phase = "over";
    real.arming.turnEnded(thread(this.thread), review.turnId);
  }
  toString(): string { return `endTurn(${this.thread})`; }
}

/** A review PwrAgent did not start lands while nothing is starting there. */
class ForeignLand implements fc.Command<Model, Real> {
  constructor(readonly thread: string) {}
  check(model: Readonly<Model>): boolean {
    return onThread(model as Model, this.thread, "pending").length === 0
      && onThread(model as Model, this.thread, "running").length === 0;
  }
  run(model: Model, real: Real): void {
    expect(real.arming.takeOnCompletion(thread(this.thread), `foreign-${model.nextId++}`)).toBe(false);
  }
  toString(): string { return `foreignLand(${this.thread})`; }
}

// Mostly one thread, so sequences on it run long; the other checks isolation.
/** Don't auto-fix on the running review: true exactly when it was still armed. */
class Disarm implements fc.Command<Model, Real> {
  constructor(readonly thread: string) {}
  check(model: Readonly<Model>): boolean { return onThread(model as Model, this.thread, "running").length > 0; }
  run(model: Model, real: Real): void {
    const review = onThread(model, this.thread, "running")[0]!;
    expect(real.arming.disarm(thread(this.thread), review.turnId)).toBe(review.autoFix);
    review.autoFix = false;
  }
  toString(): string { return `disarm(${this.thread})`; }
}

/**
 * Viewers see a thread's armed reviews: the running ones still set to
 * auto-fix. A change to that list is announced.
 */
class CheckArmed implements fc.Command<Model, Real> {
  check(): boolean { return true; }
  run(model: Model, real: Real): void {
    for (const id of ["a", "b"]) {
      const expected = onThread(model, id, "running").filter((review) => review.autoFix)
        .map((review) => review.turnId).sort();
      const armed = real.arming.armedTurnIds(thread(id)).sort();
      expect(armed).toEqual(expected);
      const key = armed.join(",");
      if ((real.seen.get(id) ?? "") !== key) expect(real.notified.has(id)).toBe(true);
      real.seen.set(id, key);
    }
    real.notified.clear();
  }
  toString(): string { return "checkArmed"; }
}

const threadArb = fc.constantFrom("a", "a", "a", "b");
const commands = fc.commands([
  fc.tuple(threadArb, fc.boolean()).map(([id, autoFix]) => new Begin(id, autoFix)),
  threadArb.map((id) => new Accept(id)),
  threadArb.map((id) => new Refuse(id)),
  threadArb.map((id) => new Land(id)),
  threadArb.map((id) => new EndTurn(id)),
  threadArb.map((id) => new ForeignLand(id)),
  threadArb.map((id) => new Disarm(id)),
  fc.constant(new CheckArmed()),
], { maxCommands: 40 });

function setup(): { model: Model; real: Real } {
  const notified = new Set<string>();
  return {
    model: { reviews: [], nextId: 0 },
    real: {
      arming: new ReviewAutoFixArming((changed) => notified.add(changed.threadId)),
      handles: new Map(),
      notified,
      seen: new Map(),
    },
  };
}

describe("review auto-fix arming", () => {
  it("fixes a landed review exactly when it was started with auto-fix, once", () => {
    fc.assert(fc.property(commands, (cmds) => {
      fc.modelRun(setup, cmds);
    }), { numRuns: 2000 });
  });

  it("keeps a running review's arm when a second start is refused", () => {
    const arming = new ReviewAutoFixArming();
    arming.starting(thread("a"), "auto-fix").accepted("turn-1");
    arming.starting(thread("a"), "wait").refused();
    expect(arming.takeOnCompletion(thread("a"), "turn-1")).toBe(true);
  });

  it("does not hand a running unarmed review a pending start's arm", () => {
    const arming = new ReviewAutoFixArming();
    arming.starting(thread("a"), "wait").accepted("turn-1");
    const second = arming.starting(thread("a"), "auto-fix");
    expect(arming.takeOnCompletion(thread("a"), "turn-1")).toBe(false);
    second.refused();
    expect(arming.takeOnCompletion(thread("a"), undefined)).toBe(false);
  });
});
