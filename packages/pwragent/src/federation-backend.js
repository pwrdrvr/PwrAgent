import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mergeCausalMessagingContext } from "../dist/federation-core.js";
import { ACTIVE, atomicJson, digest } from "./store.js";

export const METHOD_CAPABILITIES = Object.fromEntries([
  ["backend.resolveThreadAdmissionState", "messaging_route"],
  ...["getNavigationQueryPage", "getNavigationLaunchpadConfig", "getNavigationSelectedDetail", "getNavigationQueueProjection", "releaseNavigationAttentionView", "listThreads", "listBackends", "resolveThread", "markThreadSeen", "getProjectPage", "lookupArchivedThreads"].map((method) => [`backend.${method}`, "thread_navigation"]),
  ...["readThread", "readTurnAssistantReply", "listSkills", "listThreadMcpServers"].map((method) => [`backend.${method}`, "thread_detail"]),
  ...["startThread", "materializeDirectoryLaunchpad", "startTurn", "interruptTurn", "steerTurn", "controlActiveTurn", "renameThread", "setThreadModelSettings", "setThreadExecutionMode"].map((method) => [`backend.${method}`, "turn_control"]),
]);

function mode(sandbox) { return sandbox === "workspace-write" ? "auto" : "default"; }
function sandboxFor(params, fallback = "read-only") {
  if (params.executionMode && !["default", "auto", "full-access"].includes(params.executionMode)) throw new Error("Unsupported execution mode");
  if (params.executionMode === "full-access" || params.sandbox === "danger-full-access") throw new Error("Full access is unavailable on this outpost");
  const value = params.sandbox || (params.executionMode === "auto" ? "workspace-write" : params.executionMode === "default" ? "read-only" : fallback);
  if (!["read-only", "workspace-write"].includes(value)) throw new Error("Unsupported sandbox policy");
  if (params.approvalPolicy && params.approvalPolicy !== "never") throw new Error("This unattended outpost requires approvalPolicy never");
  return value;
}
function textInput(input) {
  if (!Array.isArray(input) || !input.length || input.some((item) => item?.type !== "text" || typeof item.text !== "string")) {
    throw new Error("Headless federation currently accepts text input only");
  }
  return input.map((item) => item.text).join("\n");
}

