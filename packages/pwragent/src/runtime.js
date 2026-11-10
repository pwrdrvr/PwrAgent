import { OutpostProjects } from "./projects.js";
import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { AgentToolRouter, buildPwrAgentMessagingToolDefinitions, readPwrAgentMessagingDynamicToolCall, resolveMessagingOutboundFile, validateMessagingFileMetadata, FILE_PUSH_MAX_BYTES } from "../dist/federation-core.js";
import { Codex } from "./codex.js";
import { installedVersion } from "./version.js";
import { ACTIVE, atomicJson, digest, privateDirectory, validId } from "./store.js";
import { ThreadCreationLifecycle, ThreadInterruptionLifecycle, ThreadTurnStartLifecycle, ThreadTurnQueue } from "../dist/federation-core.js";

export class Runtime {
  constructor({ store, workspace, home, command, onFailure }) {
    this.store = store;
    this.workspace = workspace;
    // Snapshot at startup: upgrading the package files does not change the
    // code this process is running.
    this.running = installedVersion();
    this.projects = new OutpostProjects(path.dirname(store.directory), workspace);
    this.messagingTools = new AgentToolRouter(buildPwrAgentMessagingToolDefinitions((request) => this.messagingRequest(request), { nativeDynamicPdfImages: true }));
    this.fileAccess = { privateStorageRoots: [home, process.env.PWRAGENT_HOME].filter(Boolean),
      deniedRoots: [home, path.dirname(store.directory)], denyHardLinks: true };
    this.toolLedgerDirectory = path.join(path.dirname(store.directory), "tool-calls");
    privateDirectory(this.toolLedgerDirectory);
    this.toolLedger = new Map();
    this.toolLedgerCount = readdirSync(this.toolLedgerDirectory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length;
    this.loadedThreads = new Set();
    this.pendingSteeringOrigins = new Map();
    this.onFailure = onFailure;
    // Stable-ID retries await their own provider dispatch, even when another
    // accepted submission has already returned from enqueueing.
    this.dispatches = new Map();
    this.queueRelease = null;
    this.turnQueue = new ThreadTurnQueue({
      startTurn: entry => this.dispatchJob(this.store.get(entry.id), entry.input[0].text, entry),
      canSteerThread: entry => this.canSteerQueued(entry),
      steerTurn: entry => this.dispatchQueuedSteer(entry),
      isThreadActive: ({ threadId }) => Boolean(this.active && this.store.get(this.active).threadId === threadId),
      isDispatchHeld: entry => Boolean(this.stopping || this.uncertain
        || this.dispatches.size > (this.queueRelease && entry.id === this.queueRelease.entryId ? 1 : 0) || this.intakeBusy || this.threadCreationBusy?.()
        || (this.active && !this.canSteerQueued(entry))),
      onLifecycle: event => this.queueEvent(event),
    });
    this.threadCreations = new ThreadCreationLifecycle();
    this.turnStarts = new ThreadTurnStartLifecycle({
      assertAvailable: () => { if (this.stopping) throw new Error("Daemon is stopping"); },
      withMutation: async (_identity, work) => await work(),
      assertUnlocked: async ({ threadId }) => {
        if (this.threadLocked?.(threadId)) throw new Error("Thread handoff is in progress");
      },
      wake: async () => {},
    });
    this.codex = new Codex({
      command, home, workspace,
      onNotification: (message) => { this.notification(message); this.onEvent?.(message); },
      onRequest: (message) => this.serverRequest(message),
      onFailure: (error) => { this.codexFailure = error; onFailure(error); },
    });
  }

  save(job) {
    let saved;
    try {
      saved = this.store.save(job);
    } catch (error) {
      this.reportFailure(error);
      throw error;
    }
    // Durability is the acceptance boundary. An observer cannot undo it or
    // convert confirmed provider input into a retryable submission failure.
    try { this.onEvent?.({ method: "headless/jobChanged", params: saved }); }
    catch (error) { this.reportFailure(error); }
    return saved;
  }

  reportFailure(error) {
    try { this.onFailure(error); } catch { /* Diagnostics cannot replace an owner outcome. */ }
  }

  async handle(method, params = {}) {
    if (this.stopping) throw new Error("Daemon is stopping");
    switch (method) {
      case "status": return { version: 1, ready: true, pid: process.pid, running: this.running, activeJob: this.active || null, workspace: this.workspace };
      case "project-list": return this.projects.list();
      case "project-create": case "project-clone": return this.projects.create(params);
      case "project-add": return this.projects.add(params);
      case "project-remove": return this.projects.remove(params.path, this.listOwnedThreads?.() || []);
      case "git-auth-configure": return this.projects.git.configure(params);
      case "list": return [...this.store.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
      case "show": return this.store.get(params.id);
      case "submit": return this.submit(params);
      case "release": return this.releaseQueuedTurn({ queueEntryId: params.id });
      case "cancel": return this.cancelQueuedTurn({ queueEntryId: params.id });
      case "pause": case "resume": return this.setQueuedTurnPaused({ queueEntryId: params.id, paused: method === "pause" });
      case "move": return this.moveQueuedTurn({ queueEntryId: params.id, beforeQueueEntryId: params.before });
      case "read": {
        const job = this.store.get(params.id);
        if (!job.threadId) throw new Error("This job has no confirmed thread ID");
        return this.codex.readThreadProtocolResult({ threadId: job.threadId, includeTurns: true });
      }
      case "interrupt": {
        const job = this.store.get(params.id);
        if (job.status === "queued") {
          const result = await this.cancelQueuedTurn({ queueEntryId: job.id });
          if (!result.cancelled) throw new Error("Job is being admitted; retry interrupt");
          return this.store.get(job.id);
        }
        if (!ACTIVE.has(job.status)) return job;
        if (job.id !== this.active) throw new Error("This job does not own the active native turn");
        if (!job.turnId) throw new Error("Turn is still starting; retry interrupt after its turn ID is confirmed");
        if (job.status === "interrupting") return job;
        await new ThreadInterruptionLifecycle({ interruptCodex: async (target) => {
          this.save({ ...job, status: "interrupting" });
          try {
            await this.codex.interruptTurn({ threadId: target.threadId, turnId: target.turnId });
          } catch (error) {
            const current = this.store.get(job.id);
            if (current.status === "interrupting" && current.turnId === job.turnId) {
              this.save({ ...current, status: job.status });
            }
            throw error;
          }
          return { threadId: job.threadId, turnId: job.turnId };
        } }).interruptTurn({ backend: "codex", threadId: job.threadId, turnId: job.turnId });
        return this.store.get(job.id);
      }
      default: throw new Error(`Unknown command: ${method}`);
    }
  }

  submit(params, queuedControls) {
    if (this.stopping) throw new Error("Daemon is stopping");
    const { id, prompt, threadId = null, model = null, sandbox = "read-only", reasoningEffort = null, serviceTier = null } = params;
    if (!validId(id)) throw new Error("Job ID must be 1–80 letters, digits, underscores or hyphens, beginning with a letter or digit");
    if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt) > 256 * 1024) {
      throw new Error("Prompt must be nonempty and at most 256 KiB");
    }
    if (!["read-only", "workspace-write"].includes(sandbox)) throw new Error("Sandbox must be read-only or workspace-write");
    if (model !== null && (typeof model !== "string" || !model.trim() || model.length > 200)) throw new Error("Invalid model");
    for (const value of [reasoningEffort, serviceTier]) {
      if (value !== null && (typeof value !== "string" || value.length > 200)) throw new Error("Invalid turn settings");
    }
    if (threadId !== null && (typeof threadId !== "string" || (!this.ownsThread?.(threadId) && ![...this.store.jobs.values()].some((job) => job.threadId === threadId)))) {
      throw new Error("Only threads created by this headless profile may be continued");
    }
    if (threadId && this.threadLocked?.(threadId)) throw new Error("Thread handoff is in progress");
    // Preserve fingerprints created before optional turn settings were added.
    const cwd = this.projects.resolve(threadId ? this.threadCwd?.(threadId) || params.cwd || this.workspace : params.cwd);
    if (threadId && params.cwd && params.cwd !== cwd) throw new Error("Turn cwd differs from its owner thread project");
    const delivery = queuedControls?.delivery === "queued-steer" ? "queued-steer" : undefined;
    const prior = this.store.jobs.get(id);
    // Accepted delivery-less identities retain their original fingerprint on
    // upgrade. New queued steers still bind delivery into their acceptance.
    const fingerprintDelivery = prior && prior.delivery === undefined ? undefined : delivery;
    const fingerprint = digest({ prompt, threadId, model, sandbox, ...(cwd !== this.workspace ? { cwd } : {}), ...(params.messageOrigin ? { messageOrigin: params.messageOrigin } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), ...(serviceTier ? { serviceTier } : {}), ...(fingerprintDelivery ? { delivery: fingerprintDelivery } : {}) });
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("Job ID was already used with different input");
      return prior;
    }
    if (this.intakeBusy) throw new Error("Outpost thread intake is in progress; no job was queued");
    if (!threadId && (this.active || this.dispatches.size || this.turnQueue.getAllQueuedEntries().length || this.threadCreationBusy?.() || this.uncertain)) {
      throw new Error("Daemon is busy; no new-thread job was queued");
    }
    if (this.store.jobs.size >= 10000) throw new Error("Job retention limit reached (10000); use a new profile");
    const status = threadId && !this.turnQueue.canStartImmediately({ backend: "codex", threadId }) ? "queued" : "starting";
    const job = this.save({ version: 1, id, fingerprint, status, threadId,
      model, sandbox, cwd, messageOrigin: params.messageOrigin, reasoningEffort, serviceTier, ...(delivery ? { delivery } : {}), createdAt: new Date().toISOString() });
    // A committed acceptance observer can initiate shutdown synchronously.
    // Its cancellation sweep ran before this entry existed in the live FIFO.
    if (this.stopping) {
      this.finish(id, "unknown", "Daemon stopped after acceptance; no work was replayed");
      this.work = Promise.resolve();
      return job;
    }
    const entry = { id, backend: "codex", threadId,
      origin: params.messageOrigin ? "messaging" : "manual", messageOrigin: structuredClone(job.messageOrigin),
      input: [{ type: "text", text: prompt }], createdAt: Date.parse(job.createdAt),
      ...(delivery ? { delivery } : {}),
      ...(queuedControls?.paused ? { paused: true, pauseRevision: queuedControls.pauseRevision } : {}),
    };
    this.work = threadId ? (queuedControls?.manualReleaseRequired
      ? this.turnQueue.submitHeld(entry, queuedControls.holdReason, { queueIndex: queuedControls.queueIndex })
      : delivery && queuedControls?.queueIndex === undefined ? this.turnQueue.submitSteer(entry)
        : this.turnQueue.submit(entry, { queueIndex: queuedControls?.queueIndex })).catch(() => {}) : this.dispatchJob(job, prompt).catch(() => {});
    // The durable acceptance precedes inference. Socket loss cannot cancel it.
    return job;
  }

  queuedEntry(id) {
    if (!validId(id)) throw new Error("Invalid queue entry ID");
    return this.turnQueue.getAllQueuedEntries().find(entry => entry.id === id);
  }

  readQueuedTurn({ backend, threadId, queueEntryId }) {
    if (this.stopping) throw new Error("Daemon is stopping");
    const entry = this.queuedEntry(queueEntryId);
    if (!entry || entry.backend !== backend || entry.threadId !== threadId) throw new Error("The queued message is no longer waiting.");
    // Accepted Outpost input is text-only, so forEdit needs no attachment
    // staging. Inspection never edits acceptance or reserves the FIFO; the
    // viewer must cancel this snapshot's hash before making its local draft.
    const { input, messageOrigin } = structuredClone(entry);
    return { queueEntryId: entry.id, contentHash: digest(input), input,
      ...(messageOrigin ? { messageOrigin } : {}) };
  }

  assertQueuedIdentity(job, entry) {
    if (entry.backend !== "codex" || entry.threadId !== job.threadId || job.turnId
      || !["queued", "starting"].includes(job.status)) throw new Error("Queued job identity changed; no work was replayed");
    if (!this.ownsThread?.(job.threadId)) throw new Error("Thread is not owned by this outpost");
    if (this.threadLocked?.(job.threadId)) throw new Error("Thread handoff is in progress");
    const cwd = this.projects.resolve(this.threadCwd?.(job.threadId) || this.workspace);
    if (cwd !== job.cwd) throw new Error("Turn cwd differs from its owner thread project");
    const { threadId, model, sandbox, messageOrigin, reasoningEffort, serviceTier, delivery } = job;
    const prompt = entry.input.length === 1 && entry.input[0].type === "text" ? entry.input[0].text : null;
    const fingerprint = digest({ prompt, threadId, model, sandbox, ...(cwd !== this.workspace ? { cwd } : {}), ...(messageOrigin ? { messageOrigin } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), ...(serviceTier ? { serviceTier } : {}), ...(delivery ? { delivery } : {}) });
    if (fingerprint !== job.fingerprint || entry.delivery !== delivery || digest(entry.messageOrigin ?? null) !== digest(messageOrigin ?? null)) throw new Error("Queued input differs from its accepted identity");
  }

  async releaseQueuedTurn({ queueEntryId }) {
    const entry = this.queuedEntry(queueEntryId);
    if (!entry) return { queueEntryId, disposition: "not_found" };
    if (this.stopping || this.uncertain || (this.active && !this.canSteerQueued(entry)) || this.dispatches.size || this.intakeBusy || this.threadCreationBusy?.()) {
      return { queueEntryId, disposition: "busy" };
    }
    try {
      const job = this.store.get(queueEntryId);
      if (job.status !== "queued") throw new Error("Job is no longer waiting; no work was replayed");
      this.assertQueuedIdentity(job, entry);
    }
    catch (error) { return { queueEntryId, disposition: "blocked", errorMessage: error.message }; }
    // Hold the existing daemon slot before the shared FIFO yields to publish
    // cleared holds. Only this entry may consume the reservation; other
    // threads, creation and handoff still observe pending dispatch work.
    let releaseSlot;
    const reservation = new Promise(resolve => { releaseSlot = resolve; });
    this.dispatches.set(queueEntryId, reservation);
    this.queueRelease = { entryId: queueEntryId, threadId: entry.threadId, done: reservation };
    try {
      const result = await this.turnQueue.releaseEntryWithDisposition(queueEntryId);
      return { queueEntryId, disposition: result.disposition,
        ...(result.disposition === "started" ? { turnId: result.turnId } : {}),
        ...(result.disposition === "blocked" ? { errorMessage: result.error.message } : {}) };
    } finally {
      this.queueRelease = null;
      if (this.dispatches.get(queueEntryId) === reservation) this.dispatches.delete(queueEntryId);
      releaseSlot();
      this.turnQueue.drainAll();
    }
  }

  async cancelQueuedTurn({ queueEntryId, expectedContentHash }) {
    let entry = this.queuedEntry(queueEntryId);
    const release = this.queueRelease;
    // A second suspension of this FIFO could prevent the reserved head from
    // starting after its holds clear. Let that admission decision finish;
    // already admitted entries remain immediately observable below.
    if (entry && release && entry.threadId === release.threadId && this.queuedEntry(release.entryId)) {
      await release.done;
      entry = this.queuedEntry(queueEntryId);
    }
    const cancel = () => {
      const current = this.queuedEntry(queueEntryId);
      if (current) {
        if (expectedContentHash && digest(current.input) !== expectedContentHash) {
          return { queueEntryId, cancelled: false, disposition: "content_changed" };
        }
        const job = this.store.get(queueEntryId);
        if (job.status !== "queued" || job.turnId || job.threadId !== current.threadId) throw new Error("Queued job identity changed");
        // Commit the outcome while the shared engine suspends admission. A
        // refused write leaves the entry waiting; no provider is interrupted.
        this.finish(job.id, "interrupted", "Cancelled before dispatch");
      }
      const result = this.turnQueue.cancelEntryWithDisposition(queueEntryId, "Cancelled before dispatch");
      return { queueEntryId, cancelled: result.disposition === "cancelled", disposition: result.disposition,
        ...(result.disposition === "already_admitted" && result.turnId ? { turnId: result.turnId } : {}) };
    };
    if (this.stopping) throw new Error("Daemon is stopping");
    return entry ? await this.turnQueue.withDispatchSuspended(entry, cancel) : cancel();
  }

  async setQueuedTurnPaused({ queueEntryId, paused }) {
    if (this.stopping) throw new Error("Daemon is stopping");
    const waiting = this.queuedEntry(queueEntryId);
    if (typeof paused !== "boolean") throw new Error("Paused must be a boolean");
    const release = this.queueRelease;
    // Match cancellation: another suspension must not defeat the reserved
    // head's admission after its manual holds have already been cleared.
    if (waiting && release && waiting.threadId === release.threadId && this.queuedEntry(release.entryId)) await release.done;
    if (this.stopping) throw new Error("Daemon is stopping");
    const result = await this.turnQueue.setEntryPaused(queueEntryId, paused);
    const entry = result.entry;
    if (result.disposition === "updated") {
      // A later serialized edit can finish before this awaiting caller resumes.
      // Publish only the live entry, never a cancelled or superseded snapshot.
      const current = this.queuedEntry(queueEntryId);
      if (current) this.queueEvent({ type: current.manualReleaseRequired ? "held" : "queued", entry: current, reason: current.holdReason });
    }
    return { queueEntryId, disposition: result.disposition,
      ...(entry ? { paused: entry.paused === true } : {}),
      ...(entry?.pauseRevision ? { pauseRevision: entry.pauseRevision } : {}) };
  }

  async moveQueuedTurn({ queueEntryId, beforeQueueEntryId }) {
    if (this.stopping) throw new Error("Daemon is stopping");
    const waiting = this.queuedEntry(queueEntryId);
    if (beforeQueueEntryId !== undefined && !validId(beforeQueueEntryId)) throw new Error("Invalid queue entry anchor ID");
    const release = this.queueRelease;
    // Preserve the same admission ordering as cancellation and pause edits.
    if (waiting && release && waiting.threadId === release.threadId && this.queuedEntry(release.entryId)) await release.done;
    if (this.stopping) throw new Error("Daemon is stopping");
    const result = await this.turnQueue.moveEntry(queueEntryId, beforeQueueEntryId);
    if (result.disposition === "moved") {
      // A later serialized edit can finish before this awaiting caller resumes.
      // Announce the live FIFO, rather than restore a since-cancelled identity.
      const queueEntryIds = this.turnQueue.getQueuedEntries({ backend: result.backend, threadId: result.threadId }).map(entry => entry.id);
      try { this.onEvent?.({ method: "headless/queueReordered", params: { threadId: result.threadId, queueEntryIds } }); }
      catch (error) { this.reportFailure(error); }
    }
    return { queueEntryId, disposition: result.disposition,
      ...(result.entryIds ? { queueEntryIds: result.entryIds } : {}) };
  }

  dispatchJob(job, prompt, entry) {
    if (this.stopping || this.uncertain) throw new Error("Daemon cannot dispatch work");
    if (this.active || this.dispatches.size > (this.queueRelease && job.id === this.queueRelease.entryId ? 1 : 0)
      || this.intakeBusy || this.threadCreationBusy?.()) throw new Error("Outpost is busy");
    if (job.threadId && this.threadLocked?.(job.threadId)) throw new Error("Thread handoff is in progress");
    if (entry) this.assertQueuedIdentity(job, entry);
    if (!ACTIVE.has(job.status) && job.status !== "queued") throw new Error("Job already has an outcome; no work was replayed");
    this.active = job.id;
    this.earlyCompletion = null;
    this.blockedReason = null;
    this.acceptedTurn = null;
    const work = Promise.resolve().then(async () => {
      try {
        if (job.status === "queued") this.save({ ...this.store.get(job.id), status: "starting", reason: undefined });
        await this.start(job, prompt);
        const current = this.store.get(job.id);
        if (!current.turnId) throw new Error("Provider did not confirm a turn identity");
        return { backend: "codex", threadId: current.threadId, turnId: current.turnId };
      } catch (error) {
        const accepted = this.acceptedTurn?.jobId === job.id ? this.acceptedTurn : null;
        const current = this.store.get(job.id);
        if (accepted || this.codexFailure || this.stopping) {
          this.uncertain = true;
          if (ACTIVE.has(current.status)) this.finish(job.id, "unknown", error.message);
          // Accepted input must never return to a retryable FIFO after a host
          // confirmation failure, even if diagnostics cannot stop this host.
          if (accepted) return { backend: "codex", threadId: accepted.threadId, turnId: accepted.turnId };
        } else if (job.status === "queued") {
          this.save({ ...current, status: "queued", reason: error.message });
          this.active = null;
        } else if (ACTIVE.has(current.status)) this.finish(job.id, "failed", error.message);
        throw error;
      }
    }).finally(() => {
      if (this.dispatches.get(job.id) === work) this.dispatches.delete(job.id);
      this.turnQueue.drainAll();
    });
    // A held release owns this job's pending value through its final queue
    // decision, so retries and shutdown also await that reservation cleanup.
    if (job.id !== this.queueRelease?.entryId) this.dispatches.set(job.id, work);
    return work;
  }

  canSteerQueued(entry) {
    const active = this.active && this.store.get(this.active);
    return Boolean(entry.delivery === "queued-steer" && this.steerQueuedTurn && active?.status === "running"
      && active.threadId === entry.threadId && active.turnId);
  }

  dispatchQueuedSteer(entry) {
    if (!this.canSteerQueued(entry)) return undefined;
    if (this.stopping || this.uncertain || this.dispatches.size > (this.queueRelease && entry.id === this.queueRelease.entryId ? 1 : 0)
      || this.intakeBusy || this.threadCreationBusy?.()) throw new Error("Outpost cannot dispatch work");
    const job = this.store.get(entry.id), active = this.store.get(this.active);
    this.assertQueuedIdentity(job, entry);
    const target = { backend: "codex", threadId: active.threadId, turnId: active.turnId };
    const work = Promise.resolve().then(async () => {
      let claimed = false;
      try {
        // Commit the exact native target before inference. Recovery already
        // settles starting jobs as unknown; it must never resend a steer.
        this.save({ ...job, status: "starting", turnId: target.turnId });
        claimed = true;
        if (this.stopping || this.uncertain || this.intakeBusy || this.threadCreationBusy?.() || this.active !== active.id) throw new Error("Active turn changed before steering");
        const result = await this.steerQueuedTurn({ backend: "codex", threadId: job.threadId, expectedTurnId: target.turnId,
          requestId: job.id, input: entry.input, messageOrigin: job.messageOrigin });
        if (result.turnId !== target.turnId) throw new Error("Provider steering target changed");
        const current = this.store.get(job.id);
        // A provider terminal can settle this captured target while native
        // acknowledgement or origin finalization is still pending.
        if (current.status === "starting") this.save({ ...current, status: "running" });
      } catch (error) {
        if (!claimed) throw error;
        this.uncertain = true;
        if (ACTIVE.has(this.store.get(job.id).status)) {
          try { this.finish(job.id, "unknown", error.message); }
          catch (failure) { this.reportFailure(failure); }
        }
        this.reportFailure(error);
      }
      // Once claimed, never restore input to the retryable FIFO, including
      // native or host-finalization uncertainty. Keep the original owner.
      return target;
    }).finally(() => {
      if (this.dispatches.get(job.id) === work) this.dispatches.delete(job.id);
      this.turnQueue.drainAll();
    });
    if (job.id !== this.queueRelease?.entryId) this.dispatches.set(job.id, work);
    return work;
  }

  queueEvent(event) {
    if (event.type === "cancelled") {
      const job = this.store.get(event.entry.id);
      if (job.status === "queued") this.finish(job.id, this.stopping ? "unknown" : "interrupted", event.reason);
    }
    try { this.onEvent?.({ method: "headless/queueChanged", params: event }); }
    catch (error) { this.reportFailure(error); }
  }

  async start(job, prompt) {
    const cwd = this.projects.resolve(job.cwd || this.workspace);
    const params = { cwd, approvalPolicy: "never", sandbox: job.sandbox,
      ...(job.model ? { model: job.model } : {}) };
    const result = job.threadId ? { threadId: job.threadId }
      : await this.threadCreations.start({ backend: "codex" }, { providers: { codex: async () => {
        const created = await this.codex.startThread({ ...params, ephemeral: false, dynamicTools: this.messagingTools.buildDynamicToolSpecs() });
        if (typeof created?.threadId !== "string" || !created.threadId || created.threadId.length > 256) throw new Error("Codex returned an invalid thread ID");
        return created;
      } } });
    if (typeof result.threadId !== "string" || !result.threadId || result.threadId.length > 256) {
      throw new Error("Codex returned an invalid thread ID");
    }
    this.loadedThreads.add(result.threadId);
    this.save({ ...this.store.get(job.id), threadId: result.threadId,
      ...(!job.threadId ? { messagingFileTools: true } : {}) });
    const identity = { backend: "codex", threadId: result.threadId };
    const submission = await this.turnStarts.run(identity, () => this.turnStarts.submitCodex({ identity, pendingTurnId: `pending:${result.threadId}`, submit: () => this.codex.startTurn({ ...params, threadId: result.threadId,
      onTerminalResult: (params) => this.notification({ method: "turn/completed", params }),
      input: [{ type: "text", text: prompt }],
      ...(job.reasoningEffort ? { reasoningEffort: job.reasoningEffort } : {}),
      ...(job.serviceTier ? { serviceTier: job.serviceTier } : {}),
    }) }));
    const turn = submission.turn;
    if (typeof turn.turnId !== "string" || !turn.turnId || turn.turnId.length > 256 || turn.turnId.startsWith("pending:")) {
      this.onFailure(new Error("Codex returned an invalid turn ID; execution outcome is unknown"));
      return;
    }
    this.acceptedTurn = { jobId: job.id, threadId: result.threadId, turnId: turn.turnId };
    // Confirmed identity is durable before independent finalizers. A storage
    // refusal stops this owner and records unknown; it never resends input.
    this.save({ ...this.store.get(job.id), turnId: turn.turnId, status: "running" });
    await this.turnStarts.finalizeCodex({ identity, turn,
      // The prompt stays in memory: job records never store it. The existing
      // event supplies both prompt fallback and shared helper-title admission.
      scheduleTitle: () => this.onEvent?.({ method: "headless/turnStarted", params: { threadId: result.threadId, jobId: job.id, prompt } }),
      failed: (_stage, error) => this.reportFailure(error),
    });
    // A terminal may arrive while finalization yields. Its provider outcome
    // already retired the job and must not complete a second time.
    if (this.active !== job.id) return;
    if (this.earlyCompletion?.turn?.id === turn.turnId) {
      this.complete(this.earlyCompletion);
    } else if (this.blockedReason) {
      await this.handle("interrupt", { id: job.id });
    }
  }

  notification({ method, params }) {
    if (method === "thread/closed") this.loadedThreads.delete(params?.threadId);
    if (!["turn/completed", "turn/failed"].includes(method)) return;
    // A process-loss failure is synthesized by the client, not a confirmed
    // provider result. Shutdown preserves this job as unknown.
    if (this.codexFailure) return;
    const turnId = params?.turn?.id ?? params?.turnId;
    if (params?.threadId && turnId) this.onTurnTerminal?.({ backend: "codex", threadId: params.threadId, turnId });
    if (this.active) {
      const job = this.store.get(this.active);
      if (params?.threadId === job.threadId) {
        if (!job.turnId) this.earlyCompletion = params;
        else if (params.turn?.id === job.turnId) this.complete(params);
      }
    }
    if (params?.threadId && turnId) {
      for (const job of this.store.jobs.values()) {
        if (ACTIVE.has(job.status) && job.delivery === "queued-steer" && job.threadId === params.threadId && job.turnId === turnId) {
          this.finish(job.id, this.blockedReason ? "blocked" : params.turn.status, this.blockedReason || params.turn.error?.message);
        }
      }
    }
    if (params?.threadId && turnId) {
      void this.turnQueue.releaseThread({ backend: "codex", threadId: params.threadId, turnId,
        status: method === "turn/failed" || params.turn?.status === "failed" ? "turn/failed" : method,
        errorMessage: params.turn?.error?.message }).catch(error => this.reportFailure(error));
    }
  }

  complete(params) {
    const status = params.turn.status;
    if (!["completed", "failed", "interrupted"].includes(status)) {
      this.onFailure(new Error("Codex returned an invalid terminal status"));
      return;
    }
    this.finish(this.active, this.blockedReason ? "blocked" : status,
      this.blockedReason || params.turn.error?.message);
  }

  async dispatchTool(call) {
    const job = this.active && this.store.get(this.active);
    if (!job || job.threadId !== call.threadId || (job.turnId && job.turnId !== call.turnId)) throw new Error("Dynamic tool call does not belong to the active outpost turn");
    const key = digest([call.threadId, call.turnId, call.callId]);
    const fingerprint = digest([call.namespace, call.tool, call.arguments]);
    const file = path.join(this.toolLedgerDirectory, `${key}.json`);
    let prior = this.toolLedger.get(key);
    if (!prior) {
      try { prior = JSON.parse(readFileSync(file, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("Tool call identity was reused with different input");
      if (prior.result) return prior.result;
      throw new Error("Original tool outcome is uncertain; reconcile it with the messaging owner. No send was replayed.");
    }
    if (this.toolLedgerCount >= 10000) throw new Error("Tool-call retention limit reached");
    this.toolLedger.set(key, { fingerprint });
    atomicJson(file, { fingerprint });
    this.toolLedgerCount++;
    const result = await this.messagingTools.handleDynamicToolCall({ backend: "codex", call });
    this.toolLedger.set(key, { fingerprint, result });
    atomicJson(file, { fingerprint, result });
    return result;
  }

  fenceSteeringMessaging(jobId) {
    const pending = this.pendingSteeringOrigins.get(jobId) || new Set();
    const token = Symbol();
    pending.add(token);
    this.pendingSteeringOrigins.set(jobId, pending);
    return () => {
      pending.delete(token);
      if (!pending.size && this.pendingSteeringOrigins.get(jobId) === pending) this.pendingSteeringOrigins.delete(jobId);
    };
  }

  async messagingRequest(request) {
    const job = this.active && this.store.get(this.active);
    if (!job || job.threadId !== request.context.threadId || (job.turnId && job.turnId !== request.context.turnId)) return { ok: false, error: { code: "forbidden", message: "Messaging call does not belong to the active outpost turn" } };
    // Native tools can arrive before a steering RPC resolves. Until every
    // attributed steer is refused or retained, the durable origin is stale.
    // Refuse immediately: waiting here could deadlock the provider's RPC.
    if (this.pendingSteeringOrigins?.get(job.id)?.size) return { ok: false, error: { code: "forbidden", message: "Messaging is unavailable while steering origin acceptance is pending" } };
    const origin = job.messageOrigin;
    const scoped = { ...request, context: { ...request.context, causalMessagingSource: origin?.causalMessagingSource,
      causalMessagingAmbiguous: origin?.causalMessagingAmbiguous } };
    const loadFile = request.operation === "send_messaging_file" ? async (capabilities) => {
      const invalid = validateMessagingFileMetadata(request.args);
      if (invalid) return invalid;
      if (capabilities.maxUploadBytes !== undefined
        && (!Number.isSafeInteger(capabilities.maxUploadBytes) || capabilities.maxUploadBytes < 1)) {
        return { ok: false, code: "unsupported_operation", message: "The messaging owner supplied an invalid upload limit" };
      }
      // Git authentication may be explicitly selected from a workspace. Those
      // files remain private even though their parent is an allowed project.
      const gitAuth = this.projects.git.settings();
      return await resolveMessagingOutboundFile(request.args, {
        ...capabilities, maxUploadBytes: Math.min(capabilities.maxUploadBytes ?? FILE_PUSH_MAX_BYTES, FILE_PUSH_MAX_BYTES),
      }, { ...this.fileAccess, allowedRoots: [this.projects.resolve(job.cwd || this.workspace)],
        deniedRoots: [...this.fileAccess.deniedRoots, ...Object.values(gitAuth)] });
    } : undefined;
    return await this.requestMessaging?.(scoped, loadFile)
      || { ok: false, error: { code: "peer_unavailable", message: "The original messaging owner is unavailable" } };
  }

  serverRequest(message) {
    const call = readPwrAgentMessagingDynamicToolCall(message);
    if (call) {
      return this.dispatchTool(call).catch((error) => ({ success: false,
        contentItems: [{ type: "inputText", text: error.message }] }));
    }
    // Never grant unattended approvals or invent answers to user questions.
    const method = message.method;
    let result;
    if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) result = { decision: "decline" };
    else if (method === "item/permissions/requestApproval") result = { permissions: {}, scope: "turn" };
    if (!this.active) {
      if (result) return result;
      throw new Error("Interactive requests are not supported by PwrAgent Headless");
    }
    this.blockedReason = `Interactive request requires an operator: ${method}`;
    const job = this.store.get(this.active);
    if (job.turnId) void this.handle("interrupt", { id: job.id }).catch(this.onFailure);
    if (result) return result;
    throw new Error("Interactive requests are not supported by PwrAgent Headless");
  }

  finish(id, status, reason) {
    const confirmed = this.acceptedTurn?.jobId === id ? { threadId: this.acceptedTurn.threadId, turnId: this.acceptedTurn.turnId } : {};
    this.save({ ...this.store.get(id), ...confirmed, status, ...(reason ? { reason: String(reason).slice(0, 4096) } : {}), finishedAt: new Date().toISOString() });
    this.pendingSteeringOrigins?.delete(id);
    if (this.active === id) this.active = null;
    this.turnQueue.drainAll();
  }

  async stop() {
    this.stopping = true;
    this.turnQueue.close();
    for (const entry of this.turnQueue.getAllQueuedEntries()) this.turnQueue.cancelEntry(entry.id, "Daemon stopped; no queued work was replayed");
    await this.codex.stop();
    try {
      await Promise.allSettled([...this.dispatches.values()]);
      await this.work;
      await this.settleTitles?.();
    } finally {
      // An admitted helper can resume async setup after the first close and
      // initialize Codex again. Drain it before the final provider shutdown,
      // while the daemon still owns its profile leases and storage.
      await this.codex.stop();
    }
    // A refused in-flight claim can restore its entry after the first sweep.
    // Dispatch has now settled, so retire that input before owner shutdown.
    for (const entry of this.turnQueue.getAllQueuedEntries()) this.turnQueue.cancelEntry(entry.id, "Daemon stopped; no queued work was replayed");
    for (const job of this.store.jobs.values()) {
      if (ACTIVE.has(job.status)) this.finish(job.id, "unknown", "Daemon stopped; inspect the thread before explicitly continuing");
    }
  }
}
