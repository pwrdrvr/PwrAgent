import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyResearchChanges, emptyResearchRunStore, projectResearchRun, RESEARCH_MAP_LEAVES, researchApproachLeaves, researchApproachOccupiesSlot, researchChangePage, researchEventPage, researchRunState,
  searchResearchItems, summarizeResearchRun, type ResearchApproach, type ResearchEvent, type ResearchEventData, type ResearchEventRange, type ResearchFinding, type ResearchItem,
  type ResearchRun, type ResearchRunStore, type ResearchSearchQuery, type ResearchSubmission,
} from "@pwragent/shared";
import { nextResearchEvent, researchCreatedEvent, researchJournalStepArb } from "../../../../../../../../packages/shared/src/__tests__/research-journal-arbitraries";
import {
  appendResearchActivityOlder, appendResearchFindingsOlder, emptyResearchActivity, emptyResearchFindings, mergeResearchActivityHead, mergeResearchFindingsHead, researchActivityHeadRange,
  researchActivityRows, researchFindingMatches, researchFindingsOlderCursor, researchMapBranches, researchMapMatches, researchRunPhase, researchRunView, researchTimeLeft,
  type ResearchActivityWindow, type ResearchFindingsWindow, type ResearchMapBranch, type ResearchPhaseInput,
} from "../research-view-model";

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
/** What a summary and a run's state carry, counted the way the owner counts them. */
function researchPhaseInput(run: Pick<ResearchRun, "status" | "approaches" | "submissions">): ResearchPhaseInput {
  return { status: run.status, activeWorkers: run.approaches.filter(researchApproachOccupiesSlot).length,
    unreviewed: run.submissions.filter((s) => !s.review).length, accepted: run.submissions.filter((s) => s.review?.decision === "accepted").length };
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
  // Enough contributions that an approach often holds more than the Map shows.
  contributions: fc.array(fc.record({ owner: fc.nat(), finding: fc.boolean() }), { size: "max", maxLength: 40 }),
  links: fc.array(fc.option(fc.nat(), { nil: undefined }), { maxLength: 6 }),
});

/** A synced store of the generated items, with the Map entries the owner would read for them. */
function mapRun(input: { approaches: number; contributions: Array<{ owner: number; finding: boolean }>; links: Array<number | undefined> }): ResearchRunStore & { findings: ResearchFinding[]; candidates: ResearchSubmission[] } {
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
  const item = (record: ResearchApproach | ResearchFinding | ResearchSubmission, type: ResearchItem["type"], createdSeq: number) => ({
    id: record.id, approachId: "approachId" in record ? record.approachId : record.id, type, record, createdSeq, version: createdSeq, updatedAt: createdSeq, work: { state: "open" } }) as ResearchItem;
  const items = [...approaches.map((record, index) => item(record, "approach", index + 1)), ...findings.map((record, index) => item(record, "finding", 100 + index)),
    ...submissions.map((record, index) => item(record, "submission", 200 + index))];
  const state = { revision: 1, status: "running" as const, activeWorkers: approaches.length, unreviewed: submissions.length, accepted: 0, findings: findings.length, candidates: submissions.length };
  return { ...applyResearchChanges(emptyResearchRunStore("run"), { runId: "run", revision: 1, state, items, approaches: researchApproachLeaves({ items }), writable: false }), findings, candidates: submissions };
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
      const branches = researchMapBranches(run);
      const seen = walk(branches, { approaches: [], leaves: [], hidden: 0 });
      expect([...seen.approaches].sort()).toEqual(run.approaches.map((a) => a.id).sort());
      expect(new Set(seen.leaves).size).toBe(seen.leaves.length);
      expect(seen.leaves.length + seen.hidden).toBe(run.findings.length + run.candidates.length);
      // Each branch shows its approach's newest contributions, newest first, and no more than the owner read.
      const check = (branch: ResearchMapBranch) => {
        const own = [...run.items.values()].filter((entry) => entry.type !== "approach" && entry.approachId === branch.approach.id).sort((a, b) => b.createdSeq - a.createdSeq);
        expect(branch.leaves.map((leaf) => leaf.record.id)).toEqual(own.slice(0, RESEARCH_MAP_LEAVES).map((entry) => entry.id));
        expect(branch.hidden).toBe(Math.max(0, own.length - RESEARCH_MAP_LEAVES));
        for (const leaf of branch.leaves) leaf.children.forEach(check);
        branch.assignments.forEach(check);
      };
      branches.forEach(check);
    }), { numRuns: 400 });
  });

  it("nests a focused child and its own findings under the item it investigates", () => {
    // Link 2 of [a0, a1, f0, f1, missing] is f0.
    const run = mapRun({ approaches: 2, contributions: [{ owner: 0, finding: true }, { owner: 1, finding: true }], links: [undefined, 2] });
    const [root] = researchMapBranches(run);
    expect(root!.approach.id).toBe("a0");
    expect(root!.leaves[0]!.children[0]!.approach.id).toBe("a1");
    expect(root!.leaves[0]!.children[0]!.leaves[0]!.record.id).toBe("f1");
  });
});

