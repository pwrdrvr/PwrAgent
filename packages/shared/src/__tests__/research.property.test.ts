import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyResearchChanges, emptyResearchRunStore, projectResearchRun, RESEARCH_BOARD_PAGE, researchApproachLeaves, researchApproachOccupiesSlot, researchBoardPage, researchChangePage,
  researchRunState, researchRunStoreCursor, researchRunStoreSynced, summarizeResearchRun, type ResearchEvent, type ResearchRun, type ResearchRunStore,
} from "../research";
import { nextResearchEvent, researchCreatedEvent, researchJournalStepArb, type ResearchJournalStep } from "./research-journal-arbitraries";

const actor = { kind: "agent", backend: "codex", threadId: "parent" } as const;
describe("research journal projection", () => {
  it("uses the owner's event order and is invariant to delivery order and identical redelivery", () => {
    fc.assert(fc.property(fc.array(fc.string({ maxLength: 30 }), { size: "max", maxLength: 40 }), (texts) => {
      const events: ResearchEvent[] = [{ seq: 1, at: 1000, actor, commandId: "created", signature: "created", data: {
        type: "created", objective: "Research", coordinator: actor, ownerId: "owner", ownerPid: 1, deadlineAt: 100_000, workspaceMode: "none",
        approaches: [{ id: "a1", title: "Approach", task: "Investigate", state: "pending" }],
      } }];
      for (const [index, text] of texts.entries()) events.push({ seq: index + 2, at: 1000 - index, actor, commandId: `f${index}`, signature: text, data: {
        type: "finding", finding: { id: `f${index}`, approachId: "a1", kind: "note", text, paths: [] },
      } });
      const normal = projectResearchRun("run", events);
      const delivered = projectResearchRun("run", [...events.toReversed(), ...events]);
      expect(delivered).toEqual(normal);
      expect(delivered.findings.map((f) => f.text)).toEqual(texts);
    }));
  });

  it("rejects an incomplete or conflicting journal instead of inventing missing history", () => {
    const event = { seq: 2, at: 1, actor, commandId: "status", signature: "status", data: { type: "status", status: "completed", reason: "done" } } as const;
    expect(() => projectResearchRun("run", [event])).toThrow("Incomplete");
    expect(() => projectResearchRun("run", [{ ...event, seq: 1 }, { ...event, seq: 1, signature: "different" }])).toThrow("Conflicting");
  });

  it("the item projection agrees with the board lists projectResearchRun keeps, for every event kind", () => {
    fc.assert(fc.property(fc.array(researchJournalStepArb, { size: "max", minLength: 5, maxLength: 60 }), (steps) => {
      const events = [researchCreatedEvent(3)];
      for (const step of steps) {
        events.push(nextResearchEvent(projectResearchRun("run", events), step));
        const run = projectResearchRun("run", events);
        const records = (type: string) => run.items.filter((item) => item.type === type).map((item) => item.record);
        expect(records("approach")).toEqual(run.approaches);
        expect(records("finding")).toEqual(run.findings);
        expect(records("submission")).toEqual(run.submissions);
        expect(run.items.map((item) => item.createdSeq)).toEqual(run.items.map((item) => item.createdSeq).sort((a, b) => a - b));
      }
    }));
  });
});

