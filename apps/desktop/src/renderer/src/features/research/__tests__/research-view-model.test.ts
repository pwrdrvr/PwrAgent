import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { researchApproachOccupiesSlot, type ResearchApproach, type ResearchFinding, type ResearchItem, type ResearchRun, type ResearchSubmission } from "@pwragent/shared";
import { researchActivityRows, researchMapBranches, researchRunPhase, researchTimeLeft, type ResearchMapBranch } from "../research-view-model";

const STATES: ResearchApproach["state"][] = ["pending", "starting", "running", "ended", "failed", "stopped", "unknown"];
const DECISIONS = [undefined, "accepted", "revision_requested", "rejected"] as const;
const actor = { backend: "codex" as const, threadId: "coordinator", kind: "agent" as const };

const approachArb = fc.record({ state: fc.constantFrom(...STATES), revisionPending: fc.boolean() });
const runArb = fc.record({
  status: fc.constantFrom<ResearchRun["status"]>("running", "stopping", "stopped", "deadline", "completed", "interrupted", "exhausted"),
  approaches: fc.array(approachArb, { minLength: 1, maxLength: 5 }),
  decisions: fc.array(fc.constantFrom(...DECISIONS), { maxLength: 5 }),
});

type PhaseInput = { status: ResearchRun["status"]; approaches: Array<{ state: ResearchApproach["state"]; revisionPending: boolean }>; decisions: Array<typeof DECISIONS[number]> };
function phaseRun(input: PhaseInput) {
  const approaches: ResearchApproach[] = input.approaches.map((a, index) => ({ id: `a${index}`, title: `A${index}`, task: "t", state: a.state, ...(a.revisionPending ? { revisionDeliveryIds: ["d"] } : {}) }));
  const submissions: ResearchSubmission[] = input.decisions.map((decision, index) => ({ id: `s${index}`, approachId: "a0", text: "c", paths: [],
    ...(decision ? { review: { decision, reason: "r", actor } } : {}) }));
  return { status: input.status, approaches, submissions };
}

describe("research run phase", () => {
  it("is Awaiting review exactly when a running run has no busy slot and an undecided candidate", () => {
    fc.assert(fc.property(runArb, (input) => {
      const run = phaseRun(input);
      const idle = !run.approaches.some(researchApproachOccupiesSlot);
      const undecided = run.submissions.some((s) => !s.review);
      expect(researchRunPhase(run).label === "Awaiting review").toBe(run.status === "running" && idle && undecided);
      if (researchRunPhase(run).label === "Ready to finish") {
        expect(run.status === "running" && idle && !undecided && run.submissions.some((s) => s.review?.decision === "accepted")).toBe(true);
      }
    }), { numRuns: 400 });
  });

  it("does not call a fully reviewed run, or one with a revision in flight, awaiting review", () => {
    // Both were "Awaiting review" on main: it checked only that every worker had ended and any candidate existed.
    const reviewed = phaseRun({ status: "running", approaches: [{ state: "ended", revisionPending: false }], decisions: ["rejected"] });
    expect(researchRunPhase(reviewed).label).toBe("Running");
    const revising = phaseRun({ status: "running", approaches: [{ state: "ended", revisionPending: true }], decisions: [undefined] });
    expect(researchRunPhase(revising).label).toBe("Running");
  });

  it("reports remaining time for live runs and the deadline for finished ones", () => {
    const deadlineAt = Date.UTC(2026, 10, 16, 12, 30);
    expect(researchTimeLeft({ status: "running", deadlineAt }, deadlineAt - 22 * 60_000 - 5_000)).toMatch(/^22 min left · ends /);
    expect(researchTimeLeft({ status: "running", deadlineAt }, deadlineAt - 30_000)).toMatch(/^Under a minute left/);
    expect(researchTimeLeft({ status: "running", deadlineAt }, deadlineAt + 1)).toBe("Deadline passed");
    expect(researchTimeLeft({ status: "running", deadlineAt }, deadlineAt - 125 * 60_000)).toMatch(/^2 h 5 min left/);
    expect(researchTimeLeft({ status: "completed", deadlineAt }, deadlineAt - 60_000)).toMatch(/^Deadline /);
  });
});

/** Generated runs whose focused children point at random items, including loops and missing sources. */
const mapArb = fc.record({
  approaches: fc.integer({ min: 1, max: 6 }),
  contributions: fc.array(fc.record({ owner: fc.nat(), finding: fc.boolean() }), { maxLength: 14 }),
  links: fc.array(fc.option(fc.nat(), { nil: undefined }), { maxLength: 6 }),
  leafLimit: fc.integer({ min: 1, max: 4 }),
});

