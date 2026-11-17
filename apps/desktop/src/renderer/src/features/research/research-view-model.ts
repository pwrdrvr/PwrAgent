import { researchApproachOccupiesSlot, sameResearchThread, type ResearchApproach, type ResearchEvent, type ResearchEventPage, type ResearchFinding, type ResearchItem, type ResearchRun, type ResearchRunBoard, type ResearchRunSummary, type ResearchSubmission } from "@pwragent/shared";

export type ResearchTone = "live" | "attention" | "done" | "neutral" | "problem";
export type ResearchPhase = { label: string; tone: ResearchTone };

export function researchLabel(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (s) => s.toUpperCase());
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function isResearchRunLive(run: Pick<ResearchRun, "status">): boolean {
  return run.status === "running" || run.status === "stopping";
}

export function unreviewedCandidates(run: Pick<ResearchRun, "submissions">): ResearchSubmission[] {
  return run.submissions.filter((submission) => !submission.review);
}

/** What names a run's phase. A summary carries it directly; a board through `researchPhaseInput`. */
export type ResearchPhaseInput = Pick<ResearchRunSummary, "status" | "activeWorkers" | "unreviewed" | "accepted">;

export function researchPhaseInput(run: Pick<ResearchRunBoard, "status" | "approaches" | "submissions">): ResearchPhaseInput {
  return { status: run.status, activeWorkers: run.approaches.filter(researchApproachOccupiesSlot).length,
    unreviewed: unreviewedCandidates(run).length, accepted: run.submissions.filter((s) => s.review?.decision === "accepted").length };
}

/**
 * The operator-facing phase. A running run with no worker holding a slot is
 * waiting on the coordinator: "Awaiting review" while any candidate is
 * undecided, "Ready to finish" once one is accepted and none is undecided.
 * An approach with an unresolved revision delivery still holds its slot.
 */
export function researchRunPhase(run: ResearchPhaseInput): ResearchPhase {
  if (run.status === "running") {
    if (run.activeWorkers > 0) return { label: "Running", tone: "live" };
    if (run.unreviewed) return { label: "Awaiting review", tone: "attention" };
    if (run.accepted) return { label: "Ready to finish", tone: "attention" };
    return { label: "Running", tone: "live" };
  }
  switch (run.status) {
    case "stopping": return { label: "Stopping", tone: "live" };
    case "completed": return { label: "Completed", tone: "done" };
    case "deadline": return { label: "Deadline reached", tone: "neutral" };
    case "stopped": return { label: "Stopped", tone: "neutral" };
    case "exhausted": return { label: "No candidates", tone: "neutral" };
    case "interrupted": return { label: "Interrupted", tone: "problem" };
  }
}

