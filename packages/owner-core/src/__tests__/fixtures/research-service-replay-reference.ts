/**
 * The research service as it was before commands and observers read stored
 * projections: every command and every turn or queue observation replays the
 * run's journal with `projectResearchRun`. The service is kept, unchanged
 * apart from its imports, the removed renderer snapshot and deliberate rule
 * changes (who may record on a run after its process is gone), as the reference
 * for differential tests: the projection-based service must accept and refuse
 * the same commands and append the same events. Its in-memory storage answers
 * as it did, but replays a journal once per length. Nothing outside tests
 * imports it.
 */
import { randomUUID } from "node:crypto";
import { RESEARCH_RUN_HELD_ELSEWHERE, researchRunHeldBy, researchRunNeedsAdoption } from "../../research-ownership";
import {
  RESEARCH_FINDING_KINDS, RESEARCH_MAX_EVENTS, RESEARCH_MAX_WORKERS, researchDeadlinePassed, validResearchMinutes, RESEARCH_MAX_TIMER_MS, RESEARCH_WORK_TRANSITIONS, sameResearchThread, researchApproachOccupiesSlot, researchApproachResumable, researchTurnIsPlaceholder, searchResearchItems,
  type ResearchActor, type ResearchApproach, type ResearchCommand, type ResearchEvent, type ResearchEventData, type ResearchDelivery,
  type ResearchRun, type ResearchThread, type StartResearchRequest, type PrepareResearchRequest,
  type ResearchRunHeader, type ResearchItem, type ResearchItemContext, type ResearchSearchQuery, type ResearchSearchPage,
  type ResearchAssignRequest, type ResearchWorkCommand, type ResearchItemWork, type ResearchBoundsCommand,
} from "@pwragent/shared/research";
import { ResearchAdmissionRefused, RESEARCH_REQUEST_TTL_MS, type ResearchAssignmentReceipt, type ResearchExecutionContext, type ResearchPorts } from "../../research-service";
import { replayResearchJournal } from "./research-memory-storage";

/** The storage contract the replay-based service was written against. */
export interface ReplayResearchStorage {
  findByStartKey(key: string): ResearchRun | undefined;
  get(id: string): ResearchRun | undefined;
  list(thread?: ResearchThread): ResearchRun[];
  header(id: string): ResearchRunHeader | undefined;
  summaries(thread: ResearchThread): ResearchRunHeader[];
  members(id: string): ResearchThread[];
  isMember(id: string, thread: ResearchThread): boolean;
  readItem(id: string, itemId: string): ResearchItem | undefined;
  search(id: string, query: ResearchSearchQuery): ResearchSearchPage;
  findCommand(id: string, commandId: string): ResearchEvent | undefined;
  create(id: string, startKey: string, event: ResearchEvent): void;
  /** False when the command was already recorded. */
  append(id: string, revision: number, event: ResearchEvent): boolean;
}

/**
 * Journals in memory. Every read answers from a replay, so it is the
 * storage's own oracle. A journal is replayed once per length and the frozen
 * run is shared by the reads that follow: a journal only grows, and the
 * service reads a run hundreds of times between appends.
 */
export class ReplayMemoryStorage implements ReplayResearchStorage {
  readonly records = new Map<string, ResearchEvent[]>();
  readonly keys = new Map<string, string>();
  readonly workers = new Map<string, ResearchThread[]>();
  findByStartKey(key: string) { const id = this.keys.get(key); return id ? this.get(id) : undefined; }
  get(id: string) {
    return replayResearchJournal(id, this.records.get(id));
  }
  /** Newest first, as the SQLite store lists them. */
  list(thread?: ResearchThread) {
    return [...this.records.keys()].map((id) => this.get(id)!)
      .filter((run) => thread ? this.isMember(run.id, thread) : ["running", "stopping"].includes(run.status))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, thread ? 50 : undefined);
  }
  header(id: string) { return this.get(id); }
  summaries(thread: ResearchThread) { return this.list(thread).slice(0, 20); }
  members(id: string) { return [this.get(id)!.coordinator, ...(this.workers.get(id) ?? [])]; }
  /** The coordinator, or any thread a worker event has named: what the `research_workers` table holds. */
  isMember(id: string, thread: ResearchThread) {
    const run = this.get(id);
    return Boolean(run && (sameResearchThread(run.coordinator, thread) || (this.workers.get(id) ?? []).some((worker) => sameResearchThread(worker, thread))));
  }
  readItem(id: string, itemId: string) { return this.get(id)?.items.find((item) => item.id === itemId); }
  search(id: string, query: ResearchSearchQuery) { const run = this.get(id)!; return searchResearchItems(id, run.items, run.revision, query); }
  findCommand(id: string, commandId: string) { return this.records.get(id)?.find((event) => event.commandId === commandId); }
  create(id: string, key: string, event: ResearchEvent) {
    if (this.keys.has(key)) throw new Error("duplicate start");
    this.keys.set(key, id);
    this.records.set(id, [structuredClone(event)]);
  }
  append(id: string, revision: number, event: ResearchEvent) {
    const records = this.records.get(id)!;
    const prior = records.find((entry) => entry.commandId === event.commandId);
    if (prior) {
      if (prior.signature !== event.signature || JSON.stringify(prior.actor) !== JSON.stringify(event.actor)) throw new Error("Research command key was reused");
      return false;
    }
    if (records.length !== revision || event.seq !== revision + 1) throw new Error("Research run changed; read its current state before retrying");
    records.push(structuredClone(event));
    if (event.data.type === "worker" && event.data.worker) {
      const worker = { backend: event.data.worker.backend, threadId: event.data.worker.threadId };
      const known = this.workers.get(id) ?? [];
      if (!known.some((entry) => sameResearchThread(entry, worker))) this.workers.set(id, [...known, worker]);
    }
    return true;
  }
}

const MINUTE = 60_000;

/**
 * Owns only structured research, never provider transcripts. Store mutations
 * are synchronous, compare-and-append commits before effects. Spawn intent is
 * durable before handing off; a thread is bound before its first model turn.
 * A lost response is never retried automatically. Foreign live owners are
 * read-only. Dead owners become interrupted, without starting any work.
 * Cancellation fences later admissions and stays stopping while a start or
 * cancellation is unresolved. Provider cancellation does not undo billing.
 */
