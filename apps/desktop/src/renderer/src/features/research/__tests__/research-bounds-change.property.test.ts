import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyResearchBounds, RESEARCH_MAX_WORKERS } from "@pwragent/shared/research";
import { researchBoundsChange } from "../ResearchBoundsEditor";
import { researchLimitDraft, researchLimitMinutes } from "../ResearchLimitField";

const CREATED = 1_000_000;
const limit = fc.option(fc.integer({ min: 1, max: 20_000 }), { nil: undefined });

/**
 * The editor sends the operator's bounds as the owner records them: only what
 * they changed, null for a limit they removed. Applying that change to the run
 * gives exactly the bounds on screen, and an unchanged editor sends nothing.
 */
describe("the bounds editor's change", () => {
  it("names exactly the bounds that differ, and applying it gives the bounds on screen", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: RESEARCH_MAX_WORKERS }), limit, limit, limit, fc.integer({ min: 1, max: RESEARCH_MAX_WORKERS }), limit, limit, limit,
      (workerLimit, minutes, turnMinutes, totalWorkerMinutes, workers, nextMinutes, nextTurn, nextTotal) => {
        const run = { workerLimit, createdAt: CREATED, ...(minutes !== undefined ? { deadlineAt: CREATED + minutes * 60_000 } : {}),
          ...(turnMinutes !== undefined ? { turnMinutes } : {}), ...(totalWorkerMinutes !== undefined ? { totalWorkerMinutes } : {}) };
        const change = researchBoundsChange(run, { workers, minutes: nextMinutes, turnMinutes: nextTurn, totalWorkerMinutes: nextTotal });
        const unchanged = workers === workerLimit && nextMinutes === minutes && nextTurn === turnMinutes && nextTotal === totalWorkerMinutes;
        if (unchanged) { expect(change).toBeUndefined(); return; }
        expect(change).toBeDefined();
        expect(Object.keys(change!).sort()).toEqual([
          ...(workers !== workerLimit ? ["workers"] : []), ...(nextMinutes !== minutes ? ["minutes"] : []),
          ...(nextTurn !== turnMinutes ? ["turnMinutes"] : []), ...(nextTotal !== totalWorkerMinutes ? ["totalWorkerMinutes"] : []),
        ].sort());
        // The owner applies the change to the run's bounds; the result is what the editor showed.
        const deadlineAt = change!.minutes === undefined ? run.deadlineAt : change!.minutes === null ? undefined : CREATED + change!.minutes * 60_000;
        const pick = (value: number | null | undefined, current: number | undefined) => value === undefined ? current : value ?? undefined;
        const applied = applyResearchBounds({ ...run }, { type: "bounds", workerLimit: change!.workers ?? workerLimit, ...(deadlineAt !== undefined ? { deadlineAt } : {}),
          ...(pick(change!.turnMinutes, turnMinutes) !== undefined ? { turnMinutes: pick(change!.turnMinutes, turnMinutes) } : {}),
          ...(pick(change!.totalWorkerMinutes, totalWorkerMinutes) !== undefined ? { totalWorkerMinutes: pick(change!.totalWorkerMinutes, totalWorkerMinutes) } : {}) });
        expect([applied.workerLimit, applied.deadlineAt, applied.turnMinutes, applied.totalWorkerMinutes])
          .toEqual([workers, nextMinutes === undefined ? undefined : CREATED + nextMinutes * 60_000, nextTurn, nextTotal]);
      }));
  });

  it("sends nothing while a field is not a whole number in range", () => {
    const run = { workerLimit: 3, createdAt: CREATED };
    for (const draft of [{ workers: 0 }, { workers: RESEARCH_MAX_WORKERS + 1 }, { workers: 2.5 }, { workers: 3, minutes: Number.NaN }]) {
      expect(researchBoundsChange(run, { minutes: undefined, turnMinutes: undefined, totalWorkerMinutes: undefined, ...draft })).toBeUndefined();
    }
  });

  it("opens each limit in the largest unit it fills, and reads it back as the same minutes", () => {
    fc.assert(fc.property(limit, (minutes) => {
      expect(researchLimitMinutes(researchLimitDraft(minutes, { length: 8, unit: "hours" }))).toBe(minutes);
    }));
    expect(researchLimitDraft(2880, { length: 1, unit: "minutes" })).toEqual({ limited: true, length: 2, unit: "days" });
    expect(researchLimitDraft(90, { length: 1, unit: "minutes" })).toEqual({ limited: true, length: 90, unit: "minutes" });
  });
});
