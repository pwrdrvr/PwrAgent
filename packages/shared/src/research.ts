import type { AppServerBackendKind } from "./contracts/normalized-app-server";
import type { ResearchHarnessState, ResearchProvenance } from "./research-harness";

export type ResearchThread = { backend: AppServerBackendKind; threadId: string };
export type ResearchActor = ResearchThread & { kind: "agent" | "operator"; turnId?: string; callId?: string };
export type ResearchStatus = "running" | "stopping" | "stopped" | "deadline" | "completed" | "interrupted" | "exhausted";
export type ResearchFindingKind = "lemma" | "partial" | "counterexample" | "dead_end" | "experiment" | "file" | "note";
export type ResearchApproach = {
  id: string;
  title: string;
  task: string;
  state: "pending" | "starting" | "running" | "ended" | "failed" | "stopped" | "unknown";
  worker?: ResearchThread & { turnId?: string };
  note?: string;
  directionState?: "active" | "abandoned";
  overlapsApproachId?: string;
  /** An item-focused child assignment; its source evidence remains immutable. */
  itemId?: string;
  /** Durable capacity held by pending, queued or unresolved revision work. */
  revisionDeliveryIds?: string[];
};
export type ResearchFinding = {
  id: string;
  author?: ResearchThread;
  approachId: string;
  kind: ResearchFindingKind;
  text: string;
  paths: string[];
  relatesTo?: string;
  relation?: "supports" | "contradicts" | "supersedes";
};
export type ResearchSubmission = {
  id: string;
  author?: ResearchThread;
  approachId: string;
  text: string;
  paths: string[];
  review?: { decision: "accepted" | "revision_requested" | "rejected"; reason: string; actor: ResearchActor };
};
export type ResearchDelivery = { id: string; target: ResearchThread; approachId?: string; state: "pending" | "queued" | "started" | "cancelled" | "unknown" | "ended"; queueEntryId?: string; turnId?: string };
export type StartResearchRequest = {
  intentId?: string;
  objective: string;
  approaches: Array<{ title: string; task: string }>;
  /** The operator's time limit for the run. Absent means none: the run goes on until it is stopped or finished. */
  minutes?: number;
  workspaceMode: "new_worktree" | "none";
};
export type PrepareResearchRequest = ResearchThread & Omit<StartResearchRequest, "approaches" | "intentId"> & { workers: number };
export const RESEARCH_WORK_STATES = ["open", "assigned", "claimed", "in_progress", "blocked", "completed", "cancel_requested", "cancelled"] as const;
export type ResearchWorkState = typeof RESEARCH_WORK_STATES[number];
export const RESEARCH_WORK_TRANSITIONS: Record<ResearchWorkState, readonly string[]> = {
  open: ["claimed", "blocked", "cancelled"], assigned: ["claimed", "blocked", "cancelled"],
  claimed: ["in_progress", "blocked", "completed", "cancelled"], in_progress: ["blocked", "completed", "cancelled"],
  blocked: ["claimed", "in_progress", "completed", "open", "cancelled"], completed: ["open"], cancelled: ["open"], cancel_requested: [],
};
export type ResearchItemWork = { state: ResearchWorkState; assignee?: ResearchThread; assignmentId?: string; note?: string };
export type ResearchItem = {
  provenance?: ResearchProvenance;
  id: string; approachId: string; version: number; createdSeq: number; updatedAt: number; work: ResearchItemWork;
} & (
  | { type: "approach"; record: ResearchApproach }
  | { type: "finding"; record: ResearchFinding }
  | { type: "submission"; record: ResearchSubmission }
);
export type ResearchSearchQuery = {
  query?: string; type?: ResearchItem["type"]; approachId?: string; kind?: ResearchFindingKind;
  review?: "unreviewed" | "accepted" | "revision_requested" | "rejected";
  state?: ResearchWorkState; assignee?: ResearchThread; limit?: number;
  cursor?: { revision: number; seq: number; id: string; filters: string };
};
export type ResearchSearchHit = Pick<ResearchItem, "id" | "type" | "approachId" | "version"> & {
  excerpt: string; state: ResearchWorkState; kind?: ResearchFindingKind; review?: string;
  assignee?: ResearchThread; assignmentId?: string;
  executionState?: ResearchApproach["state"];
};
export type ResearchSearchPage = { runId: string; revision: number; total: number; items: ResearchSearchHit[]; nextCursor?: NonNullable<ResearchSearchQuery["cursor"]> };
export type ResearchAssignRequest = { runId: string; itemId: string; expectedVersion: number; task: string };
export type ResearchRunHeader = Pick<ResearchRun, "id" | "revision" | "objective" | "coordinator" | "ownerId" | "ownerPid" | "ownerStartedAt" | "createdAt" | "deadlineAt" | "workspaceMode" | "status" | "reason" | "workerLimit" | "activeWorkers" | "harness">;
export type ResearchItemContext = { run: Pick<ResearchRunHeader, "id" | "revision" | "objective" | "coordinator" | "deadlineAt" | "workspaceMode" | "status" | "workerLimit" | "activeWorkers">; item: ResearchItem; approach?: ResearchApproach; assignment?: ResearchApproach };
export type ResearchCommand =
  | ({ action: "finding" } & Omit<ResearchFinding, "id" | "author">)
  | ({ action: "submit" } & Omit<ResearchSubmission, "id" | "review" | "author">)
  | { action: "review"; submissionId: string; decision: "accepted" | "revision_requested" | "rejected"; reason: string }
  | { action: "abandon"; approachId: string; reason: string }
  | { action: "direction"; approachId: string; title: string; task: string; reason: string; overlapsApproachId?: string }
  | { action: "stop"; reason: string }
  | { action: "finish"; reason: string }
  | ResearchWorkCommand;
