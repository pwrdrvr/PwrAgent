import { randomUUID } from "node:crypto";
import { RESEARCH_HARNESS_RECONCILABLE, RESEARCH_HARNESS_REVISION, RESEARCH_MAX_EVENTS, RESEARCH_MAX_WORKERS, researchDeadlinePassed, validResearchMinutes, researchHarnessEffectiveState, sameResearchThread, type ResearchActor, type ResearchEvent,
  type ResearchEventData, type ResearchHarnessCapabilities, type ResearchHarnessCheck, type ResearchHarnessRequest, type ResearchHarnessState, type ResearchRunHeader } from "@pwragent/shared";
import type { ResearchStorage } from "./research-storage";
import type { ResearchPorts } from "./research-service";
import { harnessMemberSlot, normalizeHarnessRecords, object, text } from "./research-harness-records";
import { normalizeHarnessDiscovery } from "./research-harness-discovery";
import { RESEARCH_RUN_HELD_ELSEWHERE, researchRunHeldBy } from "./research-ownership";
import { armResearchDeadline } from "./research-deadline";

export interface ResearchHarnessConnection {
  model?: { model: string; endpointOrigin: string };
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void | Promise<void>;
}
export type ResearchHarnessPorts = Pick<ResearchPorts, "ownerId" | "ownerPid" | "ownerStartedAt" | "isOwnerAlive" | "changed" | "now" | "onError" | "schedule" | "enabled"> & {
  open: (workspace: string, id: string, mode: "import" | "execute") => ResearchHarnessConnection;
  /** An actual ordinary-function round trip, bound to the configured endpoint and model. */
  probe: (id: string, signal: AbortSignal) => Promise<void>;
};

/** Pages one reconcile reads before it stops and asks the operator to reconcile again. */
export const RESEARCH_HARNESS_RECONCILE_PAGES = 20;

/** Optional external execution. Intents precede effects; recovery never replays execute. */
export class ResearchHarnessService {
  private readonly connections = new Map<string, ResearchHarnessConnection>();
  private readonly timers = new Map<string, () => void>();
  private readonly pending = new Map<string, Promise<ResearchRunHeader>>();
  private readonly stopping = new Set<string>();
  private readonly probes = new Map<string, AbortController>();
  private readonly reconciling = new Map<string, ResearchHarnessConnection | undefined>();
  private closed = false;
  private readonly cleanup = new Set<Promise<void>>();
  constructor(private readonly storage: ResearchStorage, private readonly ports: ResearchHarnessPorts) {}

  start(request: ResearchHarnessRequest, workspace: string): Promise<ResearchRunHeader> {
    const key = JSON.stringify(["harness", request.backend, request.threadId, text(request.requestId, 200)]);
    const existingId = this.storage.runIdForStartKey(key);
    const existing = existingId ? this.run(existingId) : undefined;
    const signature = JSON.stringify({ request, workspace });
    if (existing) {
      if (this.storage.findCommand(existing.id, "start")?.signature !== signature) return Promise.reject(new Error("Harness request ID was reused"));
      return this.pending.get(existing.id) ?? Promise.resolve(existing);
    }
    if (this.closed) return Promise.reject(new Error("Harness adapter is closed"));
    if (this.ports.enabled?.() === false) return Promise.reject(new Error("Research runs are disabled"));
    try { this.validate(request); } catch (error) { return Promise.reject(error); }
    const id = randomUUID();
    const actor: ResearchActor = { backend: request.backend, threadId: request.threadId, kind: "operator" };
    const state: ResearchHarnessState = { version: 1, mode: request.mode, project: request.project, session: request.session, swarm: request.swarm,
      workspace, upstreamRevision: RESEARCH_HARNESS_REVISION, state: "pending", cursor: 0, members: [], cancelSupported: false,
      note: "Process admission pending. Tokens and dollar spend are unknown; cancellation may still bill." };
    if (request.source === "discovery") { state.source = "discovery"; state.problem = request.problem; }
    const now = this.now();
    this.storage.create(id, key, { seq: 1, commandId: "start", signature, at: now, actor, data: { type: "created", objective: request.objective,
      coordinator: { backend: actor.backend, threadId: actor.threadId }, ownerId: this.ports.ownerId, ownerPid: this.ports.ownerPid,
      ownerStartedAt: this.ports.ownerStartedAt, ...(request.minutes !== undefined ? { deadlineAt: now + request.minutes * 60_000 } : {}), workspaceMode: "none", harness: state,
      // Execution declares the operator's member slots before dispatch. An import has read nothing yet: it admits the members its source names.
      approaches: Array.from({ length: request.mode === "execute" ? request.workers ?? 0 : 0 }, (_, i) => harnessMemberSlot(i + 1, `Harness member ${i + 1}`, request.objective)),
      ...(request.mode === "import" ? { workerLimit: RESEARCH_MAX_WORKERS } : {}) } });
    this.changed(id);
    this.scheduleDeadline(id);
    const promise = this.connect(id, request);
    this.pending.set(id, promise);
    void promise.finally(() => this.pending.delete(id)).catch(() => {});
    return promise;
  }

