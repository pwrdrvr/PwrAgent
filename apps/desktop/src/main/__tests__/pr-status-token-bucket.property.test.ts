import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PR_STATUS_TOKEN_BUCKET_CAPACITY,
  PR_STATUS_TOKEN_BUCKET_REFILL_PER_MINUTE,
  PrStatusTokenBucket,
} from "../pr-status/pr-status-token-bucket";

/*
 * The rules the shared PR request budget promises
 * (`pr-status-token-bucket.ts`, and the Activity window's polling budget):
 *
 *   1. Reading the balance is pure. `peek()` and `availableTokens` feed the
 *      Activity window and the status tools; however often they run, every
 *      later take is admitted or refused exactly as if they never ran.
 *   2. The limit holds. Over any run, admitted takes never exceed the
 *      capacity plus the refill the clock's forward movement has earned.
 *   3. A refused take spends nothing: dropping it changes no later answer.
 *
 * The oracle for rule 1 and 3 is a second bucket that sees only the takes
 * (a differential model). The oracle for rule 2 is the arithmetic bound,
 * computed from the promise, not from the bucket.
 */
const START = 1_000_000;
const MS_PER_TOKEN = 60_000 / PR_STATUS_TOKEN_BUCKET_REFILL_PER_MINUTE;

afterEach(() => vi.restoreAllMocks());

function bucketAt(now: number): PrStatusTokenBucket {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const bucket = new PrStatusTokenBucket();
  vi.restoreAllMocks();
  return bucket;
}

type Real = {
  /** Sees every command, reads included. */
  bucket: PrStatusTokenBucket;
  /** Sees only the takes: what the budget would answer with no readers. */
  shadow: PrStatusTokenBucket;
};
type Model = {
  now: number;
  /** The highest clock reading so far; refill is earned only past it. */
  forwardMs: number;
  admitted: number;
};

class AdvanceCommand implements fc.Command<Model, Real> {
  constructor(readonly deltaMs: number) {}
  check(): boolean { return true; }
  run(model: Model): void {
    model.forwardMs += Math.max(0, this.deltaMs);
    model.now += this.deltaMs;
  }
  toString(): string { return `advance(${this.deltaMs})`; }
}

class TakeCommand implements fc.Command<Model, Real> {
  /** A poll batch or a burst of agent reads spends several at one instant. */
  constructor(readonly count: number) {}
  check(): boolean { return true; }
  run(model: Model, real: Real): void {
    for (let take = 0; take < this.count; take += 1) {
      const admitted = real.bucket.tryTake(model.now);
      expect(admitted, "a read changed what the budget admits").toBe(real.shadow.tryTake(model.now));
      if (admitted) model.admitted += 1;
      const bound = PR_STATUS_TOKEN_BUCKET_CAPACITY + Math.floor(model.forwardMs / MS_PER_TOKEN);
      expect(model.admitted, "admitted more than capacity + earned refill").toBeLessThanOrEqual(bound);
    }
  }
  toString(): string { return `tryTake x${this.count}`; }
}

class PeekCommand implements fc.Command<Model, Real> {
  constructor(readonly offsetMs: number) {}
  check(): boolean { return true; }
  run(model: Model, real: Real): void {
    // A status read may be stamped a little before or after the takes'
    // clock: the Activity window reads `Date.now()` on its own schedule.
    const balance = real.bucket.peek(model.now + this.offsetMs);
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(balance).toBeLessThanOrEqual(PR_STATUS_TOKEN_BUCKET_CAPACITY);
    expect(real.bucket.availableTokens).toBeLessThanOrEqual(PR_STATUS_TOKEN_BUCKET_CAPACITY);
  }
  toString(): string { return `peek(${this.offsetMs})`; }
}

function commands(clock: fc.Arbitrary<number>) {
  return fc.commands([
    clock.map((deltaMs) => new AdvanceCommand(deltaMs)),
    fc.integer({ min: 1, max: 25 }).map((count) => new TakeCommand(count)),
    fc.integer({ min: -120_000, max: 120_000 }).map((offset) => new PeekCommand(offset)),
  ], { maxCommands: 120 });
}

function runModel(cmds: Iterable<fc.Command<Model, Real>>): void {
  fc.modelRun(() => ({
    model: { now: START, forwardMs: 0, admitted: 0 },
    real: { bucket: bucketAt(START), shadow: bucketAt(START) },
  }), cmds);
}

describe("PR status token bucket (model)", () => {
  it("reads never change admission and the limit holds on a forward clock", () => {
    fc.assert(fc.property(commands(fc.integer({ min: 0, max: 10_000 })), runModel));
  });

  it("reads never change admission and the limit holds when the clock steps back", () => {
    // A backward NTP step is real. It may not refill, and the bound counts
    // only the forward movement of the clock the takes saw.
    fc.assert(fc.property(commands(fc.integer({ min: -90_000, max: 10_000 })), runModel));
  });

  it("a refused take spends nothing on a forward clock", () => {
    // Replay the trace with every refused take replaced by a read: the
    // admitted takes must still be admitted, and each refused one must still
    // find no whole token, so a refusal neither spent nor earned anything.
    fc.assert(fc.property(
      fc.array(fc.record({ deltaMs: fc.integer({ min: 0, max: 6_000 }), takes: fc.integer({ min: 0, max: 25 }) }), { maxLength: 60 }),
      (steps) => {
        const full = bucketAt(START);
        const trace: Array<{ now: number; admitted: boolean }> = [];
        let now = START;
        for (const step of steps) {
          now += step.deltaMs;
          for (let take = 0; take < step.takes; take += 1) trace.push({ now, admitted: full.tryTake(now) });
        }
        const replay = bucketAt(START);
        for (const entry of trace) {
          if (entry.admitted) expect(replay.tryTake(entry.now)).toBe(true);
          else expect(replay.peek(entry.now), "a refused take changed the balance").toBe(0);
        }
      },
    ));
  });
});
