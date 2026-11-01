import { OutpostProjects } from "./projects.js";
import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { AgentToolRouter, buildPwrAgentMessagingToolDefinitions, readPwrAgentMessagingDynamicToolCall, resolveMessagingOutboundFile, validateMessagingFileMetadata, FILE_PUSH_MAX_BYTES } from "../dist/federation-core.js";
import { Codex } from "./codex.js";
import { ACTIVE, atomicJson, digest, privateDirectory, validId } from "./store.js";

export class Runtime {
  constructor({ store, workspace, home, command, onFailure }) {
    this.store = store;
    this.workspace = workspace;
    this.projects = new OutpostProjects(path.dirname(store.directory), workspace);
    this.messagingTools = new AgentToolRouter(buildPwrAgentMessagingToolDefinitions((request) => this.messagingRequest(request), { nativeDynamicPdfImages: true }));
    this.fileAccess = { privateStorageRoots: [home, process.env.PWRAGENT_HOME].filter(Boolean),
      deniedRoots: [home, path.dirname(store.directory)], denyHardLinks: true };
    this.toolLedgerDirectory = path.join(path.dirname(store.directory), "tool-calls");
    privateDirectory(this.toolLedgerDirectory);
    this.toolLedger = new Map();
    this.toolLedgerCount = readdirSync(this.toolLedgerDirectory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length;
    this.loadedThreads = new Set();
    this.onFailure = onFailure;
    this.codex = new Codex({
      command, home, workspace,
      onNotification: (message) => { this.notification(message); this.onEvent?.(message); },
      onRequest: (message) => this.serverRequest(message),
      onFailure,
    });
  }

  save(job) {
    try {
      const saved = this.store.save(job);
      this.onEvent?.({ method: "headless/jobChanged", params: saved });
      return saved;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  async handle(method, params = {}) {
    if (this.stopping) throw new Error("Daemon is stopping");
    switch (method) {
      case "status": return { version: 1, ready: true, pid: process.pid, activeJob: this.active || null, workspace: this.workspace };
      case "project-list": return this.projects.list();
      case "project-create": case "project-clone": return this.projects.create(params);
      case "project-add": return this.projects.add(params);
      case "project-remove": return this.projects.remove(params.path, this.listOwnedThreads?.() || []);
      case "git-auth-configure": return this.projects.git.configure(params);
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
        try {
          await this.codex.request("turn/interrupt", { threadId: job.threadId, turnId: job.turnId });
        } catch (error) {
          const current = this.store.get(job.id);
          if (current.status === "interrupting" && current.turnId === job.turnId) {
            this.save({ ...current, status: job.status });
          }
          throw error;
        }
        return this.store.get(job.id);
      }
      default: throw new Error(`Unknown command: ${method}`);
    }
  }

  submit(params) {
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
    const fingerprint = digest({ prompt, threadId, model, sandbox, ...(cwd !== this.workspace ? { cwd } : {}), ...(params.messageOrigin ? { messageOrigin: params.messageOrigin } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), ...(serviceTier ? { serviceTier } : {}) });
    const prior = this.store.jobs.get(id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("Job ID was already used with different input");
      return prior;
    }
    if (this.intakeBusy) throw new Error("Outpost thread intake is in progress; no job was queued");
    if (this.active) throw new Error(`Daemon is busy with job ${this.active}; no job was queued`);
    if (this.store.jobs.size >= 10000) throw new Error("Job retention limit reached (10000); use a new profile");
    const job = this.save({ version: 1, id, fingerprint, status: "starting", threadId,
      model, sandbox, cwd, messageOrigin: params.messageOrigin, reasoningEffort, serviceTier, createdAt: new Date().toISOString() });
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
    const cwd = this.projects.resolve(job.cwd || this.workspace);
    const params = { cwd, approvalPolicy: "never", sandbox: job.sandbox,
      ...(job.model ? { model: job.model } : {}) };
    const result = job.threadId && this.loadedThreads.has(job.threadId) ? { thread: { id: job.threadId } }
      : await this.codex.request(job.threadId ? "thread/resume" : "thread/start", {
        ...params,
        ...(job.threadId ? { threadId: job.threadId } : { ephemeral: false, dynamicTools: this.messagingTools.buildDynamicToolSpecs() }),
      });
    if (typeof result?.thread?.id !== "string" || !result.thread.id || result.thread.id.length > 256
      || (job.threadId && result.thread.id !== job.threadId)) {
      throw new Error("Codex returned an invalid thread ID");
    }
    this.loadedThreads.add(result.thread.id);
    this.save({ ...this.store.get(job.id), threadId: result.thread.id,
      ...(!job.threadId ? { messagingFileTools: true } : {}) });
    const turn = await this.codex.request("turn/start", {
      threadId: result.thread.id,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd,
      approvalPolicy: "never",
      sandboxPolicy: job.sandbox === "workspace-write"
        ? { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
        : { type: "readOnly", networkAccess: false },
      ...(job.model ? { model: job.model } : {}),
      ...(job.reasoningEffort ? { effort: job.reasoningEffort } : {}),
      ...(job.serviceTier ? { serviceTier: job.serviceTier } : {}),
    });
    if (typeof turn?.turn?.id !== "string" || !turn.turn.id || turn.turn.id.length > 256) {
      this.onFailure(new Error("Codex returned an invalid turn ID; execution outcome is unknown"));
      return;
    }
    this.save({ ...this.store.get(job.id), turnId: turn.turn.id, status: "running" });
    // The prompt stays in memory: job records never store it.
    this.onEvent?.({ method: "headless/turnStarted", params: { threadId: result.thread.id, jobId: job.id, prompt } });
    if (this.earlyCompletion?.turn?.id === turn.turn.id) {
      this.complete(this.earlyCompletion);
    } else if (["completed", "failed", "interrupted"].includes(turn.turn.status)) {
      this.complete({ threadId: result.thread.id, turn: turn.turn });
    } else if (this.blockedReason) {
      await this.handle("interrupt", { id: job.id });
    }
  }

  notification({ method, params }) {
    if (method === "thread/closed") this.loadedThreads.delete(params?.threadId);
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

  async messagingRequest(request) {
    const job = this.active && this.store.get(this.active);
    if (!job || job.threadId !== request.context.threadId || (job.turnId && job.turnId !== request.context.turnId)) return { ok: false, error: { code: "forbidden", message: "Messaging call does not belong to the active outpost turn" } };
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
      void this.dispatchTool(call).then((result) => this.codex.send({ id: message.id, result }),
        (error) => this.codex.send({ id: message.id, result: { success: false, contentItems: [{ type: "inputText", text: error.message }] } }));
      return;
    }
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
