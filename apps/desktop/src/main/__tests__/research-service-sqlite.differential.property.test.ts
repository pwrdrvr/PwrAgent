import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import type { ResearchEvent } from "@pwragent/shared/research";
import {
  emptyResearchDifferentialCoverage, expectResearchServicesAgree, researchDifferentialBoundsStepArb, researchDifferentialStepArb,
  type ResearchDifferentialCoverage, type ResearchDifferentialStep,
} from "../../../../../packages/owner-core/src/__tests__/fixtures/research-differential";
import { StateDb } from "../state/state-db";
import { createTempStateDb } from "./sqlite-test-utils";

const uuid = vi.hoisted(() => ({ next: (): string => "00000000-0000-4000-8000-ffffffffffff" }));
vi.mock("node:crypto", async (importOriginal) => ({ ...await importOriginal<typeof import("node:crypto")>(), randomUUID: () => uuid.next() }));

let db: StateDb;
let fixture: ReturnType<typeof createTempStateDb>;
beforeEach(() => { fixture = createTempStateDb("pwragent-research-differential-"); db = StateDb.open(fixture.dbPath); });
afterEach(() => { db.close(); rmSync(fixture.tempDir, { recursive: true, force: true }); });

const noFaults = { spawn: "ok", stop: "ok", notify: "plain", cancel: "plain" } as const;

function step(kind: ResearchDifferentialStep["kind"], options: Partial<Omit<ResearchDifferentialStep, "kind">> = {}): ResearchDifferentialStep {
  return { kind, run: 0, actor: 0, approach: 0, item: 0, other: 0, variant: 0, flag: false, faults: noFaults, ...options };
}

async function compareHistory(steps: ResearchDifferentialStep[], coverage?: ResearchDifferentialCoverage): Promise<void> {
  db.raw.exec("DELETE FROM research_deliveries; DELETE FROM research_items; DELETE FROM research_workers; DELETE FROM research_events; DELETE FROM research_runs;");
  // Read the stored journal apart from the storage the service holds.
  const journal = (id: string) => {
    const rows = db.raw.prepare("SELECT payload FROM research_events WHERE run_id = ? ORDER BY seq").all(id) as { payload: string }[];
    return rows.length ? rows.map((row) => JSON.parse(row.payload) as ResearchEvent) : undefined;
  };
  await expectResearchServicesAgree(uuid, steps, new ResearchStore(db), journal, coverage);
}

describe("research service on the SQLite projections", () => {
  it("accepts, refuses and records exactly what the replay-based service does, without replaying a journal", async () => {
    const coverage = emptyResearchDifferentialCoverage();
    await compareHistory([
      step("start", { other: 19, flag: true }),
      // Exercise the refusal paths while the run still accepts commands.
      step("bounds"), // Agent caller.
      step("bounds", { flag: true }), // No changes.
      step("bounds", { flag: true, variant: 7 }), // Zero workers.
      step("finish"), // No accepted submission.
      step("review"), // No submission to review.
      step("finding"), // Missing relationship target.
      step("finding", { variant: 16 }), // Unknown finding kind.
      step("finding", { variant: 1, approach: 10 }), // Unknown approach.
      step("finding", { variant: 1, actor: 7 }), // Non-member caller.
      step("direction", { flag: true }), // Overlaps itself.
      step("work", { item: 12 }), // Unknown item.
      step("submit", { variant: 18 }), // Blank submission.
      // A valid finding, work transition and submission, then queued revision delivery.
      step("finding", { variant: 1 }),
      step("work"),
      step("submit"),
      step("review", { variant: 1, faults: { ...noFaults, notify: "queued" } }),
      step("bounds", { flag: true, item: 2 }),
      step("stop"),
    ], coverage);
    for (const type of ["worker", "status", "finding", "submission", "review", "item_work", "delivery", "bounds"]) expect(coverage.events[type] ?? 0, `${type} events recorded`).toBeGreaterThan(0);
    expect(Object.keys(coverage.refusals).length).toBeGreaterThan(10);
    await fc.assert(fc.asyncProperty(
      fc.array(researchDifferentialStepArb, { size: "max", minLength: 15, maxLength: 40 }),
      (steps) => compareHistory(steps),
    ), { numRuns: 6 });
  });

  it("agrees on the operator's bounds as the stored header reads them, and on what their timers enforce", async () => {
    const coverage = emptyResearchDifferentialCoverage();
    await compareHistory([
      step("start", { variant: 1, other: 11 }),
      step("bounds", { flag: true, item: 2 }), // Set the per-worker limit to three minutes.
      step("advance", { other: 7, variant: 3 }), // Advance four minutes.
    ], coverage);
    await compareHistory([
      step("start", { variant: 2, other: 9 }), // Three workers share one minute of total worker time.
      step("advance", { other: 7 }),
    ], coverage);
    for (const type of ["bounds", "worker:turn-limit", "status:worker-time"]) expect(coverage.events[type] ?? 0, `${type} events recorded`).toBeGreaterThan(0);
    await fc.assert(fc.asyncProperty(
      fc.array(researchDifferentialBoundsStepArb, { size: "max", minLength: 15, maxLength: 40 }),
      (steps) => compareHistory(steps),
    ), { numRuns: 6 });
  });
});