function mapRun(input: { approaches: number; contributions: Array<{ owner: number; finding: boolean }>; links: Array<number | undefined> }): ResearchRun {
  const approaches: ResearchApproach[] = Array.from({ length: input.approaches }, (_, index) => ({ id: `a${index}`, title: `A${index}`, task: "t", state: "running" }));
  const findings: ResearchFinding[] = [];
  const submissions: ResearchSubmission[] = [];
  input.contributions.forEach((entry, index) => {
    const approachId = `a${entry.owner % input.approaches}`;
    if (entry.finding) findings.push({ id: `f${index}`, approachId, kind: "note", text: `finding ${index}`, paths: [] });
    else submissions.push({ id: `s${index}`, approachId, text: `candidate ${index}`, paths: [] });
  });
  const ids = [...approaches.map((a) => a.id), ...findings.map((f) => f.id), ...submissions.map((s) => s.id), "missing"];
  input.links.forEach((link, index) => {
    const approach = approaches[index % approaches.length]!;
    if (link !== undefined) approach.itemId = ids[link % ids.length];
  });
  const items = [...approaches.map((record, index) => ({ id: record.id, approachId: record.id, type: "approach", record, createdSeq: index + 1 })),
    ...findings.map((record, index) => ({ id: record.id, approachId: record.approachId, type: "finding", record, createdSeq: 100 + index })),
    ...submissions.map((record, index) => ({ id: record.id, approachId: record.approachId, type: "submission", record, createdSeq: 200 + index }))] as unknown as ResearchItem[];
  return { approaches, findings, submissions, items, events: [] } as unknown as ResearchRun;
}

function walk(branches: ResearchMapBranch[], seen: { approaches: string[]; leaves: string[]; hidden: number }) {
  for (const branch of branches) {
    seen.approaches.push(branch.approach.id);
    seen.hidden += branch.hidden;
    for (const leaf of branch.leaves) { seen.leaves.push(leaf.record.id); walk(leaf.children, seen); }
    walk(branch.assignments, seen);
  }
  return seen;
}

describe("research map", () => {
  it("places every approach exactly once and accounts for every contribution", () => {
    fc.assert(fc.property(mapArb, (input) => {
      const run = mapRun(input);
      const seen = walk(researchMapBranches(run, input.leafLimit), { approaches: [], leaves: [], hidden: 0 });
      expect([...seen.approaches].sort()).toEqual(run.approaches.map((a) => a.id).sort());
      expect(new Set(seen.leaves).size).toBe(seen.leaves.length);
      expect(seen.leaves.length + seen.hidden).toBe(run.findings.length + run.submissions.length);
    }), { numRuns: 400 });
  });

  it("nests a focused child and its own findings under the item it investigates", () => {
    const run = mapRun({ approaches: 2, contributions: [{ owner: 0, finding: true }, { owner: 1, finding: true }], links: [undefined, 0] });
    run.approaches[1]!.itemId = "f0";
    const [root] = researchMapBranches(run);
    expect(root!.approach.id).toBe("a0");
    expect(root!.leaves[0]!.children[0]!.approach.id).toBe("a1");
    expect(root!.leaves[0]!.children[0]!.leaves[0]!.record.id).toBe("f1");
  });
});

describe("research activity", () => {
  it("lists newest first with approach titles instead of IDs", () => {
    const run = { approaches: [{ id: "a1", title: "Bisect fixture setup", task: "t", state: "running" }], coordinator: actor, items: [],
      events: [
        { seq: 1, at: 1, commandId: "c1", signature: "s", actor, data: { type: "worker", approachId: "a1", state: "running" } },
        { seq: 2, at: 2, commandId: "operator:c2", signature: "s", actor: { ...actor, kind: "operator" }, data: { type: "abandoned", approachId: "a1", reason: "Ruled out" } },
        { seq: 3, at: 3, commandId: "settled:2", signature: "s", actor: { ...actor, kind: "operator" }, data: { type: "status", status: "deadline", reason: "Research deadline reached" } },
      ] } as unknown as ResearchRun;
    const rows = researchActivityRows(run);
    expect(rows.map((row) => row.seq)).toEqual([3, 2, 1]);
    expect(rows[0]).toMatchObject({ actor: "PwrAgent", kind: "Deadline reached" });
    expect(rows[1]).toMatchObject({ actor: "You", text: "Bisect fixture setup: Ruled out" });
    expect(rows[2]).toMatchObject({ actor: "PwrAgent", text: "Bisect fixture setup: Running" });
  });
});
