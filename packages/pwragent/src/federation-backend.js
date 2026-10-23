import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ACTIVE, atomicJson, digest } from "./store.js";

export const METHOD_CAPABILITIES = Object.fromEntries([
  ...["getNavigationQueryPage", "getNavigationLaunchpadConfig", "getNavigationSelectedDetail", "getNavigationQueueProjection", "releaseNavigationAttentionView", "listThreads", "listBackends", "resolveThread", "resolveThreadAdmissionState", "markThreadSeen", "getProjectPage", "lookupArchivedThreads"].map((method) => [`backend.${method}`, "thread_navigation"]),
  ...["readThread", "listSkills", "listThreadMcpServers"].map((method) => [`backend.${method}`, "thread_detail"]),
  ...["startThread", "startTurn", "interruptTurn", "steerTurn", "controlActiveTurn", "renameThread", "setThreadModelSettings", "setThreadExecutionMode"].map((method) => [`backend.${method}`, "turn_control"]),
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
    this.file = path.join(path.dirname(runtime.store.directory), "threads.json");
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.threads)) throw new Error("Invalid headless thread registry");
      this.threads = new Map(data.threads.map((thread) => [thread.id, thread]));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.threads = new Map();
    }
    runtime.ownsThread = (id) => this.threads.has(id);
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
        createdAt: Date.parse(job.createdAt), sandbox: job.sandbox, model: job.model });
      changed = true;
    }
    if (changed) this.persist();
  }

  owned(id) {
    const thread = this.threads.get(id);
    if (!thread) throw new Error("Thread is not owned by this outpost");
    return thread;
  }

  latest(id) {
    return this.latestJobs.get(id);
  }

  summary(thread) {
    const job = this.latest(thread.id);
    const updatedAt = Math.max(thread.updatedAt || thread.createdAt, job ? Date.parse(job.updatedAt) : 0);
    return { id: thread.id, title: thread.title, titleSource: thread.titleSource, source: "codex",
      createdAt: thread.createdAt, updatedAt, projectKey: this.runtime.workspace,
      threadStatus: job && ACTIVE.has(job.status) ? "active" : "idle",
      linkedDirectories: [{ id: this.runtime.workspace, kind: "local", path: this.runtime.workspace, label: path.basename(this.runtime.workspace) }],
      executionMode: mode(thread.sandbox), model: thread.model || undefined,
      reasoningEffort: thread.reasoningEffort, serviceTier: thread.serviceTier,
      inbox: { inInbox: updatedAt > (thread.seenAt || 0), reason: "updated-since-seen" },
      workspaceHandoff: { available: false, unavailableReason: "Workspace handoff is unavailable on this outpost" } };
  }

  event(message) {
    if (message.method === "headless/jobChanged") {
      this.syncJobs([message.params]);
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
    if (params.cwd && path.resolve(params.cwd) !== this.runtime.workspace) throw new Error("Requested workspace is not owned by this outpost");
    const name = method.replace(/^backend\./, "");
    switch (name) {
      case "listBackends": return this.listBackends();
      case "listThreads": return { backend: "codex", fetchedAt: Date.now(), threads: [...this.threads.values()].map((thread) => this.summary(thread)), workspaceRoots: [this.runtime.workspace] };
      case "getNavigationQueryPage": return this.query(params);
      case "getNavigationLaunchpadConfig": return { protocol: 2, revision: "headless-v1", defaults: { backend: "codex", executionMode: "default", workMode: "local" } };
      case "getNavigationSelectedDetail": return { protocol: 2, ref: params.ref, revision: digest(this.summary(this.owned(params.ref.threadId))), readiness: "ready", identity: "present", thread: this.summary(this.owned(params.ref.threadId)), collections: [] };
      case "getNavigationQueueProjection": return { protocol: 2, ref: params.ref, revision: "no-queue", readiness: "ready", complete: true, entries: [] };
      case "releaseNavigationAttentionView": return {};
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
        directories: (!params.projectKey || params.projectKey === this.runtime.workspace)
          && (!params.afterKey || this.runtime.workspace > params.afterKey)
          ? [{ key: this.runtime.workspace, kind: "directory", path: this.runtime.workspace, label: path.basename(this.runtime.workspace), threadKeys: [] }] : [] };
      case "readThread": return this.readThread(params.threadId);
      case "startThread": return this.startThread(params);
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
        thread.seenAt = Date.now();
        this.persist();
        this.invalidate(thread.id);
        return { backend: "codex", threadId: thread.id, seenAt: thread.seenAt };
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

  async startThread(params) {
    if (this.runtime.active || this.creating) throw new Error("Outpost is busy");
    if (params.workMode && params.workMode !== "local") throw new Error("Outpost threads use the configured workspace; worktree creation is unavailable");
    if (this.threads.size >= 10000) throw new Error("Thread retention limit reached");
    const sandbox = sandboxFor(params);
    for (const key of ["model", "reasoningEffort", "serviceTier"]) {
      if (params[key] !== undefined && (typeof params[key] !== "string" || !params[key] || params[key].length > 200)) throw new Error(`Invalid ${key}`);
    }
    this.creating = true;
    try {
      const result = await this.runtime.codex.request("thread/start", { cwd: this.runtime.workspace, approvalPolicy: "never", sandbox, ...(params.model ? { model: params.model } : {}), ephemeral: false });
      if (!result?.thread?.id || typeof result.thread.id !== "string" || result.thread.id.length > 256) throw new Error("Invalid thread/start response");
      const thread = { id: result.thread.id, title: "New outpost thread", titleSource: "fallback", createdAt: Date.now(), sandbox,
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
    const sandbox = sandboxFor(params, thread.sandbox);
    const prompt = textInput(params.input);
    if (params.queueEntryId !== undefined && (typeof params.queueEntryId !== "string" || !params.queueEntryId || params.queueEntryId.length > 256)) throw new Error("Invalid submission identity");
    const job = this.runtime.submit({ id: `fed-${digest([envelope.sourceInstanceId, params.queueEntryId || envelope.id])}`, prompt,
      threadId: thread.id, sandbox, model: params.model || thread.model,
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
      for (const [index, item] of (turn.items || []).entries()) {
        const itemId = item.id || `${turn.id}-${index}`;
        if (item.type === "agentMessage" || item.type === "userMessage") {
          entries.push({ type: "message", id: itemId, role: item.type === "agentMessage" ? "assistant" : "user",
            text: item.text || (item.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n"),
            turn: { id: turn.id, status: turn.status } });
        } else {
          const details = item.type === "commandExecution" ? [{ id: itemId, kind: "command", label: item.command,
            command: { displayCommand: item.command, cwd: item.cwd, output: item.aggregatedOutput || "", exitCode: item.exitCode, durationMs: item.durationMs } }]
            : [{ id: itemId, kind: item.type === "fileChange" ? "write" : "read", label: item.type, markdown: JSON.stringify(item, null, 2) }];
          entries.push({ type: "activity", id: itemId, summary: item.command || item.type,
            status: item.status === "inProgress" ? "in_progress" : item.status === "failed" ? "failed" : "completed", details, turn: { id: turn.id, status: turn.status } });
        }
      }
    }
    const messages = entries.filter((entry) => entry.type === "message");
    return { backend: "codex", threadId: id, fetchedAt: Date.now(), threadStatus: this.summary(this.owned(id)).threadStatus,
      replay: { entries, messages, lastUserMessage: messages.filter((item) => item.role === "user").at(-1)?.text,
        lastAssistantMessage: messages.filter((item) => item.role === "assistant").at(-1)?.text,
        pagination: { supportsPagination: false, hasPreviousPage: false } } };
  }

  query(request) {
    if (request.protocol !== 2 || !request.query || request.inventory === "viewer") throw new Error("Expected owner navigation protocol 2");
    let rows = [...this.threads.values()].map((thread) => this.summary(thread));
    const counts = { total: rows.length, active: rows.filter((row) => row.threadStatus === "active").length,
      unread: rows.filter((row) => row.inbox.inInbox).length, review: rows.filter((row) => row.inbox.inInbox && row.threadStatus !== "active").length, pinned: 0 };
    const directory = { key: this.runtime.workspace, kind: "directory", label: path.basename(this.runtime.workspace), path: this.runtime.workspace,
      counts, pinnedRootCount: 0, unpinnedRootCount: rows.length, launchpadPresent: true, launchpadBackend: "codex" };
    const query = request.query;
    if (!["exact", "children", "group-members", "directory", "lens", "search", "directory-index", "messaging-projects", "messaging-threads", "model-inventory", "star-map", "star-map-geometry"].includes(query.kind)) throw new Error("Unsupported navigation query");
    if (request.backend && !["codex", "all"].includes(request.backend)) rows = [];
    if (query.kind === "exact") rows = rows.filter((row) => query.identities?.some((ref) => ref.backend === "codex" && ref.threadId === row.id));
    else if (["children", "group-members"].includes(query.kind) || query.roots === "pinned") rows = [];
    else if (query.kind === "directory" && query.directoryKey !== this.runtime.workspace) rows = [];
    else if (query.kind === "lens" && query.lens === "attention") rows = rows.filter((row) => row.threadStatus === "active" || row.inbox.inInbox);
    if (query.agentOnly || (query.allowedBackends && !query.allowedBackends.includes("codex"))) rows = [];
    if (query.projectKey && query.projectKey !== this.runtime.workspace) rows = [];
    if (query.directoryKey && query.directoryKey !== this.runtime.workspace) rows = [];
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
    rows.sort((a, b) => (creationOrder ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
    const queryKey = digest({ backend: request.backend, query });
    const generation = digest(rows);
    let offset = 0;
    if (request.cursor) {
      const cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString());
      if (cursor.queryKey !== queryKey || cursor.generation !== generation || cursor.epoch !== this.epoch
        || !Number.isInteger(cursor.offset) || cursor.offset < 0) throw new Error("Navigation cursor expired; refresh the collection");
      offset = cursor.offset;
    } else if (request.anchor?.kind === "thread") {
      const index = rows.findIndex((row) => row.id === request.anchor.ref.threadId && request.anchor.ref.backend === "codex");
      if (index >= 0) offset = index;
    }
    const limit = Math.min(100, Math.max(1, Number.isInteger(request.pageSize) ? request.pageSize : 50));
    const page = rows.slice(offset, offset + limit);
    const complete = offset + page.length >= rows.length;
    const result = { protocol: 2, queryKey, generation, ownerEpoch: this.epoch, countsRevision: digest(counts), coverage: { state: "complete" }, counts,
      collectionSize: rows.length, rangeStart: offset, complete,
      entries: page.map((row, index) => ({ row: { ...row, ref: { backend: "codex", threadId: row.id }, rowRevision: digest(row),
        ordinaryChildCount: 0, nativeSubAgentGroupPresent: false, queueCount: 0, queueState: "ready" }, orderKey: String(offset + index).padStart(8, "0"), placement: { kind: "root" } })),
      ...(!complete ? { nextCursor: Buffer.from(JSON.stringify({ queryKey, generation, epoch: this.epoch, offset: offset + page.length })).toString("base64url") } : {}) };
    if (["directory-index", "messaging-projects", "star-map-geometry"].includes(query.kind)) {
      const matches = (!query.keys || query.keys.includes(directory.key)) && (!query.paths || query.paths.includes(directory.path))
        && (!query.directoryKey || query.directoryKey === directory.key)
        && (!query.allowedBackends || query.allowedBackends.includes("codex")) && !query.agentOnly
        && (!filter || `${directory.label} ${directory.path}`.toLowerCase().includes(filter.toLowerCase()));
      result.directories = matches ? [directory] : []; result.collectionSize = result.directories.length;
      result.entries = []; result.complete = true; delete result.nextCursor;
    }
    if (query.kind === "model-inventory") {
      const groups = new Map();
      for (const row of rows) { const key = row.model || ""; groups.set(key, { backend: "codex", model: row.model, threadCount: (groups.get(key)?.threadCount || 0) + 1, fastThreadCount: 0 }); }
      result.modelGroups = [...groups.values()]; result.collectionSize = groups.size;
      result.entries = []; result.complete = true; delete result.nextCursor;
    }
    if (query.kind === "directory" && query.directoryKey === directory.key) result.selectionDirectory = directory;
    if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new Error("Navigation page exceeds its byte budget; request fewer rows");
    return result;
  }
}
