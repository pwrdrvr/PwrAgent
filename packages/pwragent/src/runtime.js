import { Codex } from "./codex.js";
import { ACTIVE, digest, validId } from "./store.js";

export class Runtime {
  constructor({ store, workspace, home, command, onFailure }) {
    this.store = store;
    this.workspace = workspace;
    this.onFailure = onFailure;
    this.codex = new Codex({
      command, home, workspace,
      onNotification: (message) => this.notification(message),
      onRequest: (message) => this.serverRequest(message),
      onFailure,
    });
  }

  save(job) {
    try { return this.store.save(job); } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  async handle(method, params = {}) {
    if (this.stopping) throw new Error("Daemon is stopping");
    switch (method) {
      case "status": return { version: 1, ready: true, pid: process.pid, activeJob: this.active || null, workspace: this.workspace };
      case "list": return [...this.store.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
      case "show": return this.store.get(params.id);
      case "submit": return this.submit(params);
      case "read": {
        const job = this.store.get(params.id);
        if (!job.threadId) throw new Error("This job has no confirmed thread ID");
        return this.codex.request("thread/read", { threadId: job.threadId, includeTurns: true });
      }
      case "interrupt": {
        const job = this.store.get(params.id);
        if (!ACTIVE.has(job.status)) return job;
        if (!job.turnId) throw new Error("Turn is still starting; retry interrupt after its turn ID is confirmed");
        if (job.status === "interrupting") return job;
        this.save({ ...job, status: "interrupting" });
        await this.codex.request("turn/interrupt", { threadId: job.threadId, turnId: job.turnId });
        return this.store.get(job.id);
      }
      default: throw new Error(`Unknown command: ${method}`);
    }
  }

  submit(params) {
    const { id, prompt, threadId = null, model = null, sandbox = "read-only" } = params;
    if (!validId(id)) throw new Error("Job ID must be 1–80 letters, digits, underscores or hyphens, beginning with a letter or digit");
    if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt) > 256 * 1024) {
      throw new Error("Prompt must be nonempty and at most 256 KiB");
    }
    if (!["read-only", "workspace-write"].includes(sandbox)) throw new Error("Sandbox must be read-only or workspace-write");
    if (model !== null && (typeof model !== "string" || !model.trim() || model.length > 200)) throw new Error("Invalid model");
    if (threadId !== null && (typeof threadId !== "string" || ![...this.store.jobs.values()].some((job) => job.threadId === threadId))) {
      throw new Error("Only threads created by this headless profile may be continued");
    }
    const fingerprint = digest({ prompt, threadId, model, sandbox });
    const prior = this.store.jobs.get(id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("Job ID was already used with different input");
      return prior;
    }
    if (this.active) throw new Error(`Daemon is busy with job ${this.active}; no job was queued`);
    if (this.store.jobs.size >= 10000) throw new Error("Job retention limit reached (10000); use a new profile");
    const job = this.save({ version: 1, id, fingerprint, status: "starting", threadId,
      model, sandbox, createdAt: new Date().toISOString() });
    this.active = id;
    this.earlyCompletion = null;
    this.blockedReason = null;
    this.work = this.start(job, prompt).catch((error) => {
      const current = this.store.get(id);
      if (ACTIVE.has(current.status)) {
        this.finish(id, this.codex.failure || this.stopping ? "unknown" : "failed", error.message);
      }
    });
    // The durable acceptance precedes inference. Socket loss cannot cancel it.
    return job;
  }

  async start(job, prompt) {
    const params = { cwd: this.workspace, approvalPolicy: "never", sandbox: job.sandbox,
      ...(job.model ? { model: job.model } : {}) };
    const result = await this.codex.request(job.threadId ? "thread/resume" : "thread/start", {
      ...params,
      ...(job.threadId ? { threadId: job.threadId } : { ephemeral: false }),
    });
    if (typeof result?.thread?.id !== "string" || !result.thread.id || result.thread.id.length > 256
      || (job.threadId && result.thread.id !== job.threadId)) {
      throw new Error("Codex returned an invalid thread ID");
    }
    this.save({ ...this.store.get(job.id), threadId: result.thread.id });
    const turn = await this.codex.request("turn/start", {
      threadId: result.thread.id,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd: this.workspace,
      approvalPolicy: "never",
      sandboxPolicy: job.sandbox === "workspace-write"
        ? { type: "workspaceWrite", writableRoots: [this.workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
        : { type: "readOnly", networkAccess: false },
      ...(job.model ? { model: job.model } : {}),
    });
    if (typeof turn?.turn?.id !== "string" || !turn.turn.id || turn.turn.id.length > 256) {
      this.onFailure(new Error("Codex returned an invalid turn ID; execution outcome is unknown"));
      return;
    }
    this.save({ ...this.store.get(job.id), turnId: turn.turn.id, status: "running" });
    if (this.earlyCompletion?.turn?.id === turn.turn.id) {
      this.complete(this.earlyCompletion);
    } else if (["completed", "failed", "interrupted"].includes(turn.turn.status)) {
      this.complete({ threadId: result.thread.id, turn: turn.turn });
    } else if (this.blockedReason) {
      await this.handle("interrupt", { id: job.id });
    }
  }

  notification({ method, params }) {
    if (method !== "turn/completed" || !this.active) return;
    const job = this.store.get(this.active);
    if (params?.threadId !== job.threadId) return;
    if (!job.turnId) this.earlyCompletion = params;
    else if (params.turn?.id === job.turnId) this.complete(params);
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

  serverRequest(message) {
    // Never grant unattended approvals or invent answers to user questions.
    const method = message.method;
    let result;
    if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) result = { decision: "decline" };
    else if (method === "item/permissions/requestApproval") result = { permissions: {}, scope: "turn" };
    this.codex.send(result
      ? { id: message.id, result }
      : { id: message.id, error: { code: -32601, message: "Interactive requests are not supported by PwrAgent Headless" } });
    if (!this.active) return;
    this.blockedReason = `Interactive request requires an operator: ${method}`;
    const job = this.store.get(this.active);
    if (job.turnId) void this.handle("interrupt", { id: job.id }).catch(this.onFailure);
  }

  finish(id, status, reason) {
    this.save({ ...this.store.get(id), status, ...(reason ? { reason: String(reason).slice(0, 4096) } : {}), finishedAt: new Date().toISOString() });
    if (this.active === id) this.active = null;
  }

  async stop() {
    this.stopping = true;
    await this.codex.stop();
    await this.work;
    if (this.active) this.finish(this.active, "unknown", "Daemon stopped; inspect the thread before explicitly continuing");
  }
}
