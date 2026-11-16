import { randomUUID } from "node:crypto";
import {
  RESEARCH_FINDING_KINDS, RESEARCH_MAX_EVENTS, RESEARCH_MAX_WORKERS, sameResearchThread,
  type ResearchActor, type ResearchApproach, type ResearchCommand, type ResearchEventData, type ResearchDelivery,
  type ResearchRun, type ResearchSnapshot, type ResearchThread, type StartResearchRequest, type PrepareResearchRequest,
} from "@pwragent/shared/research";
import type { ResearchStorage } from "./research-storage";

export type ResearchExecutionContext = ResearchActor & { kind: "agent"; turnId: string; callId: string };
/** The adapter has confirmed that no model turn was admitted. */
export class ResearchAdmissionRefused extends Error {}
export type ResearchPorts = {
  spawn: (context: ResearchExecutionContext, task: string, title: string, workspaceMode: StartResearchRequest["workspaceMode"],
    onCreated: (worker: ResearchThread) => void) => Promise<ResearchThread & { turnId?: string; failure?: string }>;
  stop: (worker: NonNullable<ResearchApproach["worker"]>) => Promise<void>;
  notify: (context: ResearchActor, target: ResearchThread, text: string) => Promise<{ queueEntryId?: string; turnId?: string }>;
  cancelQueued: (queueEntryId: string) => Promise<{ turnId?: string }>;
  changed: (thread: ResearchThread) => void;
  ownerId: string;
  ownerPid: number;
  isOwnerAlive: (pid: number) => boolean;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => () => void;
  onError: (error: unknown) => void;
};

/**
 * Owns only structured research, never provider transcripts. Store mutations
 * are synchronous, compare-and-append commits before effects. Spawn intent is
 * durable before handing off; a thread is bound before its first model turn.
 * A lost response is never retried automatically. Foreign live owners are
 * read-only. Dead owners become interrupted, without starting any work.
 * Cancellation fences later admissions and stays stopping while a start or
 * cancellation is unresolved. Provider cancellation does not undo billing.
 */