describe("research change stream", () => {
  /** Sync `store` to the journal's end, appending `between` pages as a live run would. */
  function sync(store: ResearchRunStore, events: ResearchEvent[], limit: number, between: ResearchJournalStep[]): ResearchRunStore {
    const pending = [...between];
    do {
      const page = researchChangePage(projectResearchRun("run", events), researchRunStoreCursor(store).sinceRevision, researchRunStoreCursor(store).after, limit);
      store = applyResearchChanges(store, { ...page, writable: true });
      const step = store.cursor ? pending.shift() : undefined;
      if (step) events.push(nextResearchEvent(projectResearchRun("run", events), step));
    } while (store.cursor);
    return store;
  }
  function expectStoreHoldsRun(store: ResearchRunStore, run: ResearchRun) {
    expect(researchRunStoreSynced(store)).toBe(true);
    expect(store.revision).toBe(run.revision);
    expect(store.items).toEqual(new Map(run.items.map((item) => [item.id, item])));
    expect(store.approaches).toEqual(run.approaches);
    expect(store.submissions).toEqual(run.submissions);
    expect(store.state).toEqual(researchRunState(run));
    expect(store.leaves).toEqual(new Map(researchApproachLeaves(run).map((entry) => [entry.approachId, entry])));
  }
  const opArb = fc.oneof(
    { weight: 3, arbitrary: fc.record({ append: fc.array(researchJournalStepArb, { minLength: 1, maxLength: 8 }) }) },
    { weight: 1, arbitrary: fc.record({ sync: fc.integer({ min: 1, max: 7 }), between: fc.array(researchJournalStepArb, { maxLength: 3 }) }) },
  );

  it("a store fed pages of changes holds the run projectResearchRun holds, whatever the page size, the gap between syncs, and the appends between pages", () => {
    fc.assert(fc.property(fc.array(opArb, { size: "max", minLength: 4, maxLength: 30 }), (ops) => {
      const events = [researchCreatedEvent(3)];
      let store = emptyResearchRunStore("run");
      for (const op of ops) {
        if ("append" in op) { for (const step of op.append) events.push(nextResearchEvent(projectResearchRun("run", events), step)); continue; }
        const held = store;
        store = sync(store, events, op.sync, op.between);
        const run = projectResearchRun("run", events);
        expectStoreHoldsRun(store, run);
        // The delta agrees with a full sync into an empty store.
        expectStoreHoldsRun(sync(emptyResearchRunStore("run"), events, op.sync, []), run);
        // An apply returns a new store, and replaces a list only when one of its records changed.
        if (held.revision === store.revision) expect(store.approaches).toBe(held.approaches);
      }
    }));
  });

  it("a delta carries only the items changed since the store's revision", () => {
    fc.assert(fc.property(fc.array(researchJournalStepArb, { minLength: 2, maxLength: 40 }), fc.nat(), (steps, cut) => {
      const events = [researchCreatedEvent(3)];
      for (const step of steps) events.push(nextResearchEvent(projectResearchRun("run", events), step));
      const run = projectResearchRun("run", events);
      const since = 1 + cut % run.revision;
      const page = researchChangePage(run, since);
      expect(page.items.map((item) => item.id).sort()).toEqual(run.items.filter((item) => item.version > since).map((item) => item.id).sort());
      expect(page.items.every((item) => item.version > since)).toBe(true);
      expect((page.approaches ?? []).map((entry) => entry.approachId).sort()).toEqual([...new Set(page.items.map((item) => item.approachId))].sort());
      expect(researchChangePage(run, run.revision)).toEqual({ runId: "run", revision: run.revision, state: researchRunState(run), items: [], approaches: [] });
    }));
  });

  it("a store ahead of the journal is replaced, not merged", () => {
    const events = [researchCreatedEvent(2)];
    events.push(nextResearchEvent(projectResearchRun("run", events), { kind: "finding", pick: 0, other: 0, variant: 0, flag: false }));
    const run = projectResearchRun("run", events);
    const stale = applyResearchChanges(emptyResearchRunStore("run"), { runId: "run", revision: 9, writable: true, state: { ...researchRunState(run), revision: 9 },
      items: [{ id: "gone", type: "finding", approachId: "a1", version: 9, createdSeq: 9, updatedAt: 1, work: { state: "open" }, record: { id: "gone", approachId: "a1", kind: "note", text: "From another journal", paths: [] } }],
      approaches: [{ approachId: "gone-approach", findings: 1, candidates: 0, leafIds: ["gone"] }] });
    expect(stale.revision).toBe(9);
    const page = researchChangePage(run, stale.revision);
    expect(page.reset).toBe(true);
    expectStoreHoldsRun(applyResearchChanges(stale, { ...page, writable: false }), run);
    expect(applyResearchChanges(stale, { ...page, runId: "other", writable: false })).toBe(stale);
  });

  it("board pages and summaries are slices of the replayed run", () => {
    fc.assert(fc.property(fc.array(researchJournalStepArb, { minLength: 1, maxLength: 60 }), fc.nat(30), fc.nat(30), fc.nat(30), (steps, approachOffset, findingOffset, submissionOffset) => {
      const events = [researchCreatedEvent(3)];
      for (const step of steps) events.push(nextResearchEvent(projectResearchRun("run", events), step));
      const run = projectResearchRun("run", events);
      const board = researchBoardPage(run, { approachOffset, findingOffset, submissionOffset });
      expect(board.approaches).toEqual(run.approaches.slice(approachOffset, approachOffset + RESEARCH_BOARD_PAGE));
      expect(board.findings).toEqual(run.findings.slice(findingOffset, findingOffset + RESEARCH_BOARD_PAGE));
      expect(board.submissions).toEqual(run.submissions.slice(submissionOffset, submissionOffset + RESEARCH_BOARD_PAGE));
      expect([board.totalApproaches, board.totalFindings, board.totalSubmissions]).toEqual([run.approaches.length, run.findings.length, run.submissions.length]);
      const summary = summarizeResearchRun(run);
      expect(summary).toMatchObject({ status: run.status, activeWorkers: run.approaches.filter(researchApproachOccupiesSlot).length });
      expect(summary.reason).toBe(run.reason);
    }));
  });
});
