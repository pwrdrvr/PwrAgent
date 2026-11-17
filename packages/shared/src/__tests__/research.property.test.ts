import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { projectResearchRun, researchBoardEntry, researchRunBoard, type ResearchEvent, type ResearchEventData } from "../research";

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

  // Every event kind that creates or changes an item, aimed at items the journal already holds, as the owner would append them.
  const stepArb = fc.record({
    kind: fc.constantFrom("finding", "submission", "review", "worker", "abandoned", "direction", "assignment", "item_work", "delivery", "status"),
    pick: fc.nat(), other: fc.nat(), flag: fc.boolean(),
  });

  it("serves every item's record and creation order from the board, as projectResearchRun's items hold them", () => {
    fc.assert(fc.property(fc.array(stepArb, { size: "max", minLength: 5, maxLength: 60 }), (steps) => {
      const events: ResearchEvent[] = [{ seq: 1, at: 1000, actor, commandId: "created", signature: "created", data: {
        type: "created", objective: "Research", coordinator: actor, ownerId: "owner", ownerPid: 1, deadlineAt: 100_000, workspaceMode: "none",
        approaches: [{ id: "a1", title: "One", task: "t", state: "pending" }, { id: "a2", title: "Two", task: "t", state: "pending" }],
      } }];
      for (const step of steps) {
        const run = projectResearchRun("run", events);
        const seq = events.length + 1;
        const approach = run.approaches[step.pick % run.approaches.length]!;
        const item = run.items[step.other % run.items.length]!;
        const submission = run.submissions.length ? run.submissions[step.pick % run.submissions.length] : undefined;
        let data: ResearchEventData;
        switch (step.kind) {
          case "submission": data = { type: "submission", submission: { id: `s${seq}`, approachId: approach.id, text: `Candidate ${seq}`, paths: [] } }; break;
          case "review": data = submission ? { type: "review", submissionId: submission.id, decision: step.flag ? "accepted" : "revision_requested", reason: `r${seq}` }
            : { type: "status", status: "running", reason: "no candidate yet" }; break;
          case "worker": data = { type: "worker", approachId: approach.id, state: step.flag ? "running" : "ended",
            ...(step.flag ? { worker: { backend: "codex", threadId: `w${step.other % 3}`, turnId: `t${seq}` } } : { note: `ended ${seq}` }) }; break;
          case "abandoned": data = { type: "abandoned", approachId: approach.id, reason: `abandon ${seq}` }; break;
          case "direction": data = { type: "direction", approachId: approach.id, title: `Retitled ${seq}`, task: `task ${seq}`, reason: `why ${seq}`,
            ...(step.flag ? { overlapsApproachId: run.approaches[step.other % run.approaches.length]!.id } : {}) }; break;
          case "assignment": data = { type: "assignment", itemId: item.id, task: `focus ${seq}`,
            approach: { id: `work-${seq}`, itemId: item.id, title: `Focus ${seq}`, task: `focus ${seq}`, state: "pending" } }; break;
          case "item_work": data = { type: "item_work", itemId: item.id, work: { state: step.flag ? "claimed" : "blocked", note: `work ${seq}` } }; break;
          case "delivery": data = { type: "delivery", delivery: { id: `d${step.other % 3}`, target: actor, approachId: approach.id,
            state: (["pending", "queued", "started", "ended", "cancelled"] as const)[step.other % 5]! } }; break;
          case "status": data = { type: "status", status: "running", reason: `status ${seq}` }; break;
          default: data = { type: "finding", finding: { id: `f${seq}`, approachId: approach.id, kind: "note", text: `Finding ${seq}`, paths: [],
            ...(step.flag ? { relatesTo: item.id, relation: "supports" as const } : {}) } };
        }
        events.push({ seq, at: 1000 + seq, actor, commandId: `c${seq}`, signature: `c${seq}`, data });
      }
      const run = projectResearchRun("run", events);
      const board = researchRunBoard(run);
      const { events: _events, items: _items, ...rest } = run;
      expect(board).toEqual({ ...rest, createdSeq: board.createdSeq });
      expect(Object.keys(board.createdSeq).sort()).toEqual(run.items.map((i) => i.id).sort());
      for (const item of run.items) {
        expect(researchBoardEntry(board, item.id)).toEqual({ id: item.id, type: item.type, record: item.record, createdSeq: item.createdSeq });
      }
      expect(researchBoardEntry(board, "missing")).toBeUndefined();
      expect(researchBoardEntry(board, "constructor")).toBeUndefined();
    }));
  });
});