export class ResearchService {
  private readonly starts = new Map<string, { signature: string; promise: Promise<ResearchRun> }>();
  private readonly deadlines = new Map<string, () => void>();
  private readonly pendingStarts = new Set<string>();
  private readonly pendingDeliveries = new Set<string>();
  private readonly stops = new Map<string, Promise<ResearchRun>>();
  private readonly workerStops = new Map<string, Promise<void>>();
  private readonly intents = new Map<string, { id: string; request: PrepareResearchRequest; expiresAt: number }>();
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly storage: ResearchStorage, private readonly ports: ResearchPorts) {
    this.now = ports.now ?? Date.now;
  }

  initialize(): void {
    for (const run of this.storage.list()) {
      if (!["running", "stopping"].includes(run.status)) continue;
      if (run.ownerId === this.ports.ownerId) this.scheduleDeadline(run);
      else if (!this.ports.isOwnerAlive(run.ownerPid)) {
        this.append(run, `recovery:${this.ports.ownerId}`, this.operator(run), {
          type: "status", status: "interrupted", reason: "The owning process ended. Inspect the retained worker threads before starting a new run.",
        });
      }
    }
  }

  snapshot(thread: ResearchThread): ResearchSnapshot {
    const runs = this.storage.list(thread);
    return { runs, writableRunIds: this.closed ? [] : runs.filter((r) => r.ownerId === this.ports.ownerId).map((r) => r.id) };
  }

  read(id: string, actor: ResearchActor): ResearchRun {
    const run = this.requireRun(id);
    this.requireMember(run, actor);
    return run;
  }

  isWorker(thread: ResearchThread): boolean {
    return this.storage.list(thread).some((run) => ["running", "stopping"].includes(run.status)
      && run.approaches.some((a) => a.worker && sameResearchThread(a.worker, thread)));
  }

  /** Bind the operator's form limits before asking the coordinator to propose directions. No writes or spend. */
  prepare(request: PrepareResearchRequest): { intentId: string } {
    this.requireOpen();
    if (!Number.isInteger(request.workers) || request.workers < 1 || request.workers > RESEARCH_MAX_WORKERS) throw new Error("Choose 1–8 workers");
    validateStartResearch({ ...request, approaches: Array.from({ length: request.workers }, (_, i) => ({ title: `Approach ${i + 1}`, task: "Awaiting assignment" })) });
    const id = randomUUID();
    this.intents.set(JSON.stringify([request.backend, request.threadId]), { id, request: { ...request }, expiresAt: this.now() + 5 * 60_000 });
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
      if (request.objective !== intent.request.objective || request.approaches.length !== intent.request.workers || request.minutes !== intent.request.minutes || request.workspaceMode !== intent.request.workspaceMode) throw new Error("Research must use the exact objective, worker count, deadline and workspace choice the operator requested");
    }
    const id = randomUUID();
    const approaches: ResearchApproach[] = request.approaches.map((a, index) => ({ title: a.title, task: a.task, id: `a${index + 1}`, state: "pending" }));
    this.storage.create(id, key, { seq: 1, commandId: "start", signature: JSON.stringify(request), at: this.now(), actor: context,
      data: { type: "created", objective: request.objective, coordinator: { backend: context.backend, threadId: context.threadId }, approaches, ownerId: this.ports.ownerId,
        ownerPid: this.ports.ownerPid, deadlineAt: this.now() + request.minutes * 60_000, workspaceMode: request.workspaceMode } });
    if (intent) this.intents.delete(intentKey);
    this.ports.changed(context);
    this.scheduleDeadline(this.requireRun(id));
    for (const approach of approaches) {
      if (!this.canDispatch(this.requireRun(id))) break;
      this.pendingStarts.add(`${id}:${approach.id}`);
      this.append(this.requireRun(id), `starting:${approach.id}`, context, { type: "worker", approachId: approach.id, state: "starting" });
      try {
        const worker = await this.ports.spawn({ ...context, callId: `${context.callId}:${approach.id}` },
          researchWorkerPrompt(id, request.objective, approach), approach.title, request.workspaceMode,
          (created) => {
            const current = this.requireRun(id);
            this.append(current, `bound:${approach.id}`, context, { type: "worker", approachId: approach.id, state: "starting", worker: created });
            if (!this.canDispatch(this.requireRun(id))) throw new ResearchAdmissionRefused("Research run stopped before worker admission");
          });
        const current = this.requireRun(id);
        const prior = current.approaches.find((a) => a.id === approach.id)!;
        // A trusted provider event can precede the handoff reply. It already
        // owns this transition; do not rewrite it or regress its outcome.
        if (worker.failure || prior.worker?.turnId !== worker.turnId || prior.state === "starting") {
          this.append(current, `started:${approach.id}`, context, { type: "worker", approachId: approach.id, worker,
            state: worker.failure ? "failed" : ["ended", "stopped", "failed"].includes(prior.state) ? prior.state : "running", note: worker.failure });
        }
        if (!this.canDispatch(this.requireRun(id)) && !worker.failure && !["ended", "stopped", "failed"].includes(prior.state)) await this.stopWorker(id, approach.id, context);
      } catch (error) {
        const current = this.requireRun(id);
        const observed = this.requireApproach(current, approach.id);
        const state = observed.worker?.turnId && ["running", "ended", "stopped", "failed"].includes(observed.state)
          ? observed.state : error instanceof ResearchAdmissionRefused ? "failed" : "unknown";
        this.append(current, `start-failed:${approach.id}`, context, { type: "worker", approachId: approach.id, state, note: message(error) });
        if (!this.canDispatch(this.requireRun(id)) && state === "running") await this.stopWorker(id, approach.id, context);
      } finally {
        this.pendingStarts.delete(`${id}:${approach.id}`);
      }
    }
    const current = this.requireRun(id);
    if (current.status === "stopping") this.finishStopping(current);
    else if (current.status === "running" && this.now() >= current.deadlineAt) await this.stop(id, context, "deadline", "Research deadline reached");
    else this.finishExploration(current);
    return this.requireRun(id);
  }

  async update(id: string, requestId: string, command: ResearchCommand, actor: ResearchActor): Promise<ResearchRun> {
    this.requireOpen();
    if (!command || !["finding", "submit", "review", "abandon", "direction", "stop", "finish"].includes(command.action)) throw new Error("Unknown research command");
    boundedText(requestId, "requestId", 300);
    let run = this.read(id, actor);
    if (run.ownerId !== this.ports.ownerId) throw new Error("This run belongs to another process. Open its worker threads to inspect interrupted work.");
    const signature = JSON.stringify(command);
    const duplicate = run.events.find((e) => e.commandId === requestId);
    if (duplicate) {
      if (duplicate.signature !== signature || !sameResearchThread(duplicate.actor, actor) || duplicate.actor.kind !== actor.kind) throw new Error("Research command key was reused");
      return run;
    }
    const coordinator = actor.kind === "operator" || sameResearchThread(actor, run.coordinator);
    if ((command.action === "review" || command.action === "stop" || command.action === "finish") && !coordinator) throw new Error("Only the coordinator or operator may review or stop a run");
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
        if (revision) {
          this.pendingDeliveries.add(`${id}:${deliveryId}`);
          this.append(this.requireRun(id), `pending:${deliveryId}`, actor, { type: "delivery", delivery: { id: deliveryId, target, state: "pending" } });
        }
        try {
          const receipt = await this.ports.notify(actor, target,
            `Research run ${id}: ${command.action === "submit" ? "A candidate is ready for review" : "Revision requested"}. Read research_read with runId=${id}. ${command.action === "review" ? command.reason : "Review the submission and its evidence; acceptance is not formal verification."}`);
          if (revision) {
            const delivery: ResearchDelivery = { id: deliveryId, target, ...receipt, state: receipt.queueEntryId ? "queued" : receipt.turnId ? "started" : "unknown" };
            this.append(this.requireRun(id), `receipt:${deliveryId}`, actor, { type: "delivery", delivery });
            if (!this.canDispatch(this.requireRun(id))) await this.cancelDelivery(id, delivery, actor);
          }
        } catch (error) {
          this.append(this.requireRun(id), `delivery:${requestId}`, actor, { type: "delivery_failed", reason: message(error) });
          if (revision) this.append(this.requireRun(id), `unknown:${deliveryId}`, actor, { type: "delivery", delivery: { id: deliveryId, target, state: "unknown" } });
        } finally {
          this.pendingDeliveries.delete(`${id}:${deliveryId}`);
          this.finishStopping(this.requireRun(id));
        }
      }
    }
    return this.requireRun(id);
  }

  async stop(id: string, actor: ResearchActor, outcome: "stopped" | "deadline" | "completed", reason: string, requestId: string = randomUUID(), signature: string = outcome): Promise<ResearchRun> {
    const run = this.read(id, actor);
    if (actor.kind !== "operator" && !sameResearchThread(actor, run.coordinator)) throw new Error("Only the coordinator or operator may stop a run");
    if (run.ownerId !== this.ports.ownerId) throw new Error("Research owner is unavailable");
    const pending = this.stops.get(id);
    if (pending) return pending;
    if (!["running", "stopping"].includes(run.status)) return run;
    this.append(run, requestId, actor, { type: "status", status: "stopping", reason: `${outcome}: ${reason}` }, signature);
    this.deadlines.get(id)?.();
    this.deadlines.delete(id);
    const promise = this.performStop(id, actor);
    this.stops.set(id, promise);
    try { return await promise; } finally { this.stops.delete(id); }
  }

  private async performStop(id: string, actor: ResearchActor): Promise<ResearchRun> {
    const run = this.requireRun(id);
    for (const delivery of run.deliveries) {
      if (["queued", "started"].includes(delivery.state)) await this.cancelDelivery(id, delivery, actor);
    }
    for (const approach of this.requireRun(id).approaches) {
      if (approach.worker && !["ended", "stopped", "failed"].includes(approach.state)) await this.stopWorker(id, approach.id, actor);
      else if (approach.state === "pending") this.append(this.requireRun(id), `unstarted:${approach.id}`, actor, { type: "worker", approachId: approach.id, state: "stopped" });
    }
    this.finishStopping(this.requireRun(id));
    return this.requireRun(id);
  }

  private async cancelDelivery(id: string, delivery: ResearchDelivery, actor: ResearchActor): Promise<void> {
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
        const ended = run.events.some((event) => event.commandId === `ended:${approach.id}:${receipt.turnId}`
          || event.commandId === `stopped:${approach.id}:${receipt.turnId}`);
        if (!ended && (approach.worker?.turnId !== receipt.turnId || !["ended", "stopped", "failed"].includes(approach.state))) {
          await this.ports.stop({ ...delivery.target, turnId: receipt.turnId });
          const current = this.requireRun(id);
          if (this.requireApproach(current, approach.id).worker?.turnId === receipt.turnId) this.append(current, `revision-stopped:${delivery.id}:${receipt.turnId}`, actor, { type: "worker", approachId: approach.id, state: "stopped" });
        }
      }
      this.append(this.requireRun(id), `cancelled:${delivery.id}`, actor, { type: "delivery", delivery: { ...known, state: "cancelled" } });
    } catch (error) {
      if (this.requireRun(id).deliveries.find((d) => d.id === delivery.id)?.state === "cancelled") return;
      this.append(this.requireRun(id), `cancel-unknown:${delivery.id}:${this.requireRun(id).revision}`, actor, { type: "delivery", delivery: { ...known, state: "unknown" } });
      this.append(this.requireRun(id), `cancel-error:${delivery.id}:${this.requireRun(id).revision}`, actor, { type: "delivery_failed", reason: message(error) });
    }
  }

  private async stopWorker(id: string, approachId: string, actor: ResearchActor): Promise<void> {
    const approach = this.requireApproach(this.requireRun(id), approachId);
    if (!approach.worker?.turnId) return;
    const worker = approach.worker;
    const key = JSON.stringify([id, approachId, worker.turnId]);
    let pending = this.workerStops.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => this.performWorkerStop(id, approachId, actor, worker));
      this.workerStops.set(key, pending);
    }
    try { await pending; }
    finally { if (this.workerStops.get(key) === pending) this.workerStops.delete(key); }
  }

  private async performWorkerStop(id: string, approachId: string, actor: ResearchActor, worker: NonNullable<ResearchApproach["worker"]>): Promise<void> {
    try {
      const before = this.requireApproach(this.requireRun(id), approachId);
      if (before.worker?.turnId !== worker.turnId || ["ended", "stopped", "failed"].includes(before.state)) return;
      await this.ports.stop(worker);
      const current = this.requireRun(id);
      if (this.requireApproach(current, approachId).worker?.turnId !== worker.turnId) return;
      this.append(current, `stopped:${approachId}:${worker.turnId}`, actor, { type: "worker", approachId, state: "stopped" });
    } catch (error) {
      const current = this.requireRun(id);
      const latest = this.requireApproach(current, approachId);
      if (latest.worker?.turnId !== worker.turnId || ["ended", "stopped", "failed"].includes(latest.state)) return;
      this.append(current, `stop-error:${approachId}:${current.revision}`, actor, { type: "worker", approachId, state: "unknown", note: message(error) });
    }
  }

  /** Only the exact recorded worker turn can retire an assignment. No token events write. */
  observeStart(thread: ResearchThread, turnId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const cancellations: Promise<void>[] = [];
    for (const run of this.storage.list(thread)) {
      if (run.ownerId !== this.ports.ownerId || !["running", "stopping"].includes(run.status)) continue;
      const approach = run.approaches.find((a) => a.worker && sameResearchThread(a.worker, thread));
      if (!approach || approach.worker?.turnId === turnId) continue;
      this.append(run, `observed-start:${approach.id}:${turnId}`, this.operator(run), {
        type: "worker", approachId: approach.id, state: "running", worker: { ...thread, turnId },
      });
      if (!this.canDispatch(this.requireRun(run.id))) cancellations.push(this.stopWorker(run.id, approach.id, this.operator(run)).then(() => {
        if (!this.closed) this.finishStopping(this.requireRun(run.id));
      }));
    }
    return Promise.all(cancellations).then(() => undefined);
  }

  observeEnd(thread: ResearchThread, turnId: string, outcome: { failed?: boolean; note?: string } = {}): void {
    if (this.closed) return;
    for (const run of this.storage.list(thread)) {
      if (run.ownerId !== this.ports.ownerId || !["running", "stopping"].includes(run.status)) continue;
      for (const delivery of run.deliveries) {
        if (run.status === "stopping" && delivery.state !== "cancelled" && delivery.turnId === turnId && sameResearchThread(delivery.target, thread)) {
          this.append(this.requireRun(run.id), `terminal-delivery:${delivery.id}:${turnId}`, this.operator(run), { type: "delivery", delivery: { ...delivery, state: "cancelled" } });
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
      if (run.status === "stopping") this.finishStopping(this.requireRun(run.id));
      else this.finishExploration(this.requireRun(run.id));
    }
  }

  close(): void {
    this.closed = true;
    this.intents.clear();
    for (const cancel of this.deadlines.values()) cancel();
    this.deadlines.clear();
    for (const run of this.storage.list()) {
      if (run.ownerId === this.ports.ownerId && ["running", "stopping"].includes(run.status)) this.append(run, `shutdown:${this.ports.ownerId}`, this.operator(run), {
        type: "status", status: "interrupted", reason: "PwrAgent closed. Research evidence is retained; execution was not automatically resumed.",
      });
    }
  }

  private finishStopping(run: ResearchRun): void {
    if (run.status !== "stopping"
      || run.deliveries.some((d) => this.pendingDeliveries.has(`${run.id}:${d.id}`) || d.state !== "cancelled")
      || run.approaches.some((a) => this.pendingStarts.has(`${run.id}:${a.id}`) || !["ended", "stopped", "failed"].includes(a.state))) return;
    const status = run.reason?.startsWith("deadline:") ? "deadline" : run.reason?.startsWith("completed:") ? "completed" : "stopped";
    this.append(run, `settled:${run.revision}`, this.operator(run), { type: "status", status, reason: run.reason ?? status });
  }

  private finishExploration(run: ResearchRun): void {
    if (run.status !== "running" || run.submissions.length || run.approaches.some((a) => this.pendingStarts.has(`${run.id}:${a.id}`) || !["ended", "failed", "stopped"].includes(a.state))) return;
    this.append(run, `exhausted:${run.revision}`, this.operator(run), { type: "status", status: "exhausted", reason: "All workers ended without submitting a candidate. Findings are retained; this does not establish that the problem is unsolvable." });
    this.deadlines.get(run.id)?.();
    this.deadlines.delete(run.id);
  }

  private scheduleDeadline(run: ResearchRun): void {
    const callback = () => { void this.stop(run.id, this.operator(run), "deadline", "Research deadline reached").catch(this.ports.onError); };
    const schedule = this.ports.schedule ?? ((fn, delay) => { const timer = setTimeout(fn, delay); timer.unref(); return () => clearTimeout(timer); });
    this.deadlines.set(run.id, schedule(callback, Math.max(0, run.deadlineAt - this.now())));
  }

  private append(run: ResearchRun, commandId: string, actor: ResearchActor, data: ResearchEventData, signature = JSON.stringify(data)): void {
    // Contribution limits cannot block receipts or cancellation settlement.
    if (run.revision >= RESEARCH_MAX_EVENTS && !["status", "worker", "delivery", "delivery_failed"].includes(data.type)) throw new Error("Research event limit reached; finish this run before starting another");
    this.storage.append(run.id, run.revision, { seq: run.revision + 1, commandId, signature, at: this.now(), actor, data });
    this.ports.changed(run.coordinator);
    for (const approach of run.approaches) if (approach.worker) this.ports.changed(approach.worker);
  }
  private requireOpen(): void { if (this.closed) throw new Error("Research service is closed"); }
  private canDispatch(run: ResearchRun): boolean { return !this.closed && run.status === "running" && this.now() < run.deadlineAt; }
  private requireRun(id: string): ResearchRun { const run = this.storage.get(id); if (!run) throw new Error("Research run not found"); return run; }
  private requireApproach(run: ResearchRun, id: string): ResearchApproach { const approach = run.approaches.find((a) => a.id === id); if (!approach) throw new Error("Research approach not found"); return approach; }
  private operator(run: ResearchRun): ResearchActor { return { ...run.coordinator, kind: "operator" }; }
  private requireMember(run: ResearchRun, actor: ResearchActor): void {
    if (sameResearchThread(actor, run.coordinator) || run.approaches.some((a) => a.worker && sameResearchThread(a.worker, actor))) return;
    throw new Error("The calling thread is not a member of this research run");
  }
}

export function validateStartResearch(request: StartResearchRequest): void {
  boundedText(request.objective, "objective", 8000);
  if (!Number.isInteger(request.minutes) || request.minutes < 1 || request.minutes > 120) throw new Error("Research deadline must be 1–120 minutes");
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