export type ResearchWorkCommand = { action: "work"; itemId: string; expectedVersion: number; state: Exclude<ResearchWorkState, "assigned" | "cancel_requested">; reason: string };

export type ResearchEventData =
  | { type: "created"; objective: string; coordinator: ResearchThread; ownerId: string; ownerPid: number; ownerStartedAt?: number; deadlineAt?: number; workspaceMode: StartResearchRequest["workspaceMode"]; approaches: ResearchApproach[]; harness?: ResearchHarnessState }
  | { type: "harness"; state: ResearchHarnessState }
  | { type: "harness_observation"; event: string; text: string }
  | { type: "worker"; approachId: string; state: ResearchApproach["state"]; worker?: ResearchApproach["worker"]; note?: string }
  | { type: "finding"; finding: ResearchFinding }
  | { type: "submission"; submission: ResearchSubmission }
  | { type: "review"; submissionId: string; decision: "accepted" | "revision_requested" | "rejected"; reason: string }
  | { type: "abandoned"; approachId: string; reason: string }
  | { type: "direction"; approachId: string; title: string; task: string; reason: string; overlapsApproachId?: string }
  | { type: "status"; status: ResearchStatus; reason: string }
  | { type: "delivery_failed"; reason: string }
  | { type: "delivery"; delivery: ResearchDelivery }
  | { type: "assignment"; itemId: string; approach: ResearchApproach; task: string }
  | { type: "item_work"; itemId: string; work: ResearchItemWork };
// Delivery receipts identify exactly the revision work a stop may cancel.
export type ResearchEvent = {
  seq: number;
  commandId: string;
  signature: string;
  at: number;
  actor: ResearchActor;
  data: ResearchEventData;
  provenance?: ResearchProvenance;
};
export type ResearchRun = {
  harness?: ResearchHarnessState;
  id: string;
  revision: number;
  objective: string;
  coordinator: ResearchThread;
  ownerId: string;
  ownerPid: number;
  /** Absent in older journals, whose process identity cannot be validated. */
  ownerStartedAt?: number;
  createdAt: number;
  /** When the operator's time limit ends the run. Absent when the operator set none. */
  deadlineAt?: number;
  workspaceMode: StartResearchRequest["workspaceMode"];
  status: ResearchStatus;
  reason?: string;
  approaches: ResearchApproach[];
  findings: ResearchFinding[];
  submissions: ResearchSubmission[];
  events: ResearchEvent[];
  deliveries: ResearchDelivery[];
  workerLimit: number;
  activeWorkers: number;
  items: ResearchItem[];
};
/** The operator's bound request, waiting for this thread to call research_start. Owner memory only. */
export type ResearchPendingRequest = Omit<PrepareResearchRequest, "backend" | "threadId"> & { preparedAt: number; expiresAt: number };
/** A run header with the review counts the run list needs to name its phase. */
export type ResearchRunSummary = Omit<ResearchRunHeader, "harness"> & { unreviewed: number; accepted: number; harness?: ResearchHarnessPhase };
/** Just enough of a Harness run's state to name its phase in a run list; notes, IDs and snapshots stay with the run. */
export type ResearchHarnessPhase = Pick<ResearchHarnessState, "state" | "mode" | "source">;
export function researchHarnessPhase(harness: ResearchHarnessState): ResearchHarnessPhase {
  return { state: harness.state, mode: harness.mode, ...(harness.source ? { source: harness.source } : {}) };
}

/**
 * The Harness state a run is effectively in. When the owner dies mid-run,
 * recovery retires the run as interrupted, but its last Harness state still
 * says pending or running. Nothing is running it, so its outcome is unknown.
 */
export function researchHarnessEffectiveState(status: ResearchRun["status"], harness: Pick<ResearchHarnessState, "state">): ResearchHarnessState["state"] {
  const live = status === "running" || status === "stopping";
  return !live && (harness.state === "pending" || harness.state === "running") ? "unknown" : harness.state;
}

