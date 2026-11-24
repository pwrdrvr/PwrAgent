import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ResourceCondition, ResourceDomain } from "@pwragent/shared/contracts/resource-checkouts";
import { MAX_USAGE_POINTS, ResourceUsageRecorder } from "../resource-checkouts/checkout-usage-history";

/**
 * The rules the in-memory usage recorder must keep:
 *
 * - Evaluated as a step function, the history equals what was observed: at
 *   any time from `max(observedSince, now - window)` to now, its value is
 *   the last observation at or before that time from an authority that
 *   answered. Observations from an unreachable or unresolved authority
 *   change nothing.
 * - It stays bounded: at most one point at or before the window's start,
 *   never more than MAX_USAGE_POINTS, and a resource unseen for a whole
 *   window is forgotten.
 * - Points are strictly ordered and adjacent points differ, so an idle
 *   resource costs one point however long it is watched.
 *
 * The oracle replays the observation log.
 */

const WINDOW = 10_000;
const T0 = 1_800_000_000_000;

type Observation = { at: number; held: number[]; waiting: number[]; condition: ResourceCondition };

function resource(observation: Observation): ResourceDomain {
  return {
    resourceId: "r",
    condition: observation.condition,
    allocations: observation.held.map((units) => ({ units, lastKnown: false })),
    queue: observation.waiting.map((units) => ({ units })),
  } as unknown as ResourceDomain;
}

const units = fc.array(fc.integer({ min: 1, max: 4 }), { maxLength: 3 });
const observations = fc.array(
  fc.record({
    gap: fc.integer({ min: 0, max: 3_000 }),
    held: units,
    waiting: units,
    condition: fc.constantFrom<ResourceCondition>("available", "busy", "busy", "unreachable", "ownership_unresolved"),
  }),
  { minLength: 1, maxLength: 60 },
).map((steps) => {
  let at = T0;
  return steps.map(({ gap, ...rest }) => ({ ...rest, at: (at += gap) }));
});

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe("ResourceUsageRecorder", () => {
  it("replays exactly what answered authorities reported, inside the window", () => {
    fc.assert(fc.property(observations, (log) => {
      const recorder = new ResourceUsageRecorder(WINDOW);
      for (const observation of log) recorder.observe([resource(observation)], observation.at);
      const now = log[log.length - 1].at;
      const answered = log.filter(({ condition }) => condition !== "unreachable" && condition !== "ownership_unresolved");
      const history = recorder.history("r");
      if (answered.length === 0) {
        expect(history).toBeUndefined();
        return;
      }
      expect(history).toBeDefined();
      const { points, observedSince } = history!;
      expect(observedSince).toBe(answered[0].at);
      for (let index = 1; index < points.length; index += 1) {
        expect(points[index].at).toBeGreaterThan(points[index - 1].at);
        expect([points[index].held, points[index].waiting]).not.toEqual([points[index - 1].held, points[index - 1].waiting]);
      }
      const cutoff = now - WINDOW;
      expect(points.filter(({ at }) => at <= cutoff).length).toBeLessThanOrEqual(1);
      expect(points[0].at).toBeLessThanOrEqual(Math.max(cutoff, observedSince));
      const instants = new Set([Math.max(cutoff, observedSince), now, ...answered.map(({ at }) => at)]);
      for (const at of instants) {
        if (at < Math.max(cutoff, observedSince) || at > now) continue;
        const expected = answered.filter((observation) => observation.at <= at).at(-1)!;
        const actual = points.filter((point) => point.at <= at).at(-1);
        expect(actual && { held: actual.held, waiting: actual.waiting })
          .toEqual({ held: sum(expected.held), waiting: sum(expected.waiting) });
      }
    }));
  });

  it("forgets a resource no read has listed for a whole window", () => {
    const recorder = new ResourceUsageRecorder(WINDOW);
    recorder.observe([resource({ at: T0, held: [2], waiting: [], condition: "busy" })], T0);
    recorder.observe([], T0 + WINDOW);
    expect(recorder.history("r")).toBeDefined();
    recorder.observe([], T0 + WINDOW + 1);
    expect(recorder.history("r")).toBeUndefined();
  });

  it("caps a series that changes on every observation and stops claiming what it dropped", () => {
    const recorder = new ResourceUsageRecorder(Number.MAX_SAFE_INTEGER);
    const total = MAX_USAGE_POINTS + 50;
    for (let index = 0; index < total; index += 1) {
      recorder.observe([resource({ at: T0 + index, held: [1 + (index % 2)], waiting: [], condition: "busy" })], T0 + index);
    }
    const history = recorder.history("r")!;
    expect(history.points).toHaveLength(MAX_USAGE_POINTS);
    expect(history.observedSince).toBe(history.points[0].at);
    expect(history.points.at(-1)!.at).toBe(T0 + total - 1);
  });
});