  /** Refuses a malformed request before any intent, process or model effect. */
  private validate(request: ResearchHarnessRequest): void {
    if (request.source !== undefined && !["swarm", "discovery"].includes(request.source)) throw new Error("Unsupported Harness source");
    if (request.source === "discovery" && request.mode !== "import") throw new Error("Discovery supports read-only observation");
    for (const v of [request.project, request.swarm, ...(request.source === "discovery" ? [] : [request.session])]) text(v, 64);
    if (request.problem !== undefined) text(request.problem, 64);
    text(request.objective, 8000);
    if (!["import", "execute"].includes(request.mode)) throw new Error("Unsupported Harness operation");
    // Only execution needs a member limit. An import's members come from its source, so a count sent with one bounds nothing,
    // but a malformed one is still refused: older windows send a valid 8.
    const workers = request.workers;
    if (workers !== undefined && (!Number.isInteger(workers) || workers < 1 || workers > RESEARCH_MAX_WORKERS)) throw new Error(`Choose 1–${RESEARCH_MAX_WORKERS} members`);
    if (request.mode === "execute" && workers === undefined) throw new Error(`Choose 1–${RESEARCH_MAX_WORKERS} members`);
    if (!validResearchMinutes(request.minutes)) throw new Error("A time limit is a whole number of minutes, at least 1");
    // The bridge binds a deadline before it admits a swarm, so execution needs one. An import only reads.
    if (request.mode === "execute" && request.minutes === undefined) throw new Error("Set a deadline for the swarm; the bridge requires one before it starts");
    // Imports and snapshots make no model call; execution spends model budget without a hard cap.
    if (request.mode === "execute" && request.budgetAcknowledged !== true) throw new Error("Acknowledge unknown token/dollar usage and cancellation billing before continuing");
  }

  private async connect(id: string, request: ResearchHarnessRequest): Promise<ResearchRunHeader> {
    try {
      const connection = this.ports.open(this.run(id).harness!.workspace, id, request.mode);
      this.connections.set(id, connection);
      const hello = object(await connection.request("hello", { version: 1, upstreamRevision: RESEARCH_HARNESS_REVISION }));
      if (hello.version !== 1 || hello.upstreamRevision !== RESEARCH_HARNESS_REVISION) throw new Error("Unsupported Harness bridge version/revision");
      if (this.closed || this.ports.enabled?.() === false || this.run(id).status !== "running" || researchDeadlinePassed(this.run(id), this.now())) throw new Error("Harness admission was fenced before probing");
      const capabilities = hello as unknown as ResearchHarnessCapabilities;
      if (request.source === "discovery" && capabilities.discovery !== true) throw new Error("Harness bridge does not support discovery observation");
      if (capabilities[request.mode] !== true) throw new Error(`Harness bridge does not support ${request.mode}`);
      const state = { ...this.run(id).harness!, ...connection.model, cancelSupported: capabilities.cancel === true };
      if (request.mode === "execute") {
        if (hello.researchFunctions !== true) throw new Error("Bridge must dispatch the ordinary research_read/research_update functions to its scoped service");
        if (!state.cancelSupported) throw new Error("Execution requires a bridge that can request scoped cancellation");
        const probe = new AbortController();
        this.probes.set(id, probe);
        try {
          if (connection.model) this.append(id, [{ type: "harness", state: { ...state, note: "Checking the configured model's ordinary functions. Compatibility calls may bill even if execution is refused." } }]);
          await this.ports.probe(id, probe.signal);
        } finally { this.probes.delete(id); }
      }
      // Stop/close can win while hello or the compatibility probe is outstanding.
      if (this.closed || this.ports.enabled?.() === false || this.run(id).status !== "running" || researchDeadlinePassed(this.run(id), this.now())) throw new Error("Harness admission was fenced before dispatch");
      this.append(id, [{ type: "harness", state: { ...state, state: "running", note: request.mode === "execute" ? "Execution dispatch recorded; no automatic replay." : "Observing source records; source work is not owned by this import." } }]);
      if (request.mode === "execute") {
        // Durable boundary above must remain before this potentially budget-spending call.
        await connection.request("execute", { version: 1, runId: id, project: request.project, session: request.session, swarm: request.swarm,
          objective: request.objective, workers: request.workers, deadlineAt: this.run(id).deadlineAt });
      }
      if (this.run(id).status === "running") {
        if (request.source === "discovery") await this.observeDiscovery(id);
        else await this.poll(id);
      }
    } catch (error) { this.unknown(id, error); }
    return this.run(id);
  }

