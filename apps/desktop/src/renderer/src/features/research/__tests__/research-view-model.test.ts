import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { projectResearchRun, researchApproachOccupiesSlot, researchEventPage, researchRunBoard, summarizeResearchRun, type ResearchApproach, type ResearchEvent, type ResearchEventData, type ResearchEventRange, type ResearchFinding, type ResearchItem, type ResearchRun, type ResearchRunBoard, type ResearchSubmission } from "@pwragent/shared";
import { appendResearchActivityOlder, emptyResearchActivity, mergeResearchActivityHead, researchActivityHeadRange, researchActivityRows, researchMapBranches, researchPhaseInput, researchRunPhase, researchTimeLeft, type ResearchActivityWindow, type ResearchMapBranch } from "../research-view-model";

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
      const phase = researchRunPhase(researchPhaseInput(run));
      expect(phase.label === "Awaiting review").toBe(run.status === "running" && idle && undecided);
      if (phase.label === "Ready to finish") {
        expect(run.status === "running" && idle && !undecided && run.submissions.some((s) => s.review?.decision === "accepted")).toBe(true);
      }
    }), { numRuns: 400 });
  });

  it("does not call a fully reviewed run, or one with a revision in flight, awaiting review", () => {
    // Both were "Awaiting review" on main: it checked only that every worker had ended and any candidate existed.
    const reviewed = phaseRun({ status: "running", approaches: [{ state: "ended", revisionPending: false }], decisions: ["rejected"] });
    expect(researchRunPhase(researchPhaseInput(reviewed)).label).toBe("Running");
    const revising = phaseRun({ status: "running", approaches: [{ state: "ended", revisionPending: true }], decisions: [undefined] });
    expect(researchRunPhase(researchPhaseInput(revising)).label).toBe("Running");
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

function mapRun(input: { approaches: number; contributions: Array<{ owner: number; finding: boolean }>; links: Array<number | undefined> }): ResearchRunBoard {
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
  return researchRunBoard({ approaches, findings, submissions, items, events: [] } as unknown as ResearchRun);
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
    const rows = researchActivityRows(researchRunBoard(run), run.events.toReversed());
    expect(rows.map((row) => row.seq)).toEqual([3, 2, 1]);
    expect(rows[0]).toMatchObject({ actor: "PwrAgent", kind: "Deadline reached" });
    expect(rows[1]).toMatchObject({ actor: "You", text: "Bisect fixture setup: Ruled out" });
    expect(rows[2]).toMatchObject({ actor: "PwrAgent", text: "Bisect fixture setup: Running" });
  });
});

/** A valid journal, built the way workers and the coordinator append: findings, candidates, reviews and worker changes. */
const stepArb = fc.oneof(
  fc.record({ type: fc.constant("finding" as const), approach: fc.integer({ min: 1, max: 2 }) }),
  fc.record({ type: fc.constant("submission" as const), approach: fc.integer({ min: 1, max: 2 }) }),
  fc.record({ type: fc.constant("review" as const), pick: fc.nat(), decision: fc.constantFrom("accepted" as const, "revision_requested" as const, "rejected" as const) }),
  fc.record({ type: fc.constant("worker" as const), approach: fc.integer({ min: 1, max: 2 }), state: fc.constantFrom<ResearchApproach["state"]>("running", "ended", "failed") }),
);
type Step = typeof stepArb extends fc.Arbitrary<infer T> ? T : never;

function appendStep(journal: ResearchEvent[], step: Step): void {
  const seq = journal.length + 1;
  const submissions = journal.flatMap((event) => event.data.type === "submission" ? [event.data.submission.id] : []);
  let data: ResearchEventData;
  if (step.type === "finding") data = { type: "finding", finding: { id: `f${seq}`, approachId: `a${step.approach}`, kind: "note", text: `Finding ${seq}`, paths: [] } };
  else if (step.type === "submission") data = { type: "submission", submission: { id: `s${seq}`, approachId: `a${step.approach}`, text: `Candidate ${seq}`, paths: [] } };
  else if (step.type === "review" && submissions.length) data = { type: "review", submissionId: submissions[step.pick % submissions.length]!, decision: step.decision, reason: `Review ${seq}` };
  else if (step.type === "worker") data = { type: "worker", approachId: `a${step.approach}`, state: step.state };
  else data = { type: "finding", finding: { id: `f${seq}`, approachId: "a1", kind: "note", text: `Finding ${seq}`, paths: [] } };
  journal.push({ seq, commandId: `c${seq}`, signature: `s${seq}`, at: 1000 + seq, actor, data });
}

