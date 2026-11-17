import fc from "fast-check";
import { RESEARCH_FINDING_KINDS, RESEARCH_WORK_STATES, type ResearchActor, type ResearchApproach, type ResearchDelivery, type ResearchEvent, type ResearchEventData, type ResearchRun, type ResearchStatus } from "../research";

/**
 * Generated research journals for oracle tests: every event kind, aimed at
 * items the journal already holds, in the shapes the owner appends. Item IDs
 * sort in creation order within one event, as the owner's `a1`..`a8` do, so a
 * store that orders by (created_seq, item_id) agrees with replay order.
 */
export const RESEARCH_JOURNAL_COORDINATOR = { kind: "agent", backend: "codex", threadId: "coordinator" } as const satisfies ResearchActor;

export const RESEARCH_JOURNAL_EVENT_KINDS = [
  "finding", "submission", "review", "worker", "abandoned", "direction", "status", "delivery_failed", "delivery", "assignment", "item_work",
] as const satisfies readonly Exclude<ResearchEventData["type"], "created">[];

export type ResearchJournalStep = { kind: typeof RESEARCH_JOURNAL_EVENT_KINDS[number]; pick: number; other: number; variant: number; flag: boolean };

export const researchJournalStepArb: fc.Arbitrary<ResearchJournalStep> = fc.record({
  // Findings and worker events are the bulk of a real journal.
  kind: fc.constantFrom(...RESEARCH_JOURNAL_EVENT_KINDS, "finding" as const, "finding" as const, "worker" as const),
  // Half the picks choose the first approach, so one branch collects more contributions than the Map shows.
  pick: fc.oneof(fc.constant(0), fc.nat()), other: fc.nat(), variant: fc.nat(), flag: fc.boolean(),
});

const APPROACH_STATES: ResearchApproach["state"][] = ["pending", "starting", "running", "ended", "failed", "stopped", "unknown"];
const DELIVERY_STATES: ResearchDelivery["state"][] = ["pending", "queued", "started", "cancelled", "unknown", "ended"];
const STATUSES: ResearchStatus[] = ["running", "stopping", "stopped", "deadline", "completed", "interrupted", "exhausted"];
const TEXTS = ["Queue reversal", "OWNER lifetime", "100%_literal", "ÉTUDE α", "quoted ' evidence", "a\nsecond line"];

export function researchJournalWorker(index: number) {
  return { backend: "codex" as const, threadId: `worker-${index % 4}` };
}

export function researchCreatedEvent(approaches: number, options: { at?: number; coordinator?: ResearchActor } = {}): ResearchEvent {
  const coordinator = options.coordinator ?? RESEARCH_JOURNAL_COORDINATOR;
  return { seq: 1, at: options.at ?? 1000, actor: coordinator, commandId: "created", signature: "created", data: {
    type: "created", objective: "Research", coordinator: { backend: coordinator.backend, threadId: coordinator.threadId }, ownerId: "owner", ownerPid: 1, ownerStartedAt: 500,
    deadlineAt: 100_000, workspaceMode: "none",
    approaches: Array.from({ length: approaches }, (_, index) => ({ id: `a${index + 1}`, title: `Approach ${index + 1}`, task: `Task ${index + 1}`, state: "pending" as const })),
  } };
}

/** The next event of `run`'s journal for a generated step. Always valid for `projectResearchRun`. */
export function nextResearchEvent(run: ResearchRun, step: ResearchJournalStep): ResearchEvent {
  const seq = run.revision + 1;
  const approach = run.approaches[step.pick % run.approaches.length]!;
  const item = run.items[step.other % run.items.length]!;
  const submission = run.submissions.length ? run.submissions[step.pick % run.submissions.length] : undefined;
  const worker = researchJournalWorker(step.other);
  const actor: ResearchActor = step.variant % 3 === 0 ? RESEARCH_JOURNAL_COORDINATOR
    : step.variant % 3 === 1 ? { ...RESEARCH_JOURNAL_COORDINATOR, kind: "operator" } : { ...worker, kind: "agent", turnId: `turn-${seq}` };
  const text = `${TEXTS[step.variant % TEXTS.length]} ${seq}`;
  let data: ResearchEventData;
  switch (step.kind) {
    case "submission": data = { type: "submission", submission: { id: `s${seq}`, approachId: approach.id, text, paths: step.flag ? ["evidence/result.txt"] : [],
      ...(step.flag ? { author: worker } : {}) } }; break;
    case "review": data = submission ? { type: "review", submissionId: submission.id, decision: (["accepted", "revision_requested", "rejected"] as const)[step.variant % 3]!, reason: text }
      : { type: "delivery_failed", reason: text }; break;
    case "worker": data = { type: "worker", approachId: approach.id, state: APPROACH_STATES[step.variant % APPROACH_STATES.length]!,
      ...(step.flag ? { worker: { ...worker, turnId: `turn-${seq}` } } : { note: text }) }; break;
    case "abandoned": data = { type: "abandoned", approachId: approach.id, reason: text }; break;
    case "direction": data = { type: "direction", approachId: approach.id, title: `Retitled ${seq}`, task: text, reason: `why ${seq}`,
      ...(step.flag ? { overlapsApproachId: run.approaches[step.other % run.approaches.length]!.id } : {}) }; break;
    case "status": data = { type: "status", status: STATUSES[step.variant % STATUSES.length]!, reason: text }; break;
    case "delivery_failed": data = { type: "delivery_failed", reason: text }; break;
    case "delivery": data = { type: "delivery", delivery: step.pick % 5 === 0
      ? { id: `d-run-${step.other % 2}`, target: { backend: "codex", threadId: "coordinator" }, state: DELIVERY_STATES[step.variant % DELIVERY_STATES.length]! }
      : { id: `d-${approach.id}-${step.other % 2}`, target: worker, approachId: approach.id, state: DELIVERY_STATES[step.variant % DELIVERY_STATES.length]!,
        ...(step.flag ? { queueEntryId: `queue-${step.other % 3}` } : {}), ...(step.variant % 2 ? { turnId: `turn-${step.other % 5}` } : {}) } }; break;
    case "assignment": data = { type: "assignment", itemId: item.id, task: text,
      approach: { id: `work-${seq}`, itemId: item.id, title: `Focus ${seq}`, task: text, state: "pending" } }; break;
    case "item_work": data = { type: "item_work", itemId: item.id, work: { state: RESEARCH_WORK_STATES[step.variant % RESEARCH_WORK_STATES.length]!, note: text,
      ...(step.flag ? { assignee: worker } : {}), ...(item.work.assignmentId ? { assignmentId: item.work.assignmentId } : {}) } }; break;
    default: data = { type: "finding", finding: { id: `f${seq}`, approachId: approach.id, kind: RESEARCH_FINDING_KINDS[step.variant % RESEARCH_FINDING_KINDS.length]!, text,
      paths: step.variant % 4 === 0 ? ["notes/a.md", "notes/b.md"] : [], ...(step.flag ? { relatesTo: item.id, relation: "supports" as const, author: worker } : {}) } };
  }
  return { seq, at: 1000 + seq, actor, commandId: `c${seq}`, signature: JSON.stringify(data), data };
}