  private async observeDiscovery(id: string): Promise<void> {
    const run = this.run(id), origin = run.harness!, connection = this.connections.get(id)!;
    const params = { project: origin.project, run: origin.swarm };
    const admitted = () => !this.closed && this.connections.has(id) && this.run(id).status === "running" && !researchDeadlinePassed(this.run(id), this.now());
    const status = await connection.request("discovery.status", params);
    if (!admitted()) return;
    const problems = await connection.request("discovery.problems", params);
    if (!admitted()) return;
    const tree = origin.problem ? await connection.request("discovery.tree", { ...params, problem: origin.problem }) : undefined;
    const current = this.run(id);
    if (!admitted()) return;
    const normalized = normalizeHarnessDiscovery(current, { status, problems, tree }, this.now());
    const actor = this.actor(current);
    const events: ResearchEvent[] = normalized.events.map((entry, i) => ({ ...entry, seq: current.revision + i + 1,
      commandId: `discovery:${i}`, signature: entry.provenance.digest, at: this.now(), actor }));
    const data: ResearchEventData[] = [{ type: "harness", state: { ...current.harness!, state: "imported", discovery: normalized.snapshot, observedAt: this.now(),
      note: "Read-only discovery snapshot. Source verification and spend are observations; source work may continue. No source event cursor is available." } },
    { type: "status", status: "interrupted", reason: "Retained discovery snapshot; no source work was started or stopped." }];
    for (const entry of data) events.push({ seq: current.revision + events.length + 1, commandId: `discovery:${events.length}`, signature: JSON.stringify(entry), at: this.now(), actor, data: entry });
    this.storage.appendBatch(id, current.revision, events);
    this.changed(id);
    this.release(id);
  }

