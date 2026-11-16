import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { projectResearchRun, type ResearchEvent } from "../research";

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
});
