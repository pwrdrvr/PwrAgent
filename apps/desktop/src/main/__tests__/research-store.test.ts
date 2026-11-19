import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { ResearchService, type ResearchPorts } from "@pwragent/owner-core/research-service";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import { projectResearchRun, researchEventPage, searchResearchItems, summarizeResearchRun, type ResearchActor, type ResearchApproach, type ResearchEvent, type ResearchEventData, type ResearchSearchQuery } from "@pwragent/shared";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, resetSqliteWriteMetrics, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb } from "./sqlite-test-utils";

let db: StateDb;
let fixture: ReturnType<typeof createTempStateDb>;
const actor = { backend: "codex", threadId: "coordinator", kind: "agent", turnId: "parent-turn", callId: "start" } as const;
const request = { objective: "Investigate race conditions", minutes: 10, workspaceMode: "none",
  approaches: [{ title: "Events", task: "Trace events" }, { title: "Lifetime", task: "Trace owners" }, { title: "Persistence", task: "Trace commits" }] } as const;
const mutableRequest = () => ({ ...request, approaches: [...request.approaches] });

beforeEach(() => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  fixture = createTempStateDb("pwragent-research-");
  db = StateDb.open(fixture.dbPath);
  resetSqliteWriteMetrics();
});
afterEach(() => { db.close(); rmSync(fixture.tempDir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

function createService(overrides: Partial<ResearchPorts> = {}, storage = new ResearchStore(db)) {
  let worker = 0;
  const service = new ResearchService(storage, {
    ownerId: "owner", ownerPid: 123, ownerStartedAt: 500, isOwnerAlive: () => false, now: () => 1000,
    schedule: () => () => {}, changed: () => {}, onError: (error) => { throw error; },
    stop: async () => {}, notify: async () => ({}), cancelQueued: async () => ({}),
    spawn: async (_context, _task, _title, _mode, created) => {
      const result = { backend: "codex" as const, threadId: `worker-${++worker}`, turnId: `turn-${worker}` };
      created({ backend: result.backend, threadId: result.threadId });
      service.observeStart(result, result.turnId);
      return result;
    },
    ...overrides,
  });
  return service;
}

/** Start a run and replay it, for the worker bindings and items a test then acts on. */
async function startRun(service: ResearchService, start: Parameters<ResearchService["start"]>[0] = mutableRequest(), context: Parameters<ResearchService["start"]>[1] = actor) {
  return service.read((await service.start(start, context)).id, actor);
}

describe("research journal storage", () => {
  it("budgets disabling the experiment as one existing stop lifecycle with no new idle writes", async () => {
    let enabled = true;
    const service = createService({ enabled: () => enabled });
    const run = await service.start(mutableRequest(), actor);
    const stopped = await measureSqliteWrites(async () => { enabled = false; await service.stopOwnedRuns("Research disabled"); });
    expectSqliteWriteBudget({ scenario: "research-experiment-disable", note: "Explicitly disabling research stops three workers through the existing stop lifecycle. No setting polling or idle writes.", writes: stopped.writes });
    expect(new ResearchStore(db).get(run.id)?.status).toBe("stopped");
    const idle = await measureSqliteWrites(async () => { for (let i = 0; i < 20; i++) await service.stopOwnedRuns("Still disabled"); });
    expect(idle.writes.commits).toBe(0);
  });

  it("matches indexed filters and cursor pages to an independent journal projection", async () => {
    const service = createService();
    const run = await service.start(mutableRequest(), actor);
    for (const [i, text] of ["Queue reversal", "OWNER lifetime", "100%_literal", "ÉTUDE α", "quoted ' evidence"].entries()) {
      await service.update(run.id, `query-${i}`, { action: "finding", approachId: i % 2 ? "a2" : "a1", kind: i % 2 ? "counterexample" : "note", text, paths: [] }, actor);
    }
    for (let i = 0; i < 3; i++) await service.update(run.id, `candidate-${i}`, { action: "submit", approachId: "a1", text: `Candidate ${i}`, paths: [] }, actor);
    const initial = service.read(run.id, actor);
    await service.update(run.id, "verdict", { action: "review", submissionId: initial.submissions[0]!.id, decision: "accepted", reason: "Informal review" }, actor);
    const item = service.readItem(run.id, initial.findings[0]!.id, actor).item;
    await service.work(run.id, "claim", { action: "work", itemId: item.id, expectedVersion: item.version, state: "claimed", reason: "Investigating" }, actor);
    const journal = service.read(run.id, actor);
    const store = new ResearchStore(db);
    fc.assert(fc.property(fc.record({ query: fc.constantFrom(undefined, "queue", "owner", "%_", "étude", "'", "no match"),
      type: fc.constantFrom(undefined, "approach", "finding", "submission"), kind: fc.constantFrom(undefined, "note", "counterexample"),
      review: fc.constantFrom(undefined, "unreviewed", "accepted"), state: fc.constantFrom(undefined, "open", "claimed"),
      approachId: fc.constantFrom(undefined, "a1", "a2"), limit: fc.integer({ min: 1, max: 3 }),
    }), (query) => {
      const filters = query as ResearchSearchQuery;
      let expected = searchResearchItems(run.id, journal.items, journal.revision, filters);
      let actual = store.search(run.id, filters);
      expect(actual).toEqual(expected);
      while (expected.nextCursor) {
        expected = searchResearchItems(run.id, journal.items, journal.revision, { ...filters, cursor: expected.nextCursor });
        actual = store.search(run.id, { ...filters, cursor: actual.nextCursor });
        expect(actual).toEqual(expected);
      }
    }), { numRuns: 60 });
  });

  it("focuses reads, search and progress without loading a run journal or writing on reads", async () => {
    const store = new ResearchStore(db);
    const service = createService({}, store);
    const run = await service.start(mutableRequest(), actor);
    await service.update(run.id, "source", { action: "finding", approachId: "a1", kind: "note", text: "Focused evidence", paths: [] }, actor);
    const source = service.read(run.id, actor).findings[0]!;
    const journal = vi.spyOn(store, "get").mockImplementation(() => { throw new Error("Focused operations must not load the journal"); });
    try {
      const reads = await measureSqliteWrites(() => {
        for (let i = 0; i < 50; i++) {
          expect(service.readItem(run.id, source.id, actor).item.record).toMatchObject({ text: "Focused evidence" });
          expect(service.search(run.id, { query: "Focused", type: "finding" }, actor).items).toHaveLength(1);
          expect(service.summaries(actor).map((entry) => entry.id)).toContain(run.id);
          expect(store.runSummaries(actor, 50).map((entry) => entry.id)).toContain(run.id);
          expect(service.readEvents(run.id, { limit: 2 }, actor).events.map((event) => event.seq)).toEqual([run.revision + 1, run.revision]);
        }
      });
      expectSqliteWriteBudget({ scenario: "research-item-focused-reads", note: "Fifty direct item/context reads and indexed searches. No journal replay, repair writes or polling commits.", writes: reads.writes });
      const item = service.readItem(run.id, source.id, actor).item;
      const command = { action: "work", itemId: item.id, expectedVersion: item.version, state: "claimed", reason: "Taking this item" } as const;
      const claim = await measureSqliteWrites(async () => await service.work(run.id, "claim", command, actor));
      expectSqliteWriteBudget({ scenario: "research-item-claim", note: "One optimistic claim, journal and item projection in the same commit.", writes: claim.writes });
      const duplicate = await measureSqliteWrites(async () => {
        await service.work(run.id, "claim", command, actor);
        await expect(service.work(run.id, "stale", command, actor)).rejects.toThrow("changed");
      });
      expectSqliteWriteBudget({ scenario: "research-item-redelivery-and-stale", note: "A duplicate claim and a rejected stale version cause zero commits.", writes: duplicate.writes });
      expect(journal).not.toHaveBeenCalled();
    } finally { journal.mockRestore(); }
  });

  it("pages the stored journal and summarizes runs as projectResearchRun does while the board changes between page reads", () => {
    const store = new ResearchStore(db);
    let runCount = 0;
    const step = fc.oneof(
      fc.record({ type: fc.constant("finding" as const), approach: fc.integer({ min: 1, max: 2 }) }),
      fc.record({ type: fc.constant("submission" as const), approach: fc.integer({ min: 1, max: 2 }) }),
      fc.record({ type: fc.constant("review" as const), pick: fc.nat(), decision: fc.constantFrom("accepted" as const, "revision_requested" as const, "rejected" as const) }),
      fc.record({ type: fc.constant("worker" as const), approach: fc.integer({ min: 1, max: 2 }), state: fc.constantFrom<ResearchApproach["state"]>("running", "ended", "failed") }),
    );
    // Each read pages down from the newest event; appends between reads must not shift, repeat or skip a page.
    const op = fc.oneof(fc.record({ append: fc.array(step, { minLength: 1, maxLength: 6 }) }), fc.record({ read: fc.integer({ min: 1, max: 5 }) }));
    fc.assert(fc.property(fc.array(op, { minLength: 8, maxLength: 30 }), (ops) => {
      const id = `paged-${++runCount}`;
      const records: ResearchEvent[] = [];
      const append = (data: ResearchEventData) => {
        const event: ResearchEvent = { seq: records.length + 1, commandId: `c${records.length + 1}`, signature: "s", at: 1000 + records.length, actor, data };
        if (event.seq === 1) store.create(id, id, event); else store.append(id, records.length, event);
        records.push(event);
      };
      append({ type: "created", objective: "Paged", coordinator: actor, ownerId: "owner", ownerPid: 1, deadlineAt: 10_000, workspaceMode: "none",
        approaches: [{ id: "a1", title: "One", task: "t", state: "pending" }, { id: "a2", title: "Two", task: "t", state: "pending" }] });
      let cursor: { before?: number; seen: number[]; top: number } | undefined;
      for (const entry of ops) {
        if ("append" in entry) {
          for (const s of entry.append) {
            const seq = records.length + 1;
            const submissions = records.flatMap((e) => e.data.type === "submission" ? [e.data.submission.id] : []);
            if (s.type === "review" && submissions.length) append({ type: "review", submissionId: submissions[s.pick % submissions.length]!, decision: s.decision, reason: "r" });
            else if (s.type === "worker") append({ type: "worker", approachId: `a${s.approach}`, state: s.state });
            else if (s.type === "submission") append({ type: "submission", submission: { id: `s${seq}`, approachId: `a${s.approach}`, text: `Candidate ${seq}`, paths: [] } });
            else append({ type: "finding", finding: { id: `f${seq}`, approachId: `a${"approach" in s ? s.approach : 1}`, kind: "note", text: `Finding ${seq}`, paths: [] } });
          }
          continue;
        }
        const projected = projectResearchRun(id, structuredClone(records));
        const range = cursor?.before !== undefined ? { beforeSeq: cursor.before, limit: entry.read } : { limit: entry.read };
        const page = store.events(id, range);
        expect(page).toEqual(researchEventPage(projected, range));
        cursor ??= { seen: [], top: page.events[0]?.seq ?? 0 };
        cursor.seen.push(...page.events.map((event) => event.seq));
        cursor.before = page.nextBeforeSeq;
        if (cursor.before === undefined) {
          // A completed walk is exactly the journal as of its first page, newest first, whatever was appended since.
          expect(cursor.seen).toEqual(projected.events.slice(0, cursor.top).map((event) => event.seq).reverse());
          cursor = undefined;
        }
        expect(store.runSummaries(actor, 50).find((summary) => summary.id === id)).toEqual(summarizeResearchRun(projected));
      }
    }), { numRuns: 30 });
  });

  it("keeps search metadata and results on one SQLite snapshot during a concurrent append", async () => {
    const service = createService();
    const run = await service.start(mutableRequest(), actor);
    const reader = new ResearchStore(db);
    const second = StateDb.open(fixture.dbPath);
    const writer = new ResearchStore(second);
    const original = reader.header.bind(reader);
    let append = true;
    const observation = vi.spyOn(reader, "header").mockImplementation((id) => {
      const header = original(id)!;
      if (append) {
        append = false;
        writer.append(id, header.revision, { seq: header.revision + 1, commandId: "concurrent", signature: "concurrent", at: 1000, actor,
          data: { type: "finding", finding: { id: "concurrent-item", approachId: "a1", kind: "note", text: "Concurrent evidence", paths: [] } } });
      }
      return header;
    });
    try {
      expect(reader.search(run.id, { type: "finding" })).toMatchObject({ revision: run.revision, total: 0, items: [] });
      expect(reader.search(run.id, { type: "finding" })).toMatchObject({ revision: run.revision + 1, total: 1, items: [{ id: "concurrent-item" }] });
    } finally { observation.mockRestore(); second.close(); }
  });

  it("rebuilds item projections from retained journals once, and reopening stays read-only", async () => {
    const service = createService();
    const run = await service.start(mutableRequest(), actor);
    await service.update(run.id, "source", { action: "finding", approachId: "a1", kind: "experiment", text: "Retained evidence", paths: [] }, actor);
    const before = service.read(run.id, actor);
    db.raw.exec("DROP TABLE research_items");
    db.close();
    db = StateDb.open(fixture.dbPath);
    const store = new ResearchStore(db);
    expect(store.search(run.id, { limit: 20 })).toEqual(searchResearchItems(run.id, before.items, before.revision, { limit: 20 }));
    expect(store.get(run.id)).toEqual(before);
    db.close();
    const reopened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
    db = reopened.result;
    expect(reopened.writes.commits).toBe(0);
  });

  it.each(["source", "approach"] as const)("budgets one focused child admission and exact %s item cancellation", async (target) => {
    const service = createService();
    const run = await startRun(service);
    await service.update(run.id, "source", { action: "finding", approachId: "a1", kind: "note", text: "Investigate this item", paths: [] }, actor);
    const source = service.read(run.id, actor).findings[0]!;
    service.observeEnd(run.approaches[0]!.worker!, run.approaches[0]!.worker!.turnId!);
    const item = service.readItem(run.id, source.id, actor).item;
    const assignment = await measureSqliteWrites(async () => await service.assign({ runId: run.id, itemId: item.id, expectedVersion: item.version, task: "Investigate only this evidence" }, { ...actor, callId: "assign" }));
    expect(assignment.result.worker?.threadId).toBe("worker-4");
    expectSqliteWriteBudget({ scenario: "research-item-assignment", note: "One child intent, starting boundary, durable binding and provider admission; projection updates share each journal commit.", writes: assignment.writes });
    const current = service.readItem(run.id, target === "source" ? item.id : assignment.result.assignmentId, actor).item;
    const cancelled = await measureSqliteWrites(async () => await service.work(run.id, "cancel", { action: "work", itemId: current.id, expectedVersion: current.version, state: "cancelled", reason: "Stop this assignment" }, actor));
    expect(cancelled.result.work.state).toBe("cancelled");
    expectSqliteWriteBudget({ scenario: target === "source" ? "research-item-cancel" : "research-focused-approach-cancel", note: "Durable cancellation request, exact worker acknowledgement and item settlement. An unknown outcome would retain cancel_requested.", writes: cancelled.writes });
  });

  it("budgets settling both cancelled references to one focused assignment", async () => {
    const service = createService({ stop: async () => { throw new Error("Lost cancellation response"); } });
    const run = await startRun(service);
    await service.update(run.id, "source", { action: "finding", approachId: "a1", kind: "note", text: "Source evidence", paths: [] }, actor);
    service.observeEnd(run.approaches[0]!.worker!, run.approaches[0]!.worker!.turnId!);
    const source = service.readItem(run.id, service.read(run.id, actor).findings[0]!.id, actor).item;
    const child = await service.assign({ runId: run.id, itemId: source.id, expectedVersion: source.version, task: "Investigate" }, { ...actor, callId: "child" });
    for (const id of [source.id, child.assignmentId]) {
      const item = service.readItem(run.id, id, actor).item;
      await service.work(run.id, `cancel-${id}`, { action: "work", itemId: id, expectedVersion: item.version, state: "cancelled", reason: "Cancel this assignment" }, actor);
    }
    const settled = await measureSqliteWrites(() => service.observeEnd(child.worker!, child.worker!.turnId!));
    expect(service.readItem(run.id, source.id, actor).item.work.state).toBe("cancelled");
    expect(service.readItem(run.id, child.assignmentId, actor).item.work.state).toBe("cancelled");
    expectSqliteWriteBudget({ scenario: "research-focused-cancel-both-references", note: "One exact worker terminal event and one settlement per requested item: source evidence and focused approach. No duplicate settlement writes.", writes: settled.writes });
  });
  it("retains the board and exact review provenance after reopening a real database", async () => {
    const service = createService();
    const run = await startRun(service);
    const worker: ResearchActor = { ...run.approaches[0]!.worker!, kind: "agent", callId: "post" };
    await service.update(run.id, "finding", { action: "finding", approachId: "a1", kind: "experiment", text: "Ordering reproduced the failure", paths: ["evidence/result.txt"] }, worker);
    await service.update(run.id, "candidate", { action: "submit", approachId: "a1", text: "Preserve event order", paths: [] }, actor);
    const submission = service.read(run.id, actor).submissions[0]!;
    await service.update(run.id, "review", { action: "review", submissionId: submission.id, decision: "accepted", reason: "Reproduction supports it" }, actor);
    const before = service.read(run.id, actor);
    expect(new ResearchStore(db).runSummaries(worker, 50).map((r) => r.id)).toContain(run.id);
    db.close();
    db = StateDb.open(fixture.dbPath);
    const after = new ResearchStore(db).get(run.id)!;
    expect(after).toEqual(before);
    expect(after.findings[0]).toMatchObject({ text: "Ordering reproduced the failure", author: { backend: worker.backend, threadId: worker.threadId } });
    expect(after.submissions[0]?.review?.actor).toEqual(actor);
  });

  it("refuses a stale append from a second database connection and conflicting command reuse", async () => {
    const service = createService();
    const run = await service.start(mutableRequest(), actor);
    const second = StateDb.open(fixture.dbPath);
    try {
      const staleStore = new ResearchStore(second);
      const stale = staleStore.get(run.id)!;
      await service.update(run.id, "post", { action: "finding", approachId: "a1", kind: "note", text: "Evidence", paths: [] }, actor);
      const event: ResearchEvent = { seq: stale.revision + 1, commandId: "other", signature: "other", at: 1000, actor, data: { type: "status", status: "stopped", reason: "stale" } };
      expect(() => staleStore.append(run.id, stale.revision, event)).toThrow("changed");
      const stored = staleStore.get(run.id)!;
      expect(stored.status).toBe("running");
      const last = stored.events.at(-1)!;
      expect(() => staleStore.append(run.id, stored.revision, { ...last, signature: "different" })).toThrow("reused");
      staleStore.append(run.id, stored.revision, last);
      expect(staleStore.get(run.id)?.revision).toBe(stored.revision);
    } finally { second.close(); }
  });

  it("budgets worker startup and explicit findings, with zero writes for reads and redelivery", async () => {
    const service = createService();
    const start = await measureSqliteWrites(async () => await service.start(mutableRequest(), actor));
    expectSqliteWriteBudget({ scenario: "research-start-three-workers", note: "One run and three managed worker admissions; no provider transcripts or token events.", writes: start.writes });
    const run = service.read(start.result.id, actor);
    const command = { action: "finding", approachId: "a1", kind: "note", text: "Evidence", paths: [] } as const;
    const post = await measureSqliteWrites(async () => await service.update(run.id, "post", { ...command, paths: [] }, actor));
    expectSqliteWriteBudget({ scenario: "research-finding", note: "One explicit structured finding. No polling writes. Project using observed bytes per commit at one finding/minute, not one streamed token/event.", writes: post.writes });
    const idle = await measureSqliteWrites(async () => {
      for (let i = 0; i < 100; i++) {
        service.snapshot(actor);
        service.snapshot({ ...actor, runId: run.id });
        service.changes(run.id, undefined, undefined, actor);
        service.changes(run.id, run.revision, undefined, actor);
        service.readBoard(run.id, { approachOffset: 0, findingOffset: 0, submissionOffset: 0 }, actor);
        service.read(run.id, actor);
        await service.update(run.id, "post", { ...command, paths: [] }, actor);
        service.observeEnd(run.approaches[0]!.worker!, "unrelated-turn");
      }
    });
    expectSqliteWriteBudget({ scenario: "research-reads-and-redelivery", note: "100 board reads, duplicate commands, and unrelated terminal observations: zero commits.", writes: idle.writes });
    const stop = await measureSqliteWrites(async () => await service.update(run.id, "stop", { action: "stop", reason: "Operator stopped" }, actor));
    expectSqliteWriteBudget({ scenario: "research-stop-three-workers", note: "Stop admission, three acknowledged worker cancellations, and terminal outcome.", writes: stop.writes });
  });

  it("budgets revision delivery and cancels only its recorded queued message", async () => {
    const cancelQueued = vi.fn(async () => ({}));
    const service = createService({ notify: async () => ({ queueEntryId: "research-feedback" }), cancelQueued });
    const run = await startRun(service);
    await service.update(run.id, "submission", { action: "submit", approachId: "a1", text: "Candidate", paths: [] }, actor);
    const submissionId = service.read(run.id, actor).submissions[0]!.id;
    const revision = await measureSqliteWrites(async () => await service.update(run.id, "review", { action: "review", submissionId, decision: "revision_requested", reason: "Reproduce the counterexample" }, { ...actor, kind: "operator" }));
    expectSqliteWriteBudget({ scenario: "research-revision-feedback", note: "One review decision, delivery intent, and accepted queue receipt. No blind retry on an unknown receipt.", writes: revision.writes });
    for (const approach of run.approaches) service.observeEnd(approach.worker!, approach.worker!.turnId!);
    const store = new ResearchStore(db);
    expect(store.header(run.id)?.activeWorkers).toBe(1);
    expect(store.get(run.id)?.activeWorkers).toBe(1);
    const held = await measureSqliteWrites(async () => {
      const item = service.readItem(run.id, submissionId, actor).item;
      // Other slots are free, but three concurrent children cannot consume the reserved one.
      for (let i = 0; i < 2; i++) {
        await service.update(run.id, `extra-${i}`, { action: "finding", approachId: "a1", kind: "note", text: `Evidence ${i}`, paths: [] }, actor);
        const finding = service.read(run.id, actor).findings.at(-1)!;
        await service.assign({ runId: run.id, itemId: finding.id, expectedVersion: service.readItem(run.id, finding.id, actor).item.version, task: "Focused work" }, { ...actor, callId: `child-${i}` });
      }
      const denied = await measureSqliteWrites(async () => await expect(service.assign({ runId: run.id, itemId: item.id, expectedVersion: item.version, task: "One too many" }, { ...actor, callId: "denied" })).rejects.toThrow("worker limit"));
      expect(denied.writes.commits).toBe(0);
    });
    expect(held.writes.commits).toBeGreaterThan(0);
    await service.update(run.id, "stop", { action: "stop", reason: "Cancel" }, actor);
    expect(cancelQueued).toHaveBeenCalledExactlyOnceWith("research-feedback");
    expect(service.read(run.id, actor).status).toBe("stopped");
  });

  it("budgets exact queued revision admission and terminal release", async () => {
    const service = createService({ notify: async () => ({ queueEntryId: "exact-feedback" }) });
    const run = await startRun(service, { ...mutableRequest(), approaches: [request.approaches[0]] });
    await service.update(run.id, "submission", { action: "submit", approachId: "a1", text: "Candidate", paths: [] }, actor);
    await service.update(run.id, "review", { action: "review", submissionId: service.read(run.id, actor).submissions[0]!.id, decision: "revision_requested", reason: "Check it" }, actor);
    const worker = run.approaches[0]!.worker!;
    service.observeEnd(worker, worker.turnId!);
    const lifecycle = await measureSqliteWrites(async () => {
      await service.observeQueue(worker, "exact-feedback", "started", "revision-turn");
      await service.observeQueue(worker, "exact-feedback", "terminal", "revision-turn");
    });
    expectSqliteWriteBudget({ scenario: "research-revision-queue-lifecycle", note: "Two exact queue boundaries: bind the admitted revision and release its reservation on terminal evidence. No token or timer writes.", writes: lifecycle.writes });
    const store = new ResearchStore(db);
    expect(store.header(run.id)?.activeWorkers).toBe(0);
    expect(store.get(run.id)?.activeWorkers).toBe(0);
    const duplicate = await measureSqliteWrites(async () => {
      await service.observeQueue(worker, "exact-feedback", "terminal", "revision-turn");
      await service.observeQueue(worker, "other-feedback", "terminal", "other-turn");
    });
    expectSqliteWriteBudget({ scenario: "research-revision-queue-redelivery", note: "Repeated or unrelated queue terminal events do not write research state.", writes: duplicate.writes });
  });

  it("budgets terminal observations and restart recovery without polling writes", async () => {
    const service = createService();
    const prepared = await measureSqliteWrites(async () => service.prepare({ backend: actor.backend, threadId: actor.threadId,
      objective: request.objective, workers: 3, minutes: request.minutes, workspaceMode: request.workspaceMode }));
    expectSqliteWriteBudget({ scenario: "research-prepare", note: "Bind the operator's exact limits in memory before the coordinator receives the request. No execution or SQLite writes.", writes: prepared.writes });
    const run = await startRun(service, { ...mutableRequest(), ...prepared.result });
    const firstWorker = run.approaches[0]!.worker!;
    const terminal = await measureSqliteWrites(async () => service.observeEnd(firstWorker, firstWorker.turnId!));
    expectSqliteWriteBudget({ scenario: "research-worker-terminal", note: "One exact provider terminal event for an assigned worker; duplicate and unrelated terminal events do not write.", writes: terminal.writes });
    const secondWorker = run.approaches[1]!.worker!;
    service.observeEnd(secondWorker, secondWorker.turnId!);
    const lastWorker = run.approaches[2]!.worker!;
    const exhausted = await measureSqliteWrites(async () => service.observeEnd(lastWorker, lastWorker.turnId!));
    expectSqliteWriteBudget({ scenario: "research-exhausted", note: "The last worker ends without a candidate: retain its terminal event and the honest exhausted outcome.", writes: exhausted.writes });
    expect(service.read(run.id, actor).status).toBe("exhausted");
    await service.start(mutableRequest(), { ...actor, callId: "second-run" });
    const replacement = createService({ ownerId: "replacement", isOwnerAlive: () => false });
    const recovery = await measureSqliteWrites(async () => replacement.initialize());
    expectSqliteWriteBudget({ scenario: "research-recovery", note: "At launch, a live run whose process is gone is taken over in one commit: the new holder and each cut-off worker. No workers are started and no periodic recovery writes are introduced.", writes: recovery.writes });
  });

  it("budgets admitted revision cancellation and settlement from exact provider evidence", async () => {
    const service = createService({ notify: async () => ({ queueEntryId: "feedback" }),
      cancelQueued: async () => ({ turnId: "revision-turn" }),
      stop: async (worker) => { if (worker.turnId === "revision-turn") throw new Error("Lost cancellation receipt"); },
    });
    const run = await startRun(service);
    await service.update(run.id, "submission", { action: "submit", approachId: "a1", text: "Candidate", paths: [] }, actor);
    await service.update(run.id, "review", { action: "review", submissionId: service.read(run.id, actor).submissions[0]!.id, decision: "revision_requested", reason: "Check evidence" }, { ...actor, kind: "operator" });
    const stopping = await measureSqliteWrites(async () => await service.update(run.id, "stop", { action: "stop", reason: "Stop" }, actor));
    expect(stopping.result.status).toBe("stopping");
    expect(service.read(run.id, actor).deliveries[0]).toMatchObject({ state: "unknown", turnId: "revision-turn" });
    expectSqliteWriteBudget({ scenario: "research-revision-cancel-unknown", note: "Stop admission, retain the exact newly admitted revision turn before cancellation, record its unknown receipt, and cancel three initial worker turns.", writes: stopping.writes });
    const settled = await measureSqliteWrites(async () => service.observeEnd(run.approaches[0]!.worker!, "revision-turn"));
    expect(service.read(run.id, actor).status).toBe("stopped");
    expectSqliteWriteBudget({ scenario: "research-revision-cancel-settled", note: "An exact provider terminal event settles the unknown delivery and the run. Duplicate terminal events do not write.", writes: settled.writes });
  });
});