  async poll(id: string): Promise<void> {
    if (this.closed || !this.connections.has(id)) return;
    try {
      const before = this.run(id);
      if (!["running", "stopping"].includes(before.status)) return;
      const response = object(await this.connections.get(id)!.request("records", { project: before.harness!.project, session: before.harness!.session,
        swarm: before.harness!.swarm, after: before.harness!.cursor, limit: 50 }));
      if (response.swarm !== before.harness!.swarm || !Array.isArray(response.records)) throw new Error("Invalid Harness records response");
      // Re-read after await: cancellation and review may have appended meanwhile.
      const run = this.run(id);
      if (!this.connections.has(id) || !["running", "stopping"].includes(run.status)) return;
      const normalized = normalizeHarnessRecords({ ...run, approaches: this.approaches(id) }, response.records, (seq) => this.storage.harnessRecord(id, seq));
      if (response.next !== undefined && (response.next !== normalized.state.cursor || normalized.state.cursor <= run.harness!.cursor)) throw new Error("Invalid Harness continuation cursor");
      if (normalized.events.length) {
        if (run.revision + normalized.events.length + 2 > RESEARCH_MAX_EVENTS) throw new Error("Research event limit reached; import retained source separately");
        const actor = this.actor(run);
        const events: ResearchEvent[] = normalized.events.map((entry, i) => ({ ...entry, seq: run.revision + i + 1,
          commandId: `source:${entry.provenance.seq}:${i}`, signature: entry.provenance.digest, at: this.now(), actor }));
        const state = { ...normalized.state, observedAt: this.now() };
        events.push({ seq: run.revision + events.length + 1, commandId: `cursor:${state.cursor}`, signature: JSON.stringify(state),
          at: this.now(), actor, data: { type: "harness", state } });
        this.storage.appendBatch(id, run.revision, events);
        this.changed(id);
      }
      if (normalized.state.state === "unknown") {
        this.append(id, [{ type: "status", status: "interrupted", reason: "Source resumed outside this execution's admission. Reconcile with a read-only import." }]);
        this.release(id);
      } else if (response.next !== undefined) this.schedulePoll(id, 0);
      else if (normalized.ended) {
        const current = this.run(id);
        const status = current.status === "stopping" ? current.reason?.startsWith("deadline:") ? "deadline" : current.reason?.startsWith("completed:") ? "completed" : "stopped" : "exhausted";
        this.append(id, [{ type: "status", status, reason: "Harness execution ended. Source verdicts are observations; PwrAgent reviews remain independent." }]);
        this.release(id);
      } else if (before.harness!.mode === "import" && response.next === undefined) {
        this.append(id, [{ type: "harness", state: { ...this.run(id).harness!, state: "imported", observedAt: this.now(), note: "Imported an observed prefix. Source work may continue; this import cannot stop it." } },
          { type: "status", status: "interrupted", reason: "Read-only import. Source execution and usage may be incomplete." }]);
        this.release(id);
      } else {
        this.schedulePoll(id, 1000);
      }
    } catch (error) { this.unknown(id, error); }
  }

  async stop(id: string, actor: ResearchActor, outcome: "stopped" | "deadline" | "completed", reason: string): Promise<ResearchRunHeader> {
    const run = this.run(id);
    if (this.closed || !sameResearchThread(run.coordinator, actor)) throw new Error("Harness owner or coordinator unavailable");
    // Cancelling needs the process that holds the bridge; completing a retained run needs only that no other process still does.
    if (!researchRunHeldBy(run, this.ports.ownerId, this.ports.isOwnerAlive)) throw new Error(RESEARCH_RUN_HELD_ELSEWHERE);
    if (outcome === "completed") {
      if (!this.storage.hasSubmission(id, "accepted")) throw new Error("Accept a submission before completing the run");
      if (["ended", "imported"].includes(run.harness!.state) && ["exhausted", "interrupted"].includes(run.status)) {
        this.append(id, [{ type: "status", status: "completed", reason: text(reason, 2000) }]);
        return this.run(id);
      }
    }
    if (this.stopping.has(id) || !["running", "stopping"].includes(run.status)) return run;
    this.stopping.add(id);
    this.probes.get(id)?.abort();
    this.append(id, [{ type: "status", status: "stopping", reason: `${outcome}: ${text(reason, 2000)}` },
      { type: "harness", state: { ...run.harness!, state: "stopping", note: "Cancellation requested. A process exit alone does not confirm the remote work stopped." } }]);
    const connection = this.connections.get(id);
    try {
      if (run.harness!.state === "pending" || run.harness!.mode === "import") {
        this.append(id, [...this.approaches(id).map((a): ResearchEventData => ({ type: "worker", approachId: a.id, state: "stopped" })),
          { type: "harness", state: { ...this.run(id).harness!, state: "stopped", note: "Stopped before execution dispatch, or detached an observation import. Source work was not cancelled." } },
          { type: "status", status: outcome, reason: "Stopped before execution dispatch, or detached an observation import." }]);
      } else {
        if (!connection || !run.harness!.cancelSupported) throw new Error("Scoped cancellation is unavailable");
        const receipt = object(await connection.request("cancel", { runId: id, project: run.harness!.project, session: run.harness!.session, swarm: run.harness!.swarm }));
        if (receipt.stopped !== true || receipt.runId !== id || receipt.swarm !== run.harness!.swarm) throw new Error("Harness cancellation acknowledgement is unresolved");
        if (!["running", "stopping"].includes(this.run(id).status)) return this.run(id);
        this.append(id, [ ...this.approaches(id).map((a): ResearchEventData => ({ type: "worker", approachId: a.id, state: "stopped" })),
          { type: "harness", state: { ...this.run(id).harness!, state: "stopped", note: "Bridge confirmed this run's work stopped. In-flight provider usage may still bill." } },
          { type: "status", status: outcome, reason }]);
      }
      this.release(id);
    } catch (error) { this.unknown(id, error); }
    // Never resend cancel after an ambiguous response, including a later UI click.
    return this.run(id);
  }

