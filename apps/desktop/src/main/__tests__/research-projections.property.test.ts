import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import {
  applyResearchChanges, emptyResearchRunStore, projectResearchRun, RESEARCH_MAP_LEAVES, researchApproachLeaves, researchRunState, researchRunStoreCursor, summarizeResearchRun,
  type ResearchEvent, type ResearchRun, type ResearchRunStore, type ResearchThread,
} from "@pwragent/shared";
import { MemoryResearchStorage } from "../../../../../packages/owner-core/src/__tests__/fixtures/research-memory-storage";
import {
  nextResearchEvent, RESEARCH_JOURNAL_COORDINATOR, researchCreatedEvent, researchJournalStepArb, researchJournalWorker, type ResearchJournalStep,
} from "../../../../../packages/shared/src/__tests__/research-journal-arbitraries";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, resetSqliteWriteMetrics, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb } from "./sqlite-test-utils";

/**
 * The oracle is the journal. `MemoryResearchStorage` answers every read by
 * replaying it through `projectResearchRun`; the SQLite store answers from
 * the projections it wrote in each append's commit. They must agree after
 * every step, and so must a renderer store fed only the store's deltas.
 */
let db: StateDb;
let fixture: ReturnType<typeof createTempStateDb>;

beforeEach(() => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  fixture = createTempStateDb("pwragent-research-projections-");
  db = StateDb.open(fixture.dbPath);
  resetSqliteWriteMetrics();
});
afterEach(() => { db.close(); rmSync(fixture.tempDir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

/** Replays a journal once per revision. The comparisons below read each run hundreds of times a step and never mutate it. */
class ReplayOracle extends MemoryResearchStorage {
  private readonly replayed = new Map<string, ResearchRun>();
  override get(id: string): ResearchRun | undefined {
    const records = this.records.get(id);
    if (!records) return undefined;
    const held = this.replayed.get(id);
    if (held?.revision === records.length) return held;
    const run = projectResearchRun(id, structuredClone(records));
    this.replayed.set(id, run);
    return run;
  }
}

const RUNS = ["run-a", "run-b"] as const;
const coordinator: ResearchThread = { backend: RESEARCH_JOURNAL_COORDINATOR.backend, threadId: RESEARCH_JOURNAL_COORDINATOR.threadId };
const workers = [0, 1, 2, 3].map(researchJournalWorker);
const stranger: ResearchThread = { backend: "codex", threadId: "stranger" };
// A coordinator, a worker, a worker that coordinates the second run, and a thread in neither.
const threads = [coordinator, workers[0]!, workers[1]!, stranger];
const key = (thread: ResearchThread) => `${thread.backend}:${thread.threadId}`;

const opArb = fc.record({
  // Mostly the first run, so its journal grows long enough to pass the page and Map limits.
  run: fc.oneof({ weight: 3, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.nat(RUNS.length - 1) }),
  // Mostly appends, with the stale, repeated and conflicting commands an owner must refuse or ignore.
  kind: fc.constantFrom("append", "append", "append", "append", "append", "stale", "duplicate", "conflict"),
  // More receipts and work changes than a journal usually holds: these rewrite rows that already exist.
  step: fc.oneof(
    { weight: 5, arbitrary: researchJournalStepArb },
    { weight: 1, arbitrary: researchJournalStepArb.map((step) => ({ ...step, kind: "delivery" as const })) },
    { weight: 1, arbitrary: researchJournalStepArb.map((step) => ({ ...step, kind: "item_work" as const })) },
  ),
  pick: fc.nat(),
  limit: fc.integer({ min: 1, max: 6 }),
  sync: fc.boolean(),
  offsets: fc.record({ approachOffset: fc.nat(12), findingOffset: fc.nat(12), submissionOffset: fc.nat(12) }),
});
type Op = typeof opArb extends fc.Arbitrary<infer T> ? T : never;

function clear() {
  db.raw.exec("DELETE FROM research_deliveries; DELETE FROM research_items; DELETE FROM research_workers; DELETE FROM research_events; DELETE FROM research_runs;");
}

/** Create both runs in both storages. The second run is coordinated by a thread that works in the first. */
function createRuns(store: ResearchStore, oracle: ReplayOracle, sameInstant: boolean) {
  const created = [researchCreatedEvent(3), researchCreatedEvent(2, { at: sameInstant ? 1000 : 2000, coordinator: { ...workers[1]!, kind: "agent" } })];
  for (const [index, id] of RUNS.entries()) {
    store.create(id, `start-${id}`, created[index]!);
    oracle.create(id, `start-${id}`, created[index]!);
  }
  // The first approach starts with as many contributions as the Map shows, so the generated steps take it past that limit.
  // Two open deliveries follow, bound to queue entries, so later receipts for them settle, reopen and rebind rows that exist.
  const seeded: ResearchJournalStep[] = [
    ...Array.from({ length: RESEARCH_MAP_LEAVES }, (_, n) => ({ kind: n % 3 === 2 ? "submission" as const : "finding" as const, pick: 0, other: 0, variant: n, flag: false })),
    { kind: "delivery", pick: 0, other: 0, variant: 1, flag: true }, { kind: "delivery", pick: 1, other: 1, variant: 1, flag: true },
  ];
  for (const step of seeded) {
    const run = oracle.get(RUNS[0])!;
    const event = nextResearchEvent(run, step);
    store.append(RUNS[0], run.revision, event);
    oracle.append(RUNS[0], run.revision, event);
  }
}

/** Apply one generated operation to both storages. They must accept, ignore or refuse it alike. */
async function apply(store: ResearchStore, oracle: ReplayOracle, op: Op) {
  const id = RUNS[op.run]!;
  const run = oracle.get(id)!;
  const next = nextResearchEvent(run, op.step);
  const prior = run.events[1 + op.pick % Math.max(1, run.events.length - 1)];
  const attempt = (): [revision: number, event: ResearchEvent] => {
    if (op.kind === "stale") return op.pick % 2 ? [run.revision - 1, next] : [run.revision, { ...next, seq: next.seq + 1 }];
    if (op.kind === "duplicate" && prior) return [op.pick % 2 ? run.revision : prior.seq - 1, prior];
    if (op.kind === "conflict" && prior) return [run.revision, { ...next, commandId: prior.commandId, signature: `${prior.signature}!` }];
    return [run.revision, next];
  };
  const [revision, event] = attempt();
  const outcome = (storage: Pick<ResearchStore, "append">) => {
    try { return { appended: storage.append(id, revision, structuredClone(event)) }; }
    catch (error) { return { refused: (error as Error).message }; }
  };
  const expected = outcome(oracle);
  const measured = await measureSqliteWrites(() => outcome(store));
  expect(measured.result).toEqual(expected);
  // One structured operation is one commit, and an ignored or refused one is none.
  expect(measured.writes.commits).toBe("appended" in expected && expected.appended ? 1 : 0);
}

async function expectAgreement(store: ResearchStore, oracle: ReplayOracle, op?: Op) {
  const reads = await measureSqliteWrites(() => {
    expect(store.activeRuns()).toEqual(oracle.activeRuns());
    for (const thread of threads) {
      expect(store.activeRuns(thread)).toEqual(oracle.activeRuns(thread));
      expect(store.runSummaries(thread, 50)).toEqual(oracle.runSummaries(thread, 50));
      expect(store.runSummaries(thread, 1)).toEqual(oracle.runSummaries(thread, 1));
      expect(store.summaries(thread)).toEqual(oracle.summaries(thread));
      expect(store.isActiveWorker(thread)).toBe(oracle.isActiveWorker(thread));
    }
    for (const id of RUNS) {
      const run = oracle.get(id)!;
      expect(store.header(id)).toEqual(oracle.header(id));
      expect(store.runIdForStartKey(`start-${id}`)).toBe(id);
      expect(new Set(store.members(id).map(key))).toEqual(new Set(oracle.members(id).map(key)));
      for (const thread of threads) {
        expect(store.runSummaries(thread, 50, id)).toEqual(oracle.runSummaries(thread, 50, id));
        expect(store.isMember(id, thread)).toBe(oracle.isMember(id, thread));
        expect(store.isApproachWorker(id, thread)).toBe(oracle.isApproachWorker(id, thread));
        expect(store.approaches(id, { worker: thread })).toEqual(oracle.approaches(id, { worker: thread }));
      }
      expect(store.approaches(id, { occupying: true })).toEqual(oracle.approaches(id, { occupying: true }));
      expect(store.underwayItems(id)).toEqual(oracle.underwayItems(id));
      for (const decision of [undefined, "accepted", "revision_requested", "rejected"] as const) expect(store.hasSubmission(id, decision)).toBe(oracle.hasSubmission(id, decision));
      for (const item of run.items) expect(store.readItem(id, item.id)).toEqual(item);
      expect(store.readItem(id, "missing")).toBeUndefined();
      for (const delivery of run.deliveries) expect(store.delivery(id, delivery.id)).toEqual(delivery);
      expect(store.delivery(id, "missing")).toBeUndefined();
      expect(store.deliveries(id, { open: true })).toEqual(oracle.deliveries(id, { open: true }));
      for (const queueEntryId of ["queue-0", "queue-1", "queue-2", "missing"]) expect(store.deliveries(id, { queueEntryId })).toEqual(oracle.deliveries(id, { queueEntryId }));
      for (const event of run.events.slice(-3)) expect(store.findCommand(id, event.commandId)).toEqual(event);
      expect(store.events(id, { limit: 4 })).toEqual(oracle.events(id, { limit: 4 }));
      expect(store.search(id, { type: "finding", limit: 5 })).toEqual(oracle.search(id, { type: "finding", limit: 5 }));
      // Search reads the columns an update rewrites, so ask for the items changed last by what they now say and by what they said before.
      for (const item of run.items.filter((entry) => entry.version > run.revision - 2)) {
        const earlier = item.version > 1 ? projectResearchRun(id, run.events.slice(0, item.version - 1)).items.find((entry) => entry.id === item.id) : undefined;
        for (const state of [item, earlier]) {
          if (!state) continue;
          for (const query of [{ state: state.work.state }, ...(state.work.note ? [{ query: state.work.note }] : []), ...(state.work.assignee ? [{ assignee: state.work.assignee }] : [])]) {
            expect(store.search(id, { ...query, limit: 5 })).toEqual(oracle.search(id, { ...query, limit: 5 }));
          }
        }
      }
      const offsets = op?.offsets ?? { approachOffset: 0, findingOffset: 0, submissionOffset: 0 };
      expect(store.board(id, offsets)).toEqual(oracle.board(id, offsets));
    }
    expect(store.header("missing")).toBeUndefined();
    expect(store.board("missing", { approachOffset: 0, findingOffset: 0, submissionOffset: 0 })).toBeUndefined();
  });
  // Reads never repair or write.
  expect(reads.writes.commits).toBe(0);
}

/** Every page of a delta at this page size, and of a full read, is the page replay gives. */
async function expectChangesAgree(store: ResearchStore, oracle: ReplayOracle, limit: number) {
  const reads = await measureSqliteWrites(() => {
    for (const id of RUNS) {
      const revision = oracle.get(id)!.revision;
      for (const from of [0, Math.max(0, revision - 3), revision, revision + 5]) {
        let since = from;
        let after: { version: number; id: string } | undefined;
        do {
          const page = store.changes(id, since, after, limit);
          expect(page).toEqual(oracle.changes(id, since, after, limit));
          // A reset empties the reader's store, so it asks for the rest from revision 0.
          if (page!.reset) since = 0;
          after = page!.next;
        } while (after);
      }
    }
    expect(store.changes("missing")).toBeUndefined();
  });
  expect(reads.writes.commits).toBe(0);
}

/** Bring a renderer store up to date from the SQLite store alone, as the panel does. */
function sync(store: ResearchStore, held: ResearchRunStore, limit: number): ResearchRunStore {
  do {
    const cursor = researchRunStoreCursor(held);
    held = applyResearchChanges(held, { ...store.changes(held.runId, cursor.sinceRevision, cursor.after, limit)!, writable: true });
  } while (held.cursor);
  return held;
}

function expectStoreHoldsRun(held: ResearchRunStore, run: ResearchRun) {
  expect(held.revision).toBe(run.revision);
  expect(held.items).toEqual(new Map(run.items.map((item) => [item.id, item])));
  expect(held.approaches).toEqual(run.approaches);
  expect(held.submissions).toEqual(run.submissions);
  expect(held.state).toEqual(researchRunState(run));
  expect(held.leaves).toEqual(new Map(researchApproachLeaves(run).map((entry) => [entry.approachId, entry])));
  const { unreviewed, accepted, status, reason, activeWorkers, revision } = summarizeResearchRun(run);
  expect(held.state).toMatchObject({ unreviewed, accepted, status, activeWorkers, revision, ...(reason !== undefined ? { reason } : {}) });
}

describe("research projections", () => {
  it("every stored read agrees with replaying the journal after every step, and no read writes", async () => {
    await fc.assert(fc.asyncProperty(fc.array(opArb, { size: "max", minLength: 10, maxLength: 24 }), fc.boolean(), async (ops, sameInstant) => {
      clear();
      const store = new ResearchStore(db);
      const oracle = new ReplayOracle();
      createRuns(store, oracle, sameInstant);
      await expectAgreement(store, oracle);
      for (const op of ops) {
        await apply(store, oracle, op);
        await expectAgreement(store, oracle, op);
      }
      // The journal itself is what both sides were given.
      for (const id of RUNS) expect(store.get(id)).toEqual(oracle.get(id));
    }), { numRuns: 25 });
  });

  it("the change stream, applied to an empty renderer store or to one a few steps behind, gives the replayed run after every step", async () => {
    await fc.assert(fc.asyncProperty(fc.array(opArb, { size: "max", minLength: 10, maxLength: 40 }), async (ops) => {
      clear();
      const store = new ResearchStore(db);
      const oracle = new ReplayOracle();
      createRuns(store, oracle, false);
      const held = new Map(RUNS.map((id) => [id, emptyResearchRunStore(id)]));
      for (const op of ops) {
        await apply(store, oracle, op);
        await expectChangesAgree(store, oracle, op.limit);
        for (const id of RUNS) {
          const run = oracle.get(id)!;
          // An empty store reads the whole run; the held one syncs after some steps and not others, so its delta spans one change or many.
          expectStoreHoldsRun(sync(store, emptyResearchRunStore(id), op.limit), run);
          if (!op.sync) continue;
          held.set(id, sync(store, held.get(id)!, op.limit));
          expectStoreHoldsRun(held.get(id)!, run);
        }
      }
    }), { numRuns: 25 });
  });

  it("a database from before the projections is backfilled once, to what replay gives, and later opens write nothing", async () => {
    await fc.assert(fc.asyncProperty(fc.array(opArb, { size: "max", minLength: 10, maxLength: 40 }), async (ops) => {
      clear();
      const oracle = new ReplayOracle();
      createRuns(new ResearchStore(db), oracle, false);
      for (const op of ops) await apply(new ResearchStore(db), oracle, op);
      // The schema this change found: no reason, version, slot or worker columns, and no deliveries table.
      db.raw.exec(`DROP INDEX idx_research_items_version; DROP INDEX idx_research_items_slot; DROP INDEX idx_research_items_worker;
        ALTER TABLE research_items DROP COLUMN version; ALTER TABLE research_items DROP COLUMN occupies_slot;
        ALTER TABLE research_items DROP COLUMN worker_backend; ALTER TABLE research_items DROP COLUMN worker_thread_id;
        ALTER TABLE research_runs DROP COLUMN reason; DROP TABLE research_deliveries; DROP INDEX idx_research_events_delivery_failed;`);
      db.close();
      db = StateDb.open(fixture.dbPath);
      await expectAgreement(new ResearchStore(db), oracle);
      await expectChangesAgree(new ResearchStore(db), oracle, 3);
      db.close();
      const reopened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
      db = reopened.result;
      expect(reopened.writes.commits).toBe(0);
      await expectAgreement(new ResearchStore(db), oracle);
    }), { numRuns: 8 });
  });

  it("reads the newest delivery failures through their index, not a scan of the journal", () => {
    const plan = db.raw.prepare(`EXPLAIN QUERY PLAN SELECT payload FROM research_events WHERE run_id = ? AND json_extract(payload, '$.data.type') = 'delivery_failed'
      ORDER BY seq DESC LIMIT ?`).all("run", 3) as { detail: string }[];
    expect(plan.map((row) => row.detail).join("\n")).toContain("idx_research_events_delivery_failed");
    const changes = db.raw.prepare("EXPLAIN QUERY PLAN SELECT payload FROM research_items WHERE run_id = ? AND version > ? ORDER BY version, item_id LIMIT ?").all("run", 1, 10) as { detail: string }[];
    expect(changes.map((row) => row.detail).join("\n")).toContain("idx_research_items_version");
    expect(changes.map((row) => row.detail).join("\n")).not.toContain("TEMP B-TREE");
  });
});