/** What a run asks of the operator: a decision or reconcile, nothing while it works, or nothing because it is settled. */
export type ResearchRunAttention = "needs_you" | "live" | "retained";
export const RESEARCH_RUN_ATTENTION_ORDER: readonly ResearchRunAttention[] = ["needs_you", "live", "retained"];
/**
 * The one rule for a run's attention group. The run list's SQL ranks by it and
 * the run chip's tone follows it; tests hold both to this function.
 */
export function researchRunAttention(run: Pick<ResearchRunSummary, "status" | "activeWorkers" | "unreviewed" | "accepted" | "harness">): ResearchRunAttention {
  if (run.harness) {
    if (run.status === "completed") return "retained";
    switch (researchHarnessEffectiveState(run.status, run.harness)) {
      case "unknown": return "needs_you";
      case "stopping": return run.status === "stopping" ? "live" : "needs_you";
      case "ended": return run.unreviewed ? "needs_you" : "retained";
      case "running": return run.harness.mode === "execute" && run.unreviewed ? "needs_you" : "live";
      case "pending": case "reconciling": return "live";
      case "imported": case "stopped": return "retained";
    }
  }
  if (run.status === "running") return run.activeWorkers === 0 && (run.unreviewed || run.accepted) ? "needs_you" : "live";
  return run.status === "stopping" ? "live" : "retained";
}

/** Runs one page of the profile's run list holds. */
export const RESEARCH_PROFILE_RUNS_PAGE = 50;
/** Where the next page of the profile's run list starts: after this run in attention, then newest-first, order. */
export type ResearchProfileRunsCursor = { attention: ResearchRunAttention; createdAt: number; id: string };
export type ResearchProfileRunsQuery = {
  /** Only runs PwrAgent workers did, or only runs from a Harness source. */
  source?: "native" | "harness";
  /** Case-insensitive literal text in the objective. */
  text?: string;
  after?: ResearchProfileRunsCursor;
};
export type ResearchProfileRun = ResearchRunSummary & {
  attention: ResearchRunAttention;
  /** The coordinating thread as this instance last observed it; absent when the thread is gone. */
  thread?: { title: string; project?: string };
};
/** Every run on this profile, grouped by attention and newest first within a group. Local owner only. */
export type ResearchProfileRunsPage = {
  runs: ResearchProfileRun[];
  /** Runs this process owns and may still act on. */
  writableRunIds: string[];
  /** How many runs each group holds across all pages, under the same filters. */
  counts: Record<ResearchRunAttention, number>;
  nextCursor?: ResearchProfileRunsCursor;
};
/** The thread's run summaries. Each run's items are read separately, by delta (`ResearchChangesRequest`). */
export type ResearchSnapshot = { runs: ResearchRunSummary[]; writableRunIds: string[]; pending?: ResearchPendingRequest };
/** With `runId`, `runs` holds only that run's summary, or nothing when the thread cannot see it. */
export type ResearchSnapshotRequest = ResearchThread & { runId?: string };
/**
 * What a `research:changed` event names. With `runId`, that run reached
 * `revision`. Without one, the thread's pending request changed.
 */
export type ResearchChange = ResearchThread & { runId?: string; revision?: number };
/** The parts of a run that change after it starts, with the counts its card shows. */
export type ResearchRunState = Pick<ResearchRun, "revision" | "status" | "reason" | "activeWorkers" | "harness"> & { unreviewed: number; accepted: number; findings: number; candidates: number };
/** One approach on the Map: how many contributions it has, and the IDs of its newest few, newest first. */
export type ResearchApproachLeaves = { approachId: string; findings: number; candidates: number; leafIds: string[] };
/** The last item a page of changes returned. Versions repeat when one event changes several items. */
export type ResearchChangesCursor = { version: number; id: string };
/**
 * Items with version > `sinceRevision`, oldest change first, read from one
 * snapshot. An item changed between two pages moves to a later page, so the
 * last page leaves a store that applied every page equal to `revision`.
 */