export class HeadlessBackend {
  constructor(runtime, publish) {
    this.runtime = runtime;
    this.publish = publish;
    this.epoch = randomUUID();
    this.attentionViews = new Map();
    this.file = path.join(path.dirname(runtime.store.directory), "threads.json");
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.threads)) throw new Error("Invalid headless thread registry");
      this.threads = new Map(data.threads.map((thread) => [thread.id, thread]));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.threads = new Map();
    }
    runtime.ownsThread = (id) => this.threads.has(id) && !this.threads.get(id).archived;
    runtime.threadCwd = (id) => this.owned(id).cwd || runtime.workspace;
    runtime.listOwnedThreads = () => [...this.threads.values()].filter((thread) => !thread.archived);
    this.latestJobs = new Map();
    this.syncJobs();
  }

  persist() {
    try { atomicJson(this.file, { version: 1, threads: [...this.threads.values()] }); }
    catch (error) { this.runtime.onFailure(error); throw error; }
  }

  syncJobs(jobs = this.runtime.store.jobs.values()) {
    let changed = false;
    for (const job of jobs) {
      if (!job.threadId) continue;
      const previous = this.latestJobs.get(job.threadId);
      if (!previous || previous.id === job.id || job.createdAt > previous.createdAt) this.latestJobs.set(job.threadId, job);
      if (this.threads.has(job.threadId)) continue;
      this.threads.set(job.threadId, { id: job.threadId, title: `Thread ${job.threadId.slice(0, 8)}`, titleSource: "fallback",
        createdAt: Date.parse(job.createdAt), cwd: job.cwd || this.runtime.workspace, sandbox: job.sandbox, model: job.model });
      changed = true;
    }
    if (changed) this.persist();
  }

  owned(id) {
    const thread = this.threads.get(id);
    if (!thread || thread.archived) throw new Error("Thread is not owned by this outpost");
    return thread;
  }

  latest(id) {
    return this.latestJobs.get(id);
  }

  summary(thread) {
    const cwd = thread.cwd || this.runtime.workspace;
    const job = this.latest(thread.id);
    const updatedAt = Math.max(thread.updatedAt || thread.createdAt, job ? Date.parse(job.updatedAt) : 0);
    return { id: thread.id, title: thread.title, titleSource: thread.titleSource, source: "codex",
      createdAt: thread.createdAt, updatedAt, projectKey: cwd,
      threadStatus: job && ACTIVE.has(job.status) ? "active" : "idle",
      linkedDirectories: [{ id: cwd, kind: "local", path: cwd, label: path.basename(cwd) }],
      executionMode: mode(thread.sandbox), model: thread.model || undefined,
      reasoningEffort: thread.reasoningEffort, serviceTier: thread.serviceTier,
      inbox: { inInbox: updatedAt > (thread.seenUpdatedAt ?? thread.seenAt ?? 0), reason: "updated-since-seen" },
      workspaceHandoff: { available: false, unavailableReason: "Workspace handoff is unavailable on this outpost" } };
  }

  event(message) {
    if (message.method === "headless/jobChanged") {
      this.syncJobs([message.params]);
      if (message.params.threadId) this.forgetSeenAttentionMember(message.params.threadId);
      this.publish({ backend: "codex", notification: { method: "navigation/invalidated", params: { threadId: message.params.threadId, sourceMethod: "turn/completed" } } }, "navigation");
      return;
    }
    const id = message.params?.threadId || message.params?.thread?.id;
    if (!this.threads.has(id)) return;
    // The desktop adapter represents failed completions as turn/failed and
    // supplies turnId alongside the provider's nested turn object.
    const turnId = message.params?.turnId || message.params?.turn?.id;
    const notification = { method: message.method === "turn/completed" && message.params.turn?.status === "failed" ? "turn/failed" : message.method,
      params: { ...message.params, ...(turnId ? { turnId } : {}) } };
    this.publish({ backend: "codex", notification }, "transcript");
    if (["thread/started", "turn/started", "turn/completed", "thread/status/changed"].includes(message.method)) {
      this.publish({ backend: "codex", notification: { method: "navigation/invalidated", params: { threadId: id, sourceMethod: message.method } } }, "navigation");
    }
  }

  async handle(method, params = {}, envelope = {}) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Expected request parameters");
    if (params.backend && !["codex", "all"].includes(params.backend)) throw new Error("This outpost serves Codex only");
    if (params.ref && params.ref.backend !== "codex") throw new Error("This outpost serves Codex only");
    if (params.cwd) this.runtime.projects.resolve(params.cwd);
    const name = method.replace(/^backend\./, "");
    switch (name) {
      case "listBackends": return this.listBackends();
      case "listThreads": return { backend: "codex", fetchedAt: Date.now(), threads: [...this.threads.values()].filter((thread) => !thread.archived).map((thread) => this.summary(thread)), workspaceRoots: this.runtime.projects.list().map((project) => project.path) };
      case "getNavigationQueryPage": return this.query(params);
      case "getNavigationLaunchpadConfig": {
        if (params.protocol !== 2) throw new Error("Unsupported navigation protocol");
        if (params.directoryKey !== undefined) this.runtime.projects.resolve(params.directoryKey);
        return { protocol: 2, revision: "headless-v1", ...(params.directoryKey ? { directoryKey: params.directoryKey } : {}),
          ...(params.knownRevision === "headless-v1" ? { unchanged: true } : { defaults: { backend: "codex", executionMode: "default", workMode: "local" } }) };
      }
      case "getNavigationSelectedDetail": return { protocol: 2, ref: params.ref, revision: digest(this.summary(this.owned(params.ref.threadId))), readiness: "ready", identity: "present", thread: this.summary(this.owned(params.ref.threadId)), collections: [] };
      case "getNavigationQueueProjection": return { protocol: 2, ref: params.ref, revision: "no-queue", readiness: "ready", complete: true, entries: [] };
      case "releaseNavigationAttentionView": this.attentionViews.delete(params.viewId); return {};
      case "resolveThread": return this.threads.has(params.threadId) ? { thread: this.summary(this.owned(params.threadId)) } : {};
      case "resolveThreadAdmissionState": {
        const thread = this.summary(this.owned(params.threadId));
        const job = this.latest(params.threadId);
        return { thread, threadStatus: thread.threadStatus,
          ...(job?.turnId && ACTIVE.has(job.status) ? { activeTurn: { backend: "codex", threadId: thread.id, turnId: job.turnId } } : {}) };
      }
      case "lookupArchivedThreads": return { threads: [] };
      case "getProjectPage": return { backend: "codex", fetchedAt: Date.now(),
        launchpadDefaults: { backend: "codex", executionMode: "default", workMode: "local" },
        directories: this.runtime.projects.list().filter((project) => (!params.projectKey || params.projectKey === project.path)
          && (!params.afterKey || project.path > params.afterKey)).map((project) => ({ key: project.path, kind: "directory", path: project.path, label: project.label, threadKeys: [] })) };
      case "readTurnAssistantReply": {
        const history = await this.readThread(params.threadId);
        const messages = history.replay.messages.filter((message) => message.role === "assistant" && message.turn?.id === params.turnId);
        return { message: messages.find((message) => params.itemId ? message.id === params.itemId : message.text === params.text) || null };
      }
      case "readThread": return this.readThread(params.threadId);
      case "startThread": return this.startThread(params);
      case "materializeDirectoryLaunchpad": return this.materializeLaunchpad(params, envelope);
      case "startTurn": return this.startTurn(params, envelope);
      case "interruptTurn": {
        this.owned(params.threadId);
        const job = this.latest(params.threadId);
        if (!job || !ACTIVE.has(job.status)) throw new Error("Thread has no active turn");
        if (params.turnId && params.turnId !== job.turnId) throw new Error("Active turn changed");
        await this.runtime.handle("interrupt", { id: job.id });
        return { backend: "codex", threadId: params.threadId, turnId: job.turnId };
      }
      case "steerTurn": case "controlActiveTurn": {
        this.owned(params.threadId);
        const job = this.latest(params.threadId);
        if (!job || !ACTIVE.has(job.status) || !job.turnId) throw new Error("Thread has no active turn");
        if (params.expectedTurnId && params.expectedTurnId !== job.turnId) throw new Error("Active turn changed");
        if (name === "controlActiveTurn" && params.operation === "stop") {
          await this.runtime.handle("interrupt", { id: job.id });
          return { ok: true, backend: "codex", threadId: params.threadId, requestId: params.requestId, turnId: job.turnId, disposition: "interrupted" };
        }
        if (name === "controlActiveTurn" && params.operation !== "steer") throw new Error("Unsupported active-turn operation");
        const input = [{ type: "text", text: textInput(params.input), text_elements: [] }];
        const incoming = this.authenticateOrigin?.(params.messageOrigin, envelope);
        if (incoming) {
          const original = job.messageOrigin;
          this.runtime.save({ ...job, messageOrigin: { ...incoming, ...mergeCausalMessagingContext([original, incoming]) } });
        }
        const result = await this.runtime.codex.request("turn/steer", { threadId: params.threadId, expectedTurnId: params.expectedTurnId || job.turnId, input });
        return { backend: "codex", threadId: params.threadId, turnId: result.turnId || job.turnId, disposition: "steered",
          ...(name === "controlActiveTurn" ? { ok: true, requestId: params.requestId } : {}) };
      }
      case "renameThread": {
        const thread = this.owned(params.threadId);
        const title = params.title || params.name;
        if (typeof title !== "string" || !title.trim() || title.length > 200) throw new Error("Invalid title");
        Object.assign(thread, { title: title.trim(), titleSource: "explicit", updatedAt: Date.now() });
        this.persist();
        this.invalidate(thread.id);
        return { backend: "codex", threadId: thread.id, title: thread.title };
      }
      case "markThreadSeen": {
        const thread = this.owned(params.threadId);
        for (const key of ["seenAt", "seenUpdatedAt"]) {
          if (params[key] !== undefined && (!Number.isFinite(params[key]) || params[key] < 0)) throw new Error(`Invalid ${key}`);
        }
        const seenUpdatedAt = params.seenUpdatedAt ?? this.summary(thread).updatedAt;
        thread.seenAt = params.seenAt ?? Date.now();
        thread.seenUpdatedAt = seenUpdatedAt;
        this.persist();
        this.forgetSeenAttentionMember(thread.id);
        this.invalidate(thread.id);
        return { backend: "codex", threadId: thread.id, seenAt: thread.seenAt, seenUpdatedAt };
      }
      case "setThreadExecutionMode": {
        const thread = this.owned(params.threadId);
        thread.sandbox = sandboxFor({ executionMode: params.executionMode });
        this.persist();
        this.invalidate(thread.id);
        return { backend: "codex", threadId: thread.id, executionMode: mode(thread.sandbox) };
      }
      case "setThreadModelSettings": {
        const thread = this.owned(params.threadId);
        for (const key of ["model", "reasoningEffort", "serviceTier"]) {
          if (params[key] !== undefined && (typeof params[key] !== "string" || params[key].length > 200)) throw new Error(`Invalid ${key}`);
          if (params[key] !== undefined) thread[key] = params[key];
        }
        this.persist();
        this.invalidate(thread.id);
        return { backend: "codex", threadId: thread.id, model: thread.model, reasoningEffort: thread.reasoningEffort, serviceTier: thread.serviceTier };
      }
      case "listSkills": case "listThreadMcpServers": throw new Error("This inventory is not exposed by the headless adapter");
      default: throw new Error(`Unsupported outpost operation: ${method}`);
    }
  }

  invalidate(threadId) { this.publish({ backend: "codex", notification: { method: "navigation/invalidated", params: { threadId } } }, "navigation"); }

  async materializeLaunchpad(params, envelope) {
    const cwd = this.runtime.projects.resolve(params.directoryKey);
    const draft = params.launchpad || {};
    if (draft.backend && draft.backend !== "codex") throw new Error("This outpost serves Codex only");
    if (draft.directoryPath && draft.directoryPath !== cwd) throw new Error("Requested workspace is not owned by this outpost");
    if (params.parentThreadId || params.agent || params.reviewTarget || params.scheduledFor || params.collaborationMode
      || (params.codexEnvironmentSelector && params.codexEnvironmentSelector !== "none") || draft.codexEnvironmentId
      || draft.branchName || draft.acpRuntime || draft.fastMode || draft.tokenMiserEnabled || draft.mcpConnectionIds?.length) {
      throw new Error("This outpost supports local workspace launchpads without grouping, environments or provider extensions");
    }
    const input = params.input?.length ? params.input : draft.prompt ? [{ type: "text", text: draft.prompt }] : undefined;
    if (input) textInput(input);
    const created = { ...await this.startThread({ ...draft, cwd }), workMode: "local" };
    if (!input) return created;
    try {
      const turn = await this.startTurn({ ...draft, threadId: created.threadId, input }, envelope);
      return { ...created, turnId: turn.turnId };
    } catch (error) {
      return { ...created, turnStartFailure: { message: error.message, phase: "turn" } };
    }
  }

  async startThread(params) {
    if (this.runtime.active || this.runtime.intakeBusy || this.creating) throw new Error("Outpost is busy");
    if (params.workMode && params.workMode !== "local") throw new Error("Outpost threads use the configured workspace; worktree creation is unavailable");
    if (this.threads.size >= 10000) throw new Error("Thread retention limit reached");
    const sandbox = sandboxFor(params);
    for (const key of ["model", "reasoningEffort", "serviceTier"]) {
      if (params[key] !== undefined && (typeof params[key] !== "string" || !params[key] || params[key].length > 200)) throw new Error(`Invalid ${key}`);
    }
    const cwd = this.runtime.projects.resolve(params.cwd || params.directoryPath || params.projectKey);
    this.creating = true;
    try {
      const result = await this.runtime.codex.request("thread/start", { cwd, dynamicTools: this.runtime.messagingTools.buildDynamicToolSpecs(), approvalPolicy: "never", sandbox, ...(params.model ? { model: params.model } : {}), ephemeral: false });
      if (!result?.thread?.id || typeof result.thread.id !== "string" || result.thread.id.length > 256) throw new Error("Invalid thread/start response");
      this.runtime.loadedThreads.add(result.thread.id);
      const thread = { id: result.thread.id, title: "New outpost thread", titleSource: "fallback", createdAt: Date.now(), cwd, sandbox,
        model: params.model, reasoningEffort: params.reasoningEffort, serviceTier: params.serviceTier };
      this.threads.set(thread.id, thread);
      this.persist();
      this.invalidate(thread.id);
      return { backend: "codex", threadId: thread.id, executionMode: mode(sandbox) };
    } finally { this.creating = false; }
  }

  async startTurn(params, envelope) {
    if (params.collaborationMode || params.fastMode || params.acpRuntime) throw new Error("Collaboration modes, fast mode and ACP settings are unavailable on this outpost");
    const thread = this.owned(params.threadId);
    if (params.cwd && params.cwd !== (thread.cwd || this.runtime.workspace)) throw new Error("Turn cwd differs from its owner thread project");
    const sandbox = sandboxFor(params, thread.sandbox);
    const prompt = textInput(params.input);
    if (params.queueEntryId !== undefined && (typeof params.queueEntryId !== "string" || !params.queueEntryId || params.queueEntryId.length > 256)) throw new Error("Invalid submission identity");
    const job = this.runtime.submit({ id: `fed-${digest([envelope.sourceInstanceId, params.queueEntryId || envelope.id])}`, prompt,
      threadId: thread.id, cwd: thread.cwd || this.runtime.workspace, messageOrigin: this.authenticateOrigin?.(params.messageOrigin, envelope), sandbox, model: params.model || thread.model,
      reasoningEffort: params.reasoningEffort || thread.reasoningEffort, serviceTier: params.serviceTier || thread.serviceTier });
    await this.runtime.work;
    const started = this.runtime.store.get(job.id);
    if (!started.turnId) throw new Error(started.reason || "Turn was not started");
    return { backend: "codex", threadId: thread.id, turnId: started.turnId, queueStatus: "started" };
  }

  async listBackends() {
    const result = await this.runtime.codex.request("model/list", {});
    const models = (result.data || []).map((model) => ({ id: model.id, label: model.displayName || model.id,
      current: model.isDefault, reasoningEfforts: (model.supportedReasoningEfforts || []).map((entry) => entry.reasoningEffort),
      defaultReasoningEffort: model.defaultReasoningEffort, supportsSteering: true, supportsImage: false, supportsFast: false }));
    return { fetchedAt: Date.now(), backends: [{ kind: "codex", label: "Codex (headless outpost)", available: true,
      methods: Object.keys(METHOD_CAPABILITIES), capabilities: { listThreads: true, createThread: true, resumeThread: true,
        renameThread: true, readThread: true, startTurn: true, interruptTurn: true, steerTurn: true,
        transcriptPagination: false, toolUse: true, approvalRequests: false, multiDirectoryThreads: false },
      executionModes: [{ mode: "default", label: "Read-only", available: true, isDefault: true },
        { mode: "auto", label: "Workspace write", available: true }, { mode: "full-access", label: "Full access", available: false }],
      launchpadOptions: { models, supportsFastMode: false } }] };
  }

  async readThread(id) {
    this.owned(id);
    const result = await this.runtime.codex.request("thread/read", { threadId: id, includeTurns: true });
    const entries = [];
    for (const turn of result.thread?.turns || []) {
      const status = turn.status === "inProgress" ? "in_progress" : turn.status;
      const job = [...this.runtime.store.jobs.values()].find((job) => job.threadId === id && job.turnId === turn.id);
      const metadata = { id: turn.id,
        ...(["in_progress", "completed", "failed", "cancelled", "interrupted"].includes(status) ? { status } : {}) };
      for (const [index, item] of (turn.items || []).entries()) {
        const itemId = item.id || `${turn.id}-${index}`;
        if (item.type === "agentMessage" || item.type === "userMessage") {
          entries.push({ type: "message", id: itemId, role: item.type === "agentMessage" ? "assistant" : "user",
            text: item.text || (item.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n"),
            turn: metadata, ...(item.type === "userMessage" && job?.messageOrigin ? { origin: job.messageOrigin } : {}) });
        } else {
          const details = item.type === "commandExecution" ? [{ id: itemId, kind: "command", label: item.command,
            command: { displayCommand: item.command, cwd: item.cwd, output: item.aggregatedOutput || "", exitCode: item.exitCode, durationMs: item.durationMs } }]
            : [{ id: itemId, kind: item.type === "fileChange" ? "write" : "read", label: item.type, markdown: JSON.stringify(item, null, 2) }];
          entries.push({ type: "activity", id: itemId, summary: item.command || item.type,
            status: item.status === "inProgress" ? "in_progress" : item.status === "failed" ? "failed" : "completed", details, turn: metadata });
        }
      }
    }
    const messages = entries.filter((entry) => entry.type === "message");
    return { backend: "codex", threadId: id, fetchedAt: Date.now(), threadStatus: this.summary(this.owned(id)).threadStatus,
      replay: { entries, messages, lastUserMessage: messages.filter((item) => item.role === "user").at(-1)?.text,
        lastAssistantMessage: messages.filter((item) => item.role === "assistant").at(-1)?.text,
        pagination: { supportsPagination: false, hasPreviousPage: false } } };
  }

  forgetSeenAttentionMember(id) {
    const thread = this.threads.get(id);
    if (!thread) return;
    const row = this.summary(thread);
    if (row.threadStatus !== "active" && !row.inbox.inInbox) {
      for (const view of this.attentionViews.values()) view.members.delete(id);
    }
  }

  attentionOrder(rows, options = { id: "default", promoteOnTurnEnd: true }) {
    if (typeof options.id !== "string" || !options.id || options.id.length > 256
      || typeof options.promoteOnTurnEnd !== "boolean") throw new Error("Invalid Attention view");
    let view = this.attentionViews.get(options.id);
    if (!view) {
      if (this.attentionViews.size >= 128) throw new Error("Attention view limit reached; release an unused view");
      view = { members: new Map(), nextRank: 1 };
      this.attentionViews.set(options.id, view);
    }
    const members = new Map();
    // Bootstrap oldest turn first. Subsequent ranks follow turn identities and
    // active/terminal transitions, never mutable thread or job activity stamps.
    const eligible = rows.filter((row) => row.threadStatus === "active" || row.inbox.inInbox)
      .sort((a, b) => (Date.parse(this.latest(a.id)?.createdAt) || a.createdAt)
        - (Date.parse(this.latest(b.id)?.createdAt) || b.createdAt) || a.id.localeCompare(b.id));
    for (const row of eligible) {
      const previous = view.members.get(row.id);
      const job = this.latest(row.id);
      const turnKey = job?.id;
      const active = row.threadStatus === "active";
      const newTurn = turnKey !== previous?.turnKey;
      const started = active && (!previous?.active || newTurn);
      const finished = !active && (previous?.active || newTurn);
      const rank = !previous || started || (finished && options.promoteOnTurnEnd) ? view.nextRank++ : previous.rank;
      members.set(row.id, { rank, active, turnKey });
    }
    view.members = members;
    return members;
  }

  query(request) {
    if (request.protocol !== 2 || !request.query || request.inventory === "viewer") throw new Error("Expected owner navigation protocol 2");
    let rows = [...this.threads.values()].filter((thread) => !thread.archived).map((thread) => this.summary(thread));
    const counts = { total: rows.length, active: rows.filter((row) => row.threadStatus === "active").length,
      unread: rows.filter((row) => row.inbox.inInbox).length, review: rows.filter((row) => row.inbox.inInbox && row.threadStatus !== "active").length, pinned: 0 };
    const directories = this.runtime.projects.list().map((project) => {
      const members = rows.filter((row) => row.projectKey === project.path);
      return { key: project.path, kind: "directory", label: project.label, path: project.path,
        counts: { total: members.length, active: members.filter((row) => row.threadStatus === "active").length,
          unread: members.filter((row) => row.inbox.inInbox).length, review: members.filter((row) => row.inbox.inInbox && row.threadStatus !== "active").length, pinned: 0 },
        pinnedRootCount: 0, unpinnedRootCount: members.length, launchpadPresent: true, launchpadBackend: "codex" };
    });
    const query = request.query;
    const attention = query.kind === "lens" && query.lens === "attention" ? this.attentionOrder(rows, request.attentionView) : undefined;
    if (!["exact", "children", "group-members", "directory", "lens", "search", "directory-index", "messaging-projects", "messaging-threads", "model-inventory", "star-map", "star-map-geometry"].includes(query.kind)) throw new Error("Unsupported navigation query");
    if (request.backend && !["codex", "all"].includes(request.backend)) rows = [];
    if (query.kind === "exact") rows = rows.filter((row) => query.identities?.some((ref) => ref.backend === "codex" && ref.threadId === row.id));
    else if (["children", "group-members"].includes(query.kind) || query.roots === "pinned") rows = [];
    else if (query.kind === "directory") rows = rows.filter((row) => row.projectKey === query.directoryKey);
    else if (query.kind === "lens" && query.lens === "attention") rows = rows.filter((row) => row.threadStatus === "active" || row.inbox.inInbox);
    if (query.agentOnly || (query.allowedBackends && !query.allowedBackends.includes("codex"))) rows = [];
    if (query.projectKey) rows = rows.filter((row) => row.projectKey === query.projectKey);
    if (query.directoryKey) rows = rows.filter((row) => row.projectKey === query.directoryKey);
    if (query.kind === "star-map") {
      for (const [key, selection] of Object.entries(query.filters || {})) {
        if (selection === "neutral") continue;
        rows = rows.filter((row) => {
          const matches = key === "attention" && (row.threadStatus === "active" || row.inbox.inInbox);
          return selection === "include" ? matches : !matches;
        });
      }
    }
    const filter = query.filter || query.text;
    if (filter) rows = rows.filter((row) => row.title.toLowerCase().includes(filter.toLowerCase()));
    const creationOrder = query.kind === "directory" || (query.kind === "lens" && query.lens === "recents");
    rows.sort((a, b) => (attention ? attention.get(b.id).rank - attention.get(a.id).rank
      : creationOrder ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
    const queryKey = digest({ backend: request.backend, query, ...(attention ? { attentionView: request.attentionView } : {}) });
    const generation = digest(attention ? rows.map((row) => ({ ...row, attentionRank: attention.get(row.id).rank })) : rows);
    const countsRevision = digest(counts);
    let offset = 0;
    if (request.cursor) {
      const cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString());
      if (cursor.queryKey !== queryKey || cursor.generation !== generation || cursor.countsRevision !== countsRevision || cursor.epoch !== this.epoch
        || !Number.isInteger(cursor.offset) || cursor.offset < 0) throw new Error("Navigation cursor expired; refresh the collection");
      offset = cursor.offset;
    } else if (request.anchor?.kind === "thread") {
      const index = rows.findIndex((row) => row.id === request.anchor.ref.threadId && request.anchor.ref.backend === "codex");
      if (index >= 0) offset = index;
    }
    const limit = Math.min(100, Math.max(1, Number.isInteger(request.pageSize) ? request.pageSize : 50));
    const page = rows.slice(offset, offset + limit);
    const complete = offset + page.length >= rows.length;
    const result = { protocol: 2, queryKey, generation, ownerEpoch: this.epoch, countsRevision, coverage: { state: "complete" }, counts,
      collectionSize: rows.length, rangeStart: offset, complete,
      entries: page.map((row, index) => ({ row: { ...row, ref: { backend: "codex", threadId: row.id }, rowRevision: digest(row),
        ordinaryChildCount: 0, nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "ready" }, orderKey: String(offset + index).padStart(8, "0"),
        ...(attention ? { attentionRank: attention.get(row.id).rank } : {}), placement: { kind: "root" } })),
      ...(!complete ? { nextCursor: Buffer.from(JSON.stringify({ queryKey, generation, countsRevision, epoch: this.epoch, offset: offset + page.length })).toString("base64url") } : {}) };
    if (["directory-index", "messaging-projects", "star-map-geometry"].includes(query.kind)) {
      result.directories = directories.filter((directory) => (!query.keys || query.keys.includes(directory.key)) && (!query.paths || query.paths.includes(directory.path))
        && (!query.directoryKey || query.directoryKey === directory.key)
        && (!query.allowedBackends || query.allowedBackends.includes("codex")) && !query.agentOnly
        && (!filter || `${directory.label} ${directory.path}`.toLowerCase().includes(filter.toLowerCase())));
      result.collectionSize = result.directories.length;
      result.entries = []; result.complete = true; delete result.nextCursor;
    }
    if (query.kind === "model-inventory") {
      const groups = new Map();
      for (const row of rows) { const key = row.model || ""; groups.set(key, { backend: "codex", model: row.model, threadCount: (groups.get(key)?.threadCount || 0) + 1, fastThreadCount: 0 }); }
      result.modelGroups = [...groups.values()]; result.collectionSize = groups.size;
      result.entries = []; result.complete = true; delete result.nextCursor;
    }
    if (query.kind === "directory") result.selectionDirectory = directories.find((directory) => query.directoryKey === directory.key);
    if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new Error("Navigation page exceeds its byte budget; request fewer rows");
    return result;
  }
}
