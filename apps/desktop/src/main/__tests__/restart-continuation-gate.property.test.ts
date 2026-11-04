import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  OPEN_RESTART_GATE,
  planRestartDispatch,
  restartGateHolds,
  transitionRestartGate,
  type RestartGateEvent,
  type RestartGateState,
} from "../app-server/restart-continuation-gate";

const IDS = ["a", "b", "c", "d", "e"] as const;
const id = fc.constantFrom(...IDS);

const event: fc.Arbitrary<RestartGateEvent> = fc.oneof(
  fc.record({ type: fc.constant("quiet" as const), at: fc.nat(1_000) }),
  fc.record({
    type: fc.constant("restore" as const),
    schedule: fc.uniqueArray(
      fc.record({ entryId: id, dispatchAt: fc.nat(1_000) }).map((item) => ({ ...item, threadKey: `codex:${item.entryId}` })),
      { selector: (item) => item.entryId, maxLength: IDS.length },
    ),
    releaseBy: fc.nat(1_000),
  }),
  fc.record({ type: fc.constant("settled" as const), entryId: id }),
  fc.record({ type: fc.constant("deadline" as const), at: fc.nat(1_000) }),
  fc.constant({ type: "release" as const }),
);

/**
 * The gate's promises, written as plain flags and sets rather than phases:
 * a quiet restart shuts everything for good; otherwise the gate is shut while
 * any restored continuation has not settled, until its deadline passes or
 * the operator releases it.
 */
type Reference = { quiet: boolean; pending: Map<string, number>; releaseBy: number };

function referenceStep(reference: Reference, next: RestartGateEvent): Reference {
  if (reference.quiet) return reference;
  switch (next.type) {
    case "quiet":
      return { quiet: true, pending: new Map(), releaseBy: 0 };
    case "restore": {
      const pending = new Map(reference.pending);
      for (const item of next.schedule) pending.set(item.entryId, item.dispatchAt);
      return {
        quiet: false,
        pending,
        releaseBy: reference.pending.size > 0 ? Math.max(reference.releaseBy, next.releaseBy) : next.releaseBy,
      };
    }
    case "settled": {
      const pending = new Map(reference.pending);
      pending.delete(next.entryId);
      return { ...reference, pending };
    }
    case "deadline":
      return next.at >= reference.releaseBy ? { ...reference, pending: new Map() } : reference;
    case "release":
      return { ...reference, pending: new Map() };
  }
}

describe("restart gate (property)", () => {
  it("agrees with the reference on what it holds after any event sequence", () => {
    fc.assert(fc.property(fc.array(event, { maxLength: 25 }), fc.nat(1_000), (events, now) => {
      let state: RestartGateState = OPEN_RESTART_GATE;
      let reference: Reference = { quiet: false, pending: new Map(), releaseBy: 0 };
      for (const next of events) {
        state = transitionRestartGate(state, next);
        reference = referenceStep(reference, next);

        const shut = reference.quiet || reference.pending.size > 0;
        expect(state.phase === "open").toBe(!shut);
        expect(state.phase === "quieting").toBe(reference.quiet);
        // Work that is not a continuation waits exactly while the gate is shut.
        expect(restartGateHolds(state, {}, now)).toBe(shut);
        for (const entryId of IDS) {
          const dispatchAt = reference.pending.get(entryId);
          const held = reference.quiet || (dispatchAt !== undefined && now < dispatchAt);
          expect(restartGateHolds(state, { restartEntryId: entryId }, now)).toBe(held);
        }
        if (state.phase === "resuming") {
          expect([...state.pending.keys()].sort()).toEqual([...reference.pending.keys()].sort());
        }
      }
    }));
  });
});

describe("planRestartDispatch (property)", () => {
  const options = fc.record({
    now: fc.nat(1_000_000),
    batchSize: fc.integer({ min: 1, max: 8 }),
    firstDelayMs: fc.nat(60_000),
    intervalMs: fc.nat(120_000),
    jitterMs: fc.nat(60_000),
    releaseGraceMs: fc.nat(600_000),
  });
  const entries = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 30 })
    .map((ids) => ids.map((entryId) => ({ entryId, threadKey: `codex:${entryId}` })));
  const randoms = fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 30, maxLength: 30 });

  it("keeps order, puts each continuation in its batch's window, and releases after the last", () => {
    fc.assert(fc.property(entries, options, randoms, (items, plan, values) => {
      let index = 0;
      const result = planRestartDispatch(items, { ...plan, random: () => values[index++] ?? 0 });
      expect(result.schedule.map((item) => item.entryId)).toEqual(items.map((item) => item.entryId));
      result.schedule.forEach((item, position) => {
        const start = plan.now + plan.firstDelayMs + Math.floor(position / plan.batchSize) * plan.intervalMs;
        expect(item.dispatchAt).toBeGreaterThanOrEqual(start);
        expect(item.dispatchAt).toBeLessThanOrEqual(start + plan.jitterMs);
        expect(item.threadKey).toBe(items[position]!.threadKey);
      });
      const last = Math.max(plan.now, ...result.schedule.map((item) => item.dispatchAt));
      expect(result.releaseBy).toBe(last + plan.releaseGraceMs);
    }));
  });

  it("starts at most one batch of threads in each interval when jitter is shorter than the interval", () => {
    fc.assert(fc.property(entries, options, randoms, (items, plan, values) => {
      fc.pre(plan.jitterMs < plan.intervalMs);
      let index = 0;
      const result = planRestartDispatch(items, { ...plan, random: () => values[index++] ?? 0 });
      const base = plan.now + plan.firstDelayMs;
      for (let batch = 0; batch * plan.batchSize < items.length; batch += 1) {
        const windowStart = base + batch * plan.intervalMs;
        const inWindow = result.schedule.filter((item) =>
          item.dispatchAt >= windowStart && item.dispatchAt < windowStart + plan.intervalMs);
        expect(inWindow.length).toBeLessThanOrEqual(plan.batchSize);
      }
    }));
  });
});
