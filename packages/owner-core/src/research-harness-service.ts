import { randomUUID } from "node:crypto";
import { RESEARCH_HARNESS_REVISION, RESEARCH_MAX_EVENTS, sameResearchThread, type ResearchActor, type ResearchEvent,
  type ResearchEventData, type ResearchHarnessCapabilities, type ResearchHarnessRequest, type ResearchHarnessState, type ResearchRun } from "@pwragent/shared";
import type { ResearchStorage } from "./research-storage";
import type { ResearchPorts } from "./research-service";
import { normalizeHarnessRecords, object, text } from "./research-harness-records";

export interface ResearchHarnessConnection {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void | Promise<void>;
}
export type ResearchHarnessPorts = Pick<ResearchPorts, "ownerId" | "ownerPid" | "ownerStartedAt" | "changed" | "now" | "onError" | "schedule"> & {
  open: (workspace: string, id: string) => ResearchHarnessConnection;
  /** An actual ordinary-function round trip, bound to the configured endpoint and model. */
  probe: (id: string, signal: AbortSignal) => Promise<void>;
};

/** Optional external execution. Intents precede effects; recovery never replays execute. */
export class ResearchHarnessService {
  private readonly connections = new Map<string, ResearchHarnessConnection>();
  private readonly timers = new Map<string, () => void>();
  private readonly pending = new Map<string, Promise<ResearchRun>>();
  private readonly stopping = new Set<string>();
  private readonly probes = new Map<string, AbortController>();
  private closed = false;
  private readonly cleanup = new Set<Promise<void>>();
  constructor(private readonly storage: ResearchStorage, private readonly ports: ResearchHarnessPorts) {}

  start(request: ResearchHarnessRequest, workspace: string): Promise<ResearchRun> {
    const key = JSON.stringify(["harness", request.backend, request.threadId, text(request.requestId, 200)]);
    const existing = this.storage.findByStartKey(key);
    const signature = JSON.stringify({ request, workspace });
    if (existing) {
      if (existing.events[0]?.signature !== signature) return Promise.reject(new Error("Harness request ID was reused"));
      return this.pending.get(existing.id) ?? Promise.resolve(existing);
    }
    if (this.closed) return Promise.reject(new Error("Harness adapter is closed"));
    for (const v of [request.project, request.session, request.swarm]) text(v, 64);
    text(request.objective, 8000);
    if (!["import", "execute"].includes(request.mode) || !Number.isInteger(request.workers) || request.workers < 1 || request.workers > 8
      || !Number.isInteger(request.minutes) || request.minutes < 1 || request.minutes > 120) throw new Error("Choose 1–8 workers and 1–120 minutes");
    if (request.budgetAcknowledged !== true) throw new Error("Acknowledge unknown token/dollar usage and cancellation billing before continuing");
    const id = randomUUID();
    const actor: ResearchActor = { backend: request.backend, threadId: request.threadId, kind: "operator" };
    const state: ResearchHarnessState = { version: 1, mode: request.mode, project: request.project, session: request.session, swarm: request.swarm,
      workspace, upstreamRevision: RESEARCH_HARNESS_REVISION, state: "pending", cursor: 0, members: [], cancelSupported: false,
      note: "Process admission pending. Tokens and dollar spend are unknown; cancellation may still bill." };
    const now = this.now();
    this.storage.create(id, key, { seq: 1, commandId: "start", signature, at: now, actor, data: { type: "created", objective: request.objective,
      coordinator: { backend: actor.backend, threadId: actor.threadId }, ownerId: this.ports.ownerId, ownerPid: this.ports.ownerPid,
      ownerStartedAt: this.ports.ownerStartedAt, deadlineAt: now + request.minutes * 60_000, workspaceMode: "none", harness: state,
      approaches: Array.from({ length: request.workers }, (_, i) => ({ id: `a${i + 1}`, title: `Harness member ${i + 1}`, task: request.objective, state: "unknown" })) } });
    this.changed(id);
    this.scheduleDeadline(id);
    const promise = this.connect(id, request);
    this.pending.set(id, promise);
    void promise.finally(() => this.pending.delete(id)).catch(() => {});
    return promise;
  }

