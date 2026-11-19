import { randomUUID } from "node:crypto";
import {
  RESEARCH_FINDING_KINDS, RESEARCH_MAX_EVENTS, RESEARCH_MAX_WORKERS, researchApproachResumable, researchDeadlinePassed, validResearchMinutes, RESEARCH_WORK_TRANSITIONS, sameResearchThread, researchApproachOccupiesSlot, researchTurnIsPlaceholder,
  type ResearchActor, type ResearchApproach, type ResearchCommand, type ResearchEventData, type ResearchDelivery,
  type ResearchRun, type ResearchSnapshot, type ResearchThread, type StartResearchRequest, type PrepareResearchRequest,
  type ResearchRunHeader, type ResearchItem, type ResearchItemContext, type ResearchSearchQuery, type ResearchSearchPage,
  type ResearchAssignRequest, type ResearchWorkCommand, type ResearchItemWork, type ResearchPendingRequest,
  type ResearchSnapshotRequest, type ResearchEventRange, type ResearchEventPage, type ResearchChange, type ResearchChanges,
  type ResearchChangesCursor, type ResearchBoardRange, type ResearchBoardPage,
  RESEARCH_PROFILE_RUNS_PAGE, type ResearchProfileRunsQuery, type ResearchProfileRunsPage, type ResearchProfileRun,
  RESEARCH_WORKER_TIME_REACHED, researchTurnElapsed, researchTurnLimitNote, researchWorkerTimeReachedAt, researchWorkerTimeUsed, type ResearchBoundsCommand,
} from "@pwragent/shared/research";
import { armResearchDeadline } from "./research-deadline";
import { RESEARCH_RUN_HELD_ELSEWHERE, researchRunNeedsAdoption, researchRunHeldBy, type ResearchOwnerIdentity } from "./research-ownership";

/** How many of a thread's runs the panel lists. Each run's items are read by delta. */
export const RESEARCH_SNAPSHOT_RUN_LIMIT = 50;

/** An operator request expires if the coordinator has not started it within five minutes. */
export const RESEARCH_REQUEST_TTL_MS = 5 * 60_000;
const MINUTE = 60_000;
import type { ResearchStorage } from "./research-storage";

export type ResearchExecutionContext = ResearchActor & { kind: "agent"; turnId: string; callId: string };
export type ResearchAssignmentReceipt = { runId: string; itemId: string; version: number; assignmentId: string; state: ResearchApproach["state"]; worker?: ResearchApproach["worker"] };
/** The adapter has confirmed that no model turn was admitted. */
export class ResearchAdmissionRefused extends Error {}
export type ResearchPorts = {
  stopHarness?: (id: string, actor: ResearchActor, outcome: "stopped" | "deadline" | "completed", reason: string) => Promise<ResearchRunHeader>;
  enabled?: () => boolean;
  spawn: (context: ResearchExecutionContext, task: string, title: string, workspaceMode: StartResearchRequest["workspaceMode"],
    onCreated: (worker: ResearchThread) => void) => Promise<ResearchThread & { turnId?: string }>;
  stop: (worker: NonNullable<ResearchApproach["worker"]>) => Promise<void>;
  notify: (context: ResearchActor, target: ResearchThread, text: string) => Promise<{ queueEntryId?: string; turnId?: string }>;
  cancelQueued: (queueEntryId: string) => Promise<{ turnId?: string }>;
  /** A run reached a revision, or (with no run) the thread's pending request changed. */
  changed: (change: ResearchChange) => void;
  ownerId: string;
  ownerPid: number;
  ownerStartedAt: number;
  isOwnerAlive: (owner: Pick<ResearchRun, "ownerId" | "ownerPid" | "ownerStartedAt">) => boolean;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => () => void;
  onError: (error: unknown) => void;
};

/**
 * Owns only structured research, never provider transcripts. Commands and
 * observers validate against the stored projections, the run header and the
 * items they touch, so their cost does not grow with the journal. Store
 * mutations are synchronous, compare-and-append commits before effects. Spawn intent is
 * durable before handing off; a thread is bound before its first model turn.
 * A lost response is never retried automatically. Foreign live owners are
 * read-only. A run outlives its process: the next one takes it over, records
 * which workers were cut off, and starts no work until asked to resume them.
 * Cancellation fences later admissions and stays stopping while a start or
 * cancellation is unresolved. Provider cancellation does not undo billing.
 */