export class ReplayResearchService {
  private readonly starts = new Map<string, { signature: string; promise: Promise<ResearchRun> }>();
  private readonly assignments = new Map<string, { signature: string; promise: Promise<ResearchAssignmentReceipt> }>();
  private readonly deadlines = new Map<string, () => void>();
  /** `${runId}:${approachId}` to the per-worker limit timer of a running worker, and when it is due. */
  private readonly turnLimits = new Map<string, { at: number; cancel: () => void }>();
  private readonly workerTimeLimits = new Map<string, { at: number; cancel: () => void }>();
  private readonly pendingStarts = new Set<string>();
  private readonly pendingDeliveries = new Set<string>();
  private readonly pendingQueueEvents = new Map<string, Map<string, { status: string; turnId?: string }>>();
  private readonly stops = new Map<string, Promise<ResearchRun>>();
  private readonly queuedResumes = new Map<string, string>();
  private readonly workerStops = new Map<string, Promise<void>>();
  private readonly intents = new Map<string, { id: string; request: PrepareResearchRequest; preparedAt: number; expiresAt: number }>();
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly storage: ReplayResearchStorage, private readonly ports: ResearchPorts) {
    this.now = ports.now ?? Date.now;
  }

  initialize(): void {
    for (const run of this.storage.list()) {
      if (!["running", "stopping"].includes(run.status)) continue;
      if (run.ownerId === this.ports.ownerId) { this.scheduleDeadline(run); this.armBounds(run.id); }
      else if (this.ports.isOwnerAlive(run)) continue;
      else try { this.adopt(run); } catch (error) { this.ports.onError(error); }
    }
  }

  private adopt(run: ResearchRun): ResearchRun {
    const started = run.deliveries.filter((delivery) => delivery.state === "started");
    const cutOff = run.approaches.filter((approach) => researchApproachOccupiesSlot(approach)
      && (!["ended", "stopped", "failed"].includes(approach.state) || started.some((delivery) => delivery.approachId === approach.id)));
    this.append(run, `adopted:${this.ports.ownerId}:${run.revision}`, this.operator(run), { type: "adopted", ownerId: this.ports.ownerId, ownerPid: this.ports.ownerPid,
      ...(this.ports.ownerStartedAt !== undefined ? { ownerStartedAt: this.ports.ownerStartedAt } : {}), approachIds: cutOff.map((approach) => approach.id) });
    for (const delivery of started) {
      this.append(this.requireRun(run.id), `adopted-delivery:${delivery.id}:${this.ports.ownerId}`, this.operator(run), { type: "delivery", delivery: { ...delivery, state: "ended" } });
    }
    const limited = this.stopCutOffPastTurnLimit(run.id);
    const current = this.requireRun(run.id);
    if (current.status === "running") {
      this.scheduleDeadline(current);
      if (limited) this.finishExploration(current);
    }
    else if (current.status === "stopping" && !this.stops.has(run.id)) {
      const stopping = this.performStop(run.id, this.operator(run));
      this.stops.set(run.id, stopping);
      void stopping.finally(() => { if (this.stops.get(run.id) === stopping) this.stops.delete(run.id); }).catch(this.ports.onError);
    }
    return current;
  }

  /** A worker waiting to be resumed whose turn already ran the per-worker limit is stopped for that reason. */
  private stopCutOffPastTurnLimit(id: string): boolean {
    let run = this.requireRun(id);
    const minutes = run.turnMinutes;
    if (minutes === undefined || run.status !== "running") return false;
    let stopped = false;
    for (const approach of run.approaches.filter((candidate) => candidate.interrupted)) {
      if ((approach.turnMs ?? 0) + (approach.turnSince === undefined ? 0 : Math.max(0, this.now() - approach.turnSince)) < minutes * MINUTE) continue;
      this.append(run, `turn-limit:${approach.id}:${run.revision}`, this.operator(run), { type: "worker", approachId: approach.id, state: "stopped",
        note: `Stopped at the per-worker time limit of ${minutes === 1 ? "1 minute" : `${minutes} minutes`}. Its findings are kept; the run continues.` });
      run = this.requireRun(id);
      stopped = true;
    }
    return stopped;
  }

  private hold(run: ResearchRun): ResearchRun {
    if (!researchRunHeldBy(run, this.ports.ownerId, this.ports.isOwnerAlive)) throw new Error(RESEARCH_RUN_HELD_ELSEWHERE);
    return researchRunNeedsAdoption(run, this.ports.ownerId) ? this.adopt(run) : run;
  }

  /** Withdraw the thread's waiting request so a later research_start for it is refused. No writes. */
  withdraw(thread: ResearchThread): void {
    if (this.intents.delete(JSON.stringify([thread.backend, thread.threadId]))) this.ports.changed({ backend: thread.backend, threadId: thread.threadId });
  }
  summaries(thread: ResearchThread) {
    return this.storage.summaries(thread).map((run) => ({ id: run.id, objective: run.objective.slice(0, 200), status: run.status, deadlineAt: run.deadlineAt, workerLimit: run.workerLimit, activeWorkers: run.activeWorkers,
      ...(run.turnMinutes !== undefined ? { turnMinutes: run.turnMinutes } : {}), ...(run.totalWorkerMinutes !== undefined ? { totalWorkerMinutes: run.totalWorkerMinutes } : {}) }));
  }

  read(id: string, actor: ResearchActor): ResearchRun {
    const run = this.requireRun(id);
    this.requireMember(run, actor);
    return run;
  }

  private accessibleHeader(id: string, actor: ResearchActor): ResearchRunHeader {
    const header = this.storage.header(id);
    if (!header) throw new Error("Research run not found");
    if (!this.storage.isMember(id, actor)) throw new Error("The calling thread is not a member of this research run");
    return header;
  }

  search(id: string, query: ResearchSearchQuery, actor: ResearchActor): ResearchSearchPage {
    this.accessibleHeader(id, actor);
    return this.storage.search(id, query);
  }

  readItem(id: string, itemId: string, actor: ResearchActor): ResearchItemContext {
    const header = this.accessibleHeader(id, actor);
    const run = { id: header.id, revision: header.revision, objective: header.objective, coordinator: header.coordinator,
      deadlineAt: header.deadlineAt, workspaceMode: header.workspaceMode, status: header.status, workerLimit: header.workerLimit, activeWorkers: header.activeWorkers };
    const item = this.storage.readItem(id, itemId);
    if (!item) throw new Error("Research item not found");
    const approach = this.storage.readItem(id, item.approachId);
    const assignment = item.work.assignmentId ? this.storage.readItem(id, item.work.assignmentId) : undefined;
    return { run, item, ...(approach?.type === "approach" ? { approach: approach.record } : {}),
      ...(assignment?.type === "approach" ? { assignment: assignment.record } : {}) };
  }

  assign(request: ResearchAssignRequest, context: ResearchExecutionContext): Promise<ResearchAssignmentReceipt> {
    const key = `assign:${context.backend}:${context.threadId}:${context.turnId}:${context.callId}`;
    const signature = JSON.stringify(request);
    const pending = this.assignments.get(key);
    if (pending) return pending.signature === signature ? pending.promise : Promise.reject(new Error("Assignment command key was reused"));
    const promise = this.performAssignment(request, context, key, signature);
    this.assignments.set(key, { signature, promise });
    void promise.finally(() => this.assignments.delete(key)).catch(() => {});
    return promise;
  }

  private async performAssignment(request: ResearchAssignRequest, context: ResearchExecutionContext, key: string, signature: string): Promise<ResearchAssignmentReceipt> {
    this.requireOpen();
    const member = this.read(request.runId, context);
    if (!sameResearchThread(member.coordinator, context)) throw new Error("Only the coordinating thread can assign research items");
    const run = this.hold(member);
    const duplicate = this.storage.findCommand(run.id, key);
    if (duplicate) {
      if (duplicate.signature !== signature || duplicate.data.type !== "assignment") throw new Error("Assignment command key was reused");
      return this.assignmentReceipt(run.id, duplicate.data.approach.id, request.itemId);
    }
    if (!["running", "exhausted"].includes(run.status) || researchDeadlinePassed(run, this.now())) throw new Error("Research run is no longer accepting assignments");
    if (run.revision + (run.status === "exhausted" ? 1 : 0) >= RESEARCH_MAX_EVENTS) throw new Error("Research event limit reached; finish this run before starting another");
    boundedText(request.task, "assignment task", 2000);
    const item = this.requireItemVersion(run.id, request.itemId, request.expectedVersion);
    this.requireReleasedAssignment(run, item);
    if (!["open", "blocked"].includes(item.work.state) || item.work.assignee) throw new Error("Release or reopen the item before assigning it");
    if (run.activeWorkers >= run.workerLimit) throw new Error("Research worker limit reached; wait for or cancel an existing worker");
    if (run.status === "exhausted") {
      this.append(run, `reopen:${key}`, context, { type: "status", status: "running", reason: "The coordinator explicitly assigned retained evidence within the original deadline." });
      this.scheduleDeadline(this.requireRun(run.id));
    }
    const title = `Investigate: ${item.type === "approach" ? item.record.title : item.record.text}`.slice(0, 160);
    const approach: ResearchApproach = { id: `work-${randomUUID()}`, title, task: request.task, state: "pending", itemId: item.id };
    this.append(this.requireRun(run.id), key, context, { type: "assignment", itemId: item.id, approach, task: request.task }, signature);
    await this.admitApproach(run.id, approach, context);
    if (this.requireRun(run.id).status === "stopping") this.finishStopping(this.requireRun(run.id));
    else this.finishExploration(this.requireRun(run.id));
    return this.assignmentReceipt(run.id, approach.id, item.id);
  }

  private assignmentReceipt(id: string, assignmentId: string, itemId: string): ResearchAssignmentReceipt {
    const assignment = this.storage.readItem(id, assignmentId);
    if (assignment?.type !== "approach") throw new Error("Assignment is unavailable");
    const item = this.storage.readItem(id, itemId)!;
    return { runId: id, itemId, version: item.version, assignmentId, state: assignment.record.state, worker: assignment.record.worker };
  }

  async work(id: string, requestId: string, command: ResearchWorkCommand, actor: ResearchActor): Promise<ResearchItem> {
    this.requireOpen();
    this.accessibleHeader(id, actor);
    const header = this.hold(this.requireRun(id));
    const signature = JSON.stringify(command);
    const duplicate = this.storage.findCommand(id, requestId);
    if (duplicate) {
      if (duplicate.signature !== signature || !sameResearchThread(duplicate.actor, actor) || duplicate.actor.kind !== actor.kind) throw new Error("Research command key was reused");
      return this.storage.readItem(id, command.itemId)!;
    }
    const coordinator = actor.kind === "operator" || sameResearchThread(header.coordinator, actor);
    if ((header.status !== "running" && !(coordinator && header.status === "exhausted")) || researchDeadlinePassed(header, this.now())) throw new Error("Research run is no longer accepting work");
    boundedText(requestId, "requestId", 300);
    boundedText(command.reason, "reason", 2000);
    const item = this.requireItemVersion(id, command.itemId, command.expectedVersion);
    const approach = this.storage.readItem(id, item.approachId);
    const originalWorker = approach?.type === "approach" ? approach.record.worker : undefined;
    const assigned = item.work.assignee;
    if (!coordinator && (assigned ? !sameResearchThread(assigned, actor) : !originalWorker || !sameResearchThread(originalWorker, actor))) throw new Error("Only the item's assignee or coordinator may change its work state");
    if (["open", "cancelled"].includes(command.state) && !coordinator) throw new Error("Only the coordinator may release or cancel an item");
    if (!RESEARCH_WORK_TRANSITIONS[item.work.state].includes(command.state)) throw new Error("Invalid item work-state transition");
    if (command.state === "open") this.requireReleasedAssignment(this.requireRun(id), item);
    const cancellation = command.state === "cancelled" ? item.work.assignmentId ?? (item.type === "approach" ? item.id : undefined) : undefined;
    const work: ResearchItemWork = command.state === "open" ? { state: "open", note: command.reason }
      : { ...item.work, state: cancellation ? "cancel_requested" : command.state, note: command.reason,
        ...(cancellation ? { assignmentId: cancellation, assignee: assigned ?? originalWorker } : {}),
        ...(command.state === "claimed" ? { assignee: assigned ?? { backend: actor.backend, threadId: actor.threadId } } : {}) };
    if (header.revision >= RESEARCH_MAX_EVENTS && command.state !== "cancelled") throw new Error("Research event limit reached; finish this run before starting another");
    this.storage.append(id, header.revision, { seq: header.revision + 1, commandId: requestId, signature, at: this.now(), actor, data: { type: "item_work", itemId: item.id, work } });
    this.publish(id);
    if (cancellation) {
      for (const delivery of this.requireRun(id).deliveries) {
        if (delivery.approachId === cancellation && !["cancelled", "ended"].includes(delivery.state)) await this.cancelDelivery(id, delivery, actor);
      }
      await this.stopWorker(id, cancellation, actor);
      this.settleItemCancellation(id, cancellation);
    }
    return this.storage.readItem(id, item.id)!;
  }

  private requireItemVersion(id: string, itemId: string, version: number): ResearchItem {
    const item = this.storage.readItem(id, itemId);
    if (!item) throw new Error("Research item not found");
    if (!Number.isSafeInteger(version) || item.version !== version) throw new Error("Research item changed; read its current version before updating");
    return item;
  }

  private requireReleasedAssignment(run: ResearchRun, item: ResearchItem): void {
    const assignment = item.work.assignmentId ? run.approaches.find((a) => a.id === item.work.assignmentId) : undefined;
    if (assignment && researchApproachOccupiesSlot(assignment)) throw new Error("The prior assignment is still active or unresolved; cancel it before reassigning");
  }

  private settleItemCancellation(id: string, assignmentId: string): void {
    const run = this.requireRun(id);
    const assignment = run.approaches.find((a) => a.id === assignmentId);
    if (!assignment || researchApproachOccupiesSlot(assignment)) return;
    for (const itemId of new Set([assignment.id, assignment.itemId].filter((value): value is string => Boolean(value)))) {
      const item = this.storage.readItem(id, itemId);
      if (item?.work.assignmentId !== assignmentId || item.work.state !== "cancel_requested") continue;
      this.append(this.requireRun(id), `item-cancelled:${assignmentId}:${item.id}:${item.version}`, this.operator(run), { type: "item_work", itemId: item.id, work: { ...item.work, state: "cancelled" } });
    }
  }

  isWorker(thread: ResearchThread): boolean {
    return this.storage.list(thread).some((run) => ["running", "stopping"].includes(run.status)
      && run.approaches.some((a) => a.worker && sameResearchThread(a.worker, thread)));
  }

  /** Bind the operator's form limits before asking the coordinator to propose directions. No writes or spend. */
  prepare(request: PrepareResearchRequest): { intentId: string } {
    this.requireOpen();
    if (!Number.isInteger(request.workers) || request.workers < 1 || request.workers > RESEARCH_MAX_WORKERS) throw new Error(`Choose 1–${RESEARCH_MAX_WORKERS} workers`);
    validateStartResearch({ ...request, approaches: Array.from({ length: request.workers }, (_, i) => ({ title: `Approach ${i + 1}`, task: "Awaiting assignment" })) });
    const id = randomUUID();
    const preparedAt = this.now();
    this.intents.set(JSON.stringify([request.backend, request.threadId]), { id, request: { ...request }, preparedAt, expiresAt: preparedAt + RESEARCH_REQUEST_TTL_MS });
    this.ports.changed({ backend: request.backend, threadId: request.threadId });
    return { intentId: id };
  }

  start(request: StartResearchRequest, context: ResearchExecutionContext): Promise<ResearchRun> {
    const key = JSON.stringify([context.backend, context.threadId, context.turnId, context.callId]);
    const pending = this.starts.get(key);
    const signature = JSON.stringify(request);
    if (pending) return pending.signature === signature ? pending.promise : Promise.reject(new Error("Research start key was reused with different arguments"));
    const existing = this.storage.findByStartKey(key);
    if (existing) {
      if (existing.events[0]?.signature !== signature) return Promise.reject(new Error("Research start key was reused with different arguments"));
      return Promise.resolve(existing);
    }
    const promise = this.performStart(request, context, key);
    this.starts.set(key, { signature, promise });
    void promise.finally(() => this.starts.delete(key)).catch(() => {});
    return promise;
  }

  private async performStart(request: StartResearchRequest, context: ResearchExecutionContext, key: string): Promise<ResearchRun> {
    this.requireOpen();
    validateStartResearch(request);
    if (this.isWorker(context)) throw new Error("Research workers cannot start additional runs. Ask the coordinating thread to change the assignment.");
    const intentKey = JSON.stringify([context.backend, context.threadId]);
    const intent = this.intents.get(intentKey);
    if (request.intentId || intent) {
      if (!intent || request.intentId !== intent.id || this.now() >= intent.expiresAt) throw new Error("Research request expired or was replaced. Submit a fresh request from the Research panel.");
      if (request.objective !== intent.request.objective || request.approaches.length !== intent.request.workers || request.minutes !== intent.request.minutes
        || request.turnMinutes !== intent.request.turnMinutes || request.totalWorkerMinutes !== intent.request.totalWorkerMinutes || request.workspaceMode !== intent.request.workspaceMode) throw new Error("Research must use the exact objective, worker count, time limits and workspace choice the operator requested");
    }
    const id = randomUUID();
    const approaches: ResearchApproach[] = request.approaches.map((a, index) => ({ title: a.title, task: a.task, id: `a${index + 1}`, state: "pending" }));
    this.storage.create(id, key, { seq: 1, commandId: "start", signature: JSON.stringify(request), at: this.now(), actor: context,
      data: { type: "created", objective: request.objective, coordinator: { backend: context.backend, threadId: context.threadId }, approaches, ownerId: this.ports.ownerId,
        ownerPid: this.ports.ownerPid, ownerStartedAt: this.ports.ownerStartedAt, ...(request.minutes !== undefined ? { deadlineAt: this.now() + request.minutes * 60_000 } : {}),
        ...(request.turnMinutes !== undefined ? { turnMinutes: request.turnMinutes } : {}), ...(request.totalWorkerMinutes !== undefined ? { totalWorkerMinutes: request.totalWorkerMinutes } : {}), workspaceMode: request.workspaceMode } });
    if (intent) this.intents.delete(intentKey);
    this.ports.changed(context);
    this.scheduleDeadline(this.requireRun(id));
    for (const approach of approaches) {
      if (!this.canDispatch(this.requireRun(id))) break;
      await this.admitApproach(id, approach, context);
    }
    const current = this.requireRun(id);
    if (current.status === "stopping") this.finishStopping(current);
    else if (current.status === "running" && researchDeadlinePassed(current, this.now())) await this.stop(id, context, "deadline", "Research deadline reached");
    else this.finishExploration(current);
    return this.requireRun(id);
  }

  private async admitApproach(id: string, approach: ResearchApproach, context: ResearchExecutionContext): Promise<void> {
    const run = this.requireRun(id);
    // An approach not yet started holds its slot only within the worker count: a lowered count starts no new worker.
    const overCount = run.activeWorkers > run.workerLimit;
    if (overCount || !this.canAdmitApproach(run, approach)) {
      this.append(run, `unadmitted:${approach.id}`, context, { type: "worker", approachId: approach.id, state: "stopped",
        ...(overCount && this.canAdmitApproach(run, approach) ? { note: "Not started: the run already had as many workers as its worker count." } : {}) });
      this.settleItemCancellation(id, approach.id);
      return;
    }
    this.pendingStarts.add(`${id}:${approach.id}`);
    this.append(this.requireRun(id), `starting:${approach.id}`, context, { type: "worker", approachId: approach.id, state: "starting" });
    try {
      const worker = await this.ports.spawn({ ...context, callId: `${context.callId}:${approach.id}` },
        approach.itemId ? researchItemWorkerPrompt(id, approach) : researchWorkerPrompt(id, run.objective, approach), approach.title, run.workspaceMode,
        (created) => {
          const current = this.requireRun(id);
          this.append(current, `bound:${approach.id}`, context, { type: "worker", approachId: approach.id, state: "starting", worker: created });
          if (!this.canAdmitApproach(this.requireRun(id), approach)) throw new ResearchAdmissionRefused("Research assignment stopped before worker admission");
        });
      const current = this.requireRun(id);
      const prior = current.approaches.find((a) => a.id === approach.id)!;
      // A trusted provider event can precede the handoff reply. It already
      // owns this transition; do not rewrite it or regress its outcome.
      if (!prior.worker?.turnId || (prior.state === "starting" && prior.worker.turnId === worker.turnId)) {
        this.append(current, `started:${approach.id}`, context, { type: "worker", approachId: approach.id, worker,
          state: ["ended", "stopped", "failed"].includes(prior.state) ? prior.state : worker.turnId ? "running" : "unknown" });
      }
      const admitted = this.requireApproach(this.requireRun(id), approach.id);
      if (!this.canAdmitApproach(this.requireRun(id), approach) && !["ended", "stopped", "failed"].includes(admitted.state)) await this.stopWorker(id, approach.id, context);
    } catch (error) {
      const current = this.requireRun(id);
      const observed = this.requireApproach(current, approach.id);
      const state = observed.worker?.turnId && ["running", "ended", "stopped", "failed"].includes(observed.state)
        ? observed.state : error instanceof ResearchAdmissionRefused ? "failed" : "unknown";
      this.append(current, `start-failed:${approach.id}`, context, { type: "worker", approachId: approach.id, state, note: message(error) });
      if (!this.canAdmitApproach(this.requireRun(id), approach) && state === "running") await this.stopWorker(id, approach.id, context);
    } finally {
      this.pendingStarts.delete(`${id}:${approach.id}`);
      this.settleItemCancellation(id, approach.id);
    }
  }

  async update(id: string, requestId: string, command: ResearchCommand, actor: ResearchActor): Promise<ResearchRun> {
    this.requireOpen();
    if (command?.action === "work") { await this.work(id, requestId, command, actor); return this.requireRun(id); }
    if (!command || !["finding", "submit", "review", "abandon", "direction", "stop", "finish", "resume", "bounds"].includes(command.action)) throw new Error("Unknown research command");
    boundedText(requestId, "requestId", 300);
    let run = this.hold(this.read(id, actor));
    const signature = JSON.stringify(command);
    const duplicate = run.events.find((e) => e.commandId === requestId);
    if (duplicate) {
      if (duplicate.signature !== signature || !sameResearchThread(duplicate.actor, actor) || duplicate.actor.kind !== actor.kind) throw new Error("Research command key was reused");
      return run;
    }
    if (command.action === "bounds") {
      if (actor.kind !== "operator") throw new Error("Only the operator can change a run's bounds");
      return this.changeBounds(run, requestId, signature, command, actor);
    }
    const coordinator = actor.kind === "operator" || sameResearchThread(actor, run.coordinator);
    if ((command.action === "review" || command.action === "stop" || command.action === "finish") && !coordinator) throw new Error("Only the coordinator or operator may review or stop a run");
    if (command.action === "resume") {
      if (!coordinator) throw new Error("Only the coordinator or operator may resume workers");
      return await this.resume(run, requestId, signature, command.approachIds, actor);
    }
    if (command.action === "stop" || command.action === "finish") {
      boundedText(command.reason, "reason", 2000);
      if (command.action === "finish" && !run.submissions.some((s) => s.review?.decision === "accepted")) throw new Error("Accept a submission before completing the run");
      return await this.stop(id, actor, command.action === "finish" ? "completed" : "stopped", command.reason, requestId, signature);
    }
    if (command.action !== "review" && !this.canDispatch(run)) throw new Error("Research run is no longer accepting work");
    let data: ResearchEventData;
    if (command.action === "finding" || command.action === "submit") {
      const approach = this.requireApproach(run, command.approachId);
      if (!coordinator && (!approach.worker || !sameResearchThread(actor, approach.worker))) throw new Error("A worker may post only under its assigned approach");
      if (approach.directionState === "abandoned") throw new Error("Revise the abandoned direction before posting more work");
      boundedText(command.text, "text", 4000);
      validatePaths(command.paths);
      if (command.action === "finding") {
        if (!RESEARCH_FINDING_KINDS.includes(command.kind)) throw new Error("Unknown finding kind");
        if (Boolean(command.relatesTo) !== Boolean(command.relation)) throw new Error("A relationship needs both relation and relatesTo");
        if (command.relatesTo && (!run.findings.some((f) => f.id === command.relatesTo) || !["supports", "contradicts", "supersedes"].includes(command.relation ?? ""))) throw new Error("Unknown finding relationship");
        data = { type: "finding", finding: { id: randomUUID(), author: { backend: actor.backend, threadId: actor.threadId }, approachId: command.approachId, kind: command.kind,
          text: command.text, paths: [...command.paths], ...(command.relatesTo ? { relatesTo: command.relatesTo, relation: command.relation } : {}) } };
      } else data = { type: "submission", submission: { id: randomUUID(), author: { backend: actor.backend, threadId: actor.threadId }, approachId: command.approachId, text: command.text, paths: command.paths } };
    } else if (command.action === "review") {
      if (!run.submissions.some((s) => s.id === command.submissionId)) throw new Error("Unknown submission");
      if (!["accepted", "revision_requested", "rejected"].includes(command.decision)) throw new Error("Unknown review decision");
      if (command.decision === "revision_requested" && !this.canDispatch(run)) throw new Error("The run is no longer accepting revisions");
      if (command.decision === "revision_requested") {
        const submission = run.submissions.find((s) => s.id === command.submissionId)!;
        const approach = this.requireApproach(run, submission.approachId);
        if (!approach.worker) throw new Error("Revision worker is unavailable");
        if (approach.revisionDeliveryIds?.length) throw new Error("A revision is already pending for this worker");
        if (!researchApproachOccupiesSlot(approach) && run.activeWorkers >= run.workerLimit) throw new Error("Research worker limit reached; wait for or cancel an existing worker");
        if (!this.canAdmitApproach(run, approach)) throw new Error("The research assignment is no longer accepting revisions");
      }
      boundedText(command.reason, "reason", 2000);
      data = { type: "review", submissionId: command.submissionId, decision: command.decision, reason: command.reason };
    } else if (command.action === "direction") {
      const approach = this.requireApproach(run, command.approachId);
      if (!coordinator && (!approach.worker || !sameResearchThread(actor, approach.worker))) throw new Error("A worker may revise only its own direction");
      boundedText(command.title, "title", 160);
      boundedText(command.task, "task", 4000);
      boundedText(command.reason, "reason", 2000);
      if (command.overlapsApproachId) {
        this.requireApproach(run, command.overlapsApproachId);
        if (command.overlapsApproachId === approach.id) throw new Error("A direction cannot overlap itself");
      }
      data = { type: "direction", approachId: command.approachId, title: command.title, task: command.task, reason: command.reason, overlapsApproachId: command.overlapsApproachId };
    } else {
      const approach = this.requireApproach(run, command.approachId);
      if (!coordinator && (!approach.worker || !sameResearchThread(actor, approach.worker))) throw new Error("A worker may abandon only its own approach");
      boundedText(command.reason, "reason", 2000);
      data = { type: "abandoned", approachId: command.approachId, reason: command.reason };
    }
    this.append(run, requestId, actor, data, signature);
    run = this.requireRun(id);
    if ((actor.kind === "agent" && actor.turnId && actor.callId && command.action === "submit") || (command.action === "review" && command.decision === "revision_requested")) {
      const target = command.action === "submit" ? run.coordinator
        : this.requireApproach(run, run.submissions.find((s) => s.id === command.submissionId)!.approachId).worker;
      if (target && !sameResearchThread(actor, target)) {
        const revision = command.action === "review";
        const deliveryId = `feedback:${requestId}`;
        const approachId = command.action === "review" ? run.submissions.find((s) => s.id === command.submissionId)!.approachId : undefined;
        if (revision) {
          this.pendingDeliveries.add(`${id}:${deliveryId}`);
          this.pendingQueueEvents.set(`${id}:${deliveryId}`, new Map());
          this.append(this.requireRun(id), `pending:${deliveryId}`, actor, { type: "delivery", delivery: { id: deliveryId, target, approachId, state: "pending" } });
        }
        try {
          const receipt = await this.ports.notify(actor, target,
            `Research run ${id}: ${command.action === "submit" ? "A candidate is ready for review" : "Revision requested"}. Read research_read with runId=${id}. ${command.action === "review" ? command.reason : "Review the submission and its evidence; acceptance is not formal verification."}`);
          if (revision) {
            const current = this.requireRun(id);
            const terminal = receipt.turnId && this.turnEnded(current, approachId!, receipt.turnId);
            const delivery: ResearchDelivery = { id: deliveryId, target, approachId, ...receipt,
              state: terminal ? current.status === "stopping" ? "cancelled" : "ended" : receipt.queueEntryId ? "queued" : receipt.turnId ? "started" : "unknown" };
            this.append(this.requireRun(id), `receipt:${deliveryId}`, actor, { type: "delivery", delivery });
            const queuedEvent = receipt.queueEntryId ? this.pendingQueueEvents.get(`${id}:${deliveryId}`)?.get(receipt.queueEntryId) : undefined;
            if (receipt.queueEntryId && queuedEvent) await this.observeQueue(target, receipt.queueEntryId, queuedEvent.status, queuedEvent.turnId);
            const afterReceipt = this.requireRun(id);
            const known = afterReceipt.deliveries.find((d) => d.id === deliveryId)!;
            if (!["cancelled", "ended"].includes(known.state) && !this.canAdmitApproach(afterReceipt, this.requireApproach(afterReceipt, approachId!))) await this.cancelDelivery(id, known, actor);
          }
        } catch (error) {
          this.append(this.requireRun(id), `delivery:${requestId}`, actor, { type: "delivery_failed", reason: message(error) });
          if (revision) this.append(this.requireRun(id), `unknown:${deliveryId}`, actor, { type: "delivery", delivery: { id: deliveryId, target, approachId, state: "unknown" } });
        } finally {
          this.pendingDeliveries.delete(`${id}:${deliveryId}`);
          this.pendingQueueEvents.delete(`${id}:${deliveryId}`);
          if (approachId) this.settleItemCancellation(id, approachId);
          this.finishStopping(this.requireRun(id));
        }
      }
    }
    return this.requireRun(id);
  }

  private changeBounds(run: ResearchRun, requestId: string, signature: string, command: ResearchBoundsCommand, actor: ResearchActor): ResearchRun {
    if (!this.canDispatch(run)) throw new Error("Only a running run's bounds can be changed");
    const keys = ["workers", "minutes", "turnMinutes", "totalWorkerMinutes"] as const;
    if (keys.every((key) => command[key] === undefined)) throw new Error("Choose a bound to change");
    if (command.workers !== undefined && (!Number.isInteger(command.workers) || command.workers < 1 || command.workers > RESEARCH_MAX_WORKERS)) throw new Error(`Choose 1–${RESEARCH_MAX_WORKERS} workers`);
    if ([command.minutes, command.turnMinutes, command.totalWorkerMinutes].some((value) => value !== null && !validResearchMinutes(value))) throw new Error("A research limit is a whole number of minutes, at least 1. Choose No limit to remove it.");
    const now = this.now();
    const deadlineAt = command.minutes === undefined ? run.deadlineAt : command.minutes === null ? undefined : run.createdAt + command.minutes * MINUTE;
    const turnMinutes = command.turnMinutes === undefined ? run.turnMinutes : command.turnMinutes ?? undefined;
    const totalWorkerMinutes = command.totalWorkerMinutes === undefined ? run.totalWorkerMinutes : command.totalWorkerMinutes ?? undefined;
    const workerLimit = command.workers ?? run.workerLimit;
    const minutes = (ms: number) => { const whole = Math.floor(ms / MINUTE); return whole === 1 ? "1 minute" : `${whole} minutes`; };
    if (deadlineAt !== undefined && deadlineAt !== run.deadlineAt && now >= deadlineAt) throw new Error(`That time limit has already passed: the run started ${minutes(now - run.createdAt)} ago. Choose a longer limit, or stop the run.`);
    if (totalWorkerMinutes !== undefined && totalWorkerMinutes !== run.totalWorkerMinutes) {
      const used = this.workerTimeUsed(run, now);
      if (used >= totalWorkerMinutes * MINUTE) throw new Error(`Workers have already used ${minutes(used)}. Choose a larger total worker time, or stop the run.`);
    }
    if (workerLimit === run.workerLimit && deadlineAt === run.deadlineAt && turnMinutes === run.turnMinutes && totalWorkerMinutes === run.totalWorkerMinutes) return run;
    this.append(run, requestId, actor, { type: "bounds", workerLimit, ...(deadlineAt !== undefined ? { deadlineAt } : {}),
      ...(turnMinutes !== undefined ? { turnMinutes } : {}), ...(totalWorkerMinutes !== undefined ? { totalWorkerMinutes } : {}) }, signature);
    if (deadlineAt !== run.deadlineAt) {
      this.deadlines.get(run.id)?.();
      this.deadlines.delete(run.id);
      this.scheduleDeadline(this.requireRun(run.id));
    }
    if (turnMinutes !== run.turnMinutes && this.stopCutOffPastTurnLimit(run.id)) this.finishExploration(this.requireRun(run.id));
    return this.requireRun(run.id);
  }

  /** Every finished part of every worker's turns, and each part still running, up to `now`. */
  private workerTimeUsed(run: ResearchRun, now: number): number {
    return run.approaches.reduce((sum, approach) => sum + (approach.workedMs ?? 0) + (approach.turnSince === undefined ? 0 : Math.max(0, now - approach.turnSince)), 0);
  }

  async stop(id: string, actor: ResearchActor, outcome: "stopped" | "deadline" | "completed", reason: string, requestId: string = randomUUID(), signature: string = outcome): Promise<ResearchRun> {
    const member = this.read(id, actor);
    if (actor.kind !== "operator" && !sameResearchThread(actor, member.coordinator)) throw new Error("Only the coordinator or operator may stop a run");
    const run = this.hold(member);
    const pending = this.stops.get(id);
    if (pending) return pending;
    if (!["running", "stopping"].includes(run.status)) {
      if (outcome === "completed" && ["interrupted", "exhausted"].includes(run.status)) {
        if (!run.submissions.some((submission) => submission.review?.decision === "accepted")) throw new Error("Accept a submission before completing the run");
        this.append(run, requestId, actor, { type: "status", status: "completed", reason }, signature);
        return this.requireRun(id);
      }
      return run;
    }
    this.append(run, requestId, actor, { type: "status", status: "stopping", reason: `${outcome}: ${reason}` }, signature);
    this.deadlines.get(id)?.();
    this.deadlines.delete(id);
    const promise = this.performStop(id, actor);
    this.stops.set(id, promise);
    try { return await promise; } finally { this.stops.delete(id); }
  }

  private async performStop(id: string, actor: ResearchActor): Promise<ResearchRun> {
    const run = this.requireRun(id);
    for (const item of run.items) {
      if (item.work.assignmentId && !["open", "completed", "cancelled", "cancel_requested"].includes(item.work.state)) this.append(this.requireRun(id), `cancel-item:${item.id}:${run.revision}`, actor, { type: "item_work", itemId: item.id, work: { ...item.work, state: "cancel_requested", note: "Research run stopped" } });
    }
    for (const delivery of run.deliveries) {
      if (["queued", "started"].includes(delivery.state)) await this.cancelDelivery(id, delivery, actor);
    }
    for (const key of [...this.queuedResumes.keys()]) if (key.startsWith(`${id}:`)) await this.withdrawResume(id, key.slice(id.length + 1), actor);
    for (const approach of this.requireRun(id).approaches) {
      if (this.pendingStarts.has(`${id}:${approach.id}`)) continue;
      if (approach.worker && !["ended", "stopped", "failed"].includes(approach.state)) await this.stopWorker(id, approach.id, actor);
      else if (approach.state === "pending") this.append(this.requireRun(id), `unstarted:${approach.id}`, actor, { type: "worker", approachId: approach.id, state: "stopped" });
    }
    this.finishStopping(this.requireRun(id));
    return this.requireRun(id);
  }

  private async cancelDelivery(id: string, delivery: ResearchDelivery, actor: ResearchActor): Promise<void> {
    if (["cancelled", "ended"].includes(this.requireRun(id).deliveries.find((d) => d.id === delivery.id)?.state ?? "")) return;
    let known = delivery;
    try {
      if (!delivery.queueEntryId && !delivery.turnId) throw new Error("Revision delivery has no confirmed receipt");
      const receipt = delivery.queueEntryId ? await this.ports.cancelQueued(delivery.queueEntryId) : { turnId: delivery.turnId };
      if (receipt.turnId) {
        known = { ...delivery, turnId: receipt.turnId };
        if (delivery.turnId !== receipt.turnId) this.append(this.requireRun(id), `admitted:${delivery.id}`, actor, { type: "delivery", delivery: { ...known, state: "started" } });
        const run = this.requireRun(id);
        const approach = run.approaches.find((a) => a.worker && sameResearchThread(a.worker, delivery.target));
        if (!approach) throw new Error("Revision worker is unavailable");
        const ended = this.turnEnded(run, approach.id, receipt.turnId);
        if (!ended && (approach.worker?.turnId !== receipt.turnId || !["ended", "stopped", "failed"].includes(approach.state))) {
          await this.ports.stop({ ...delivery.target, turnId: receipt.turnId });
          const current = this.requireRun(id);
          if (this.requireApproach(current, approach.id).worker?.turnId === receipt.turnId) this.append(current, `revision-stopped:${delivery.id}:${receipt.turnId}`, actor, { type: "worker", approachId: approach.id, state: "stopped" });
        }
      }
      if (["cancelled", "ended"].includes(this.requireRun(id).deliveries.find((d) => d.id === delivery.id)?.state ?? "")) return;
      this.append(this.requireRun(id), `cancelled:${delivery.id}`, actor, { type: "delivery", delivery: { ...known, state: "cancelled" } });
      if (known.approachId) this.settleItemCancellation(id, known.approachId);
    } catch (error) {
      if (["cancelled", "ended"].includes(this.requireRun(id).deliveries.find((d) => d.id === delivery.id)?.state ?? "")) return;
      this.append(this.requireRun(id), `cancel-unknown:${delivery.id}:${this.requireRun(id).revision}`, actor, { type: "delivery", delivery: { ...known, state: "unknown" } });
      this.append(this.requireRun(id), `cancel-error:${delivery.id}:${this.requireRun(id).revision}`, actor, { type: "delivery_failed", reason: message(error) });
    }
  }

  private async stopWorker(id: string, approachId: string, actor: ResearchActor, note?: string): Promise<void> {
    const approach = this.requireApproach(this.requireRun(id), approachId);
    if (!approach.worker?.turnId) return;
    const worker = approach.worker;
    const key = JSON.stringify([id, approachId, worker.turnId]);
    let pending = this.workerStops.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => this.performWorkerStop(id, approachId, actor, worker, note));
      this.workerStops.set(key, pending);
    }
    try { await pending; }
    finally { if (this.workerStops.get(key) === pending) this.workerStops.delete(key); }
  }

  private async performWorkerStop(id: string, approachId: string, actor: ResearchActor, worker: NonNullable<ResearchApproach["worker"]>, note?: string): Promise<void> {
    try {
      const before = this.requireApproach(this.requireRun(id), approachId);
      if (before.worker?.turnId !== worker.turnId || ["ended", "stopped", "failed"].includes(before.state)) return;
      await this.ports.stop(worker);
      const current = this.requireRun(id);
      if (this.requireApproach(current, approachId).worker?.turnId !== worker.turnId) return;
      this.append(current, `stopped:${approachId}:${worker.turnId}`, actor, { type: "worker", approachId, state: "stopped", ...(note ? { note } : {}) });
      this.settleItemCancellation(id, approachId);
    } catch (error) {
      const current = this.requireRun(id);
      const latest = this.requireApproach(current, approachId);
      if (latest.worker?.turnId !== worker.turnId || ["ended", "stopped", "failed"].includes(latest.state)) return;
      this.append(current, `stop-error:${approachId}:${current.revision}`, actor, { type: "worker", approachId, state: "unknown", note: message(error) });
    }
  }

  /** Only the exact recorded worker turn can retire an assignment. No token events write. */
  async observeQueue(thread: ResearchThread, queueEntryId: string, status: string, turnId?: string): Promise<void> {
    if (this.closed || (turnId !== undefined && researchTurnIsPlaceholder(thread, turnId)) || !["started", "terminal", "cancelled", "failed", "blocked"].includes(status)) return;
    for (const run of this.storage.list(thread)) {
      if (run.ownerId !== this.ports.ownerId || !["running", "stopping"].includes(run.status)) continue;
      const resumed = [...this.queuedResumes].find(([key, entry]) => key.startsWith(`${run.id}:`) && entry === queueEntryId)?.[0].slice(run.id.length + 1);
      if (resumed !== undefined) {
        if (["cancelled", "failed", "blocked"].includes(status)) {
          this.queuedResumes.delete(`${run.id}:${resumed}`);
          if (run.approaches.find((approach) => approach.id === resumed)?.state === "starting") this.append(run, `resume-withdrawn:${resumed}:${queueEntryId}`, this.operator(run),
            { type: "worker", approachId: resumed, state: "stopped", interrupted: true, note: "The resume message did not start. Resume the worker again to continue." });
          this.finishStopping(this.requireRun(run.id));
        }
        continue;
      }
      const delivery = run.deliveries.find((d) => d.queueEntryId === queueEntryId && sameResearchThread(d.target, thread));
      if (!delivery) {
        // The queue may admit and finish before notify returns its queue ID.
        // Buffer only while a research send is unresolved, then match its exact receipt.
        for (const pending of run.deliveries.filter((d) => sameResearchThread(d.target, thread))) {
          const events = this.pendingQueueEvents.get(`${run.id}:${pending.id}`);
          if (!events) continue;
          if (["terminal", "cancelled"].includes(events.get(queueEntryId)?.status ?? "")) continue;
          if (events.size >= 128 && !events.has(queueEntryId)) events.delete(events.keys().next().value!);
          events.set(queueEntryId, { status, turnId });
        }
        continue;
      }
      if (["cancelled", "ended"].includes(delivery.state)) continue;
      if (delivery.turnId && turnId && delivery.turnId !== turnId) continue;
      let state: ResearchDelivery["state"];
      if (status === "cancelled") {
        if (delivery.turnId) continue;
        state = "cancelled";
      } else if (status === "terminal" || status === "started") {
        if (!turnId) continue;
        const ended = status === "terminal" || (delivery.approachId && this.turnEnded(run, delivery.approachId, turnId));
        state = ended ? run.status === "stopping" ? "cancelled" : "ended" : "started";
      } else state = "unknown";
      if (delivery.state === state && (!turnId || delivery.turnId === turnId)) continue;
      const known = { ...delivery, state, ...(turnId ? { turnId } : {}) };
      this.append(run, `queue:${delivery.id}:${run.revision}`, this.operator(run), { type: "delivery", delivery: known });
      if (known.approachId) {
        const current = this.requireRun(run.id);
        if (!["cancelled", "ended", "unknown"].includes(state) && !this.canAdmitApproach(current, this.requireApproach(current, known.approachId))) await this.cancelDelivery(run.id, known, this.operator(current));
        this.settleItemCancellation(run.id, known.approachId);
      }
      this.finishStopping(this.requireRun(run.id));
    }
  }

  observeStart(thread: ResearchThread, turnId: string): Promise<void> {
    // Registry placeholders describe local submission, not provider admission.
    if (this.closed || researchTurnIsPlaceholder(thread, turnId)) return Promise.resolve();
    const cancellations: Promise<void>[] = [];
    for (const run of this.storage.list(thread)) {
      if (run.ownerId !== this.ports.ownerId || !["running", "stopping"].includes(run.status)) continue;
      const approach = run.approaches.find((a) => a.worker && sameResearchThread(a.worker, thread));
      if (!approach || approach.worker?.turnId === turnId) continue;
      const newcomer = !researchApproachOccupiesSlot(approach);
      this.append(run, `observed-start:${approach.id}:${turnId}`, this.operator(run), {
        type: "worker", approachId: approach.id, state: "running", worker: { ...thread, turnId },
      });
      this.queuedResumes.delete(`${run.id}:${approach.id}`);
      const current = this.requireRun(run.id);
      if ((newcomer && current.activeWorkers > current.workerLimit) || !this.canAdmitApproach(current, approach)) cancellations.push(this.stopWorker(run.id, approach.id, this.operator(run)).then(() => {
        if (!this.closed) this.finishStopping(this.requireRun(run.id));
      }));
    }
    return Promise.all(cancellations).then(() => undefined);
  }

  observeEnd(thread: ResearchThread, turnId: string, outcome: { failed?: boolean; note?: string } = {}): void {
    if (this.closed || researchTurnIsPlaceholder(thread, turnId)) return;
    for (const run of this.storage.list(thread)) {
      if (run.ownerId !== this.ports.ownerId || !["running", "stopping"].includes(run.status)) continue;
      for (const delivery of run.deliveries) {
        if (!["cancelled", "ended"].includes(delivery.state) && delivery.turnId === turnId && sameResearchThread(delivery.target, thread)) {
          this.append(this.requireRun(run.id), `terminal-delivery:${delivery.id}:${turnId}`, this.operator(run), { type: "delivery", delivery: { ...delivery, state: run.status === "stopping" ? "cancelled" : "ended" } });
          if (delivery.approachId) this.settleItemCancellation(run.id, delivery.approachId);
        }
      }
      const current = this.requireRun(run.id);
      const approach = current.approaches.find((a) => a.worker && sameResearchThread(a.worker, thread) && a.worker.turnId === turnId);
      if (!approach || ["ended", "stopped", "failed"].includes(approach.state)) {
        if (current.status === "stopping") this.finishStopping(current);
        continue;
      }
      this.append(current, `ended:${approach.id}:${turnId}`, this.operator(run), { type: "worker", approachId: approach.id,
        state: outcome.failed ? "failed" : "ended", ...(outcome.note ? { note: outcome.note.slice(0, 2000) } : {}) });
      this.settleItemCancellation(run.id, approach.id);
      if (run.status === "stopping") this.finishStopping(this.requireRun(run.id));
      else this.finishExploration(this.requireRun(run.id));
    }
  }

  close(): void {
    this.closed = true;
    this.intents.clear();
    this.pendingQueueEvents.clear();
    this.queuedResumes.clear();
    for (const cancel of this.deadlines.values()) cancel();
    this.deadlines.clear();
    for (const timer of this.turnLimits.values()) timer.cancel();
    this.turnLimits.clear();
    for (const timer of this.workerTimeLimits.values()) timer.cancel();
    this.workerTimeLimits.clear();
  }

  private async resume(held: ResearchRun, requestId: string, signature: string, approachIds: string[] | undefined, actor: ResearchActor): Promise<ResearchRun> {
    const id = held.id;
    if (!this.canDispatch(held)) throw new Error("Research run is no longer accepting work");
    if (approachIds !== undefined && (!Array.isArray(approachIds) || !approachIds.length || approachIds.length > RESEARCH_MAX_WORKERS || approachIds.some((value) => typeof value !== "string")
      || new Set(approachIds).size !== approachIds.length)) throw new Error("Name each worker to resume once");
    const cutOff = held.approaches.filter((approach) => approach.interrupted);
    const resumable = (approach: ResearchApproach) => researchApproachResumable(approach, (itemId) => held.items.find((candidate) => candidate.id === itemId));
    const targets = approachIds === undefined ? cutOff.filter(resumable) : approachIds.map((approachId) => {
      const approach = cutOff.find((candidate) => candidate.id === approachId);
      if (!approach) throw new Error("That worker is not waiting to be resumed");
      if (!resumable(approach)) throw new Error(`"${approach.title}" is closed and cannot be resumed`);
      return approach;
    });
    if (!targets.length) throw new Error("No worker is waiting to be resumed");
    if (held.activeWorkers + targets.filter((approach) => !researchApproachOccupiesSlot(approach)).length > held.workerLimit) throw new Error("Research worker limit reached; resume fewer workers or wait for one to end");
    this.append(held, requestId, actor, { type: "resumed", approachIds: targets.map((approach) => approach.id) }, signature);
    for (const approach of targets) this.pendingStarts.add(`${id}:${approach.id}`);
    await Promise.all(targets.map(async (approach) => {
      const worker = approach.worker!;
      const thread = { backend: worker.backend, threadId: worker.threadId };
      const now = () => this.requireRun(id).approaches.find((candidate) => candidate.id === approach.id)!;
      try {
        const receipt = await this.ports.notify(actor, thread, researchResumePrompt(id, approach));
        const current = now();
        if (receipt.turnId && current.state === "starting" && current.worker?.turnId === worker.turnId) {
          this.append(this.requireRun(id), `resume-started:${approach.id}:${receipt.turnId}`, actor, { type: "worker", approachId: approach.id, state: "running", worker: { ...thread, turnId: receipt.turnId } });
        } else if (!receipt.turnId && receipt.queueEntryId && current.state === "starting") this.queuedResumes.set(`${id}:${approach.id}`, receipt.queueEntryId);
        if (!this.canAdmitApproach(this.requireRun(id), approach)) await this.withdrawResume(id, approach.id, actor);
      } catch (error) {
        const current = now();
        if (current.state === "starting" && current.worker?.turnId === worker.turnId) {
          this.append(this.requireRun(id), `resume-failed:${approach.id}:${requestId}`, actor, { type: "worker", approachId: approach.id, state: "stopped", interrupted: true,
            note: `The resume message was not delivered: ${message(error)}` });
        }
      } finally {
        this.pendingStarts.delete(`${id}:${approach.id}`);
      }
    }));
    const settled = this.requireRun(id);
    if (settled.status === "stopping") this.finishStopping(settled);
    return this.requireRun(id);
  }

  private async withdrawResume(id: string, approachId: string, actor: ResearchActor): Promise<void> {
    const now = () => this.requireRun(id).approaches.find((candidate) => candidate.id === approachId)!;
    const entry = this.queuedResumes.get(`${id}:${approachId}`);
    if (entry !== undefined) {
      this.queuedResumes.delete(`${id}:${approachId}`);
      try {
        const receipt = await this.ports.cancelQueued(entry);
        const current = now();
        if (!receipt.turnId) {
          if (current.state === "starting") this.append(this.requireRun(id), `resume-withdrawn:${approachId}:${entry}`, actor, { type: "worker", approachId, state: "stopped", note: "The resume message was withdrawn before it started." });
          return;
        }
        if (current.worker?.turnId !== receipt.turnId) this.append(this.requireRun(id), `resume-started:${approachId}:${receipt.turnId}`, actor,
          { type: "worker", approachId, state: "running", worker: { backend: current.worker!.backend, threadId: current.worker!.threadId, turnId: receipt.turnId } });
      } catch (error) {
        if (now().state === "starting") this.append(this.requireRun(id), `resume-unknown:${approachId}:${entry}`, actor, { type: "worker", approachId, state: "unknown", note: message(error) });
        return;
      }
    }
    if (now().state === "running") await this.stopWorker(id, approachId, actor);
  }

  async stopOwnedRuns(reason: string, include: (run: ResearchRunHeader) => boolean = () => true): Promise<void> {
    await Promise.all(this.storage.list().filter((run) => run.ownerId === this.ports.ownerId && ["running", "stopping"].includes(run.status) && include(run))
      .map(async (run) => await this.stop(run.id, this.operator(run), "stopped", reason)));
  }

  private finishStopping(run: ResearchRun): void {
    if (run.status !== "stopping"
      || run.deliveries.some((d) => this.pendingDeliveries.has(`${run.id}:${d.id}`) || !["cancelled", "ended"].includes(d.state))
      || run.approaches.some((a) => this.pendingStarts.has(`${run.id}:${a.id}`) || researchApproachOccupiesSlot(a))) return;
    const status = run.reason?.startsWith("deadline:") ? "deadline" : run.reason?.startsWith("completed:") ? "completed" : "stopped";
    this.append(run, `settled:${run.revision}`, this.operator(run), { type: "status", status, reason: run.reason ?? status });
  }

  private finishExploration(run: ResearchRun): void {
    if (run.status !== "running" || run.submissions.length || run.approaches.some((a) => this.pendingStarts.has(`${run.id}:${a.id}`) || researchApproachOccupiesSlot(a)
      || researchApproachResumable(a, (itemId) => run.items.find((item) => item.id === itemId)))) return;
    this.append(run, `exhausted:${run.revision}`, this.operator(run), { type: "status", status: "exhausted", reason: "All workers ended without submitting a candidate. Findings are retained; this does not establish that the problem is unsolvable." });
    this.deadlines.get(run.id)?.();
    this.deadlines.delete(run.id);
  }

  private scheduleDeadline(run: ResearchRun): void {
    const callback = () => { void this.stop(run.id, this.operator(run), "deadline", "Research deadline reached").catch(this.ports.onError); };
    const deadlineAt = run.deadlineAt;
    // No time limit, no timer: the run ends when the operator stops or finishes it.
    if (deadlineAt === undefined) return;
    this.wait(deadlineAt, callback, (cancel) => this.deadlines.set(run.id, cancel));
  }

  /** One timer cannot wait longer than about 24 days, and a longer delay fires at once. Wait in steps. */
  private wait(at: number, callback: () => void, hold: (cancel: () => void) => void): void {
    const schedule = this.ports.schedule ?? ((fn, delay) => { const timer = setTimeout(fn, delay); timer.unref(); return () => clearTimeout(timer); });
    const arm = (): void => {
      const remaining = at - this.now();
      hold(remaining > RESEARCH_MAX_TIMER_MS ? schedule(arm, RESEARCH_MAX_TIMER_MS) : schedule(callback, Math.max(0, remaining)));
    };
    arm();
  }

  /** The timers for a per-worker time limit and total worker time the operator set, re-derived from the replayed run. */
  private armBounds(id: string, approachIds?: readonly string[]): void {
    if (this.closed) return;
    const run = this.requireRun(id);
    const live = run.status === "running" && run.ownerId === this.ports.ownerId;
    const keyOf = (approachId: string) => `${id}:${approachId}`;
    const mine = [...this.turnLimits.keys()].filter((key) => key.startsWith(`${id}:`));
    if (!live || run.turnMinutes === undefined) {
      for (const key of mine) { this.turnLimits.get(key)!.cancel(); this.turnLimits.delete(key); }
    } else {
      const minutes = run.turnMinutes;
      const targets = approachIds ? run.approaches.filter((approach) => approachIds.includes(approach.id)).sort((a, b) => approachIds.indexOf(a.id) - approachIds.indexOf(b.id))
        : run.approaches.filter(researchApproachOccupiesSlot);
      if (!approachIds) for (const key of mine) if (!targets.some((approach) => keyOf(approach.id) === key)) { this.turnLimits.get(key)!.cancel(); this.turnLimits.delete(key); }
      for (const approach of targets) {
        const at = approach.state === "running" && approach.turnSince !== undefined ? approach.turnSince + minutes * MINUTE - (approach.turnMs ?? 0) : undefined;
        const held = this.turnLimits.get(keyOf(approach.id));
        if (held?.at === at) continue;
        held?.cancel();
        this.turnLimits.delete(keyOf(approach.id));
        if (at === undefined) continue;
        const timer = { at, cancel: () => {} };
        this.turnLimits.set(keyOf(approach.id), timer);
        this.wait(at, () => this.turnLimitReached(id, approach.id, at), (cancel) => { timer.cancel = cancel; });
      }
    }
    const held = this.workerTimeLimits.get(id);
    let at: number | undefined;
    if (live && run.totalWorkerMinutes !== undefined) {
      const limit = run.totalWorkerMinutes * MINUTE;
      const open = run.approaches.flatMap((approach) => approach.turnSince === undefined ? [] : [approach.turnSince]);
      const closed = run.approaches.reduce((sum, approach) => sum + (approach.workedMs ?? 0), 0);
      // With the same turns running, worker time grows by one millisecond per running turn per millisecond.
      at = this.workerTimeUsed(run, this.now()) >= limit ? this.now() : open.length ? Math.ceil((limit - closed + open.reduce((sum, since) => sum + since, 0)) / open.length) : undefined;
    }
    if (held?.at === at) return;
    held?.cancel();
    this.workerTimeLimits.delete(id);
    if (at === undefined) return;
    const timer = { at, cancel: () => {} };
    this.workerTimeLimits.set(id, timer);
    this.wait(at, () => this.workerTimeReached(id, at), (cancel) => { timer.cancel = cancel; });
  }

  private turnLimitReached(id: string, approachId: string, at: number): void {
    if (this.turnLimits.get(`${id}:${approachId}`)?.at === at) this.turnLimits.delete(`${id}:${approachId}`);
    if (this.closed) return;
    const run = this.storage.get(id);
    if (!run || run.status !== "running" || run.ownerId !== this.ports.ownerId || run.turnMinutes === undefined) return;
    const minutes = run.turnMinutes;
    const approach = run.approaches.find((candidate) => candidate.id === approachId);
    if (!approach || approach.state !== "running" || (approach.turnMs ?? 0) + (approach.turnSince === undefined ? 0 : Math.max(0, this.now() - approach.turnSince)) < minutes * MINUTE) return;
    void this.stopWorker(id, approachId, this.operator(run), `Stopped at the per-worker time limit of ${minutes === 1 ? "1 minute" : `${minutes} minutes`}. Its findings are kept; the run continues.`).then(() => {
      if (this.closed) return;
      const current = this.requireRun(id);
      if (current.status === "running") this.finishExploration(current);
      else this.finishStopping(current);
    }).catch(this.ports.onError);
  }

  private workerTimeReached(id: string, at: number): void {
    if (this.workerTimeLimits.get(id)?.at === at) this.workerTimeLimits.delete(id);
    if (this.closed) return;
    const run = this.storage.get(id);
    if (!run || run.status !== "running" || run.ownerId !== this.ports.ownerId || run.totalWorkerMinutes === undefined) return;
    if (this.workerTimeUsed(run, this.now()) < run.totalWorkerMinutes * MINUTE) { this.armBounds(id, []); return; }
    void this.stop(id, this.operator(run), "deadline", "Total worker time reached").catch(this.ports.onError);
  }

  private append(run: ResearchRun, commandId: string, actor: ResearchActor, data: ResearchEventData, signature = JSON.stringify(data)): void {
    // Contribution limits cannot block receipts or cancellation settlement.
    if (run.revision >= RESEARCH_MAX_EVENTS && !["status", "worker", "delivery", "delivery_failed", "adopted"].includes(data.type)
      && !(data.type === "item_work" && ["cancel_requested", "cancelled"].includes(data.work.state))) throw new Error("Research event limit reached; finish this run before starting another");
    if (!this.storage.append(run.id, run.revision, { seq: run.revision + 1, commandId, signature, at: this.now(), actor, data })) return;
    this.publish(run.id);
    if (data.type !== "bounds" && run.turnMinutes === undefined && run.totalWorkerMinutes === undefined) return;
    if (data.type === "worker") this.armBounds(run.id, [data.approachId]);
    else if (data.type === "adopted" || data.type === "resumed") this.armBounds(run.id, data.approachIds);
    else if (data.type === "bounds" || data.type === "status") this.armBounds(run.id);
  }
  private publish(id: string): void { for (const thread of this.storage.members(id)) this.ports.changed(thread); }
  private requireOpen(): void {
    if (this.closed) throw new Error("Research service is closed");
    if (this.ports.enabled?.() === false) throw new Error("Research runs are disabled");
  }
  private canDispatch(run: ResearchRun): boolean { return !this.closed && this.ports.enabled?.() !== false && run.status === "running" && !researchDeadlinePassed(run, this.now()); }
  private canAdmitApproach(run: ResearchRun, approach: ResearchApproach): boolean {
    if (!this.canDispatch(run)) return false;
    const selected = this.storage.readItem(run.id, approach.id);
    if (!selected || ["completed", "cancel_requested", "cancelled"].includes(selected.work.state)) return false;
    const item = this.storage.readItem(run.id, approach.itemId ?? approach.id);
    if (!approach.itemId) return Boolean(item && !["completed", "cancel_requested", "cancelled"].includes(item.work.state));
    return item?.work.assignmentId === approach.id && !["open", "completed", "cancel_requested", "cancelled"].includes(item.work.state);
  }
  private turnEnded(run: ResearchRun, approachId: string, turnId: string): boolean {
    return run.events.some((event) => event.commandId === `ended:${approachId}:${turnId}` || event.commandId === `stopped:${approachId}:${turnId}`);
  }
  private requireRun(id: string): ResearchRun { const run = this.storage.get(id); if (!run) throw new Error("Research run not found"); return run; }
  private requireApproach(run: ResearchRun, id: string): ResearchApproach { const approach = run.approaches.find((a) => a.id === id); if (!approach) throw new Error("Research approach not found"); return approach; }
  private operator(run: ResearchRun): ResearchActor { return { ...run.coordinator, kind: "operator" }; }
  private requireMember(run: ResearchRun, actor: ResearchActor): void {
    if (sameResearchThread(actor, run.coordinator) || run.approaches.some((a) => a.worker && sameResearchThread(a.worker, actor))) return;
    throw new Error("The calling thread is not a member of this research run");
  }
}

