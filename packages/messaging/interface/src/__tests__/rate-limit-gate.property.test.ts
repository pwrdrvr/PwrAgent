import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MessagingRateLimitGate,
  type MessagingRateLimitBucket,
} from "../rate-limit-gate";

// Rules, from the gate's contract and the Slack adapter that relies on it:
// - Within any window of `intervalMs`, a bucket admits at most `limit` calls.
// - Admitted calls in one bucket are at least `minIntervalMs` apart.
// - Nothing is admitted before a recorded provider Retry-After expires, and a
//   shorter Retry-After never shortens a longer one already recorded.
// - A denial consumes nothing: a later call is admitted exactly when the
//   admitted history allows it, however many denials came before.
// - Buckets are independent; clearing one bucket leaves every other alone.
// The model below is the slow, obviously correct version: it keeps every
// admitted timestamp and recomputes each answer from scratch.

const BUCKETS: MessagingRateLimitBucket[] = [
  { id: "slack:workspace:T1:start", intervalMs: 60_000, limit: 3, minIntervalMs: 1_000 },
  { id: "slack:workspace:T1:append", intervalMs: 10_000, limit: 2 },
  { id: "slack:workspace:T1:stop", intervalMs: 5_000, limit: 1, minIntervalMs: 2_500 },
];

type BucketModel = { admitted: number[]; blockedUntil: number };

type Model = { now: number; buckets: BucketModel[] };

type Real = { gate: MessagingRateLimitGate; clock: { now: number } };

function expectedRetryAt(
  bucket: MessagingRateLimitBucket,
  state: BucketModel,
  now: number,
): number {
  const inWindow = state.admitted.filter((at) => at > now - bucket.intervalMs);
  const last = state.admitted.at(-1);
  const spacingReadyAt = last === undefined
    ? now
    : last + Math.max(0, bucket.minIntervalMs ?? 0);
  const windowReadyAt = inWindow.length < bucket.limit
    ? now
    : (inWindow[inWindow.length - bucket.limit] ?? now) + bucket.intervalMs;
  return Math.max(state.blockedUntil, spacingReadyAt, windowReadyAt);
}

class AdvanceCommand implements fc.Command<Model, Real> {
  constructor(readonly ms: number) {}
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    model.now += this.ms;
    real.clock.now = model.now;
  }
  toString(): string {
    return `advance(${this.ms})`;
  }
}

class AdmitCommand implements fc.Command<Model, Real> {
  constructor(readonly bucketIndex: number) {}
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    const bucket = BUCKETS[this.bucketIndex]!;
    const state = model.buckets[this.bucketIndex]!;
    const retryAt = expectedRetryAt(bucket, state, model.now);
    const admission = real.gate.admit(bucket);
    if (retryAt <= model.now) {
      expect(admission).toEqual({ admitted: true });
      state.admitted.push(model.now);
    } else {
      expect(admission).toEqual({ admitted: false, retryAt });
    }
    const windowCount = state.admitted.filter(
      (at) => at > model.now - bucket.intervalMs,
    ).length;
    expect(windowCount).toBeLessThanOrEqual(bucket.limit);
  }
  toString(): string {
    return `admit(${BUCKETS[this.bucketIndex]!.id})`;
  }
}

class RecordRateLimitCommand implements fc.Command<Model, Real> {
  constructor(readonly bucketIndex: number, readonly retryAfterMs: number) {}
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    const state = model.buckets[this.bucketIndex]!;
    state.blockedUntil = Math.max(
      state.blockedUntil,
      model.now + Math.max(0, this.retryAfterMs),
    );
    real.gate.recordRateLimit(BUCKETS[this.bucketIndex]!.id, this.retryAfterMs);
  }
  toString(): string {
    return `recordRateLimit(${BUCKETS[this.bucketIndex]!.id}, ${this.retryAfterMs})`;
  }
}

class ClearBucketCommand implements fc.Command<Model, Real> {
  constructor(readonly bucketIndex: number) {}
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    model.buckets[this.bucketIndex] = { admitted: [], blockedUntil: 0 };
    real.gate.clear(BUCKETS[this.bucketIndex]!.id);
  }
  toString(): string {
    return `clear(${BUCKETS[this.bucketIndex]!.id})`;
  }
}

const bucketIndex = fc.integer({ min: 0, max: BUCKETS.length - 1 });

const commands = [
  fc.integer({ min: 0, max: 15_000 }).map((ms) => new AdvanceCommand(ms)),
  fc.integer({ min: 0, max: 400 }).map((ms) => new AdvanceCommand(ms)),
  bucketIndex.map((index) => new AdmitCommand(index)),
  bucketIndex.map((index) => new AdmitCommand(index)),
  fc
    .tuple(bucketIndex, fc.integer({ min: -1_000, max: 90_000 }))
    .map(([index, ms]) => new RecordRateLimitCommand(index, ms)),
  bucketIndex.map((index) => new ClearBucketCommand(index)),
];

function setup(): { model: Model; real: Real } {
  const clock = { now: 1_000_000 };
  return {
    model: {
      now: clock.now,
      buckets: BUCKETS.map(() => ({ admitted: [], blockedUntil: 0 })),
    },
    real: { gate: new MessagingRateLimitGate(() => clock.now), clock },
  };
}

describe("MessagingRateLimitGate model", () => {
  it("admits exactly what the window, spacing and Retry-After allow", () => {
    fc.assert(
      fc.property(fc.commands(commands, { maxCommands: 80 }), (cmds) => {
        fc.modelRun(setup, cmds);
      }),
    );
  });

  it("never admits a bucket before its recorded Retry-After, whatever runs in between", () => {
    const otherBucketOps = fc.array(
      fc.oneof(
        fc.integer({ min: 0, max: 2_000 }).map((ms) => ({ kind: "advance" as const, ms })),
        fc.constant({ kind: "admit" as const }),
        fc.constant({ kind: "admit-other" as const }),
        fc.constant({ kind: "clear-other" as const }),
        fc.integer({ min: 0, max: 10_000 }).map((ms) => ({ kind: "shorter-429" as const, ms })),
      ),
      { maxLength: 60 },
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30_000 }),
        otherBucketOps,
        (retryAfterMs, ops) => {
          let now = 50_000;
          const gate = new MessagingRateLimitGate(() => now);
          const [limited, other] = [BUCKETS[0]!, BUCKETS[1]!];
          gate.recordRateLimit(limited.id, retryAfterMs);
          const blockedUntil = now + retryAfterMs;
          for (const op of ops) {
            if (op.kind === "advance") now += op.ms;
            else if (op.kind === "admit-other") gate.admit(other);
            else if (op.kind === "clear-other") gate.clear(other.id);
            else if (op.kind === "shorter-429") gate.recordRateLimit(limited.id, op.ms);
            else {
              const admission = gate.admit(limited);
              if (now < blockedUntil) {
                expect(admission.admitted).toBe(false);
              }
            }
          }
        },
      ),
    );
  });
});
