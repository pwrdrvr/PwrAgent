import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  projectResearchRun, researchApproachLeaves, researchChangePage, researchRunState, researchRunStoreSynced, summarizeResearchRun,
  type ResearchChange, type ResearchChanges, type ResearchChangesRequest, type ResearchEvent, type ResearchPendingRequest, type ResearchRun, type ResearchRunStore, type ResearchSnapshot, type ResearchSnapshotRequest,
} from "@pwragent/shared";
import { nextResearchEvent, researchCreatedEvent, researchJournalStepArb } from "../../../../../../../../packages/shared/src/__tests__/research-journal-arbitraries";
import { ResearchSync, type ResearchSyncState } from "../research-sync";

const thread = { backend: "codex" as const, threadId: "coordinator" };
const pendingRequest: ResearchPendingRequest = { objective: "Waiting", workers: 2, minutes: 10, workspaceMode: "none", preparedAt: 1, expiresAt: 2 };

/**
 * The owner as the window sees it: journals that grow, a pending request, and
 * reads answered from the state at the moment each was asked. A reply is held
 * until the test delivers it, so appends and change events land while a read
 * is in flight.
 */
function owner() {
  const journals = new Map<string, ResearchEvent[]>();
  let pending: ResearchPendingRequest | undefined;
  let failNext = false;
  const held: Array<() => void> = [];
  const calls = { list: 0, summary: 0, changes: 0, items: 0 };
  const run = (id: string) => projectResearchRun(id, journals.get(id)!);
  const summaries = () => [...journals.keys()].map((id) => summarizeResearchRun(run(id))).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  const reply = <T,>(read: () => T): Promise<T> => {
    const fail = failNext;
    failNext = false;
    const value = fail ? undefined : read();
    return new Promise<T>((resolve, reject) => { held.push(() => { if (fail) reject(new Error("The owner did not answer")); else resolve(value as T); }); });
  };
  return {
    journals, held, calls, run, summaries,
    setPending: (value: ResearchPendingRequest | undefined) => { pending = value; },
    pending: () => pending,
    fail: () => { failNext = true; },
    reads: {
      researchSnapshot: (request: ResearchSnapshotRequest) => reply((): ResearchSnapshot => {
        if (request.runId === undefined) calls.list++; else calls.summary++;
        const runs = summaries().filter((entry) => request.runId === undefined || entry.id === request.runId);
        return { runs, writableRunIds: runs.map((entry) => entry.id), ...(pending ? { pending } : {}) };
      }),
      researchChanges: (request: ResearchChangesRequest) => reply((): ResearchChanges => {
        calls.changes++;
        // A small page, so one sync takes several reads and the journal can grow between them.
        const page = researchChangePage(run(request.runId), request.sinceRevision, request.after, 3);
        calls.items += page.items.length;
        return { ...page, writable: true };
      }),
    },
  };
}

const settle = () => new Promise<void>((resolve) => { setImmediate(resolve); });

const opArb = fc.oneof(
  { weight: 6, arbitrary: fc.record({ op: fc.constant("append" as const), run: fc.nat(), step: researchJournalStepArb, defer: fc.boolean() }) },
  { weight: 5, arbitrary: fc.record({ op: fc.constant("reply" as const) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("notify" as const) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("start" as const), defer: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("select" as const), run: fc.option(fc.nat(), { nil: undefined }) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("pending" as const), defer: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("fail" as const) }) },
);

function expectStoreIsRunAt(store: ResearchRunStore, journal: ResearchEvent[]) {
  // The store is the run as of its revision: nothing newer leaked in, nothing older was left behind.
  const run: ResearchRun = projectResearchRun(store.runId, journal.slice(0, store.revision));
  expect(researchRunStoreSynced(store)).toBe(true);
  expect(store.items).toEqual(new Map(run.items.map((item) => [item.id, item])));
  expect(store.approaches).toEqual(run.approaches);
  expect(store.submissions).toEqual(run.submissions);
  expect(store.state).toEqual(researchRunState(run));
  expect(store.leaves).toEqual(new Map(researchApproachLeaves(run).map((entry) => [entry.approachId, entry])));
}