describe("research activity", () => {
  it("lists newest first with approach titles instead of IDs", () => {
    const approach = { id: "a1", title: "Bisect fixture setup", task: "t", state: "running" } as const;
    const run = { approaches: [approach], coordinator: actor,
      items: new Map<string, ResearchItem>([["a1", { id: "a1", approachId: "a1", type: "approach", record: approach, createdSeq: 1, version: 1, updatedAt: 1, work: { state: "open" } }]]),
      events: [
        { seq: 1, at: 1, commandId: "c1", signature: "s", actor, data: { type: "worker", approachId: "a1", state: "running" } },
        { seq: 2, at: 2, commandId: "operator:c2", signature: "s", actor: { ...actor, kind: "operator" }, data: { type: "abandoned", approachId: "a1", reason: "Ruled out" } },
        { seq: 3, at: 3, commandId: "settled:2", signature: "s", actor: { ...actor, kind: "operator" }, data: { type: "status", status: "deadline", reason: "Research deadline reached" } },
      ] as ResearchEvent[] };
    const rows = researchActivityRows(run, run.events.toReversed());
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

  it("names the same phase from a run summary as from the synced store of its run", () => {
    fc.assert(fc.property(fc.array(stepArb, { minLength: 0, maxLength: 30 }), fc.constantFrom<ResearchRun["status"]>("running", "stopping", "completed", "exhausted"), (steps, status) => {
      const journal = createdJournal();
      for (const step of steps) appendStep(journal, step);
      if (status !== "running") journal.push({ seq: journal.length + 1, commandId: "end", signature: "end", at: 9000, actor, data: { type: "status", status, reason: "r" } });
      const run = projectResearchRun("run", journal);
      const view = researchRunView(summarizeResearchRun(run), applyResearchChanges(emptyResearchRunStore("run"), { ...researchChangePage(run), writable: true }))!;
      expect(researchRunPhase(view)).toEqual(researchRunPhase(summarizeResearchRun(run)));
      expect(researchRunPhase(view)).toEqual(researchRunPhase(researchPhaseInput(run)));
      expect(view).toMatchObject(researchRunState(run));
    }));
  });

  it("shows no run until its store has finished a sync, or for another run's store", () => {
    const run = projectResearchRun("run", createdJournal());
    const summary = summarizeResearchRun(run);
    expect(researchRunView(summary, emptyResearchRunStore("run"))).toBeUndefined();
    const partial = applyResearchChanges(emptyResearchRunStore("run"), { ...researchChangePage(run, 0, undefined, 1), writable: true });
    expect(partial.cursor).toBeDefined();
    expect(researchRunView(summary, partial)).toBeUndefined();
    const synced = applyResearchChanges(partial, { ...researchChangePage(run, 0, partial.cursor, 5), writable: true });
    expect(researchRunView(summary, synced)?.approaches.map((approach) => approach.id)).toEqual(["a1", "a2"]);
    expect(researchRunView({ ...summary, id: "other" }, synced)).toBeUndefined();
  });
});

describe("research findings filter", () => {
  const queryArb = fc.record({
    pick: fc.nat(), part: fc.constantFrom("text", "title", "path", "kind", "relation", "absent"), start: fc.nat(40), length: fc.integer({ min: 1, max: 14 }), upper: fc.boolean(),
  });
  /** The card's line for the finding it relates to, from the replayed run. */
  const relationLine = (run: ResearchRun, finding: ResearchFinding) => {
    if (!finding.relatesTo) return undefined;
    const related = run.findings.find((other) => other.id === finding.relatesTo)?.text;
    return `${finding.relation ?? "related"}: ${related === undefined ? "an earlier finding" : related.length > 80 ? `${related.slice(0, 80).trimEnd()}…` : related}`;
  };
  /** What the card of `finding` shows, from the replayed run: its kind as labelled, its text, its approach's title, its relation line and its evidence paths. */
  const cardParts = (run: ResearchRun, finding: ResearchFinding) => [
    finding.kind, finding.kind.replaceAll("_", " "), finding.text, run.approaches.find((approach) => approach.id === finding.approachId)?.title ?? finding.approachId,
    relationLine(run, finding) ?? "", ...finding.paths,
  ];

  it("lists exactly the findings whose card shows the filter text, newest first, as the run changes", () => {
    let cut = 0;
    let byTitle = 0;
    let byPath = 0;
    let byLabel = 0;
    let byRelation = 0;
    fc.assert(fc.property(fc.array(fc.record({ steps: fc.array(researchJournalStepArb, { minLength: 1, maxLength: 8 }), queries: fc.array(queryArb, { minLength: 1, maxLength: 4 }) }), { minLength: 1, maxLength: 6 }), (rounds) => {
      const journal = [researchCreatedEvent(3)];
      let store = emptyResearchRunStore("run");
      for (const round of rounds) {
        for (const step of round.steps) journal.push(nextResearchEvent(projectResearchRun("run", journal), step));
        const run = projectResearchRun("run", journal);
        // The window's store follows by delta, so most items are the objects an earlier round matched against.
        store = applyResearchChanges(store, { ...researchChangePage(run, store.revision), writable: true });
        const view = researchRunView(summarizeResearchRun(run), store)!;
        for (const wanted of round.queries) {
          const source = run.findings.length ? run.findings[wanted.pick % run.findings.length] : undefined;
          const parts = source ? cardParts(run, source) : [];
          const whole = wanted.part === "absent" || !source ? "no card shows this"
            : wanted.part === "kind" ? parts[1]! : wanted.part === "title" ? parts[3]! : wanted.part === "relation" ? parts[4] || source.text
            : wanted.part === "path" ? source.paths[0] ?? source.text : source.text;
          const piece = wanted.part === "kind" || wanted.part === "absent" ? whole : whole.slice(wanted.start % whole.length, wanted.start % whole.length + wanted.length);
          const query = wanted.upper ? piece.toUpperCase() : piece;
          const needle = query.trim().toLowerCase();
          const expected = needle ? [...run.findings].reverse().filter((finding) => cardParts(run, finding).some((part) => part.toLowerCase().includes(needle))) : [];
          expect(researchFindingMatches(view, query).map((finding) => finding.id)).toEqual(expected.map((finding) => finding.id));
          if (needle && source && wanted.part !== "absent") {
            // The text was cut from this finding's card, so the filter must list it.
            expect(expected.map((finding) => finding.id)).toContain(source.id);
            cut++;
            if (!source.text.toLowerCase().includes(needle) && wanted.part === "title") byTitle++;
            if (!source.text.toLowerCase().includes(needle) && wanted.part === "path" && source.paths.length) byPath++;
            if (wanted.part === "kind" && source.kind.includes("_")) byLabel++;
            if (!source.text.toLowerCase().includes(needle) && wanted.part === "relation" && source.relatesTo) byRelation++;
          }
        }
      }
    }), { numRuns: 150 });
    // The generated filters reached each thing a card shows beyond the finding's own text.
    expect(cut).toBeGreaterThan(100);
    expect(byTitle).toBeGreaterThan(10);
    expect(byPath).toBeGreaterThan(10);
    expect(byLabel).toBeGreaterThan(3);
    expect(byRelation).toBeGreaterThan(3);
  });

  it("finds a finding by its approach's title and by an evidence path", () => {
    const journal = [researchCreatedEvent(2)];
    journal.push(nextResearchEvent(projectResearchRun("run", journal), { kind: "finding", pick: 1, other: 0, variant: 4, flag: false }));
    const run = projectResearchRun("run", journal);
    const view = researchRunView(summarizeResearchRun(run), applyResearchChanges(emptyResearchRunStore("run"), { ...researchChangePage(run), writable: true }))!;
    const finding = run.findings[0]!;
    expect(finding).toMatchObject({ approachId: "a2", paths: ["notes/a.md", "notes/b.md"] });
    expect(researchFindingMatches(view, "approach 2")).toEqual([finding]);
    expect(researchFindingMatches(view, "notes/b.md")).toEqual([finding]);
    expect(researchFindingMatches(view, "approach 1")).toEqual([]);
    expect(researchFindingMatches(view, "  ")).toEqual([]);
  });

  it("matches the line for a related finding as the card cuts it", () => {
    const journal = [researchCreatedEvent(2)];
    const share = (change: Partial<ResearchFinding>) => {
      const event = nextResearchEvent(projectResearchRun("run", journal), { kind: "finding", pick: 0, other: 0, variant: 1, flag: false });
      if (event.data.type !== "finding") throw new Error("expected a finding");
      const data = { type: "finding" as const, finding: { ...event.data.finding, ...change } };
      journal.push({ ...event, signature: JSON.stringify(data), data });
      return data.finding.id;
    };
    // Eighty-four characters, then a tail the relation line leaves out.
    const first = share({ text: `${"long evidence ".repeat(6)}tail past the cut` });
    const second = share({ text: "A shorter result", relatesTo: first, relation: "contradicts" });
    const run = projectResearchRun("run", journal);
    const view = researchRunView(summarizeResearchRun(run), applyResearchChanges(emptyResearchRunStore("run"), { ...researchChangePage(run), writable: true }))!;
    const ids = (query: string) => researchFindingMatches(view, query).map((finding) => finding.id);
    expect(ids("Contradicts: long evidence")).toEqual([second]);
    expect(ids("long evidence")).toEqual([second, first]);
    expect(ids("tail past the cut")).toEqual([first]);
  });
});

describe("research map filter", () => {
  const PARTS = ["title", "task", "note", "text", "state", "abandoned", "kind", "candidate", "overlap", "child", "more"] as const;
  type Part = { kind: typeof PARTS[number]; text: string };
  const queryArb = fc.record({ pick: fc.nat(), part: fc.constantFrom(...PARTS, "more" as const, "more" as const, "absent" as const), which: fc.nat(), start: fc.nat(40), length: fc.integer({ min: 1, max: 14 }), upper: fc.boolean() });
  const label = (value: string) => value.replaceAll("_", " ").replace(/^./, (s) => s.toUpperCase());
  const cut = (text: string) => text.length > 100 ? `${text.slice(0, 100).trimEnd()}…` : text;

  /**
   * Every line `branch` draws, from the replayed run's own records: its title (after "Focused child" when nested), state chip, task, note,
   * overlap line, each shown contribution's label and text, the count of the rest, and the same for the children nested in it.
   */
  function shownParts(run: ResearchRun, branch: ResearchMapBranch, nested = false): Part[] {
    const approach = run.approaches.find((entry) => entry.id === branch.approach.id)!;
    const parts: Part[] = [{ kind: "title", text: approach.title }, { kind: "task", text: approach.task }];
    if (nested) parts.push({ kind: "child", text: `Focused child · ${approach.title}` });
    parts.push(approach.directionState === "abandoned" ? { kind: "abandoned", text: "Abandoned" } : { kind: "state", text: label(approach.state) });
    if (approach.note) parts.push({ kind: "note", text: approach.note });
    if (approach.overlapsApproachId) parts.push({ kind: "overlap", text: `Overlaps ${run.approaches.find((entry) => entry.id === approach.overlapsApproachId)?.title ?? approach.overlapsApproachId}` });
    for (const leaf of branch.leaves) {
      const finding = run.findings.find((entry) => entry.id === leaf.record.id);
      const candidate = run.submissions.find((entry) => entry.id === leaf.record.id);
      const shown = finding ? { kind: "kind" as const, text: label(finding.kind) }
        : { kind: "candidate" as const, text: `Candidate · ${candidate!.review ? label(candidate!.review.decision) : "Awaiting review"}` };
      parts.push(shown, { kind: "text", text: `${shown.text} ${cut((finding ?? candidate)!.text)}` });
      for (const child of leaf.children) parts.push(...shownParts(run, child, true));
    }
    if (branch.hidden > 0) parts.push({ kind: "more", text: `${branch.hidden} more from ${approach.title}` });
    for (const child of branch.assignments) parts.push(...shownParts(run, child, true));
    return parts;
  }

  it("keeps exactly the branches that show the filter text, as the run changes", () => {
    const reached = new Map<string, number>();
    // Long enough rounds that an approach often holds more contributions than its branch draws.
    fc.assert(fc.property(fc.array(fc.record({ steps: fc.array(researchJournalStepArb, { size: "max", minLength: 1, maxLength: 16 }), queries: fc.array(queryArb, { minLength: 1, maxLength: 4 }) }), { minLength: 1, maxLength: 6 }), (rounds) => {
      const journal = [researchCreatedEvent(3)];
      let store = emptyResearchRunStore("run");
      for (const round of rounds) {
        for (const step of round.steps) journal.push(nextResearchEvent(projectResearchRun("run", journal), step));
        const run = projectResearchRun("run", journal);
        store = applyResearchChanges(store, { ...researchChangePage(run, store.revision), writable: true });
        const view = researchRunView(summarizeResearchRun(run), store)!;
        const branches = researchMapBranches(view);
        const shown = branches.map((branch) => shownParts(run, branch));
        for (const wanted of round.queries) {
          // The picked branch, or the next one that shows the kind of text wanted.
          const from = wanted.pick % branches.length;
          const order = branches.map((_, index) => (from + index) % branches.length);
          const source = order.find((index) => shown[index]!.some((part) => part.kind === wanted.part)) ?? from;
          const candidates = shown[source]!.filter((part) => part.kind === wanted.part);
          const part = wanted.part === "absent" ? undefined : candidates.length ? candidates[wanted.which % candidates.length]! : shown[source]![0]!;
          // A label is typed whole; free text is cut anywhere.
          const sliced = part && ["title", "task", "note", "text"].includes(part.kind);
          const piece = !part ? "no branch shows this" : sliced ? part.text.slice(wanted.start % part.text.length, wanted.start % part.text.length + wanted.length) : part.text;
          const query = wanted.upper ? piece.toUpperCase() : piece;
          const needle = query.trim().toLowerCase();
          const expected = branches.filter((_, index) => !needle || shown[index]!.some((entry) => entry.text.toLowerCase().includes(needle)));
          expect(researchMapMatches(view, branches, query).map((branch) => branch.approach.id)).toEqual(expected.map((branch) => branch.approach.id));
          if (needle && part) {
            // The text was cut from this branch, so the filter must keep it.
            expect(expected).toContain(branches[source]);
            reached.set(part.kind, (reached.get(part.kind) ?? 0) + 1);
          }
        }
      }
    }), { numRuns: 150 });
    // The generated filters reached each kind of text a branch shows.
    for (const part of PARTS) expect([part, reached.get(part) ?? 0]).toEqual([part, expect.toSatisfy((count: number) => count > 10)]);
  });

  it("finds a branch by its state chip, a contribution's label, its overlap line and a focused child's prefix", () => {
    const journal = [researchCreatedEvent(3)];
    const append = (data: ResearchEventData) => { const seq = journal.length + 1; journal.push({ seq, at: 1000 + seq, actor, commandId: `c${seq}`, signature: JSON.stringify(data), data }); };
    append({ type: "worker", approachId: "a1", state: "ended" });
    append({ type: "abandoned", approachId: "a1", reason: "Ruled out" });
    append({ type: "finding", finding: { id: "f1", approachId: "a2", kind: "dead_end", text: "The cache is never read", paths: [] } });
    append({ type: "submission", submission: { id: "s1", approachId: "a2", text: "Drop the cache", paths: [] } });
    append({ type: "direction", approachId: "a3", title: "Third", task: "Measure", reason: "Narrowed", overlapsApproachId: "a2" });
    append({ type: "assignment", itemId: "f1", task: "Confirm", approach: { id: "work-1", itemId: "f1", title: "Confirm the read path", task: "Confirm", state: "pending" } });
    const run = projectResearchRun("run", journal);
    const view = researchRunView(summarizeResearchRun(run), applyResearchChanges(emptyResearchRunStore("run"), { ...researchChangePage(run), writable: true }))!;
    const ids = (query: string) => researchMapMatches(view, researchMapBranches(view), query).map((branch) => branch.approach.id);
    expect(ids("abandoned")).toEqual(["a1"]);
    // The chip of an abandoned approach no longer shows its worker's state.
    expect(ids("ended")).toEqual([]);
    expect(ids("Dead end")).toEqual(["a2"]);
    expect(ids("awaiting review")).toEqual(["a2"]);
    expect(ids("Candidate · Awaiting")).toEqual(["a2"]);
    expect(ids("overlaps approach 2")).toEqual(["a3"]);
    expect(ids("focused child · confirm")).toEqual(["a2"]);
    expect(ids("  ")).toEqual(["a1", "a2", "a3"]);
  });
});

describe("research findings paging", () => {
  const opArb = fc.oneof(
    { arbitrary: fc.record({ op: fc.constant("append" as const), steps: fc.array(researchJournalStepArb, { minLength: 1, maxLength: 9 }) }), weight: 3 },
    { arbitrary: fc.record({ op: fc.constant("head" as const) }), weight: 2 },
    { arbitrary: fc.record({ op: fc.constant("older" as const) }), weight: 3 },
  );

  it("keeps the newest findings in order, as the item search lists them, while the board changes between page reads", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 5 }), fc.array(opArb, { size: "max", minLength: 10, maxLength: 50 }), (limit, ops) => {
      const journal = [researchCreatedEvent(3)];
      const run = () => projectResearchRun("run", journal);
      const search = (cursor?: ResearchSearchQuery["cursor"]) => { const current = run(); return searchResearchItems("run", current.items, current.revision, { type: "finding", limit, ...(cursor ? { cursor } : {}) }); };
      const newestFirst = () => run().findings.map((finding) => finding.id).reverse();
      let window: ResearchFindingsWindow = emptyResearchFindings("run");
      const expectWindow = () => {
        // The window is the top of the list as of its last read: every hit is still a finding, in today's order, with nothing skipped between them.
        const order = newestFirst();
        const ids = window.hits.map((hit) => hit.id);
        expect(new Set(ids).size).toBe(ids.length);
        const first = order.indexOf(ids[0] ?? "");
        if (ids.length) expect(ids).toEqual(order.slice(first, first + ids.length));
      };
      const head = () => { window = mergeResearchFindingsHead(window, search()); expect(window.hits.map((hit) => hit.id)).toEqual(newestFirst().slice(0, window.hits.length)); };
      for (const entry of ops) {
        if (entry.op === "append") for (const step of entry.steps) journal.push(nextResearchEvent(run(), step));
        else if (entry.op === "head") head();
        else if (window.next) {
          let page;
          // A board that changed since the window's last read refuses the cursor; the hook then reads the head and continues.
          try { page = search(researchFindingsOlderCursor(window)); } catch { head(); page = window.next ? search(researchFindingsOlderCursor(window)) : undefined; }
          if (page) {
            window = appendResearchFindingsOlder(window, page);
            expect(window.hits.map((hit) => hit.id)).toEqual(newestFirst().slice(0, window.hits.length));
          }
        }
        expectWindow();
      }
      // A head read and Show more reach every finding, newest first.
      head();
      while (window.next) window = appendResearchFindingsOlder(window, search(researchFindingsOlderCursor(window)));
      expect(window.hits.map((hit) => hit.id)).toEqual(newestFirst());
      expect(window.total).toBe(run().findings.length);
    }), { numRuns: 200 });
  });

  it("restarts from the first page when more findings arrived than a page holds, and ignores a page that repeats loaded hits", () => {
    const journal = [researchCreatedEvent(1)];
    const finding = () => journal.push(nextResearchEvent(projectResearchRun("run", journal), { kind: "finding", pick: 0, other: 0, variant: 0, flag: false }));
    const search = (cursor?: ResearchSearchQuery["cursor"]) => { const run = projectResearchRun("run", journal); return searchResearchItems("run", run.items, run.revision, { type: "finding", limit: 2, ...(cursor ? { cursor } : {}) }); };
    for (let i = 0; i < 5; i++) finding();
    let window = mergeResearchFindingsHead(emptyResearchFindings("run"), search());
    const older = search(researchFindingsOlderCursor(window));
    window = appendResearchFindingsOlder(window, older);
    expect(window.hits.map((hit) => hit.id)).toEqual(["f6", "f5", "f4", "f3"]);
    expect(appendResearchFindingsOlder(window, older)).toBe(window);
    finding();
    window = mergeResearchFindingsHead(window, search());
    expect(window.hits.map((hit) => hit.id)).toEqual(["f7", "f6", "f5", "f4", "f3"]);
    for (let i = 0; i < 3; i++) finding();
    window = mergeResearchFindingsHead(window, search());
    expect(window.hits.map((hit) => hit.id)).toEqual(["f10", "f9"]);
    expect(window.next).toBeDefined();
  });
});
