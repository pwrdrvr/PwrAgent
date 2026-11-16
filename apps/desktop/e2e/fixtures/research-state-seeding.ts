import type { ResearchActor, ResearchEvent, ResearchEventData } from "@pwragent/shared";
import { ResearchStore } from "@pwragent/sqlite-storage/research-store";
import { StateDb } from "../../src/main/state/state-db";

export const RESEARCH_FIXTURE_OBJECTIVE = "Why does the queue occasionally reorder messages?";

/** Invented research, written through the production journal before launching a replay window. */
export function seedResearchState(stateDbPath: string): void {
  const db = StateDb.open(stateDbPath);
  const store = new ResearchStore(db);
  const actor: ResearchActor = { backend: "codex", threadId: "thread-smoke", kind: "agent" };
  let revision = 0;
  const append = (data: ResearchEventData, author = actor) => {
    if (data.type === "finding") data.finding.author = { backend: author.backend, threadId: author.threadId };
    if (data.type === "submission") data.submission.author = { backend: author.backend, threadId: author.threadId };
    const event: ResearchEvent = { seq: ++revision, commandId: `fixture-${revision}`, signature: `fixture-${revision}`,
      at: Date.UTC(2026, 10, 1, 14, 0, revision * 5), actor: author, data };
    if (revision === 1) store.create("research-fixture", "research-fixture", event);
    else store.append("research-fixture", revision - 1, event);
  };
  try {
    append({ type: "created", objective: RESEARCH_FIXTURE_OBJECTIVE, coordinator: actor, ownerId: "historical-fixture", ownerPid: 1,
      deadlineAt: Date.UTC(2026, 10, 1, 14, 30), workspaceMode: "none", approaches: [
        { id: "a1", title: "Event ordering", task: "Trace the order in which replies reach the queue.", state: "pending" },
        { id: "a2", title: "Owner lifetime", task: "Check whether ownership changes reorder messages.", state: "pending" },
        { id: "a3", title: "Persistence", task: "Compare recorded order with the queue presented to the operator.", state: "pending" },
      ] });
    for (let i = 1; i <= 3; i++) append({ type: "worker", approachId: `a${i}`, state: "ended", worker: { backend: "codex", threadId: `thread-research-worker-${i}`, turnId: `research-turn-${i}` } });
    append({ type: "finding", finding: { id: "ordering", approachId: "a1", kind: "experiment", text: "A deterministic replay reproduces the reversal when two held replies are released together.", paths: [] } }, { ...actor, threadId: "thread-research-worker-1" });
    append({ type: "finding", finding: { id: "owner", approachId: "a2", kind: "dead_end", text: "The reversal also occurs without an owner change. Ownership does not explain this reproduction.", paths: [] } }, { ...actor, threadId: "thread-research-worker-2" });
    append({ type: "abandoned", approachId: "a2", reason: "The counterexample keeps one owner for the complete run." });
    append({ type: "finding", finding: { id: "durable", approachId: "a3", kind: "partial", text: "Persisted insertion order agrees with the original input. The reversal happens during release.", paths: [], relatesTo: "ordering", relation: "supports" } }, { ...actor, threadId: "thread-research-worker-3" });
    append({ type: "submission", submission: { id: "candidate-1", approachId: "a1", text: "Release held replies in insertion order.", paths: [] } });
    append({ type: "review", submissionId: "candidate-1", decision: "revision_requested", reason: "Include evidence that independent hold reasons remain intact." });
    append({ type: "submission", submission: { id: "candidate-2", approachId: "a1", text: "Preserve insertion order and retain each reply’s independent hold reasons. The queue model agrees across generated release sequences.", paths: [] } });
    append({ type: "review", submissionId: "candidate-2", decision: "accepted", reason: "The reproducer and queue model support the revised candidate. This is an engineering review, not a formal proof." });
    append({ type: "assignment", itemId: "ordering", task: "Check that both independent hold reasons survive release.", approach: {
      id: "work-fixture", itemId: "ordering", title: "Check independent holds", task: "Check that both independent hold reasons survive release.", state: "pending",
    } });
    append({ type: "worker", approachId: "work-fixture", state: "ended", worker: { backend: "codex", threadId: "thread-research-focused", turnId: "focused-turn" } });
    append({ type: "finding", finding: { id: "focused-result", approachId: "work-fixture", kind: "experiment", text: "Both independent hold reasons remain intact in the focused reproduction.", paths: [], relatesTo: "ordering", relation: "supports" } }, { ...actor, threadId: "thread-research-focused" });
    append({ type: "item_work", itemId: "ordering", work: { state: "completed", assignmentId: "work-fixture", assignee: { backend: "codex", threadId: "thread-research-focused" }, note: "The focused child reproduced the queue behavior and checked both hold reasons." } });
    append({ type: "item_work", itemId: "owner", work: { state: "cancelled", note: "This direction was ruled out by the counterexample." } });
    append({ type: "item_work", itemId: "durable", work: { state: "blocked", note: "Retain this partial result for the next investigation." } });
    append({ type: "status", status: "completed", reason: "Completed after reviewing the queue model and reproduction." });
  } finally { db.close(); }
}
