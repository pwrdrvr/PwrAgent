import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import type { ResearchEvent } from "@pwragent/shared";
import {
  emptyResearchDifferentialCoverage, expectResearchServicesAgree, researchDifferentialStepArb,
} from "../../../../../packages/owner-core/src/__tests__/fixtures/research-differential";
import { StateDb } from "../state/state-db";
import { createTempStateDb } from "./sqlite-test-utils";

const uuid = vi.hoisted(() => ({ next: (): string => "00000000-0000-4000-8000-ffffffffffff" }));
vi.mock("node:crypto", async (importOriginal) => ({ ...await importOriginal<typeof import("node:crypto")>(), randomUUID: () => uuid.next() }));

let db: StateDb;
let fixture: ReturnType<typeof createTempStateDb>;
beforeEach(() => { fixture = createTempStateDb("pwragent-research-differential-"); db = StateDb.open(fixture.dbPath); });
afterEach(() => { db.close(); rmSync(fixture.tempDir, { recursive: true, force: true }); });

describe("research service on the SQLite projections", () => {
  it("accepts, refuses and records exactly what the replay-based service does, without replaying a journal", async () => {
    const coverage = emptyResearchDifferentialCoverage();
    await fc.assert(fc.asyncProperty(fc.array(researchDifferentialStepArb, { size: "max", minLength: 15, maxLength: 40 }), async (steps) => {
      db.raw.exec("DELETE FROM research_deliveries; DELETE FROM research_items; DELETE FROM research_workers; DELETE FROM research_events; DELETE FROM research_runs;");
      // The journal as stored, read apart from the storage the service holds.
      const journal = (id: string) => {
        const rows = db.raw.prepare("SELECT payload FROM research_events WHERE run_id = ? ORDER BY seq").all(id) as { payload: string }[];
        return rows.length ? rows.map((row) => JSON.parse(row.payload) as ResearchEvent) : undefined;
      };
      await expectResearchServicesAgree(uuid, steps, new ResearchStore(db), journal, coverage);
    }), { numRuns: 25 });
    for (const type of ["worker", "status", "finding", "submission", "review", "item_work", "delivery"]) expect(coverage.events[type] ?? 0, `${type} events recorded`).toBeGreaterThan(0);
    expect(Object.keys(coverage.refusals).length).toBeGreaterThan(10);
  });
});