function createdJournal(): ResearchEvent[] {
  return [{ seq: 1, commandId: "c1", signature: "s1", at: 1000, actor, data: { type: "created", objective: "Objective", coordinator: actor, ownerId: "o", ownerPid: 1,
    deadlineAt: 10_000, workspaceMode: "none", approaches: [{ id: "a1", title: "One", task: "t", state: "pending" }, { id: "a2", title: "Two", task: "t", state: "pending" }] } }];
}

/** The window is a contiguous stretch of the journal, newest first, and every event is the projection's own. */
function expectWindowAgrees(window: ResearchActivityWindow, journal: ResearchEvent[]) {
  const projected = projectResearchRun("run", journal).events;
  window.events.forEach((event, index) => {
    expect(event).toEqual(projected[event.seq - 1]);
    if (index) expect(event.seq).toBe(window.events[index - 1]!.seq - 1);
  });
  const oldest = window.events.at(-1);
  expect(window.nextBeforeSeq).toBe(oldest && oldest.seq > 1 ? oldest.seq : undefined);
}

describe("research activity paging", () => {
  // Pages are read from the journal as it stood when each read was issued; replies can land after later appends and reads.
  const opArb = fc.oneof(
    { arbitrary: fc.record({ op: fc.constant("append" as const), steps: fc.array(stepArb, { minLength: 1, maxLength: 9 }) }), weight: 3 },
    { arbitrary: fc.record({ op: fc.constant("head" as const), late: fc.boolean() }), weight: 2 },
    { arbitrary: fc.record({ op: fc.constant("older" as const), late: fc.boolean() }), weight: 2 },
    { arbitrary: fc.record({ op: fc.constant("deliver" as const), pick: fc.nat() }), weight: 2 },
  );

  it("keeps a contiguous window that agrees with projectResearchRun while the board changes between page reads", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 6 }), fc.array(opArb, { minLength: 10, maxLength: 60 }), (limit, ops) => {
      const journal = createdJournal();
      let window = emptyResearchActivity("run");
      const read = (range: ResearchEventRange) => researchEventPage(projectResearchRun("run", journal), range);
      const pending: Array<() => void> = [];
      for (const entry of ops) {
        if (entry.op === "append") for (const step of entry.steps) appendStep(journal, step);
        else if (entry.op === "head") {
          const page = read(researchActivityHeadRange(window, limit));
          const apply = () => { window = mergeResearchActivityHead(window, page); };
          if (entry.late) pending.push(apply); else apply();
        } else if (entry.op === "older" && window.nextBeforeSeq !== undefined) {
          const page = read({ beforeSeq: window.nextBeforeSeq, limit });
          const apply = () => { window = appendResearchActivityOlder(window, page); };
          if (entry.late) pending.push(apply); else apply();
        } else if (entry.op === "deliver" && pending.length) pending.splice(entry.pick % pending.length, 1)[0]!();
        expectWindowAgrees(window, journal);
      }
      // Once every reply has landed, a head read and Show older reach the complete journal, newest first.
      for (const apply of pending.splice(0)) { apply(); expectWindowAgrees(window, journal); }
      window = mergeResearchActivityHead(window, read(researchActivityHeadRange(window, limit)));
      while (window.nextBeforeSeq !== undefined) window = appendResearchActivityOlder(window, read({ beforeSeq: window.nextBeforeSeq, limit }));
      expect(window.events).toEqual(projectResearchRun("run", journal).events.toReversed());
    }), { numRuns: 200 });
  });

  it("names the same phase from a run summary as from its board", () => {
    fc.assert(fc.property(fc.array(stepArb, { minLength: 0, maxLength: 30 }), fc.constantFrom<ResearchRun["status"]>("running", "stopping", "completed", "exhausted"), (steps, status) => {
      const journal = createdJournal();
      for (const step of steps) appendStep(journal, step);
      if (status !== "running") journal.push({ seq: journal.length + 1, commandId: "end", signature: "end", at: 9000, actor, data: { type: "status", status, reason: "r" } });
      const run = projectResearchRun("run", journal);
      expect(researchRunPhase(summarizeResearchRun(run))).toEqual(researchRunPhase(researchPhaseInput(run)));
    }));
  });
});