export type ResearchChangePage = {
  runId: string;
  revision: number;
  state: ResearchRunState;
  items: ResearchItem[];
  /** Set while changed items remain. Pass it as `after` with the same `sinceRevision`. */
  next?: ResearchChangesCursor;
  /** On the last page: the Map entry of every approach these changes touched. */
  approaches?: ResearchApproachLeaves[];
  /** `sinceRevision` is ahead of this journal. The page starts from nothing; discard what the store holds. */
  reset?: boolean;
};
export type ResearchChanges = ResearchChangePage & { writable: boolean };
export type ResearchChangesRequest = ResearchThread & { runId: string; sinceRevision?: number; after?: ResearchChangesCursor };
/** What a panel command returns. The changed items arrive by delta. */
export type ResearchUpdateReceipt = { runId: string; revision: number; status: ResearchStatus; delivery?: ResearchDelivery };
/** Offsets into a run's approaches, findings and submissions, each in creation order. */
export type ResearchBoardRange = { approachOffset: number; findingOffset: number; submissionOffset: number };
/** One page of each list, with the newest delivery receipts and failures. */
export type ResearchBoardPage = {
  approaches: ResearchApproach[]; totalApproaches: number;
  findings: ResearchFinding[]; totalFindings: number;
  submissions: ResearchSubmission[]; totalSubmissions: number;
  latestSubmissionId?: string;
  deliveries: ResearchDelivery[];
  deliveryFailures: string[];
};
/** Events with afterSeq < seq < beforeSeq, newest first. Journal entries never change once appended. */
export type ResearchEventRange = { beforeSeq?: number; afterSeq?: number; limit?: number };
/** `nextBeforeSeq` is set while older events remain inside the range; pass it as the next `beforeSeq`. */
export type ResearchEventPage = { runId: string; revision: number; events: ResearchEvent[]; nextBeforeSeq?: number };
export type ResearchEventsRequest = ResearchThread & { runId: string; range: ResearchEventRange };
export type ResearchUpdateRequest = ResearchThread & { runId: string; requestId: string; command: ResearchCommand };
export type ResearchEvidenceRequest = ResearchThread & { runId: string; itemId: string; pathIndex: number };
export type ResearchItemReadRequest = ResearchThread & { runId: string; itemId: string };
export type ResearchSearchRequest = ResearchThread & { runId: string; query: ResearchSearchQuery };
export type ResearchWorkRequest = ResearchThread & { runId: string; requestId: string; command: ResearchWorkCommand };

/** A journal is a complete ordered prefix. Duplicates may repeat a seq, never change it. */
export function projectResearchRun(id: string, records: ResearchEvent[]): ResearchRun {
  const events: ResearchEvent[] = [];
  for (const event of [...records].sort((a, b) => a.seq - b.seq)) {
    const previous = events[event.seq - 1];
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(event)) throw new Error("Conflicting research event");
      continue;
    }
    if (event.seq !== events.length + 1) throw new Error("Incomplete research journal");
    events.push(event);
  }
  const first = events[0];
  if (!first || first.data.type !== "created") throw new Error("Missing research creation event");
  const initial = first.data;
  const run: ResearchRun = {
    id, revision: events.length, objective: initial.objective, coordinator: initial.coordinator,
    ownerId: initial.ownerId, ownerPid: initial.ownerPid, ownerStartedAt: initial.ownerStartedAt, createdAt: first.at, ...(initial.deadlineAt !== undefined ? { deadlineAt: initial.deadlineAt } : {}),
    workspaceMode: initial.workspaceMode, status: "running", approaches: initial.approaches.map((a) => ({ ...a })),
    findings: [], submissions: [], events, deliveries: [], workerLimit: initial.approaches.length, activeWorkers: 0, items: [], harness: initial.harness,
  };
  const items = new Map<string, ResearchItem>();
  for (const item of applyResearchItemEvent((key) => items.get(key), first)) items.set(item.id, item);
  for (const event of events.slice(1)) {
    for (const item of applyResearchItemEvent((key) => items.get(key), event)) items.set(item.id, item);
    const data = event.data;
    if (data.type === "harness") run.harness = data.state;
    else if (data.type === "worker") {
      const approach = run.approaches.find((a) => a.id === data.approachId);
      if (!approach) throw new Error("Unknown research approach");
      Object.assign(approach, { state: data.state }, data.worker ? { worker: data.worker } : {}, data.note ? { note: data.note } : {});
    } else if (data.type === "assignment") run.approaches.push({ ...data.approach });
    else if (data.type === "finding") run.findings.push(data.finding);
    else if (data.type === "submission") run.submissions.push({ ...data.submission });
    else if (data.type === "review") {
      const submission = run.submissions.find((s) => s.id === data.submissionId);
      if (!submission) throw new Error("Unknown research submission");
      submission.review = { decision: data.decision, reason: data.reason, actor: event.actor };
    } else if (data.type === "abandoned") {
      const approach = run.approaches.find((a) => a.id === data.approachId);
      if (!approach) throw new Error("Unknown research approach");
      approach.note = data.reason;
      approach.directionState = "abandoned";
    } else if (data.type === "direction") {
      const approach = run.approaches.find((a) => a.id === data.approachId);
      if (!approach) throw new Error("Unknown research approach");
      Object.assign(approach, { title: data.title, task: data.task, note: data.reason, directionState: "active", overlapsApproachId: data.overlapsApproachId });
    } else if (data.type === "delivery") {
      const index = run.deliveries.findIndex((d) => d.id === data.delivery.id);
      if (index < 0) run.deliveries.push(data.delivery);
      else run.deliveries[index] = data.delivery;
      if (data.delivery.approachId) {
        const item = items.get(data.delivery.approachId);
        const approach = run.approaches.find((a) => a.id === data.delivery.approachId);
        if (item?.type === "approach" && approach) Object.assign(approach, item.record);
      }
    } else if (data.type === "status") {
      run.status = data.status;
      run.reason = data.reason;
    }
  }
  run.items = [...items.values()];
  run.activeWorkers = run.approaches.filter(researchApproachOccupiesSlot).length;
  return run;
}