function validateStartResearch(request: StartResearchRequest): void {
  boundedText(request.objective, "objective", 8000);
  if (!validResearchMinutes(request.minutes)) throw new Error("A research time limit is a whole number of minutes, at least 1. Leave it out for no limit.");
  if (!validResearchMinutes(request.turnMinutes)) throw new Error("A per-worker time limit is a whole number of minutes, at least 1. Leave it out for no limit.");
  if (!validResearchMinutes(request.totalWorkerMinutes)) throw new Error("A total worker time is a whole number of minutes, at least 1. Leave it out for no limit.");
  if (!["new_worktree", "none"].includes(request.workspaceMode)) throw new Error("Choose isolated worktrees or scratch workspaces");
  if (!Array.isArray(request.approaches) || request.approaches.length < 1 || request.approaches.length > RESEARCH_MAX_WORKERS) throw new Error(`Research needs 1–${RESEARCH_MAX_WORKERS} workers`);
  const titles = new Set<string>();
  for (const approach of request.approaches) {
    boundedText(approach.title, "approach title", 160);
    boundedText(approach.task, "approach task", 4000);
    const title = approach.title.trim().toLowerCase();
    if (titles.has(title)) throw new Error("Approaches need distinct titles; explain and separate overlapping directions before starting");
    titles.add(title);
  }
}

