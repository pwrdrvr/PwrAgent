import type { AppServerBackendKind } from "./contracts/normalized-app-server";

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
  minutes: number;
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
export type ResearchRunHeader = Pick<ResearchRun, "id" | "revision" | "objective" | "coordinator" | "ownerId" | "ownerPid" | "ownerStartedAt" | "createdAt" | "deadlineAt" | "workspaceMode" | "status" | "workerLimit" | "activeWorkers">;
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
  | { type: "created"; objective: string; coordinator: ResearchThread; ownerId: string; ownerPid: number; ownerStartedAt?: number; deadlineAt: number; workspaceMode: StartResearchRequest["workspaceMode"]; approaches: ResearchApproach[] }
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
};
export type ResearchRun = {
  id: string;
  revision: number;
  objective: string;
  coordinator: ResearchThread;
  ownerId: string;
  ownerPid: number;
  /** Absent in older journals, whose process identity cannot be validated. */
  ownerStartedAt?: number;
  createdAt: number;
  deadlineAt: number;
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
export type ResearchRunSummary = ResearchRunHeader & { candidates: number; unreviewed: number; accepted: number };
/**
 * One run's board: its projection without the event journal, which Activity
 * reads in pages, or the item projection, whose records repeat approaches,
 * findings and submissions. `createdSeq` names every item and keeps the order
 * of its creation across those three lists. Work state is read per item.
 */
export type ResearchRunBoard = Omit<ResearchRun, "events" | "items"> & { createdSeq: Record<string, number> };
/** An item as the board holds it: its record from approaches, findings or submissions. */
export type ResearchBoardEntry =
  | { id: string; type: "approach"; record: ResearchApproach; createdSeq: number }
  | { id: string; type: "finding"; record: ResearchFinding; createdSeq: number }
  | { id: string; type: "submission"; record: ResearchSubmission; createdSeq: number };
/** The thread's run summaries, plus the board of the selected run (or the newest when none is named). */
export type ResearchSnapshot = { runs: ResearchRunSummary[]; writableRunIds: string[]; pending?: ResearchPendingRequest; selected?: ResearchRunBoard };
export type ResearchSnapshotRequest = ResearchThread & { runId?: string };
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
    ownerId: initial.ownerId, ownerPid: initial.ownerPid, ownerStartedAt: initial.ownerStartedAt, createdAt: first.at, deadlineAt: initial.deadlineAt,
    workspaceMode: initial.workspaceMode, status: "running", approaches: initial.approaches.map((a) => ({ ...a })),
    findings: [], submissions: [], events, deliveries: [], workerLimit: initial.approaches.length, activeWorkers: 0, items: [],
  };
  const items = new Map<string, ResearchItem>();
  for (const item of applyResearchItemEvent((key) => items.get(key), first)) items.set(item.id, item);
  for (const event of events.slice(1)) {
    for (const item of applyResearchItemEvent((key) => items.get(key), event)) items.set(item.id, item);
    const data = event.data;
    if (data.type === "worker") {
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

export function researchRunBoard(run: ResearchRun): ResearchRunBoard {
  const { events: _events, items, ...board } = run;
  return { ...board, createdSeq: Object.fromEntries(items.map((item) => [item.id, item.createdSeq])) };
}

/** The board's record for an item id, or undefined when the run has no such item. */
export function researchBoardEntry(board: Pick<ResearchRunBoard, "approaches" | "findings" | "submissions" | "createdSeq">, id: string): ResearchBoardEntry | undefined {
  if (!Object.hasOwn(board.createdSeq, id)) return undefined;
  const createdSeq = board.createdSeq[id]!;
  const finding = board.findings.find((f) => f.id === id);
  if (finding) return { id, type: "finding", record: finding, createdSeq };
  const submission = board.submissions.find((s) => s.id === id);
  if (submission) return { id, type: "submission", record: submission, createdSeq };
  const approach = board.approaches.find((a) => a.id === id);
  return approach ? { id, type: "approach", record: approach, createdSeq } : undefined;
}

/** The in-memory oracle for a stored run summary. */
export function summarizeResearchRun(run: ResearchRun): ResearchRunSummary {
  return { id: run.id, revision: run.revision, objective: run.objective, coordinator: run.coordinator, ownerId: run.ownerId, ownerPid: run.ownerPid,
    ownerStartedAt: run.ownerStartedAt, createdAt: run.createdAt, deadlineAt: run.deadlineAt, workspaceMode: run.workspaceMode, status: run.status,
    workerLimit: run.workerLimit, activeWorkers: run.activeWorkers, candidates: run.submissions.length,
    unreviewed: run.submissions.filter((s) => !s.review).length, accepted: run.submissions.filter((s) => s.review?.decision === "accepted").length };
}

export function sameResearchThread(a: ResearchThread, b: ResearchThread): boolean {
  return a.backend === b.backend && a.threadId === b.threadId;
}

export function researchApproachOccupiesSlot(approach: ResearchApproach): boolean {
  return !["ended", "failed", "stopped"].includes(approach.state) || Boolean(approach.revisionDeliveryIds?.length);
}

export const RESEARCH_MAX_WORKERS = 8;
export const RESEARCH_MAX_EVENTS = 4096;
export const RESEARCH_FINDING_KINDS: ResearchFindingKind[] = ["lemma", "partial", "counterexample", "dead_end", "experiment", "file", "note"];