/** The same deterministic projection is used by replay and atomic SQLite appends. */
export function applyResearchItemEvent(read: (id: string) => ResearchItem | undefined, event: ResearchEvent): ResearchItem[] {
  const data = event.data;
  const create = (item: Pick<ResearchItem, "id" | "approachId"> & Pick<ResearchItem, "type" | "record">): ResearchItem => ({
    ...item, version: event.seq, createdSeq: event.seq, updatedAt: event.at, work: { state: "open" },
    ...(event.provenance ? { provenance: event.provenance } : {}),
  } as ResearchItem);
  const require = (id: string) => { const item = read(id); if (!item) throw new Error("Unknown research item"); return item; };
  const touch = (item: ResearchItem): ResearchItem => ({ ...item, version: event.seq, updatedAt: event.at });
  if (data.type === "created") return data.approaches.map((record) => create({ id: record.id, approachId: record.id, type: "approach", record: { ...record } }));
  if (data.type === "finding" || data.type === "submission") {
    const record = data.type === "finding" ? data.finding : data.submission;
    return [create({ id: record.id, approachId: record.approachId, type: data.type, record: { ...record } })];
  }
  if (data.type === "assignment") {
    const source = require(data.itemId);
    return [touch({ ...source, work: { state: "assigned", assignmentId: data.approach.id, note: data.task } }),
      create({ id: data.approach.id, approachId: data.approach.id, type: "approach", record: { ...data.approach } })];
  }
  if (data.type === "item_work") return [touch({ ...require(data.itemId), work: { ...data.work } })];
  if (data.type === "delivery" && data.delivery.approachId) {
    const item = require(data.delivery.approachId);
    if (item.type !== "approach") throw new Error("Research delivery must name an approach");
    const ids = (item.record.revisionDeliveryIds ?? []).filter((id) => id !== data.delivery.id);
    if (!["cancelled", "ended"].includes(data.delivery.state)) ids.push(data.delivery.id);
    return [touch({ ...item, record: { ...item.record, revisionDeliveryIds: ids } })];
  }
  if (data.type === "review") {
    const item = require(data.submissionId);
    if (item.type !== "submission") throw new Error("Research review must name a submission");
    return [touch({ ...item, record: { ...item.record, review: { decision: data.decision, reason: data.reason, actor: event.actor } } })];
  }
  if (data.type === "worker" || data.type === "direction" || data.type === "abandoned") {
    const item = require(data.approachId);
    if (item.type !== "approach") throw new Error("Research direction must name an approach");
    const record = { ...item.record };
    if (data.type === "worker") Object.assign(record, { state: data.state }, data.worker ? { worker: data.worker } : {}, data.note ? { note: data.note } : {});
    else if (data.type === "direction") Object.assign(record, { title: data.title, task: data.task, note: data.reason, directionState: "active", overlapsApproachId: data.overlapsApproachId });
    else Object.assign(record, { note: data.reason, directionState: "abandoned" });
    const changes = [touch({ ...item, record })];
    if (data.type === "worker" && data.worker && record.itemId) {
      const source = require(record.itemId);
      if (source.work.assignmentId === record.id && !source.work.assignee) changes.push(touch({ ...source, work: { ...source.work, assignee: { backend: data.worker.backend, threadId: data.worker.threadId } } }));
    }
    return changes;
  }
  return [];
}

export function researchItemSearchText(item: ResearchItem): string {
  const record = item.record;
  return [item.id, item.approachId, item.type, "title" in record ? record.title : "", "task" in record ? record.task : "",
    "text" in record ? record.text : "", "kind" in record ? record.kind : "", "note" in record ? record.note : "",
    "review" in record ? record.review?.reason : "", item.work.note ?? ""].join("\n").toLowerCase();
}

export function researchSearchHit(item: ResearchItem): ResearchSearchHit {
  return { id: item.id, type: item.type, approachId: item.approachId, version: item.version,
    excerpt: (item.type === "approach" ? `${item.record.title}: ${item.record.task}` : item.record.text).slice(0, 200),
    state: item.work.state, assignee: item.work.assignee, assignmentId: item.work.assignmentId,
    ...(item.type === "finding" ? { kind: item.record.kind } : {}),
    ...(item.type === "approach" ? { executionState: item.record.state } : {}),
    ...(item.type === "submission" ? { review: item.record.review?.decision ?? "unreviewed" } : {}) };
}