export class ResearchService {
  private readonly starts = new Map<string, { signature: string; promise: Promise<ResearchRunHeader> }>();
  private readonly assignments = new Map<string, { signature: string; promise: Promise<ResearchAssignmentReceipt> }>();
  private readonly deadlines = new Map<string, () => void>();
  /** Run ID to the per-worker time limit timer of each running worker, by approach, with when it is due. */
  private readonly turnLimits = new Map<string, Map<string, { at: number; cancel: () => void }>>();
  /** Run ID to the timer for when its workers' time reaches the operator's total. */
  private readonly workerTimeLimits = new Map<string, { at: number; cancel: () => void }>();
  /** Run ID to the approaches whose start is unresolved. */
  private readonly pendingStarts = new Map<string, Set<string>>();
  /** Run ID to the revision deliveries whose send is unresolved, each with the queue events seen meanwhile. */
  private readonly pendingDeliveries = new Map<string, Map<string, Map<string, { status: string; turnId?: string }>>>();
  private readonly stops = new Map<string, Promise<ResearchRunHeader>>();
  /** Run ID to the resumed workers whose message waits in their thread's queue, by queue entry ID. */
  private readonly queuedResumes = new Map<string, Map<string, string>>();
  private readonly workerStops = new Map<string, Promise<void>>();
  private readonly intents = new Map<string, { id: string; request: PrepareResearchRequest; preparedAt: number; expiresAt: number }>();
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly storage: ResearchStorage, private readonly ports: ResearchPorts) {
    this.now = ports.now ?? Date.now;
  }

  initialize(): void {
    for (const run of this.storage.activeRuns()) {
      if (run.ownerId === this.ports.ownerId) { this.scheduleDeadline(run); this.armBounds(run.id); }
      else if (this.ports.isOwnerAlive(run)) continue;
      // A Harness run's bridge ended with its process, so the run did too. A native run did not: its
      // threads and board are intact, and this process holds it from here.
      else if (run.harness) this.append(run, `recovery:${this.ports.ownerId}`, this.operator(run), {
        type: "status", status: "interrupted", reason: "The owning process ended. Reconcile the retained Harness source records before starting a new run.",
      });
      else try { this.adopt(run); } catch (error) { this.ports.onError(error); }
    }
  }

  /**
   * Take over a live run whose process is gone, in one commit. Whatever was mid-flight ended with that
   * process: each such worker is recorded as cut off, and none is restarted here. A time limit kept
   * counting while nobody held the run.
   */
  private adopt(run: ResearchRunHeader): ResearchRunHeader {
    // A revision turn the gone process had started ended with it too, and its delivery would hold the worker's slot forever.
    const started = this.storage.deliveries(run.id, { open: true }).filter((delivery) => delivery.state === "started");
    const cutOff = this.storage.approaches(run.id, { occupying: true })
      .filter((approach) => !["ended", "stopped", "failed"].includes(approach.state) || started.some((delivery) => delivery.approachId === approach.id));
    this.append(run, `adopted:${this.ports.ownerId}:${run.revision}`, this.operator(run), { type: "adopted", ownerId: this.ports.ownerId, ownerPid: this.ports.ownerPid,
      ...(this.ports.ownerStartedAt !== undefined ? { ownerStartedAt: this.ports.ownerStartedAt } : {}), approachIds: cutOff.map((approach) => approach.id) });
    for (const delivery of started) {
      this.append(this.requireHeader(run.id), `adopted-delivery:${delivery.id}:${this.ports.ownerId}`, this.operator(run), { type: "delivery", delivery: { ...delivery, state: "ended" } });
    }
    // A cut-off turn counted until now. A worker already past its per-worker limit is stopped for it, not offered for resume.
    const limited = this.stopCutOffPastTurnLimit(run.id);
    const current = this.requireHeader(run.id);
    if (current.status === "running") {
      this.scheduleDeadline(current);
      if (limited) this.finishExploration(current);
    }
    else if (current.status === "stopping" && !this.stops.has(run.id)) {
      // The stop was under way when the process ended. Finish it.
      const stopping = this.performStop(run.id, this.operator(run));
      this.stops.set(run.id, stopping);
      void stopping.finally(() => { if (this.stops.get(run.id) === stopping) this.stops.delete(run.id); }).catch(this.ports.onError);
    }
    return current;
  }

  /**
   * Record each cut-off worker whose turn has reached the operator's per-worker limit as stopped for that reason.
   * Its clock does not run while it waits, so this is checked only when a turn is cut off or the limit changes.
   */
  private stopCutOffPastTurnLimit(id: string): boolean {
    let run = this.requireHeader(id);
    const minutes = run.turnMinutes;
    if (minutes === undefined || run.status !== "running") return false;
    let stopped = false;
    for (const approach of this.storage.approaches(id, { interrupted: true })) {
      if (researchTurnElapsed(approach, this.now()) < minutes * MINUTE) continue;
      this.append(run, `turn-limit:${approach.id}:${run.revision}`, this.operator(run), { type: "worker", approachId: approach.id, state: "stopped", note: researchTurnLimitNote(minutes) });
      run = this.requireHeader(id);
      stopped = true;
    }
    return stopped;
  }

  /** The run as this process may record on it, taking over an open run whose process is gone. */
  private hold(run: ResearchRunHeader): ResearchRunHeader {
    if (!researchRunHeldBy(run, this.ports.ownerId, this.ports.isOwnerAlive)) throw new Error(RESEARCH_RUN_HELD_ELSEWHERE);
    return researchRunNeedsAdoption(run, this.ports.ownerId) ? this.adopt(run) : run;
  }

  /**
   * The thread's run summaries, read in one statement. With `runId`, only
   * that run's summary: what a targeted change needs.
   */
  snapshot(request: ResearchSnapshotRequest): ResearchSnapshot {
    const thread = { backend: request.backend, threadId: request.threadId };
    const runs = this.storage.runSummaries(thread, RESEARCH_SNAPSHOT_RUN_LIMIT, request.runId);
    const pending = this.pendingRequest(thread);
    return { runs, writableRunIds: this.heldRunIds(runs), ...(pending ? { pending } : {}) };
  }

  /**
   * One page of every run on this profile, for the local operator's Research window. It names runs across
   * threads, so only the owning instance's own windows may ask. Each run's contents are still read as its
   * coordinating thread, through the member-checked reads below.
   */
  profileRuns(query: ResearchProfileRunsQuery): Omit<ResearchProfileRunsPage, "runs"> & { runs: Array<Omit<ResearchProfileRun, "thread">> } {
    const page = this.storage.profileRuns(query, RESEARCH_PROFILE_RUNS_PAGE + 1);
    const runs = page.runs.slice(0, RESEARCH_PROFILE_RUNS_PAGE);
    const last = runs.at(-1);
    return { runs, counts: page.counts, writableRunIds: this.heldRunIds(runs),
      ...(last && page.runs.length > RESEARCH_PROFILE_RUNS_PAGE ? { nextCursor: { attention: last.attention, createdAt: last.createdAt, id: last.id } } : {}) };
  }

  /** The runs this process may record on. Liveness is read once per distinct owner, not once per run. */
  private heldRunIds(runs: ReadonlyArray<Pick<ResearchRunHeader, "id" | "status" | "ownerId" | "ownerPid" | "ownerStartedAt">>): string[] {
    if (this.closed) return [];
    const alive = new Map<string, boolean>();
    const isOwnerAlive = (owner: ResearchOwnerIdentity) => {
      const key = `${owner.ownerId}\n${owner.ownerPid}\n${owner.ownerStartedAt ?? ""}`;
      if (!alive.has(key)) alive.set(key, this.ports.isOwnerAlive(owner));
      return alive.get(key)!;
    };
    return runs.filter((run) => researchRunHeldBy(run, this.ports.ownerId, isOwnerAlive)).map((run) => run.id);
  }

  /** The run's state and the items changed after `sinceRevision`. Members only; no writes. */
  changes(id: string, sinceRevision: number | undefined, after: ResearchChangesCursor | undefined, actor: ResearchActor): ResearchChanges {
    const header = this.accessibleHeader(id, actor);
    const page = this.storage.changes(id, sinceRevision, after);
    if (!page) throw new Error("Research run not found");
    return { ...page, writable: this.heldRunIds([header]).length > 0 };
  }

  /** One page of a run's journal, newest first. Members only; no writes. */
  readEvents(id: string, range: ResearchEventRange, actor: ResearchActor): ResearchEventPage {
    this.accessibleHeader(id, actor);
    return this.storage.events(id, range);
  }

  /** The thread's unexpired operator request. Memory only: a restart drops it, as the agent's start would also be refused. */
  private pendingRequest(thread: ResearchThread): ResearchPendingRequest | undefined {
    const intent = this.intents.get(JSON.stringify([thread.backend, thread.threadId]));
    if (this.closed || !intent || this.now() >= intent.expiresAt) return undefined;
    const { backend: _backend, threadId: _threadId, ...request } = intent.request;
    return { ...request, preparedAt: intent.preparedAt, expiresAt: intent.expiresAt };
  }

  /** Withdraw the thread's waiting request so a later research_start for it is refused. No writes. */
  withdraw(thread: ResearchThread): void {
    if (this.intents.delete(JSON.stringify([thread.backend, thread.threadId]))) this.ports.changed({ backend: thread.backend, threadId: thread.threadId });
  }
  summaries(thread: ResearchThread) {
    return this.storage.summaries(thread).map((run) => ({ id: run.id, objective: run.objective.slice(0, 200), status: run.status, deadlineAt: run.deadlineAt, workerLimit: run.workerLimit, activeWorkers: run.activeWorkers,
      ...(run.turnMinutes !== undefined ? { turnMinutes: run.turnMinutes } : {}), ...(run.totalWorkerMinutes !== undefined ? { totalWorkerMinutes: run.totalWorkerMinutes } : {}) }));
  }

  /** Replays the whole journal. For recovery and tests: no command, observer or view reads this way. */
  read(id: string, actor: ResearchActor): ResearchRun {
    const run = this.storage.get(id);
    if (!run) throw new Error("Research run not found");
    if (sameResearchThread(actor, run.coordinator) || run.approaches.some((a) => a.worker && sameResearchThread(a.worker, actor))) return run;
    throw new Error("The calling thread is not a member of this research run");
  }

  /** One page of approaches, findings and submissions, each in creation order, for the agent tools. */
  readBoard(id: string, range: ResearchBoardRange, actor: ResearchActor): ResearchBoardPage & { run: ResearchRunHeader } {
    const run = this.memberHeader(id, actor);
    const page = this.storage.board(id, range);
    if (!page) throw new Error("Research run not found");
    return { run, ...page };
  }

  /** The workspace-relative path of one piece of evidence, and the thread whose workspace holds it. */
  readEvidence(id: string, itemId: string, pathIndex: number, actor: ResearchActor): { relativePath: string; source: ResearchThread; harnessWorkspace?: string } {
    const run = this.memberHeader(id, actor);
    const item = this.storage.readItem(id, itemId);
    const relativePath = item && item.type !== "approach" ? item.record.paths[pathIndex] : undefined;
    // The author of evidence is whoever appended it, not a field its text can claim.
    const created = item ? this.storage.events(id, { afterSeq: item.createdSeq - 1, beforeSeq: item.createdSeq + 1, limit: 1 }).events[0] : undefined;
    if (!relativePath || !created) throw new Error("Evidence source is unavailable");
    return { relativePath, source: { backend: created.actor.backend, threadId: created.actor.threadId },
      ...(created.provenance && run.harness ? { harnessWorkspace: run.harness.workspace } : {}) };
  }

  /** What a command changed, for a compact receipt: the item it created or named, and its revision delivery. */
  receipt(id: string, commandId: string, command: ResearchCommand): { item?: ResearchItem; delivery?: ResearchDelivery } {
    const event = this.storage.findCommand(id, commandId);
    const itemId = event?.data.type === "finding" ? event.data.finding.id : event?.data.type === "submission" ? event.data.submission.id
      : command.action === "review" ? command.submissionId : "approachId" in command ? command.approachId : undefined;
    const item = itemId ? this.storage.readItem(id, itemId) : undefined;
    const delivery = command.action === "review" && command.decision === "revision_requested" ? this.revisionDelivery(id, commandId) : undefined;
    return { ...(item ? { item } : {}), ...(delivery ? { delivery } : {}) };
  }

  /** The latest receipt of the delivery a revision request made, by that request's command ID. */
  revisionDelivery(id: string, commandId: string): ResearchDelivery | undefined {
    return this.storage.delivery(id, `feedback:${commandId}`);
  }

  /** The header for a thread the run's coordinator or an approach's current worker. */
  private memberHeader(id: string, actor: ResearchActor): ResearchRunHeader {
    const header = this.requireHeader(id);
    if (sameResearchThread(actor, header.coordinator) || this.storage.isApproachWorker(id, actor)) return header;
    throw new Error("The calling thread is not a member of this research run");
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
    const member = this.memberHeader(request.runId, context);
    if (member.harness) throw new Error("Harness member admission belongs to the configured bridge");
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
    this.requireReleasedAssignment(run.id, item);
    if (!["open", "blocked"].includes(item.work.state) || item.work.assignee) throw new Error("Release or reopen the item before assigning it");
    if (run.activeWorkers >= run.workerLimit) throw new Error("Research worker limit reached; wait for or cancel an existing worker");
    if (run.status === "exhausted") {
      this.append(run, `reopen:${key}`, context, { type: "status", status: "running", reason: "The coordinator explicitly assigned retained evidence within the original deadline." });
      this.scheduleDeadline(this.requireHeader(run.id));
    }
    const title = `Investigate: ${item.type === "approach" ? item.record.title : item.record.text}`.slice(0, 160);
    const approach: ResearchApproach = { id: `work-${randomUUID()}`, title, task: request.task, state: "pending", itemId: item.id };
    this.append(this.requireHeader(run.id), key, context, { type: "assignment", itemId: item.id, approach, task: request.task }, signature);
    await this.admitApproach(run.id, approach, context);
    const settled = this.requireHeader(run.id);
    if (settled.status === "stopping") this.finishStopping(settled);
    else this.finishExploration(settled);
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
    const accessible = this.accessibleHeader(id, actor);
    if (accessible.harness) throw new Error("Harness observations do not support native worker assignments");
    const header = this.hold(accessible);
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
    if (command.state === "open") this.requireReleasedAssignment(id, item);
    const cancellation = command.state === "cancelled" ? item.work.assignmentId ?? (item.type === "approach" ? item.id : undefined) : undefined;
    const work: ResearchItemWork = command.state === "open" ? { state: "open", note: command.reason }
      : { ...item.work, state: cancellation ? "cancel_requested" : command.state, note: command.reason,
        ...(cancellation ? { assignmentId: cancellation, assignee: assigned ?? originalWorker } : {}),
        ...(command.state === "claimed" ? { assignee: assigned ?? { backend: actor.backend, threadId: actor.threadId } } : {}) };
    if (header.revision >= RESEARCH_MAX_EVENTS && command.state !== "cancelled") throw new Error("Research event limit reached; finish this run before starting another");
    if (this.storage.append(id, header.revision, { seq: header.revision + 1, commandId: requestId, signature, at: this.now(), actor, data: { type: "item_work", itemId: item.id, work } })) this.publish(id, header.revision + 1);
    if (cancellation) {
      for (const delivery of this.storage.deliveries(id, { open: true })) {
        if (delivery.approachId === cancellation) await this.cancelDelivery(id, delivery, actor);
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

  private requireReleasedAssignment(id: string, item: ResearchItem): void {
    const assignment = item.work.assignmentId ? this.approach(id, item.work.assignmentId) : undefined;
    if (assignment && researchApproachOccupiesSlot(assignment)) throw new Error("The prior assignment is still active or unresolved; cancel it before reassigning");
  }

  private settleItemCancellation(id: string, assignmentId: string): void {
    const assignment = this.approach(id, assignmentId);
    if (!assignment || researchApproachOccupiesSlot(assignment)) return;
    for (const itemId of new Set([assignment.id, assignment.itemId].filter((value): value is string => Boolean(value)))) {
      const item = this.storage.readItem(id, itemId);
      if (item?.work.assignmentId !== assignmentId || item.work.state !== "cancel_requested") continue;
      const run = this.requireHeader(id);
      this.append(run, `item-cancelled:${assignmentId}:${item.id}:${item.version}`, this.operator(run), { type: "item_work", itemId: item.id, work: { ...item.work, state: "cancelled" } });
    }
  }

  isWorker(thread: ResearchThread): boolean {
    return this.storage.isActiveWorker(thread);
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

  start(request: StartResearchRequest, context: ResearchExecutionContext): Promise<ResearchRunHeader> {
    const key = JSON.stringify([context.backend, context.threadId, context.turnId, context.callId]);
    const pending = this.starts.get(key);
    const signature = JSON.stringify(request);
    if (pending) return pending.signature === signature ? pending.promise : Promise.reject(new Error("Research start key was reused with different arguments"));
    const existing = this.storage.runIdForStartKey(key);
    if (existing) {
      if (this.storage.events(existing, { beforeSeq: 2, limit: 1 }).events[0]?.signature !== signature) return Promise.reject(new Error("Research start key was reused with different arguments"));
      return Promise.resolve(this.requireHeader(existing));
    }
    const promise = this.performStart(request, context, key);
    this.starts.set(key, { signature, promise });
    void promise.finally(() => this.starts.delete(key)).catch(() => {});
    return promise;
  }

  private async performStart(request: StartResearchRequest, context: ResearchExecutionContext, key: string): Promise<ResearchRunHeader> {
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
    this.ports.changed({ backend: context.backend, threadId: context.threadId, runId: id, revision: 1 });
    this.scheduleDeadline(this.requireHeader(id));
    for (const approach of approaches) {
      if (!this.canDispatch(this.requireHeader(id))) break;
      await this.admitApproach(id, approach, context);
    }
    const current = this.requireHeader(id);
    if (current.status === "stopping") this.finishStopping(current);
    else if (current.status === "running" && researchDeadlinePassed(current, this.now())) await this.stop(id, context, "deadline", "Research deadline reached");
    else this.finishExploration(current);
    return this.requireHeader(id);
  }

  private async admitApproach(id: string, approach: ResearchApproach, context: ResearchExecutionContext): Promise<void> {
    const run = this.requireHeader(id);
    // An approach not yet started holds its slot only within the worker count: a lowered count starts no new worker.
    const overCount = run.activeWorkers > run.workerLimit;
    if (overCount || !this.canAdmitApproach(run, approach)) {
      this.append(run, `unadmitted:${approach.id}`, context, { type: "worker", approachId: approach.id, state: "stopped",
        ...(overCount && this.canAdmitApproach(run, approach) ? { note: "Not started: the run already had as many workers as its worker count." } : {}) });
      this.settleItemCancellation(id, approach.id);
      return;
    }
    const starting = this.pendingStarts.get(id) ?? new Set<string>();
    this.pendingStarts.set(id, starting.add(approach.id));
    this.append(this.requireHeader(id), `starting:${approach.id}`, context, { type: "worker", approachId: approach.id, state: "starting" });
    try {
      const worker = await this.ports.spawn({ ...context, callId: `${context.callId}:${approach.id}` },
        approach.itemId ? researchItemWorkerPrompt(id, approach) : researchWorkerPrompt(id, run.objective, approach), approach.title, run.workspaceMode,
        (created) => {
          this.append(this.requireHeader(id), `bound:${approach.id}`, context, { type: "worker", approachId: approach.id, state: "starting", worker: created });
          if (!this.canAdmitApproach(this.requireHeader(id), approach)) throw new ResearchAdmissionRefused("Research assignment stopped before worker admission");
        });
      const current = this.requireHeader(id);
      const prior = this.requireApproach(id, approach.id);
      // A trusted provider event can precede the handoff reply. It already
      // owns this transition; do not rewrite it or regress its outcome.
      if (!prior.worker?.turnId || (prior.state === "starting" && prior.worker.turnId === worker.turnId)) {
        this.append(current, `started:${approach.id}`, context, { type: "worker", approachId: approach.id, worker,
          state: ["ended", "stopped", "failed"].includes(prior.state) ? prior.state : worker.turnId ? "running" : "unknown" });
      }
      const admitted = this.requireApproach(id, approach.id);
      if (!this.canAdmitApproach(this.requireHeader(id), approach) && !["ended", "stopped", "failed"].includes(admitted.state)) await this.stopWorker(id, approach.id, context);
    } catch (error) {
      const current = this.requireHeader(id);
      const observed = this.requireApproach(id, approach.id);
      const state = observed.worker?.turnId && ["running", "ended", "stopped", "failed"].includes(observed.state)
        ? observed.state : error instanceof ResearchAdmissionRefused ? "failed" : "unknown";
      this.append(current, `start-failed:${approach.id}`, context, { type: "worker", approachId: approach.id, state, note: message(error) });
      if (!this.canAdmitApproach(this.requireHeader(id), approach) && state === "running") await this.stopWorker(id, approach.id, context);
    } finally {
      starting.delete(approach.id);
      if (!starting.size && this.pendingStarts.get(id) === starting) this.pendingStarts.delete(id);
      this.settleItemCancellation(id, approach.id);
    }
  }

  async update(id: string, requestId: string, command: ResearchCommand, actor: ResearchActor): Promise<ResearchRunHeader> {
    this.requireOpen();
    if (command?.action === "work") { await this.work(id, requestId, command, actor); return this.requireHeader(id); }
    if (!command || !["finding", "submit", "review", "abandon", "direction", "stop", "finish", "resume", "bounds"].includes(command.action)) throw new Error("Unknown research command");
    boundedText(requestId, "requestId", 300);
    const member = this.memberHeader(id, actor);
    if (member.harness && !["review", "stop", "finish"].includes(command.action)) throw new Error("Harness records are immutable source observations");
    if (member.harness && command.action === "review" && command.decision === "revision_requested") throw new Error("Bridge revision delivery is unavailable; record rejection or acceptance locally");
    const run = this.hold(member);
    const signature = JSON.stringify(command);
    const duplicate = this.storage.findCommand(id, requestId);
    if (duplicate) {
      if (duplicate.signature !== signature || !sameResearchThread(duplicate.actor, actor) || duplicate.actor.kind !== actor.kind) throw new Error("Research command key was reused");
      return run;
    }
    if (command.action === "bounds") {
      // A run's bounds are the operator's. The coordinator proposes work within them and cannot change them.
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
      if (command.action === "finish" && !this.storage.hasSubmission(id, "accepted")) throw new Error("Accept a submission before completing the run");
      return await this.stop(id, actor, command.action === "finish" ? "completed" : "stopped", command.reason, requestId, signature);
    }
    if (command.action !== "review" && !this.canDispatch(run)) throw new Error("Research run is no longer accepting work");
    let data: ResearchEventData;
    /** The approach a revision request returns to. */
    let revisionApproachId: string | undefined;
    if (command.action === "finding" || command.action === "submit") {
      const approach = this.requireApproach(id, command.approachId);
      if (!coordinator && (!approach.worker || !sameResearchThread(actor, approach.worker))) throw new Error("A worker may post only under its assigned approach");
      if (approach.directionState === "abandoned") throw new Error("Revise the abandoned direction before posting more work");
      boundedText(command.text, "text", 4000);
      validatePaths(command.paths);
      if (command.action === "finding") {
        if (!RESEARCH_FINDING_KINDS.includes(command.kind)) throw new Error("Unknown finding kind");
        if (Boolean(command.relatesTo) !== Boolean(command.relation)) throw new Error("A relationship needs both relation and relatesTo");
        if (command.relatesTo && (this.storage.readItem(id, command.relatesTo)?.type !== "finding" || !["supports", "contradicts", "supersedes"].includes(command.relation ?? ""))) throw new Error("Unknown finding relationship");
        data = { type: "finding", finding: { id: randomUUID(), author: { backend: actor.backend, threadId: actor.threadId }, approachId: command.approachId, kind: command.kind,
          text: command.text, paths: [...command.paths], ...(command.relatesTo ? { relatesTo: command.relatesTo, relation: command.relation } : {}) } };
      } else data = { type: "submission", submission: { id: randomUUID(), author: { backend: actor.backend, threadId: actor.threadId }, approachId: command.approachId, text: command.text, paths: command.paths } };
    } else if (command.action === "review") {
      const submission = this.storage.readItem(id, command.submissionId);
      if (submission?.type !== "submission") throw new Error("Unknown submission");
      if (!["accepted", "revision_requested", "rejected"].includes(command.decision)) throw new Error("Unknown review decision");
      if (command.decision === "revision_requested" && !this.canDispatch(run)) throw new Error("The run is no longer accepting revisions");
      if (command.decision === "revision_requested") {
        const approach = this.requireApproach(id, submission.record.approachId);
        if (!approach.worker) throw new Error("Revision worker is unavailable");
        if (approach.revisionDeliveryIds?.length) throw new Error("A revision is already pending for this worker");
        if (!researchApproachOccupiesSlot(approach) && run.activeWorkers >= run.workerLimit) throw new Error("Research worker limit reached; wait for or cancel an existing worker");
        if (!this.canAdmitApproach(run, approach)) throw new Error("The research assignment is no longer accepting revisions");
        revisionApproachId = approach.id;
      }
      boundedText(command.reason, "reason", 2000);
      data = { type: "review", submissionId: command.submissionId, decision: command.decision, reason: command.reason };
    } else if (command.action === "direction") {
      const approach = this.requireApproach(id, command.approachId);
      if (!coordinator && (!approach.worker || !sameResearchThread(actor, approach.worker))) throw new Error("A worker may revise only its own direction");
      boundedText(command.title, "title", 160);
      boundedText(command.task, "task", 4000);
      boundedText(command.reason, "reason", 2000);
      if (command.overlapsApproachId) {
        this.requireApproach(id, command.overlapsApproachId);
        if (command.overlapsApproachId === approach.id) throw new Error("A direction cannot overlap itself");
      }
      data = { type: "direction", approachId: command.approachId, title: command.title, task: command.task, reason: command.reason, overlapsApproachId: command.overlapsApproachId };
    } else {
      const approach = this.requireApproach(id, command.approachId);
      if (!coordinator && (!approach.worker || !sameResearchThread(actor, approach.worker))) throw new Error("A worker may abandon only its own approach");
      boundedText(command.reason, "reason", 2000);
      data = { type: "abandoned", approachId: command.approachId, reason: command.reason };
    }
    this.append(run, requestId, actor, data, signature);
    if ((actor.kind === "agent" && actor.turnId && actor.callId && command.action === "submit") || revisionApproachId) {
      const approachId = revisionApproachId;
      const target = approachId ? this.requireApproach(id, approachId).worker : run.coordinator;
      if (target && !sameResearchThread(actor, target)) {
        const deliveryId = `feedback:${requestId}`;
        if (approachId) {
          const sending = this.pendingDeliveries.get(id) ?? new Map<string, Map<string, { status: string; turnId?: string }>>();
          this.pendingDeliveries.set(id, sending.set(deliveryId, new Map()));
          this.append(this.requireHeader(id), `pending:${deliveryId}`, actor, { type: "delivery", delivery: { id: deliveryId, target, approachId, state: "pending" } });
        }
        try {
          const receipt = await this.ports.notify(actor, target,
            `Research run ${id}: ${command.action === "submit" ? "A candidate is ready for review" : "Revision requested"}. Read research_read with runId=${id}. ${command.action === "review" ? command.reason : "Review the submission and its evidence; acceptance is not formal verification."}`);
          if (approachId) {
            const terminal = receipt.turnId && this.turnEnded(id, approachId, receipt.turnId);
            const delivery: ResearchDelivery = { id: deliveryId, target, approachId, ...receipt,
              state: terminal ? this.requireHeader(id).status === "stopping" ? "cancelled" : "ended" : receipt.queueEntryId ? "queued" : receipt.turnId ? "started" : "unknown" };
            this.append(this.requireHeader(id), `receipt:${deliveryId}`, actor, { type: "delivery", delivery });
            const queuedEvent = receipt.queueEntryId ? this.pendingDeliveries.get(id)?.get(deliveryId)?.get(receipt.queueEntryId) : undefined;
            if (receipt.queueEntryId && queuedEvent) await this.observeQueue(target, receipt.queueEntryId, queuedEvent.status, queuedEvent.turnId);
            const known = this.storage.delivery(id, deliveryId)!;
            if (!["cancelled", "ended"].includes(known.state) && !this.canAdmitApproach(this.requireHeader(id), this.requireApproach(id, approachId))) await this.cancelDelivery(id, known, actor);
          }
        } catch (error) {
          this.append(this.requireHeader(id), `delivery:${requestId}`, actor, { type: "delivery_failed", reason: message(error) });
          if (approachId) this.append(this.requireHeader(id), `unknown:${deliveryId}`, actor, { type: "delivery", delivery: { id: deliveryId, target, approachId, state: "unknown" } });
        } finally {
          const sending = this.pendingDeliveries.get(id);
          sending?.delete(deliveryId);
          if (sending && !sending.size) this.pendingDeliveries.delete(id);
          if (approachId) this.settleItemCancellation(id, approachId);
          this.finishStopping(this.requireHeader(id));
        }
      }
    }
    return this.requireHeader(id);
  }

  /**
   * The operator's new bounds for a running run, in one journal event. A lowered worker count stops nobody;
   * a time limit counts from the run's start. A time limit or total already passed is refused: Stop ends a run.
   */
  private changeBounds(run: ResearchRunHeader, requestId: string, signature: string, command: ResearchBoundsCommand, actor: ResearchActor): ResearchRunHeader {
    if (!this.canDispatch(run)) throw new Error("Only a running run's bounds can be changed");
    if (command.workers === undefined && command.minutes === undefined && command.turnMinutes === undefined && command.totalWorkerMinutes === undefined) throw new Error("Choose a bound to change");
    if (command.workers !== undefined && (!Number.isInteger(command.workers) || command.workers < 1 || command.workers > RESEARCH_MAX_WORKERS)) throw new Error(`Choose 1–${RESEARCH_MAX_WORKERS} workers`);
    for (const value of [command.minutes, command.turnMinutes, command.totalWorkerMinutes]) {
      if (value !== null && !validResearchMinutes(value)) throw new Error("A research limit is a whole number of minutes, at least 1. Choose No limit to remove it.");
    }
    const now = this.now();
    const choose = (value: number | null | undefined, current: number | undefined) => value === undefined ? current : value ?? undefined;
    const deadlineAt = command.minutes === undefined ? run.deadlineAt : command.minutes === null ? undefined : run.createdAt + command.minutes * MINUTE;
    const turnMinutes = choose(command.turnMinutes, run.turnMinutes);
    const totalWorkerMinutes = choose(command.totalWorkerMinutes, run.totalWorkerMinutes);
    const workerLimit = command.workers ?? run.workerLimit;
    if (deadlineAt !== undefined && deadlineAt !== run.deadlineAt && now >= deadlineAt) throw new Error(`That time limit has already passed: the run started ${minutesText(now - run.createdAt)} ago. Choose a longer limit, or stop the run.`);
    if (totalWorkerMinutes !== undefined && totalWorkerMinutes !== run.totalWorkerMinutes) {
      const used = researchWorkerTimeUsed(this.storage.workerTime(run.id), now);
      if (used >= totalWorkerMinutes * MINUTE) throw new Error(`Workers have already used ${minutesText(used)}. Choose a larger total worker time, or stop the run.`);
    }
    if (workerLimit === run.workerLimit && deadlineAt === run.deadlineAt && turnMinutes === run.turnMinutes && totalWorkerMinutes === run.totalWorkerMinutes) return run;
    this.append(run, requestId, actor, { type: "bounds", workerLimit, ...(deadlineAt !== undefined ? { deadlineAt } : {}),
      ...(turnMinutes !== undefined ? { turnMinutes } : {}), ...(totalWorkerMinutes !== undefined ? { totalWorkerMinutes } : {}) }, signature);
    if (deadlineAt !== run.deadlineAt) {
      this.deadlines.get(run.id)?.();
      this.deadlines.delete(run.id);
      this.scheduleDeadline(this.requireHeader(run.id));
    }
    if (turnMinutes !== run.turnMinutes && this.stopCutOffPastTurnLimit(run.id)) this.finishExploration(this.requireHeader(run.id));
    return this.requireHeader(run.id);
  }

  async stop(id: string, actor: ResearchActor, outcome: "stopped" | "deadline" | "completed", reason: string, requestId: string = randomUUID(), signature: string = outcome): Promise<ResearchRunHeader> {
    const member = this.memberHeader(id, actor);
    if (member.harness) {
      if (!this.ports.stopHarness) throw new Error("Harness cancellation is unavailable");
      return await this.ports.stopHarness(id, actor, outcome, reason);
    }
    if (actor.kind !== "operator" && !sameResearchThread(actor, member.coordinator)) throw new Error("Only the coordinator or operator may stop a run");
    const run = this.hold(member);
    const pending = this.stops.get(id);
    if (pending) return pending;
    if (!["running", "stopping"].includes(run.status)) {
      // A run that ended without being finished, as every live run does when PwrAgent quits, can still be
      // completed once a candidate is accepted. Nothing is running, so this records the outcome and stops nothing.
      if (outcome === "completed" && ["interrupted", "exhausted"].includes(run.status)) {
        if (!this.storage.hasSubmission(id, "accepted")) throw new Error("Accept a submission before completing the run");
        this.append(run, requestId, actor, { type: "status", status: "completed", reason }, signature);
        return this.requireHeader(id);
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

  private async performStop(id: string, actor: ResearchActor): Promise<ResearchRunHeader> {
    const run = this.requireHeader(id);
    const underway = this.storage.underwayItems(id);
    const deliveries = this.storage.deliveries(id, { open: true });
    for (const item of underway) {
      if (item.work.assignmentId) this.append(this.requireHeader(id), `cancel-item:${item.id}:${run.revision}`, actor, { type: "item_work", itemId: item.id, work: { ...item.work, state: "cancel_requested", note: "Research run stopped" } });
    }
    for (const delivery of deliveries) {
      if (["queued", "started"].includes(delivery.state)) await this.cancelDelivery(id, delivery, actor);
    }
    for (const approachId of [...this.queuedResumes.get(id)?.keys() ?? []]) await this.withdrawResume(id, approachId, actor);
    // An approach that holds no slot has ended, stopped or failed with no revision pending. A start or
    // resume still in flight checks the run itself once it settles; its worker's recorded turn may be stale.
    for (const approach of this.storage.approaches(id, { occupying: true })) {
      if (this.pendingStarts.get(id)?.has(approach.id)) continue;
      if (approach.worker && !["ended", "stopped", "failed"].includes(approach.state)) await this.stopWorker(id, approach.id, actor);
      else if (approach.state === "pending") this.append(this.requireHeader(id), `unstarted:${approach.id}`, actor, { type: "worker", approachId: approach.id, state: "stopped" });
    }
    this.finishStopping(this.requireHeader(id));
    return this.requireHeader(id);
  }

  private async cancelDelivery(id: string, delivery: ResearchDelivery, actor: ResearchActor): Promise<void> {
    const settled = () => ["cancelled", "ended"].includes(this.storage.delivery(id, delivery.id)?.state ?? "");
    if (settled()) return;
    let known = delivery;
    try {
      if (!delivery.queueEntryId && !delivery.turnId) throw new Error("Revision delivery has no confirmed receipt");
      const receipt = delivery.queueEntryId ? await this.ports.cancelQueued(delivery.queueEntryId) : { turnId: delivery.turnId };
      if (receipt.turnId) {
        known = { ...delivery, turnId: receipt.turnId };
        if (delivery.turnId !== receipt.turnId) this.append(this.requireHeader(id), `admitted:${delivery.id}`, actor, { type: "delivery", delivery: { ...known, state: "started" } });
        const approach = this.storage.approaches(id, { worker: delivery.target })[0];
        if (!approach) throw new Error("Revision worker is unavailable");
        const ended = this.turnEnded(id, approach.id, receipt.turnId);
        if (!ended && (approach.worker?.turnId !== receipt.turnId || !["ended", "stopped", "failed"].includes(approach.state))) {
          await this.ports.stop({ ...delivery.target, turnId: receipt.turnId });
          const current = this.requireHeader(id);
          if (this.requireApproach(id, approach.id).worker?.turnId === receipt.turnId) this.append(current, `revision-stopped:${delivery.id}:${receipt.turnId}`, actor, { type: "worker", approachId: approach.id, state: "stopped" });
        }
      }
      if (settled()) return;
      this.append(this.requireHeader(id), `cancelled:${delivery.id}`, actor, { type: "delivery", delivery: { ...known, state: "cancelled" } });
      if (known.approachId) this.settleItemCancellation(id, known.approachId);
    } catch (error) {
      if (settled()) return;
      const unknown = this.requireHeader(id);
      this.append(unknown, `cancel-unknown:${delivery.id}:${unknown.revision}`, actor, { type: "delivery", delivery: { ...known, state: "unknown" } });
      const failed = this.requireHeader(id);
      this.append(failed, `cancel-error:${delivery.id}:${failed.revision}`, actor, { type: "delivery_failed", reason: message(error) });
    }
  }

  private async stopWorker(id: string, approachId: string, actor: ResearchActor, note?: string): Promise<void> {
    const approach = this.requireApproach(id, approachId);
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
      const before = this.requireApproach(id, approachId);
      if (before.worker?.turnId !== worker.turnId || ["ended", "stopped", "failed"].includes(before.state)) return;
      await this.ports.stop(worker);
      const current = this.requireHeader(id);
      if (this.requireApproach(id, approachId).worker?.turnId !== worker.turnId) return;
      this.append(current, `stopped:${approachId}:${worker.turnId}`, actor, { type: "worker", approachId, state: "stopped", ...(note ? { note } : {}) });
      this.settleItemCancellation(id, approachId);
    } catch (error) {
      const current = this.requireHeader(id);
      const latest = this.requireApproach(id, approachId);
      if (latest.worker?.turnId !== worker.turnId || ["ended", "stopped", "failed"].includes(latest.state)) return;
      this.append(current, `stop-error:${approachId}:${current.revision}`, actor, { type: "worker", approachId, state: "unknown", note: message(error) });
    }
  }

  /** Only the exact recorded worker turn can retire an assignment. No token events write. */
  async observeQueue(thread: ResearchThread, queueEntryId: string, status: string, turnId?: string): Promise<void> {
    if (this.closed || (turnId !== undefined && researchTurnIsPlaceholder(thread, turnId)) || !["started", "terminal", "cancelled", "failed", "blocked"].includes(status)) return;
    for (const run of this.storage.activeRuns(thread)) {
      if (run.ownerId !== this.ports.ownerId) continue;
      const resumed = [...this.queuedResumes.get(run.id) ?? []].find(([, entry]) => entry === queueEntryId)?.[0];
      if (resumed !== undefined) {
        // A started turn is recorded by observeStart. A message that will never start leaves the worker cut off, to resume again.
        if (["cancelled", "failed", "blocked"].includes(status)) {
          this.forgetQueuedResume(run.id, resumed);
          if (this.requireApproach(run.id, resumed).state === "starting") this.append(run, `resume-withdrawn:${resumed}:${queueEntryId}`, this.operator(run),
            { type: "worker", approachId: resumed, state: "stopped", interrupted: true, note: "The resume message did not start. Resume the worker again to continue." });
          this.finishStopping(this.requireHeader(run.id));
        }
        continue;
      }
      const delivery = this.storage.deliveries(run.id, { queueEntryId }).find((d) => sameResearchThread(d.target, thread));
      if (!delivery) {
        // The queue may admit and finish before notify returns its queue ID.
        // Buffer only while a research send is unresolved, then match its exact receipt.
        for (const [pendingId, events] of this.pendingDeliveries.get(run.id) ?? []) {
          const pending = this.storage.delivery(run.id, pendingId);
          if (!pending || !sameResearchThread(pending.target, thread)) continue;
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
        const ended = status === "terminal" || (delivery.approachId && this.turnEnded(run.id, delivery.approachId, turnId));
        state = ended ? run.status === "stopping" ? "cancelled" : "ended" : "started";
      } else state = "unknown";
      if (delivery.state === state && (!turnId || delivery.turnId === turnId)) continue;
      const known = { ...delivery, state, ...(turnId ? { turnId } : {}) };
      this.append(run, `queue:${delivery.id}:${run.revision}`, this.operator(run), { type: "delivery", delivery: known });
      if (known.approachId) {
        const current = this.requireHeader(run.id);
        if (!["cancelled", "ended", "unknown"].includes(state) && !this.canAdmitApproach(current, this.requireApproach(run.id, known.approachId))) await this.cancelDelivery(run.id, known, this.operator(current));
        this.settleItemCancellation(run.id, known.approachId);
      }
      this.finishStopping(this.requireHeader(run.id));
    }
  }

  observeStart(thread: ResearchThread, turnId: string): Promise<void> {
    // Registry placeholders describe local submission, not provider admission.
    if (this.closed || researchTurnIsPlaceholder(thread, turnId)) return Promise.resolve();
    const cancellations: Promise<void>[] = [];
    for (const run of this.storage.activeRuns(thread)) {
      if (run.ownerId !== this.ports.ownerId) continue;
      const approach = this.storage.approaches(run.id, { worker: thread })[0];
      if (!approach || approach.worker?.turnId === turnId) continue;
      // A worker that held no slot takes one now. It may only below the worker count; one already holding a slot keeps it.
      const newcomer = !researchApproachOccupiesSlot(approach);
      this.append(run, `observed-start:${approach.id}:${turnId}`, this.operator(run), {
        type: "worker", approachId: approach.id, state: "running", worker: { ...thread, turnId },
      });
      this.forgetQueuedResume(run.id, approach.id);
      const current = this.requireHeader(run.id);
      if ((newcomer && current.activeWorkers > current.workerLimit) || !this.canAdmitApproach(current, approach)) cancellations.push(this.stopWorker(run.id, approach.id, this.operator(run)).then(() => {
        if (!this.closed) this.finishStopping(this.requireHeader(run.id));
      }));
    }
    return Promise.all(cancellations).then(() => undefined);
  }

  observeEnd(thread: ResearchThread, turnId: string, outcome: { failed?: boolean; note?: string } = {}): void {
    if (this.closed || researchTurnIsPlaceholder(thread, turnId)) return;
    for (const run of this.storage.activeRuns(thread)) {
      if (run.ownerId !== this.ports.ownerId) continue;
      // The header just read stays current until this observation appends.
      let current = run;
      for (const delivery of this.storage.deliveries(run.id, { open: true })) {
        if (delivery.turnId === turnId && sameResearchThread(delivery.target, thread)) {
          this.append(this.requireHeader(run.id), `terminal-delivery:${delivery.id}:${turnId}`, this.operator(run), { type: "delivery", delivery: { ...delivery, state: run.status === "stopping" ? "cancelled" : "ended" } });
          if (delivery.approachId) this.settleItemCancellation(run.id, delivery.approachId);
          current = this.requireHeader(run.id);
        }
      }
      const approach = this.storage.approaches(run.id, { worker: thread }).find((a) => a.worker?.turnId === turnId);
      if (!approach || ["ended", "stopped", "failed"].includes(approach.state)) {
        if (current.status === "stopping") this.finishStopping(current);
        continue;
      }
      this.append(current, `ended:${approach.id}:${turnId}`, this.operator(run), { type: "worker", approachId: approach.id,
        state: outcome.failed ? "failed" : "ended", ...(outcome.note ? { note: outcome.note.slice(0, 2000) } : {}) });
      this.settleItemCancellation(run.id, approach.id);
      if (run.status === "stopping") this.finishStopping(this.requireHeader(run.id));
      else this.finishExploration(this.requireHeader(run.id));
    }
  }

  close(): void {
    this.closed = true;
    this.intents.clear();
    this.queuedResumes.clear();
    for (const sending of this.pendingDeliveries.values()) for (const events of sending.values()) events.clear();
    for (const cancel of this.deadlines.values()) cancel();
    this.deadlines.clear();
    for (const timers of this.turnLimits.values()) for (const timer of timers.values()) timer.cancel();
    this.turnLimits.clear();
    for (const timer of this.workerTimeLimits.values()) timer.cancel();
    this.workerTimeLimits.clear();
    for (const run of this.storage.activeRuns()) {
      // Quitting ends a Harness run with its bridge. A native run stays open for the next launch to take over.
      if (run.ownerId === this.ports.ownerId && run.harness) this.append(run, `shutdown:${this.ports.ownerId}`, this.operator(run), {
        type: "status", status: "interrupted", reason: "PwrAgent closed. Research evidence is retained; execution was not automatically resumed.",
      });
    }
  }

  /**
   * Message cut-off workers to continue, each in its own thread with its history. The request is one
   * commit that gives each its slot back; a worker is running again once its turn is seen to start.
   * Only an operator or coordinator command reaches here, so no work restarts by itself.
   */
  private async resume(held: ResearchRunHeader, requestId: string, signature: string, approachIds: string[] | undefined, actor: ResearchActor): Promise<ResearchRunHeader> {
    const id = held.id;
    if (!this.canDispatch(held)) throw new Error("Research run is no longer accepting work");
    if (approachIds !== undefined && (!Array.isArray(approachIds) || !approachIds.length || approachIds.length > RESEARCH_MAX_WORKERS || approachIds.some((value) => typeof value !== "string")
      || new Set(approachIds).size !== approachIds.length)) throw new Error("Name each worker to resume once");
    const cutOff = this.storage.approaches(id, { interrupted: true });
    const resumable = (approach: ResearchApproach) => researchApproachResumable(approach, (itemId) => this.storage.readItem(id, itemId));
    // Resuming all of them skips any whose work closed since; naming one that closed is refused.
    const targets = approachIds === undefined ? cutOff.filter(resumable) : approachIds.map((approachId) => {
      const approach = cutOff.find((candidate) => candidate.id === approachId);
      if (!approach) throw new Error("That worker is not waiting to be resumed");
      if (!resumable(approach)) throw new Error(`"${approach.title}" is closed and cannot be resumed`);
      return approach;
    });
    if (!targets.length) throw new Error("No worker is waiting to be resumed");
    // A cut-off worker may still hold its slot for a revision queued before the restart; it is not counted twice.
    if (held.activeWorkers + targets.filter((approach) => !researchApproachOccupiesSlot(approach)).length > held.workerLimit) throw new Error("Research worker limit reached; resume fewer workers or wait for one to end");
    this.append(held, requestId, actor, { type: "resumed", approachIds: targets.map((approach) => approach.id) }, signature);
    const starting = this.pendingStarts.get(id) ?? new Set<string>();
    this.pendingStarts.set(id, starting);
    for (const approach of targets) starting.add(approach.id);
    await Promise.all(targets.map(async (approach) => {
      const worker = approach.worker!;
      const thread = { backend: worker.backend, threadId: worker.threadId };
      try {
        const receipt = await this.ports.notify(actor, thread, researchResumePrompt(id, approach));
        const current = this.requireApproach(id, approach.id);
        // A trusted provider event can precede the reply. It already owns this transition.
        if (receipt.turnId && current.state === "starting" && current.worker?.turnId === worker.turnId) {
          this.append(this.requireHeader(id), `resume-started:${approach.id}:${receipt.turnId}`, actor, { type: "worker", approachId: approach.id, state: "running", worker: { ...thread, turnId: receipt.turnId } });
        } else if (!receipt.turnId && receipt.queueEntryId && current.state === "starting") {
          // Held so a stop can withdraw it; the worker is running again once its turn is seen to start.
          const queued = this.queuedResumes.get(id) ?? new Map<string, string>();
          this.queuedResumes.set(id, queued.set(approach.id, receipt.queueEntryId));
        }
        // A stop or a closed item can win while the message is in flight, as it can for a start.
        if (!this.canAdmitApproach(this.requireHeader(id), approach)) await this.withdrawResume(id, approach.id, actor);
      } catch (error) {
        const current = this.requireApproach(id, approach.id);
        // Nothing was seen to start, so the worker is cut off as before and can be resumed again.
        if (current.state === "starting" && current.worker?.turnId === worker.turnId) {
          this.append(this.requireHeader(id), `resume-failed:${approach.id}:${requestId}`, actor, { type: "worker", approachId: approach.id, state: "stopped", interrupted: true,
            note: `The resume message was not delivered: ${message(error)}` });
        }
      } finally {
        starting.delete(approach.id);
        if (!starting.size && this.pendingStarts.get(id) === starting) this.pendingStarts.delete(id);
      }
    }));
    const settled = this.requireHeader(id);
    if (settled.status === "stopping") this.finishStopping(settled);
    return this.requireHeader(id);
  }

  /**
   * Take back a resume the run no longer admits: cancel its queued message, or stop the turn it started.
   * An outcome the queue cannot confirm is recorded as unknown and keeps the worker's slot.
   */
  private async withdrawResume(id: string, approachId: string, actor: ResearchActor): Promise<void> {
    const entry = this.queuedResumes.get(id)?.get(approachId);
    if (entry !== undefined) {
      this.forgetQueuedResume(id, approachId);
      try {
        const receipt = await this.ports.cancelQueued(entry);
        const current = this.requireApproach(id, approachId);
        if (!receipt.turnId) {
          if (current.state === "starting") this.append(this.requireHeader(id), `resume-withdrawn:${approachId}:${entry}`, actor, { type: "worker", approachId, state: "stopped", note: "The resume message was withdrawn before it started." });
          return;
        }
        if (current.worker?.turnId !== receipt.turnId) this.append(this.requireHeader(id), `resume-started:${approachId}:${receipt.turnId}`, actor,
          { type: "worker", approachId, state: "running", worker: { backend: current.worker!.backend, threadId: current.worker!.threadId, turnId: receipt.turnId } });
      } catch (error) {
        if (this.requireApproach(id, approachId).state === "starting") this.append(this.requireHeader(id), `resume-unknown:${approachId}:${entry}`, actor, { type: "worker", approachId, state: "unknown", note: message(error) });
        return;
      }
    }
    if (this.requireApproach(id, approachId).state === "running") await this.stopWorker(id, approachId, actor);
  }

  private forgetQueuedResume(id: string, approachId: string): void {
    const queued = this.queuedResumes.get(id);
    queued?.delete(approachId);
    if (queued && !queued.size) this.queuedResumes.delete(id);
  }

  /** Stops this process's live runs, or only those `include` selects. */
  async stopOwnedRuns(reason: string, include: (run: ResearchRunHeader) => boolean = () => true): Promise<void> {
    await Promise.all(this.storage.activeRuns().filter((run) => run.ownerId === this.ports.ownerId && include(run))
      .map(async (run) => await this.stop(run.id, this.operator(run), "stopped", reason)));
  }

  /** `run` must be the header as it stands now. */
  private finishStopping(run: ResearchRunHeader): void {
    if (run.status !== "stopping" || run.activeWorkers > 0 || this.pendingStarts.get(run.id)?.size) return;
    // A send still in flight holds the run even after its receipt is recorded as ended.
    for (const deliveryId of this.pendingDeliveries.get(run.id)?.keys() ?? []) if (this.storage.delivery(run.id, deliveryId)) return;
    if (this.storage.deliveries(run.id, { open: true }).length) return;
    const status = run.reason?.startsWith("deadline:") ? "deadline" : run.reason?.startsWith("completed:") ? "completed" : "stopped";
    this.append(run, `settled:${run.revision}`, this.operator(run), { type: "status", status, reason: run.reason ?? status });
  }

  /** `run` must be the header as it stands now. */
  private finishExploration(run: ResearchRunHeader): void {
    if (run.status !== "running" || run.activeWorkers > 0 || this.pendingStarts.get(run.id)?.size || this.storage.hasSubmission(run.id)) return;
    // Workers cut off by a restart have not ended: they are waiting to be resumed, unless their work has closed.
    if (this.storage.approaches(run.id, { interrupted: true }).some((approach) => researchApproachResumable(approach, (itemId) => this.storage.readItem(run.id, itemId)))) return;
    this.append(run, `exhausted:${run.revision}`, this.operator(run), { type: "status", status: "exhausted", reason: "All workers ended without submitting a candidate. Findings are retained; this does not establish that the problem is unsolvable." });
    this.deadlines.get(run.id)?.();
    this.deadlines.delete(run.id);
  }

  private scheduleDeadline(run: ResearchRunHeader): void {
    const callback = () => { void this.stop(run.id, this.operator(run), "deadline", "Research deadline reached").catch(this.ports.onError); };
    const deadlineAt = run.deadlineAt;
    // No time limit, no timer: the run ends when the operator stops or finishes it.
    if (deadlineAt === undefined) return;
    armResearchDeadline(deadlineAt, this.now, this.schedule, callback, (cancel) => this.deadlines.set(run.id, cancel));
  }
  private readonly schedule = (fn: () => void, delay: number): (() => void) => {
    if (this.ports.schedule) return this.ports.schedule(fn, delay);
    const timer = setTimeout(fn, delay);
    timer.unref();
    return () => clearTimeout(timer);
  };

  /**
   * Arm, move or cancel the timers for the per-worker time limit and total worker time, after an event that can
   * change what they wait for: the named approaches' turn timers, or every one, and the run's worker time. Only
   * a running run this process holds has them, and only for a bound the operator set. Timers write nothing
   * until they fire, and a fired timer acts only if its bound is still reached.
   */
  private armBounds(id: string, approachIds?: readonly string[]): void {
    if (this.closed) return;
    const run = this.requireHeader(id);
    const live = run.status === "running" && run.ownerId === this.ports.ownerId;
    const turns = this.turnLimits.get(id) ?? new Map<string, { at: number; cancel: () => void }>();
    if (!live || run.turnMinutes === undefined) {
      for (const timer of turns.values()) timer.cancel();
      this.turnLimits.delete(id);
    } else {
      const minutes = run.turnMinutes;
      const approaches = approachIds ? approachIds.flatMap((approachId) => { const approach = this.approach(id, approachId); return approach ? [approach] : []; })
        : this.storage.approaches(id, { occupying: true });
      if (!approachIds) for (const [approachId, timer] of turns) if (!approaches.some((approach) => approach.id === approachId)) { timer.cancel(); turns.delete(approachId); }
      for (const approach of approaches) {
        // Only a running turn has a clock. A worker cut off, waiting or unaccounted for has none.
        const at = approach.state === "running" && approach.turnSince !== undefined ? approach.turnSince + minutes * MINUTE - (approach.turnMs ?? 0) : undefined;
        const held = turns.get(approach.id);
        if (held?.at === at) continue;
        held?.cancel();
        turns.delete(approach.id);
        if (at === undefined) continue;
        const timer = { at, cancel: () => {} };
        turns.set(approach.id, timer);
        armResearchDeadline(at, this.now, this.schedule, () => this.turnLimitReached(id, approach.id, at), (cancel) => { timer.cancel = cancel; });
      }
      if (turns.size) this.turnLimits.set(id, turns);
      else this.turnLimits.delete(id);
    }
    const held = this.workerTimeLimits.get(id);
    const at = live && run.totalWorkerMinutes !== undefined ? researchWorkerTimeReachedAt(this.storage.workerTime(id), run.totalWorkerMinutes * MINUTE, this.now()) : undefined;
    if (held?.at === at) return;
    held?.cancel();
    this.workerTimeLimits.delete(id);
    if (at === undefined) return;
    const timer = { at, cancel: () => {} };
    this.workerTimeLimits.set(id, timer);
    armResearchDeadline(at, this.now, this.schedule, () => this.workerTimeReached(id, at), (cancel) => { timer.cancel = cancel; });
  }

  /** A worker's turn reached the per-worker limit: stop that worker, say why, and let the run go on. */
  private turnLimitReached(id: string, approachId: string, at: number): void {
    const turns = this.turnLimits.get(id);
    if (turns?.get(approachId)?.at === at) turns.delete(approachId);
    if (this.closed) return;
    const run = this.storage.header(id);
    if (!run || run.status !== "running" || run.ownerId !== this.ports.ownerId || run.turnMinutes === undefined) return;
    const approach = this.approach(id, approachId);
    if (!approach || approach.state !== "running" || researchTurnElapsed(approach, this.now()) < run.turnMinutes * MINUTE) return;
    void this.stopWorker(id, approachId, this.operator(run), researchTurnLimitNote(run.turnMinutes)).then(() => {
      if (this.closed) return;
      const current = this.requireHeader(id);
      if (current.status === "running") this.finishExploration(current);
      else this.finishStopping(current);
    }).catch(this.ports.onError);
  }

  /** The workers' turns reached the operator's total: end the run as a deadline does. */
  private workerTimeReached(id: string, at: number): void {
    if (this.workerTimeLimits.get(id)?.at === at) this.workerTimeLimits.delete(id);
    if (this.closed) return;
    const run = this.storage.header(id);
    if (!run || run.status !== "running" || run.ownerId !== this.ports.ownerId || run.totalWorkerMinutes === undefined) return;
    if (researchWorkerTimeUsed(this.storage.workerTime(id), this.now()) < run.totalWorkerMinutes * MINUTE) { this.armBounds(id, []); return; }
    void this.stop(id, this.operator(run), "deadline", RESEARCH_WORKER_TIME_REACHED).catch(this.ports.onError);
  }

  /** Appends at `run.revision`, which must be the journal's current revision, and tells the run's members. */
  private append(run: ResearchRunHeader, commandId: string, actor: ResearchActor, data: ResearchEventData, signature = JSON.stringify(data)): void {
    // Contribution limits cannot block receipts or cancellation settlement.
    if (run.revision >= RESEARCH_MAX_EVENTS && !["status", "worker", "delivery", "delivery_failed", "adopted"].includes(data.type)
      && !(data.type === "item_work" && ["cancel_requested", "cancelled"].includes(data.work.state))) throw new Error("Research event limit reached; finish this run before starting another");
    if (!this.storage.append(run.id, run.revision, { seq: run.revision + 1, commandId, signature, at: this.now(), actor, data })) return;
    this.publish(run.id, run.revision + 1);
    // A run with no per-worker limit or total worker time has no timers to move.
    if (data.type !== "bounds" && run.turnMinutes === undefined && run.totalWorkerMinutes === undefined) return;
    if (data.type === "worker") this.armBounds(run.id, [data.approachId]);
    else if (data.type === "adopted" || data.type === "resumed") this.armBounds(run.id, data.approachIds);
    else if (data.type === "bounds" || data.type === "status") this.armBounds(run.id);
  }
  private publish(id: string, revision: number): void { for (const thread of this.storage.members(id)) this.ports.changed({ backend: thread.backend, threadId: thread.threadId, runId: id, revision }); }
  private requireOpen(): void {
    if (this.closed) throw new Error("Research service is closed");
    if (this.ports.enabled?.() === false) throw new Error("Research runs are disabled");
  }
  private canDispatch(run: ResearchRunHeader): boolean { return !this.closed && this.ports.enabled?.() !== false && run.status === "running" && !researchDeadlinePassed(run, this.now()); }
  private canAdmitApproach(run: ResearchRunHeader, approach: Pick<ResearchApproach, "id" | "itemId">): boolean {
    if (!this.canDispatch(run)) return false;
    const selected = this.storage.readItem(run.id, approach.id);
    if (!selected || ["completed", "cancel_requested", "cancelled"].includes(selected.work.state)) return false;
    const item = this.storage.readItem(run.id, approach.itemId ?? approach.id);
    if (!approach.itemId) return Boolean(item && !["completed", "cancel_requested", "cancelled"].includes(item.work.state));
    return item?.work.assignmentId === approach.id && !["open", "completed", "cancel_requested", "cancelled"].includes(item.work.state);
  }
  /** The owner records a worker turn's end under one of two exact command keys. */
  private turnEnded(id: string, approachId: string, turnId: string): boolean {
    return Boolean(this.storage.findCommand(id, `ended:${approachId}:${turnId}`) ?? this.storage.findCommand(id, `stopped:${approachId}:${turnId}`));
  }
  private requireHeader(id: string): ResearchRunHeader { const run = this.storage.header(id); if (!run) throw new Error("Research run not found"); return run; }
  private approach(id: string, approachId: string): ResearchApproach | undefined { const item = this.storage.readItem(id, approachId); return item?.type === "approach" ? item.record : undefined; }
  private requireApproach(id: string, approachId: string): ResearchApproach { const approach = this.approach(id, approachId); if (!approach) throw new Error("Research approach not found"); return approach; }
  private operator(run: Pick<ResearchRunHeader, "coordinator">): ResearchActor { return { ...run.coordinator, kind: "operator" }; }
}

export function validateStartResearch(request: StartResearchRequest): void {
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
/** Whole minutes, rounded down, for a refusal that says how much time has gone. */
function minutesText(ms: number): string { const minutes = Math.floor(ms / MINUTE); return minutes === 1 ? "1 minute" : `${minutes} minutes`; }
function researchWorkerPrompt(id: string, objective: string, approach: ResearchApproach): string {
  return `Participate in research run ${id}, approach ${approach.id}: ${approach.title}.\nObjective: ${objective}\nAssignment: ${approach.task}\nUse research_read to inspect the shared board. Use research_update to post typed findings under approachId=${approach.id}, cite evidence paths relative to your workspace, and link other findings explicitly. Record counterexamples and dead ends. Submit a concise candidate with action=submit. Findings are proposals, not verified facts. The coordinator reviews submissions and may request revision. Do not start additional workers, change the objective, or claim formal verification. Stop when the run stops or its deadline is reached.`;
}
function researchResumePrompt(id: string, approach: ResearchApproach): string {
  return `PwrAgent was closed while you were working on research run ${id}, approach ${approach.id}: ${approach.title}. The run is still open and you are being asked to continue. Call research_read with runId=${id}${approach.itemId ? `, itemId=${approach.itemId}` : ""} to see what is already recorded, then carry on from where you stopped. Do not repeat findings you already posted. The run's worker limit, any time limit and cancellation still apply to you.`;
}
function researchItemWorkerPrompt(id: string, approach: ResearchApproach): string {
  return `Handle one research item. Run ID: ${id}. Item ID: ${approach.itemId}. Your approach/assignment ID: ${approach.id}.\nTask: ${approach.task}\nCall research_read with runId=${id}, itemId=${approach.itemId} to load this item's context and current version. Claim it using research_update action=work, itemId, expectedVersion, state=claimed and a reason. Update to in_progress, blocked or completed as appropriate, reading the latest version before each change. Post evidence or a candidate under approachId=${approach.id}; link the source finding when applicable. Use research_search only for additional evidence you need. Do not load the entire board or start other workers. A work item marked completed is not formally verified. The run's original deadline and cancellation apply to you.`;
}