describe("research sync", () => {
  it("shows only complete runs, converges on the owner's state, and reads the run list only when a change names no run", async () => {
    await fc.assert(fc.asyncProperty(fc.array(opArb, { size: "max", minLength: 10, maxLength: 60 }), async (ops) => {
      const model = owner();
      model.journals.set("run-1", [researchCreatedEvent(2, { at: 1000 })]);
      let state: ResearchSyncState = { writableRunIds: [] };
      let selected: string | undefined;
      const notifications: ResearchChange[] = [];
      let unnamed = 0;
      let failures = 0;
      const sync = new ResearchSync(model.reads, thread, (next) => {
        state = next;
        // Every store the panel is given is a whole run, never a sync part way through its pages.
        if (next.store) expectStoreIsRunAt(next.store, model.journals.get(next.store.runId)!);
      });
      const deliver = (change: ResearchChange) => { if (change.runId === undefined) unnamed++; sync.notify(change); };
      const publish = (change: ResearchChange, defer: boolean) => { if (defer) notifications.push(change); else deliver(change); };
      sync.start();
      for (const entry of ops) {
        const ids = [...model.journals.keys()];
        if (entry.op === "append") {
          const id = ids[entry.run % ids.length]!;
          const journal = model.journals.get(id)!;
          journal.push(nextResearchEvent(model.run(id), entry.step));
          publish({ ...thread, runId: id, revision: journal.length }, entry.defer);
        } else if (entry.op === "start") {
          const id = `run-${ids.length + 1}`;
          model.journals.set(id, [researchCreatedEvent(2, { at: 1000 + ids.length })]);
          publish({ ...thread, runId: id, revision: 1 }, entry.defer);
        } else if (entry.op === "pending") {
          model.setPending(model.pending() ? undefined : pendingRequest);
          publish({ ...thread }, entry.defer);
        } else if (entry.op === "notify") { const change = notifications.shift(); if (change) deliver(change); }
        else if (entry.op === "reply") model.held.shift()?.();
        else if (entry.op === "fail") { model.fail(); failures++; }
        else { selected = entry.run === undefined ? undefined : ids[entry.run % ids.length]; sync.select(selected); }
        await settle();
      }
      // Deliver everything outstanding. A read that failed is retried by the next change event, as it is in the app:
      // each run's latest change is sent again, and none of these names the whole list.
      for (const change of notifications.splice(0)) deliver(change);
      for (let round = 0; round < 3; round++) {
        while (model.held.length) { model.held.shift()!(); await settle(); }
        for (const [id, journal] of model.journals) deliver({ ...thread, runId: id, revision: journal.length });
        await settle();
      }
      while (model.held.length) { model.held.shift()!(); await settle(); }

      expect(state.error).toBeUndefined();
      expect(state.runs).toEqual(model.summaries());
      expect(state.pending).toEqual(model.pending());
      expect([...state.writableRunIds].sort()).toEqual([...model.journals.keys()].sort());
      const shown = model.journals.has(selected ?? "") ? selected! : model.summaries()[0]!.id;
      expect(state.store?.runId).toBe(shown);
      expect(state.store?.revision).toBe(model.journals.get(shown)!.length);
      expectStoreIsRunAt(state.store!, model.journals.get(shown)!);
      // The list is read once, then only for a change that names no run, or to retry a failed read.
      expect(model.calls.list).toBeLessThanOrEqual(1 + unnamed + failures);
      sync.dispose();
    }), { numRuns: 100 });
  });

  it("retries a failed read on the next change event, even one that asks for no read of its own", async () => {
    const model = owner();
    model.journals.set("run-1", [researchCreatedEvent(2)]);
    let state: ResearchSyncState = { writableRunIds: [] };
    const sync = new ResearchSync(model.reads, thread, (next) => { state = next; });
    const drain = async () => { await settle(); while (model.held.length) { model.held.shift()!(); await settle(); } };
    sync.start();
    await drain();
    expect(state.store?.revision).toBe(1);
    model.setPending(pendingRequest);
    model.fail();
    sync.notify({ ...thread });
    await drain();
    expect(state.error).toBeDefined();
    expect(state.pending).toBeUndefined();
    // The store already holds this revision of the run on screen.
    sync.notify({ ...thread, runId: "run-1", revision: 1 });
    await drain();
    expect(state.error).toBeUndefined();
    expect(state.pending).toEqual(pendingRequest);
    sync.dispose();
  });

  it("costs a change to the run on screen one read of the changed items, however long the run is", async () => {
    const model = owner();
    const journal = [researchCreatedEvent(3)];
    for (let i = 0; i < 400; i++) journal.push(nextResearchEvent(projectResearchRun("run-1", journal), { kind: "finding", pick: i, other: 0, variant: i, flag: false }));
    model.journals.set("run-1", journal);
    let state: ResearchSyncState = { writableRunIds: [] };
    const sync = new ResearchSync(model.reads, thread, (next) => { state = next; });
    const drain = async () => { await settle(); while (model.held.length) { model.held.shift()!(); await settle(); } };
    sync.start();
    await drain();
    expect(state.store?.items.size).toBe(403);
    const before = { ...model.calls };
    journal.push(nextResearchEvent(projectResearchRun("run-1", journal), { kind: "finding", pick: 0, other: 0, variant: 0, flag: false }));
    sync.notify({ ...thread, runId: "run-1", revision: journal.length });
    await drain();
    expect(state.store?.revision).toBe(journal.length);
    expect(state.runs?.[0]?.revision).toBe(journal.length);
    expect({ list: model.calls.list - before.list, summary: model.calls.summary - before.summary, changes: model.calls.changes - before.changes, items: model.calls.items - before.items })
      .toEqual({ list: 0, summary: 0, changes: 1, items: 1 });
    sync.dispose();
  });
});
