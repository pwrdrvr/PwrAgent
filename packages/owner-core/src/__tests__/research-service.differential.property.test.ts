import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { emptyResearchDifferentialCoverage, expectResearchServicesAgree, researchDifferentialStepArb } from "./fixtures/research-differential";
import { MemoryResearchStorage } from "./fixtures/research-memory-storage";

const uuid = vi.hoisted(() => ({ next: (): string => { throw new Error("No world is taking its turn"); } }));
vi.mock("node:crypto", async (importOriginal) => ({ ...await importOriginal<typeof import("node:crypto")>(), randomUUID: () => uuid.next() }));

describe("research service, validated against projections", () => {
  it("accepts, refuses and records exactly what the replay-based service does, for generated commands, observations, redeliveries, stale versions and restarts", async () => {
    const coverage = emptyResearchDifferentialCoverage();
    await fc.assert(fc.asyncProperty(fc.array(researchDifferentialStepArb, { size: "max", minLength: 15, maxLength: 45 }), async (steps) => {
      const storage = new MemoryResearchStorage();
      await expectResearchServicesAgree(uuid, steps, storage, (id) => storage.records.get(id), coverage);
    }), { numRuns: 30 });
    // The comparison means nothing if the sequences never get past a refusal, or never meet one.
    for (const type of ["worker", "status", "finding", "submission", "review", "item_work", "delivery"]) expect(coverage.events[type] ?? 0, `${type} events recorded`).toBeGreaterThan(0);
    for (const kind of ["finding", "submit", "review", "work", "assign", "start"]) {
      expect(coverage.accepted[kind] ?? 0, `${kind} accepted`).toBeGreaterThan(0);
      expect(coverage.refused[kind] ?? 0, `${kind} refused`).toBeGreaterThan(0);
    }
    expect(Object.keys(coverage.refusals).length).toBeGreaterThan(10);
  });
});