export function normalizeResearchSearch(query: ResearchSearchQuery, revision: number) {
  if (!query || typeof query !== "object") throw new Error("Supply search filters");
  for (const [key, value] of [["query", query.query], ["approachId", query.approachId]] as const) {
    if (value !== undefined && (typeof value !== "string" || value.length > 300)) throw new Error(`Invalid research ${key}`);
  }
  if (query.type !== undefined && !["approach", "finding", "submission"].includes(query.type)) throw new Error("Invalid item type");
  if (query.kind !== undefined && !RESEARCH_FINDING_KINDS.includes(query.kind)) throw new Error("Invalid finding kind");
  if (query.review !== undefined && !["unreviewed", "accepted", "revision_requested", "rejected"].includes(query.review)) throw new Error("Invalid review filter");
  if (query.state !== undefined && !RESEARCH_WORK_STATES.includes(query.state)) throw new Error("Invalid work state");
  if (query.assignee !== undefined && (!query.assignee || typeof query.assignee.backend !== "string" || query.assignee.backend.length > 100 || typeof query.assignee.threadId !== "string" || query.assignee.threadId.length > 300)) throw new Error("Invalid assignee");
  const limit = query.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Search limit must be 1–20");
  const normalized = { query: query.query?.trim().toLowerCase() || undefined, type: query.type, approachId: query.approachId,
    kind: query.kind, review: query.review, state: query.state, assignee: query.assignee ? { backend: query.assignee.backend, threadId: query.assignee.threadId } : undefined, limit };
  const filters = JSON.stringify(normalized);
  const cursor = query.cursor;
  if (cursor && (cursor.revision !== revision || cursor.filters !== filters || !Number.isSafeInteger(cursor.seq) || cursor.seq < 1 || typeof cursor.id !== "string" || cursor.id.length > 300)) throw new Error("Research changed or cursor filters differ; restart the search");
  return { ...normalized, filters, cursor };
}

/** A simple in-memory oracle for the indexed search implementation. */
export function searchResearchItems(runId: string, items: ResearchItem[], revision: number, query: ResearchSearchQuery): ResearchSearchPage {
  const q = normalizeResearchSearch(query, revision);
  const filtered = items.filter((item) => (!q.query || researchItemSearchText(item).includes(q.query))
    && (!q.type || item.type === q.type) && (!q.approachId || item.approachId === q.approachId)
    && (!q.kind || (item.type === "finding" && item.record.kind === q.kind))
    && (!q.review || (item.type === "submission" && (item.record.review?.decision ?? "unreviewed") === q.review))
    && (!q.state || item.work.state === q.state) && (!q.assignee || (item.work.assignee && sameResearchThread(item.work.assignee, q.assignee))));
  const ordered = filtered.sort((a, b) => b.createdSeq - a.createdSeq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const remaining = ordered.filter((item) => !q.cursor || item.createdSeq < q.cursor.seq || (item.createdSeq === q.cursor.seq && item.id > q.cursor.id));
  const page = remaining.slice(0, q.limit);
  const last = page.at(-1);
  return { runId, revision, total: filtered.length, items: page.map(researchSearchHit),
    ...(last && remaining.length > q.limit ? { nextCursor: { revision, seq: last.createdSeq, id: last.id, filters: q.filters } } : {}) };
}

export const RESEARCH_EVENT_PAGE_DEFAULT = 100;
export const RESEARCH_EVENT_PAGE_MAX = 200;

export function normalizeResearchEventRange(range: ResearchEventRange): { beforeSeq?: number; afterSeq: number; limit: number } {
  if (!range || typeof range !== "object") throw new Error("Supply an event range");
  const limit = range.limit ?? RESEARCH_EVENT_PAGE_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RESEARCH_EVENT_PAGE_MAX) throw new Error(`Event page limit must be 1–${RESEARCH_EVENT_PAGE_MAX}`);
  for (const [key, value] of [["beforeSeq", range.beforeSeq], ["afterSeq", range.afterSeq]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`Invalid research ${key}`);
  }
  return { ...(range.beforeSeq !== undefined ? { beforeSeq: range.beforeSeq } : {}), afterSeq: range.afterSeq ?? 0, limit };
}

/** The in-memory oracle for paged journal reads. */
export function researchEventPage(run: Pick<ResearchRun, "id" | "revision" | "events">, range: ResearchEventRange): ResearchEventPage {
  const r = normalizeResearchEventRange(range);
  const matching = run.events.filter((event) => event.seq > r.afterSeq && (r.beforeSeq === undefined || event.seq < r.beforeSeq)).reverse();
  const events = matching.slice(0, r.limit);
  const oldest = events.at(-1);
  return { runId: run.id, revision: run.revision, events, ...(oldest && matching.length > r.limit ? { nextBeforeSeq: oldest.seq } : {}) };
}

export const RESEARCH_CHANGES_PAGE = 500;
export const RESEARCH_MAP_LEAVES = 6;
export const RESEARCH_BOARD_PAGE = 10;
export const RESEARCH_BOARD_DELIVERIES = 5;
export const RESEARCH_BOARD_FAILURES = 3;

export function normalizeResearchChangesCursor(sinceRevision: number | undefined, after: ResearchChangesCursor | undefined): { sinceRevision: number; after?: ResearchChangesCursor } {
  const since = sinceRevision ?? 0;
  if (!Number.isSafeInteger(since) || since < 0) throw new Error("Invalid research revision");
  if (after === undefined) return { sinceRevision: since };
  if (!after || typeof after !== "object" || !Number.isSafeInteger(after.version) || after.version < 1 || typeof after.id !== "string" || after.id.length > 300) throw new Error("Invalid research changes cursor");
  return { sinceRevision: since, after: { version: after.version, id: after.id } };
}

