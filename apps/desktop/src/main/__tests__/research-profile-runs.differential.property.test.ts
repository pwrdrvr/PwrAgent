import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import {
  projectResearchRun,
  RESEARCH_RUN_ATTENTION_ORDER,
  researchRunAttention,
  summarizeResearchRun,
  type ResearchEvent,
  type ResearchProfileRunsCursor,
  type ResearchProfileRunsQuery,
  type ResearchRun,
} from "@pwragent/shared/research";
import { RESEARCH_HARNESS_REVISION, type ResearchHarnessState } from "@pwragent/shared/research-harness";
import { ResearchService } from "@pwragent/owner-core/research-service";
import { MemoryResearchStorage } from "../../../../../packages/owner-core/src/__tests__/fixtures/research-memory-storage";
import { nextResearchEvent, researchCreatedEvent, researchJournalStepArb } from "../../../../../packages/shared/src/__tests__/research-journal-arbitraries";
import { measureSqliteWrites, resetSqliteWriteMetrics, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { openInMemoryStateDb } from "./sqlite-test-utils";

beforeEach(() => { vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1"); resetSqliteWriteMetrics(); });
afterEach(() => vi.unstubAllEnvs());

const HARNESS_STATES: ResearchHarnessState["state"][] = ["pending", "running", "imported", "unknown", "stopping", "stopped", "ended", "reconciling"];
const STATUSES: ResearchRun["status"][] = ["stopping", "completed", "deadline", "stopped", "exhausted", "interrupted"];
const runArb = fc.record({
  approaches: fc.integer({ min: 1, max: 3 }),
  // Few distinct instants, so ties in creation time are common and the ID decides.
  createdAt: fc.integer({ min: 1, max: 4 }),
  objective: fc.constantFrom("Queue ordering", "queue OWNER lifetime", "Cache flake", "Release changelog"),
  steps: fc.array(researchJournalStepArb, { maxLength: 8 }),
  harness: fc.option(fc.record({ mode: fc.constantFrom<"execute" | "import">("execute", "import"), source: fc.constantFrom<"swarm" | "discovery" | undefined>(undefined, "swarm", "discovery"),
    state: fc.constantFrom(...HARNESS_STATES) }), { nil: undefined }),
  status: fc.option(fc.constantFrom(...STATUSES), { nil: undefined }),
});
const queryArb = fc.record({ source: fc.constantFrom<ResearchProfileRunsQuery["source"]>(undefined, "native", "harness"), text: fc.constantFrom(undefined, "queue", "OWNER", "  flake ", "nothing matches"),
  limit: fc.integer({ min: 1, max: 5 }) });

/** One run's journal: a native journal, optionally from a Harness source, optionally retired. */
type RunSpec = typeof runArb extends fc.Arbitrary<infer T> ? T : never;
function journal(id: string, spec: RunSpec): ResearchEvent[] {
  const created = researchCreatedEvent(spec.approaches, { at: spec.createdAt });
  if (created.data.type !== "created") throw new Error("Expected a created event");
  created.data.objective = spec.objective;
  const harness = (state: ResearchHarnessState["state"]): ResearchHarnessState => ({ version: 1, mode: spec.harness!.mode, project: "p", session: "s", swarm: "w", workspace: "/w",
    upstreamRevision: RESEARCH_HARNESS_REVISION, state, cursor: 0, members: [], cancelSupported: false, note: "", ...(spec.harness!.source ? { source: spec.harness!.source } : {}) });
  if (spec.harness) created.data.harness = harness("pending");
  const events = [created];
  for (const step of spec.steps) events.push(nextResearchEvent(projectResearchRun(id, events), step));
  const push = (data: ResearchEvent["data"]) => events.push({ seq: events.length + 1, at: 5000 + events.length, actor: created.actor, commandId: `tail:${events.length}`, signature: "tail", data });
  if (spec.harness) push({ type: "harness", state: harness(spec.harness.state) });
  if (spec.status) push({ type: "status", status: spec.status, reason: "Generated" });
  return events;
}

/**
 * The run list ranks in SQL so a page is bounded however many runs exist. The
 * rule it ranks by is `researchRunAttention`. Whatever the journals, filters
 * and page size, walking the store's pages must give exactly the runs, order,
 * groups and counts the rule gives over replayed runs, and reading never writes.
 */
it("pages every run by the shared attention rule, newest first, and never writes", async () => {
  const db = openInMemoryStateDb();
  try {
    await fc.assert(fc.asyncProperty(fc.array(runArb, { minLength: 1, maxLength: 9 }), queryArb, async (specs, query) => {
      db.raw.exec("DELETE FROM research_deliveries; DELETE FROM research_items; DELETE FROM research_workers; DELETE FROM research_events; DELETE FROM research_runs;");
      const store = new ResearchStore(db);
      const oracle = new MemoryResearchStorage();
      specs.forEach((spec, index) => {
        const id = `run-${index}`;
        const [created, ...rest] = journal(id, spec);
        for (const storage of [store, oracle]) { storage.create(id, id, created!); if (rest.length) storage.appendBatch(id, 1, rest); }
      });
      const filters = { ...(query.source ? { source: query.source } : {}), ...(query.text ? { text: query.text } : {}) };
      const walk = (storage: ResearchStore | MemoryResearchStorage) => {
        const seen: Array<{ id: string; attention: string }> = [];
        let after: ResearchProfileRunsCursor | undefined;
        let counts: unknown;
        for (;;) {
          const page = storage.profileRuns({ ...filters, ...(after ? { after } : {}) }, query.limit);
          counts = page.counts;
          for (const run of page.runs) {
            // Each row is the run's own summary, and its group is the shared rule's answer for that summary.
            expect(run).toEqual({ ...summarizeResearchRun(oracle.get(run.id)!), attention: researchRunAttention(run) });
            seen.push({ id: run.id, attention: run.attention });
          }
          const last = page.runs.at(-1);
          if (page.runs.length < query.limit || !last) return { seen, counts };
          after = { attention: last.attention, createdAt: last.createdAt, id: last.id };
        }
      };
      const measured = await measureSqliteWrites(() => walk(store));
      expect(measured.result).toEqual(walk(oracle));
      expect(measured.writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0 });
      // Groups come in order, and no run is listed twice across pages.
      const ranks = measured.result.seen.map((run) => RESEARCH_RUN_ATTENTION_ORDER.indexOf(run.attention as typeof RESEARCH_RUN_ATTENTION_ORDER[number]));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      expect(new Set(measured.result.seen.map((run) => run.id)).size).toBe(measured.result.seen.length);
    }), { numRuns: 120 });
  } finally { db.close(); }
});

it("gives the owner's page a cursor only when more runs remain, and names the runs this process may act on", () => {
  const db = openInMemoryStateDb();
  try {
    const store = new ResearchStore(db);
    for (let index = 0; index < 52; index++) {
      const created = researchCreatedEvent(1, { at: 1000 + index });
      if (created.data.type === "created") created.data.ownerId = index % 2 ? "this-owner" : "another-owner";
      store.create(`run-${String(index).padStart(2, "0")}`, `key-${index}`, created);
    }
    const service = new ResearchService(store, { ownerId: "this-owner", ownerPid: 1, ownerStartedAt: 1, isOwnerAlive: () => true, spawn: async () => { throw new Error("Reads must not dispatch"); },
      stop: async () => {}, notify: async () => ({}), cancelQueued: async () => ({}), changed: () => {}, schedule: () => () => {}, onError: () => {} });
    try {
      const first = service.profileRuns({});
      expect(first.runs).toHaveLength(50);
      expect(first.counts).toEqual({ needs_you: 0, live: 52, retained: 0 });
      expect(first.runs[0]!.id).toBe("run-51");
      expect(first.writableRunIds).toEqual(first.runs.filter((run) => run.ownerId === "this-owner").map((run) => run.id));
      const second = service.profileRuns({ after: first.nextCursor });
      expect(second.runs.map((run) => run.id)).toEqual(["run-01", "run-00"]);
      expect(second.nextCursor).toBeUndefined();
    } finally { service.close(); }
  } finally { db.close(); }
});