function boundedText(value: string, label: string, max: number): void {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} must contain 1–${max} characters`);
}
function validatePaths(paths: string[]): void {
  if (!Array.isArray(paths) || paths.length > 4 || paths.some((p) => typeof p !== "string" || p.length > 300 || !p || p.startsWith("/") || /^[a-z]:/i.test(p) || p.includes("\\") || p.split("/").some((s) => !s || s === "." || s === "..") || /[\u0000-\u001f]/.test(p))) throw new Error("Evidence paths must be up to four safe workspace-relative paths");
}
function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2000); }
function researchWorkerPrompt(id: string, objective: string, approach: ResearchApproach): string {
  return `Participate in research run ${id}, approach ${approach.id}: ${approach.title}.\nObjective: ${objective}\nAssignment: ${approach.task}\nUse research_read to inspect the shared board. Use research_update to post typed findings under approachId=${approach.id}, cite evidence paths relative to your workspace, and link other findings explicitly. Record counterexamples and dead ends. Submit a concise candidate with action=submit. Findings are proposals, not verified facts. The coordinator reviews submissions and may request revision. Do not start additional workers, change the objective, or claim formal verification. Stop when the run stops or its deadline is reached.`;
}
function researchResumePrompt(id: string, approach: ResearchApproach): string {
  return `PwrAgent was closed while you were working on research run ${id}, approach ${approach.id}: ${approach.title}. The run is still open and you are being asked to continue. Call research_read with runId=${id}${approach.itemId ? `, itemId=${approach.itemId}` : ""} to see what is already recorded, then carry on from where you stopped. Do not repeat findings you already posted. The run's worker limit, any time limit and cancellation still apply to you.`;
}
function researchItemWorkerPrompt(id: string, approach: ResearchApproach): string {
  return `Handle one research item. Run ID: ${id}. Item ID: ${approach.itemId}. Your approach/assignment ID: ${approach.id}.\nTask: ${approach.task}\nCall research_read with runId=${id}, itemId=${approach.itemId} to load this item's context and current version. Claim it using research_update action=work, itemId, expectedVersion, state=claimed and a reason. Update to in_progress, blocked or completed as appropriate, reading the latest version before each change. Post evidence or a candidate under approachId=${approach.id}; link the source finding when applicable. Use research_search only for additional evidence you need. Do not load the entire board or start other workers. A work item marked completed is not formally verified. The run's original deadline and cancellation apply to you.`;
}