  /**
   * Asks the configured bridge what it supports. `hello` only: no run, no model
   * call and no write. Starting the bridge is an explicit operator action.
   */
  async check(workspace: string): Promise<ResearchHarnessCheck> {
    if (this.closed) throw new Error("Harness adapter is closed");
    if (this.ports.enabled?.() === false) throw new Error("Research runs are disabled");
    let connection: ResearchHarnessConnection | undefined;
    try {
      connection = this.ports.open(workspace, `check:${randomUUID()}`, "import");
      const hello = object(await connection.request("hello", { version: 1, upstreamRevision: RESEARCH_HARNESS_REVISION }));
      if (hello.version !== 1 || hello.upstreamRevision !== RESEARCH_HARNESS_REVISION) throw new Error("Unsupported Harness bridge version/revision");
      return { ok: true, checkedAt: this.now(), capabilities: { import: hello.import === true, execute: hello.execute === true, cancel: hello.cancel === true,
        discovery: hello.discovery === true, researchFunctions: hello.researchFunctions === true } };
    } catch (error) {
      return { ok: false, checkedAt: this.now(), error: boundedMessage(error) };
    } finally { if (connection) this.closeConnection(connection); }
  }

  /**
   * Reads source records after the stored cursor into the same run. Read-only:
   * it never sends execute or cancel, and it cannot resurrect a run's admission.
   * Intent commits before the bridge starts; each page commits with its cursor.
   */
  async reconcile(id: string, actor: ResearchActor): Promise<ResearchRunHeader> {
    const run = this.run(id), origin = run.harness!;
    if (this.closed) throw new Error("Harness adapter is closed");
    if (this.ports.enabled?.() === false) throw new Error("Research runs are disabled");
    if (!sameResearchThread(run.coordinator, actor)) throw new Error("Only the coordinating thread can reconcile this run");
    if (origin.source === "discovery") throw new Error("A discovery snapshot has no source cursor. Import a new snapshot instead.");
    // A run its dead owner left pending or running has an unknown outcome, whatever its last recorded state says.
    const effective = researchHarnessEffectiveState(run.status, origin);
    if (!RESEARCH_HARNESS_RECONCILABLE.includes(effective)) throw new Error("This run has no unresolved source outcome to reconcile");
    if (this.connections.has(id) || this.pending.has(id) || this.reconciling.has(id)) throw new Error("This run's bridge connection is still open");
    if (!researchRunHeldBy(run, this.ports.ownerId, this.ports.isOwnerAlive)) throw new Error(RESEARCH_RUN_HELD_ELSEWHERE);
    this.reconciling.set(id, undefined);
    const prior = effective === "reconciling" ? origin.mode === "import" ? "imported" : "unknown" : effective;
    const from = origin.cursor;
    let connection: ResearchHarnessConnection | undefined;
    let ended = false, resumed = false, more = false;
    try {
      this.append(id, [{ type: "harness", state: { ...origin, state: "reconciling", note: `Reading source records after #${from}, read-only. No execution or cancellation is sent.` } }]);
      connection = this.ports.open(origin.workspace, id, "import");
      this.reconciling.set(id, connection);
      const hello = object(await connection.request("hello", { version: 1, upstreamRevision: RESEARCH_HARNESS_REVISION }));
      if (hello.version !== 1 || hello.upstreamRevision !== RESEARCH_HARNESS_REVISION) throw new Error("Unsupported Harness bridge version/revision");
      if (hello.import !== true) throw new Error("Harness bridge does not support import");
      for (let page = 0; ; page++) {
        if (page === RESEARCH_HARNESS_RECONCILE_PAGES) { more = true; break; }
        if (this.closed || this.ports.enabled?.() === false) throw new Error("Reconcile was fenced by shutdown or disablement");
        const before = this.run(id).harness!;
        const response = object(await connection.request("records", { project: before.project, session: before.session, swarm: before.swarm, after: before.cursor, limit: 50 }));
        if (response.swarm !== before.swarm || !Array.isArray(response.records)) throw new Error("Invalid Harness records response");
        const current = this.run(id);
        if (current.harness!.state !== "reconciling" || current.harness!.cursor !== before.cursor) throw new Error("This run changed while reconciling");
        const normalized = normalizeHarnessRecords({ ...current, approaches: this.approaches(id) }, response.records, (seq) => this.storage.harnessRecord(id, seq));
        if (response.next !== undefined && (response.next !== normalized.state.cursor || normalized.state.cursor <= before.cursor)) throw new Error("Invalid Harness continuation cursor");
        ended = normalized.ended;
        resumed ||= ["running", "unknown"].includes(normalized.state.state);
        if (normalized.events.length) {
          if (current.revision + normalized.events.length + 3 > RESEARCH_MAX_EVENTS) throw new Error("Research event limit reached; the source has more records than this run can retain");
          const state: ResearchHarnessState = { ...normalized.state, state: "reconciling", observedAt: this.now() };
          const runActor = this.actor(current);
          const events: ResearchEvent[] = normalized.events.map((entry, i) => ({ ...entry, seq: current.revision + i + 1,
            commandId: `source:${entry.provenance.seq}:${i}`, signature: entry.provenance.digest, at: this.now(), actor: runActor }));
          events.push({ seq: current.revision + events.length + 1, commandId: `cursor:${state.cursor}`, signature: JSON.stringify(state), at: this.now(), actor: runActor, data: { type: "harness", state } });
          this.storage.appendBatch(id, current.revision, events);
          this.changed(id);
        }
        if (response.next === undefined) break;
      }
      const current = this.run(id), harness = current.harness!;
      const read = harness.cursor - from;
      const range = read ? `${read} ${read === 1 ? "record" : "records"} (#${from + 1}–#${harness.cursor})` : `no records after #${from}`;
      const data: ResearchEventData[] = [];
      if (ended && !resumed) {
        const { unresolved: _settled, ...settled } = harness;
        data.push({ type: "harness", state: { ...settled, state: "ended", observedAt: this.now(), note: `Reconciled ${range}. The source reports this swarm ended. Nothing was resent.` } });
        // The source's own terminal record settles an unacknowledged stop; a lost reply alone never does.
        if (current.status === "stopping") {
          const outcome = current.reason?.startsWith("deadline:") ? "deadline" : current.reason?.startsWith("completed:") ? "completed" : "stopped";
          data.push({ type: "status", status: outcome, reason: "The source reported this swarm ended while cancellation was unconfirmed." });
        }
      } else if (origin.mode === "import") {
        data.push({ type: "harness", state: { ...harness, state: "imported", observedAt: this.now(), note: `Imported ${range}.${more ? " More records remain; reconcile again." : ""} Source work may continue; this import cannot stop it.` } });
      } else {
        data.push({ type: "harness", state: { ...harness, state: "unknown", observedAt: this.now(), note: `Reconciled ${range}.${more ? " More records remain; reconcile again." : ""} The source has not reported an end, so its work may still be running. Nothing was resent.` } });
      }
      this.append(id, data);
    } catch (error) {
      const current = this.run(id);
      if (current.harness!.state === "reconciling") {
        this.append(id, [{ type: "harness", state: { ...current.harness!, state: prior, note: `Reconcile stopped: ${boundedMessage(error)}. Records read before it stopped are kept. Nothing was resent.` } }]);
      }
      this.ports.onError(error);
    } finally {
      // Shutdown may already have closed it.
      if (this.reconciling.get(id) === connection && connection) this.closeConnection(connection);
      this.reconciling.delete(id);
    }
    return this.run(id);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const probe of this.probes.values()) probe.abort();
    // An in-flight reconcile's pending read fails and restores the prior outcome; nothing is resent.
    for (const [id, connection] of this.reconciling) if (connection) { this.reconciling.set(id, undefined); this.closeConnection(connection); }
    for (const id of this.connections.keys()) {
      this.unknown(id, new Error("Owner shut down; remote execution outcome is unknown"));
      this.release(id);
    }
    const results = await Promise.allSettled([...this.cleanup]);
    const failure = results.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  private unknown(id: string, error: unknown): void {
    const run = this.run(id);
    if (!["running", "stopping"].includes(run.status)) return;
    const cancel = run.status === "stopping" && run.harness!.mode === "execute";
    const note = cancel ? "Cancellation was requested, but the bridge did not confirm it. Source work may still be running."
      : run.harness!.mode === "import" ? "The connection ended before the import was complete."
      : "The bridge connection ended without a confirmed outcome. Source work may still be running.";
    this.append(id, [{ type: "harness", state: { ...run.harness!, state: "unknown", note, ...(cancel ? { unresolved: "cancel" as const } : {}) } },
      { type: "status", status: run.status === "stopping" ? "stopping" : "interrupted", reason: "Harness connection ended without a confirmed execution outcome." }]);
    this.release(id);
    this.ports.onError(error);
  }
  private scheduleDeadline(id: string): void {
    const deadlineAt = this.run(id).deadlineAt;
    // An import has no deadline of its own: it reads what the source has and stops.
    if (deadlineAt === undefined) return;
    armResearchDeadline(deadlineAt, () => this.now(), (callback, delay) => this.schedule(callback, delay),
      () => { void this.stop(id, this.actor(this.run(id)), "deadline", "Research deadline reached").catch(this.ports.onError); },
      (cancel) => this.timers.set(`${id}:deadline`, cancel));
  }
  private schedulePoll(id: string, delay: number): void {
    this.timers.set(`${id}:poll`, this.schedule(() => { this.timers.delete(`${id}:poll`); void this.poll(id); }, delay));
  }
  private schedule(callback: () => void, delay: number): () => void {
    if (this.ports.schedule) return this.ports.schedule(callback, delay);
    const timer = setTimeout(callback, delay);
    timer.unref();
    return () => clearTimeout(timer);
  }
  private release(id: string): void {
    for (const key of [`${id}:deadline`, `${id}:poll`]) { this.timers.get(key)?.(); this.timers.delete(key); }
    const connection = this.connections.get(id);
    this.connections.delete(id);
    if (connection) this.closeConnection(connection);
  }
  private closeConnection(connection: ResearchHarnessConnection): void {
    const cleanup = Promise.resolve().then(() => connection.close());
    this.cleanup.add(cleanup);
    void cleanup.then(() => this.cleanup.delete(cleanup), (error) => { this.cleanup.delete(cleanup); this.ports.onError(error); });
  }
  private append(id: string, data: ResearchEventData[]): void {
    const run = this.run(id);
    this.storage.appendBatch(id, run.revision, data.map((entry, i) => ({ seq: run.revision + i + 1, commandId: randomUUID(), signature: JSON.stringify(entry),
      at: this.now(), actor: this.actor(run), data: entry })));
    this.changed(id);
  }
  private changed(id: string): void { const run = this.run(id); this.ports.changed({ ...run.coordinator, runId: id, revision: run.revision }); }
  private actor(run: ResearchRunHeader): ResearchActor { return { ...run.coordinator, kind: "operator" }; }
  private run(id: string): ResearchRunHeader { const run = this.storage.header(id); if (!run?.harness) throw new Error("Harness run not found"); return run; }
  /** The declared member slots, `a1` onward. An import declares them as its source names members, so it may hold fewer than its limit. */
  private approaches(id: string) {
    const run = this.run(id);
    const approaches = [];
    for (let index = 1; index <= run.workerLimit; index++) {
      const item = this.storage.readItem(id, `a${index}`);
      if (item?.type !== "approach") break;
      approaches.push(item.record);
    }
    return approaches;
  }
  private now(): number { return this.ports.now?.() ?? Date.now(); }
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Harness bridge failed";
  return message.length > 300 ? `${message.slice(0, 299)}…` : message;
}