  private async connect(id: string, request: ResearchHarnessRequest): Promise<ResearchRun> {
    try {
      const connection = this.ports.open(this.run(id).harness!.workspace, id);
      this.connections.set(id, connection);
      const hello = object(await connection.request("hello", { version: 1, upstreamRevision: RESEARCH_HARNESS_REVISION }));
      if (hello.version !== 1 || hello.upstreamRevision !== RESEARCH_HARNESS_REVISION) throw new Error("Unsupported Harness bridge version/revision");
      if (this.closed || this.run(id).status !== "running" || this.now() >= this.run(id).deadlineAt) throw new Error("Harness admission was fenced before probing");
      const capabilities = hello as unknown as ResearchHarnessCapabilities;
      if (capabilities[request.mode] !== true) throw new Error(`Harness bridge does not support ${request.mode}`);
      const state = { ...this.run(id).harness!, cancelSupported: capabilities.cancel === true };
      if (request.mode === "execute") {
        if (hello.researchFunctions !== true) throw new Error("Bridge must dispatch the ordinary research_read/research_update functions to its scoped service");
        if (!state.cancelSupported) throw new Error("Execution requires a bridge that can request scoped cancellation");
        const probe = new AbortController();
        this.probes.set(id, probe);
        try { await this.ports.probe(id, probe.signal); } finally { this.probes.delete(id); }
      }
      // Stop/close can win while hello or the compatibility probe is outstanding.
      if (this.closed || this.run(id).status !== "running" || this.now() >= this.run(id).deadlineAt) throw new Error("Harness admission was fenced before dispatch");
      this.append(id, [{ type: "harness", state: { ...state, state: "running", note: request.mode === "execute" ? "Execution dispatch recorded; no automatic replay." : "Observing source records; source work is not owned by this import." } }]);
      if (request.mode === "execute") {
        // Durable boundary above must remain before this potentially budget-spending call.
        await connection.request("execute", { version: 1, runId: id, project: request.project, session: request.session, swarm: request.swarm,
          objective: request.objective, workers: request.workers, deadlineAt: this.run(id).deadlineAt });
      }
      if (this.run(id).status === "running") await this.poll(id);
    } catch (error) { this.unknown(id, error); }
    return this.run(id);
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
      const normalized = normalizeHarnessRecords(run, response.records);
      if (response.next !== undefined && (response.next !== normalized.state.cursor || normalized.state.cursor <= run.harness!.cursor)) throw new Error("Invalid Harness continuation cursor");
      if (normalized.events.length) {
        if (run.revision + normalized.events.length + 2 > RESEARCH_MAX_EVENTS) throw new Error("Research event limit reached; import retained source separately");
        const actor = this.actor(run);
        const events: ResearchEvent[] = normalized.events.map((entry, i) => ({ ...entry, seq: run.revision + i + 1,
          commandId: `source:${entry.provenance.seq}:${i}`, signature: entry.provenance.digest, at: this.now(), actor }));
        events.push({ seq: run.revision + events.length + 1, commandId: `cursor:${normalized.state.cursor}`, signature: JSON.stringify(normalized.state),
          at: this.now(), actor, data: { type: "harness", state: normalized.state } });
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
        this.append(id, [{ type: "harness", state: { ...this.run(id).harness!, state: "imported", note: "Imported an observed prefix. Source work may continue; this import cannot stop it." } },
          { type: "status", status: "interrupted", reason: "Read-only import. Source execution and usage may be incomplete." }]);
        this.release(id);
      } else {
        this.schedulePoll(id, 1000);
      }
    } catch (error) { this.unknown(id, error); }
  }

  async stop(id: string, actor: ResearchActor, outcome: "stopped" | "deadline" | "completed", reason: string): Promise<ResearchRun> {
    const run = this.run(id);
    if (this.closed || run.ownerId !== this.ports.ownerId || !sameResearchThread(run.coordinator, actor)) throw new Error("Harness owner or coordinator unavailable");
    if (outcome === "completed") {
      if (!run.submissions.some((submission) => submission.review?.decision === "accepted")) throw new Error("Accept a submission before completing the run");
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
        this.append(id, [...this.run(id).approaches.map((a): ResearchEventData => ({ type: "worker", approachId: a.id, state: "stopped" })),
          { type: "harness", state: { ...this.run(id).harness!, state: "stopped", note: "Stopped before execution dispatch, or detached an observation import. Source work was not cancelled." } },
          { type: "status", status: outcome, reason: "Stopped before execution dispatch, or detached an observation import." }]);
      } else {
        if (!connection || !run.harness!.cancelSupported) throw new Error("Scoped cancellation is unavailable");
        const receipt = object(await connection.request("cancel", { runId: id, project: run.harness!.project, session: run.harness!.session, swarm: run.harness!.swarm }));
        if (receipt.stopped !== true || receipt.runId !== id || receipt.swarm !== run.harness!.swarm) throw new Error("Harness cancellation acknowledgement is unresolved");
        if (!["running", "stopping"].includes(this.run(id).status)) return this.run(id);
        this.append(id, [ ...this.run(id).approaches.map((a): ResearchEventData => ({ type: "worker", approachId: a.id, state: "stopped" })),
          { type: "harness", state: { ...this.run(id).harness!, state: "stopped", note: "Bridge confirmed this run's work stopped. In-flight provider usage may still bill." } },
          { type: "status", status: outcome, reason }]);
      }
      this.release(id);
    } catch (error) { this.unknown(id, error); }
    // Never resend cancel after an ambiguous response, including a later UI click.
    return this.run(id);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const probe of this.probes.values()) probe.abort();
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
    this.append(id, [{ type: "harness", state: { ...run.harness!, state: "unknown", note: "Connection or dispatch outcome is unknown. Reconcile source records; do not replay execution or cancellation." } },
      { type: "status", status: run.status === "stopping" ? "stopping" : "interrupted", reason: "Harness connection ended without a confirmed execution outcome." }]);
    this.release(id);
    this.ports.onError(error);
  }
  private scheduleDeadline(id: string): void {
    const delay = Math.max(0, this.run(id).deadlineAt - this.now());
    this.timers.set(`${id}:deadline`, this.schedule(() => { void this.stop(id, this.actor(this.run(id)), "deadline", "Research deadline reached").catch(this.ports.onError); }, delay));
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
    if (connection) {
      const cleanup = Promise.resolve(connection.close());
      this.cleanup.add(cleanup);
      void cleanup.then(() => this.cleanup.delete(cleanup), (error) => { this.cleanup.delete(cleanup); this.ports.onError(error); });
    }
  }
  private append(id: string, data: ResearchEventData[]): void {
    const run = this.run(id);
    this.storage.appendBatch(id, run.revision, data.map((entry, i) => ({ seq: run.revision + i + 1, commandId: randomUUID(), signature: JSON.stringify(entry),
      at: this.now(), actor: this.actor(run), data: entry })));
    this.changed(id);
  }
  private changed(id: string): void { this.ports.changed(this.run(id).coordinator); }
  private actor(run: ResearchRun): ResearchActor { return { ...run.coordinator, kind: "operator" }; }
  private run(id: string): ResearchRun { const run = this.storage.get(id); if (!run?.harness) throw new Error("Harness run not found"); return run; }
  private now(): number { return this.ports.now?.() ?? Date.now(); }
}