/** Remaining time for a live run, or when its deadline fell for a finished one. */
export function researchTimeLeft(run: Pick<ResearchRun, "status" | "deadlineAt">, now: number): string {
  const at = formatClock(run.deadlineAt);
  if (!isResearchRunLive(run)) return `Deadline ${at}`;
  const remaining = run.deadlineAt - now;
  if (remaining <= 0) return "Deadline passed";
  if (remaining < 60_000) return `Under a minute left · ends ${at}`;
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 60) return `${minutes} min left · ends ${at}`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min left · ends ${at}`;
}

export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function researchRunCounts(run: ResearchRunBoard) {
  return {
    slotsInUse: run.activeWorkers,
    workerLimit: run.workerLimit,
    findings: run.findings.length,
    candidates: run.submissions.length,
    unreviewed: unreviewedCandidates(run).length,
    accepted: run.submissions.filter((s) => s.review?.decision === "accepted").length,
  };
}

/** Why Finish is unavailable, or undefined when it is. */
export function researchFinishBlocker(run: ResearchRunBoard): string | undefined {
  if (!run.submissions.some((s) => s.review?.decision === "accepted")) return "Accept a candidate to finish the run.";
  return undefined;
}

/** Why a revision cannot be requested for this candidate, or undefined when it can. */
export function researchRevisionBlocker(run: ResearchRunBoard, submission: ResearchSubmission, live: boolean): string | undefined {
  if (!live || run.status !== "running") return "Revisions need a running run.";
  const approach = run.approaches.find((a) => a.id === submission.approachId);
  if (!approach?.worker) return "This candidate's worker is unavailable.";
  if (approach.revisionDeliveryIds?.length) return "A revision is already pending for this worker.";
  if (!researchApproachOccupiesSlot(approach) && run.activeWorkers >= run.workerLimit) return "Every worker slot is in use.";
  return undefined;
}

export function approachTitle(run: Pick<ResearchRun, "approaches">, id: string): string {
  return run.approaches.find((a) => a.id === id)?.title ?? id;
}

/**
 * Who acted, in the operator's words. Only commands from the panel carry an
 * `operator:` key; other operator-authority events are the owner's own
 * lifecycle bookkeeping (deadline, settlement, recovery).
 */
export function researchActorLabel(run: Pick<ResearchRun, "approaches" | "coordinator">, actor: ResearchEvent["actor"], commandId = ""): string {
  if (actor.kind === "operator") return commandId.startsWith("operator:") ? "You" : "PwrAgent";
  if (sameResearchThread(actor, run.coordinator)) return "Coordinator";
  const approach = run.approaches.find((a) => a.worker && sameResearchThread(a.worker, actor));
  return approach ? approach.title : "Worker";
}

export function excerpt(text: string, max = 100): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

export type ResearchActivityRow = { seq: number; at: number; kind: string; actor: string; text: string; itemId?: string };

/** One row per loaded event, newest first as given. Approach IDs are replaced with their titles. */
export function researchActivityRows(run: ResearchRunBoard, events: readonly ResearchEvent[]): ResearchActivityRow[] {
  const title = (id: string) => approachTitle(run, id);
  const rows: ResearchActivityRow[] = [];
  for (const event of events) {
    const data = event.data;
    // Worker admission and delivery receipts are recorded by the owner, whoever triggered them.
    const system = data.type === "worker" || data.type === "delivery" || data.type === "delivery_failed";
    const row = (kind: string, text: string, itemId?: string): ResearchActivityRow => ({ seq: event.seq, at: event.at, kind,
      actor: system ? "PwrAgent" : researchActorLabel(run, event.actor, event.commandId), text, ...(itemId ? { itemId } : {}) });
    switch (data.type) {
      case "created": rows.push(row("Run requested", data.objective)); break;
      case "worker": rows.push(row("Worker", `${title(data.approachId)}: ${researchLabel(data.state)}${data.note ? ` · ${data.note}` : ""}`, data.approachId)); break;
      case "finding": rows.push(row(researchLabel(data.finding.kind), data.finding.text, data.finding.id)); break;
      case "submission": rows.push(row("Candidate", data.submission.text, data.submission.id)); break;
      case "review": rows.push(row(researchLabel(data.decision), data.reason, data.submissionId)); break;
      case "abandoned": rows.push(row("Abandoned", `${title(data.approachId)}: ${data.reason}`, data.approachId)); break;
      case "direction": rows.push(row("Direction changed", `${data.title} · ${data.reason}`, data.approachId)); break;
      case "status": rows.push(row(researchRunPhase({ status: data.status, activeWorkers: 0, unreviewed: 0, accepted: 0 }).label, data.reason)); break;
      case "delivery_failed": rows.push(row("Delivery unconfirmed", data.reason)); break;
      case "delivery": rows.push(row("Revision feedback", `${data.delivery.approachId ? `${title(data.delivery.approachId)}: ` : ""}${researchLabel(data.delivery.state)}`, data.delivery.approachId)); break;
      case "assignment": rows.push(row("Child assigned", data.task, data.itemId)); break;
      case "item_work": rows.push(row(researchLabel(data.work.state), data.work.note ?? itemExcerpt(run, data.itemId), data.itemId)); break;
    }
  }
  return rows;
}

/**
 * The loaded part of a run's journal: one contiguous stretch, newest first,
 * that ends at the newest event the window has read. `nextBeforeSeq` is set
 * while older events remain.
 */
export type ResearchActivityWindow = { runId: string; events: ResearchEvent[]; nextBeforeSeq?: number };

export function emptyResearchActivity(runId: string): ResearchActivityWindow {
  return { runId, events: [] };
}

/** The range that reads what was appended since the window's newest event. */
export function researchActivityHeadRange(window: ResearchActivityWindow, limit: number) {
  const top = window.events[0]?.seq;
  return top === undefined ? { limit } : { afterSeq: top, limit };
}

/**
 * Merge a head read (`researchActivityHeadRange`). New events go on top. If
 * more arrived than one page holds, the page leaves a gap above the old
 * window, so the window restarts from the page; Show older reaches the rest.
 */
export function mergeResearchActivityHead(window: ResearchActivityWindow, page: ResearchEventPage): ResearchActivityWindow {
  if (page.runId !== window.runId) return window;
  const top = window.events[0]?.seq ?? 0;
  const fresh = page.events.filter((event) => event.seq > top);
  if (!window.events.length || (fresh.length && page.nextBeforeSeq !== undefined && page.nextBeforeSeq > top + 1)) {
    return { runId: window.runId, events: page.events, ...(page.nextBeforeSeq !== undefined ? { nextBeforeSeq: page.nextBeforeSeq } : {}) };
  }
  if (!fresh.length) return window;
  return { ...window, events: [...fresh, ...window.events] };
}

/** Append an older page. A page that does not continue the window, such as one read before a restart, is ignored. */
export function appendResearchActivityOlder(window: ResearchActivityWindow, page: ResearchEventPage): ResearchActivityWindow {
  const oldest = window.events.at(-1);
  if (page.runId !== window.runId || !oldest || window.nextBeforeSeq !== oldest.seq || page.events[0]?.seq !== oldest.seq - 1) return window;
  const { nextBeforeSeq: _previous, ...rest } = window;
  return { ...rest, events: [...window.events, ...page.events], ...(page.nextBeforeSeq !== undefined ? { nextBeforeSeq: page.nextBeforeSeq } : {}) };
}

function itemExcerpt(run: ResearchRunBoard, itemId: string): string {
  const item = run.items.find((entry) => entry.id === itemId);
  return item ? excerpt(researchItemText(item), 80) : itemId;
}

export function researchItemText(item: ResearchItem): string {
  return item.type === "approach" ? item.record.title : item.record.text;
}

/** A finding or candidate on the map, with the focused children that investigate it. */
export type ResearchMapLeaf =
  | { type: "finding"; record: ResearchFinding; children: ResearchMapBranch[] }
  | { type: "submission"; record: ResearchSubmission; children: ResearchMapBranch[] };
export type ResearchMapBranch = { approach: ResearchApproach; leaves: ResearchMapLeaf[]; hidden: number; assignments: ResearchMapBranch[] };

/**
 * Approaches with their contributions, newest first. A focused child nests
 * under the item it investigates, with its own contributions. Every approach
 * appears exactly once: a child whose source is missing, or whose chain of
 * sources loops, stays reachable as a top-level branch. Only the newest
 * `leafLimit` contributions of a branch render; `hidden` counts the rest.
 */
export function researchMapBranches(run: ResearchRunBoard, leafLimit = 6): ResearchMapBranch[] {
  const items = new Map(run.items.map((item) => [item.id, item]));
  const childrenOf = new Map<string, ResearchApproach[]>();
  for (const approach of run.approaches) {
    if (!approach.itemId || approach.itemId === approach.id || !items.has(approach.itemId)) continue;
    childrenOf.set(approach.itemId, [...(childrenOf.get(approach.itemId) ?? []), approach]);
  }
  const placed = new Set<string>();
  const build = (approach: ResearchApproach): ResearchMapBranch => {
    placed.add(approach.id);
    const nest = (id: string) => (childrenOf.get(id) ?? []).filter((child) => !placed.has(child.id)).map(build);
    const contributions: Array<{ type: "finding"; record: ResearchFinding } | { type: "submission"; record: ResearchSubmission }> = [
      ...run.findings.filter((f) => f.approachId === approach.id).map((record) => ({ type: "finding" as const, record })),
      ...run.submissions.filter((s) => s.approachId === approach.id).map((record) => ({ type: "submission" as const, record })),
    ];
    contributions.sort((a, b) => (items.get(b.record.id)?.createdSeq ?? 0) - (items.get(a.record.id)?.createdSeq ?? 0));
    const assignments = nest(approach.id);
    // Children of hidden contributions still render; they attach to the branch instead.
    const leaves = contributions.map((entry) => ({ ...entry, children: nest(entry.record.id) }) as ResearchMapLeaf);
    const shown = leaves.slice(0, leafLimit);
    for (const leaf of leaves.slice(leafLimit)) assignments.push(...leaf.children);
    return { approach, leaves: shown, hidden: leaves.length - shown.length, assignments };
  };
  const roots = run.approaches.filter((a) => !a.itemId || a.itemId === a.id || !items.has(a.itemId));
  const branches = roots.map(build);
  // A loop of children whose sources are each other has no root; keep each reachable.
  for (const approach of run.approaches) if (!placed.has(approach.id)) branches.push(build(approach));
  return branches;
}