/** The in-memory oracle for a stored run state. */
export function researchRunState(run: ResearchRun): ResearchRunState {
  return { revision: run.revision, status: run.status, ...(run.reason !== undefined ? { reason: run.reason } : {}), activeWorkers: run.activeWorkers,
    ...(run.harness ? { harness: run.harness } : {}),
    unreviewed: run.submissions.filter((s) => !s.review).length, accepted: run.submissions.filter((s) => s.review?.decision === "accepted").length,
    findings: run.findings.length, candidates: run.submissions.length };
}

/** The in-memory oracle for the Map entries of the named approaches, or of every approach, in creation order. */
export function researchApproachLeaves(run: Pick<ResearchRun, "items">, approachIds?: ReadonlySet<string>): ResearchApproachLeaves[] {
  return run.items.filter((item) => item.type === "approach" && (!approachIds || approachIds.has(item.id))).map((approach) => {
    const contributions = run.items.filter((item) => item.type !== "approach" && item.approachId === approach.id)
      .sort((a, b) => b.createdSeq - a.createdSeq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { approachId: approach.id, findings: contributions.filter((item) => item.type === "finding").length,
      candidates: contributions.filter((item) => item.type === "submission").length, leafIds: contributions.slice(0, RESEARCH_MAP_LEAVES).map((item) => item.id) };
  });
}

/** The in-memory oracle for one page of changes. */
export function researchChangePage(run: ResearchRun, sinceRevision?: number, after?: ResearchChangesCursor, limit = RESEARCH_CHANGES_PAGE): ResearchChangePage {
  const cursor = normalizeResearchChangesCursor(sinceRevision, after);
  const reset = cursor.sinceRevision > run.revision;
  const since = reset ? 0 : cursor.sinceRevision;
  const position = reset ? undefined : cursor.after;
  const changed = run.items.filter((item) => item.version > since).sort((a, b) => a.version - b.version || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const remaining = changed.filter((item) => !position || item.version > position.version || (item.version === position.version && item.id > position.id));
  const items = remaining.slice(0, limit);
  const last = items.at(-1);
  const more = remaining.length > limit;
  return { runId: run.id, revision: run.revision, state: researchRunState(run), items,
    ...(more && last ? { next: { version: last.version, id: last.id } } : { approaches: researchApproachLeaves(run, since === 0 ? undefined : new Set(changed.map((item) => item.approachId))) }),
    ...(reset ? { reset: true } : {}) };
}

/**
 * A window's copy of one run: its items by ID, kept current by applying pages
 * of changes. An apply costs what the page holds: it updates `items` and
 * `leaves` in place and returns the store to use from then on. The store
 * passed in shares those Maps, so it must not be read again; a reader that
 * shows a store applies all of a sync's pages before showing the result.
 */
export type ResearchRunStore = {
  runId: string;
  /** The revision the items are complete at. 0 until the first sync finishes. */
  revision: number;
  /** Set between the pages of one sync. */
  cursor?: ResearchChangesCursor;
  state?: ResearchRunState;
  writable: boolean;
  items: Map<string, ResearchItem>;
  /** Approach and submission records in creation order, replaced only when one of them changes. */
  approaches: ResearchApproach[];
  submissions: ResearchSubmission[];
  /** Each approach's Map entry. */
  leaves: Map<string, ResearchApproachLeaves>;
};

export function emptyResearchRunStore(runId: string): ResearchRunStore {
  return { runId, revision: 0, writable: false, items: new Map(), approaches: [], submissions: [], leaves: new Map() };
}

/** True once a sync has finished and no later one is part way through its pages. */
export function researchRunStoreSynced(store: ResearchRunStore): boolean {
  return store.revision > 0 && !store.cursor;
}

/** What to ask for next: the changes since the store's revision, continuing a sync in progress. */
export function researchRunStoreCursor(store: ResearchRunStore): { sinceRevision: number; after?: ResearchChangesCursor } {
  return { sinceRevision: store.revision, ...(store.cursor ? { after: store.cursor } : {}) };
}

/**
 * Apply one page of changes. The store's revision moves only with the last
 * page of a sync, so every page of that sync is requested from the same
 * revision. A page for another run is ignored.
 */
export function applyResearchChanges(store: ResearchRunStore, page: ResearchChanges): ResearchRunStore {
  if (page.runId !== store.runId) return store;
  const base = page.reset ? emptyResearchRunStore(store.runId) : store;
  const { items, leaves } = base;
  let { approaches, submissions } = base;
  const byCreation = <T extends { id: string }>(records: T[]) => records.sort((a, b) => (items.get(a.id)?.createdSeq ?? 0) - (items.get(b.id)?.createdSeq ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  /** Replace the record in place, or add it and restore creation order. */
  const place = <T extends { id: string }>(records: T[], current: T[], record: T, known: boolean): T[] => {
    const next = records === current ? [...records] : records;
    const index = known ? next.findIndex((entry) => entry.id === record.id) : -1;
    if (index >= 0) next[index] = record;
    else next.push(record);
    return next;
  };
  let added = false;
  for (const item of page.items) {
    const known = items.has(item.id);
    items.set(item.id, item);
    if (item.type === "approach") approaches = place(approaches, base.approaches, item.record, known);
    else if (item.type === "submission") submissions = place(submissions, base.submissions, item.record, known);
    added ||= !known && item.type !== "finding";
  }
  if (added) {
    if (approaches !== base.approaches) byCreation(approaches);
    if (submissions !== base.submissions) byCreation(submissions);
  }
  for (const entry of page.approaches ?? []) leaves.set(entry.approachId, entry);
  const { cursor: _cursor, ...rest } = base;
  return { ...rest, approaches, submissions, state: page.state, writable: page.writable,
    ...(page.next ? { cursor: page.next } : { revision: page.revision }) };
}

/** The in-memory oracle for one page of the board the agent tools read. */
export function researchBoardPage(run: ResearchRun, range: ResearchBoardRange): ResearchBoardPage {
  const latest = run.submissions.at(-1)?.id;
  return {
    approaches: run.approaches.slice(range.approachOffset, range.approachOffset + RESEARCH_BOARD_PAGE), totalApproaches: run.approaches.length,
    findings: run.findings.slice(range.findingOffset, range.findingOffset + RESEARCH_BOARD_PAGE), totalFindings: run.findings.length,
    submissions: run.submissions.slice(range.submissionOffset, range.submissionOffset + RESEARCH_BOARD_PAGE), totalSubmissions: run.submissions.length,
    ...(latest !== undefined ? { latestSubmissionId: latest } : {}),
    deliveries: run.deliveries.slice(-RESEARCH_BOARD_DELIVERIES),
    deliveryFailures: run.events.flatMap((event) => event.data.type === "delivery_failed" ? [event.data.reason] : []).slice(-RESEARCH_BOARD_FAILURES),
  };
}

/** The in-memory oracle for a stored run summary. */
export function summarizeResearchRun(run: ResearchRun): ResearchRunSummary {
  return { id: run.id, revision: run.revision, objective: run.objective, coordinator: run.coordinator, ownerId: run.ownerId, ownerPid: run.ownerPid,
    ownerStartedAt: run.ownerStartedAt, createdAt: run.createdAt, ...(run.deadlineAt !== undefined ? { deadlineAt: run.deadlineAt } : {}), workspaceMode: run.workspaceMode, status: run.status,
    ...(run.reason !== undefined ? { reason: run.reason } : {}), workerLimit: run.workerLimit, activeWorkers: run.activeWorkers,
    unreviewed: run.submissions.filter((s) => !s.review).length, accepted: run.submissions.filter((s) => s.review?.decision === "accepted").length,
    ...(run.harness ? { harness: researchHarnessPhase(run.harness) } : {}) };
}

export function sameResearchThread(a: ResearchThread, b: ResearchThread): boolean {
  return a.backend === b.backend && a.threadId === b.threadId;
}

export function researchApproachOccupiesSlot(approach: ResearchApproach): boolean {
  return !["ended", "failed", "stopped"].includes(approach.state) || Boolean(approach.revisionDeliveryIds?.length);
}

/**
 * How many workers one run may hold at once. The operator chooses the number;
 * this only stops a mistyped or model-proposed count from starting hundreds of
 * live agent threads. It is the one place the bound is written.
 */
export const RESEARCH_MAX_WORKERS = 64;
/** Ten years. A time limit is the operator's to choose; this only keeps the deadline a valid time. */
export const RESEARCH_MAX_MINUTES = 5_256_000;
/** The longest one timer may wait (about 24 days). A longer delay overflows and fires at once, so long limits wait in steps. */
export const RESEARCH_MAX_TIMER_MS = 2_147_483_647;
/** The operator's time limit, when they set one: a whole number of minutes. */
export function validResearchMinutes(minutes: unknown): minutes is number | undefined {
  return minutes === undefined || (typeof minutes === "number" && Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= RESEARCH_MAX_MINUTES);
}
/** Whether the run's time limit has passed. A run with no limit never passes one. */
export function researchDeadlinePassed(run: { deadlineAt?: number }, now: number): boolean {
  return run.deadlineAt !== undefined && now >= run.deadlineAt;
}
/**
 * A guard against a runaway journal, not a budget for a run. Commands and views read stored projections,
 * so their cost does not grow with the journal (`research-cost.bench.test.ts` measures it at this size).
 */
export const RESEARCH_MAX_EVENTS = 100_000;
export const RESEARCH_FINDING_KINDS: ResearchFindingKind[] = ["lemma", "partial", "counterexample", "dead_end", "experiment", "file", "note"];
