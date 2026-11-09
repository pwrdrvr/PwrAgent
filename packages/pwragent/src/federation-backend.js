import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { buildThreadIdentityKey, isAppServerBackendKind, NavigationQueryStore, ThreadNamingLifecycle, projectProviderThreadSummary, FEDERATION_BACKEND_METHOD_CAPABILITIES, FEDERATION_MAX_FRAME_BYTES, fitThreadReplayWithinByteBudget, mergeCausalMessagingContext, pageThreadReplay, shortenDerivedThreadTitle } from "../dist/federation-core.js";
import { ACTIVE, digest } from "./store.js";
import { OutpostThreadRegistry } from "./owner-thread-registry.js";
import { ThreadTitleGenerationService, ThreadTitleLifecycle } from "../dist/federation-core.js";

// The owner methods this outpost serves. Each one's capability comes from the
// shared owner contract, so a grant means the same here as on desktop.
const OWNER_METHODS = [
  "resolveThreadAdmissionState", "supportsMessagingPdfTools",
  "getNavigationQueryPage", "getNavigationLaunchpadConfig", "getNavigationSelectedDetail", "getNavigationQueueProjection",
  "releaseNavigationAttentionView", "listThreads", "listBackends", "resolveThread", "markThreadSeen", "getProjectPage", "lookupArchivedThreads",
  "readThread", "readTurnAssistantReply", "listSkills", "listThreadMcpServers",
  "startThread", "materializeDirectoryLaunchpad", "startTurn", "interruptTurn", "steerTurn", "controlActiveTurn", "renameThread",
  "setThreadModelSettings", "setThreadExecutionMode",
];
export function ownerMethodCapabilities(methods, contract = FEDERATION_BACKEND_METHOD_CAPABILITIES) {
  return Object.fromEntries(methods.map((name) => {
    const method = `backend.${name}`;
    if (!Object.hasOwn(contract, method)) throw new Error(`${method} is not in the shared owner contract`);
    return [method, contract[method]];
  }));
}
export const METHOD_CAPABILITIES = ownerMethodCapabilities(OWNER_METHODS);
const RETAINED_READ_METHODS = ["listThreads", "getNavigationQueryPage", "getNavigationSelectedDetail", "resolveThread", "lookupArchivedThreads", "getProjectPage", "listBackends"];

// The placeholder title desktop gives a new thread. Viewers recognize this
// exact text as "no name yet".
export const PLACEHOLDER_THREAD_TITLE = "Untitled thread";

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
    this.navigation = new NavigationQueryStore();
    this.publish = (event, eventClass) => {
      const thread = this.threads.get(event.notification.params.threadId);
      // Acknowledging an older displayed update does not mark newer work read.
      if (event.notification.method !== "navigation/thread/seen" || (thread && !this.summary(thread).inbox.inInbox)) {
        this.navigation.observeAttentionEvent(event);
      }
      publish(event, eventClass);
    };
    // Same headroom as desktop's FEDERATION_RESPONSE_BYTE_BUDGET.
    this.replayByteBudget = FEDERATION_MAX_FRAME_BYTES - 64 * 1024;
    this.threads = new OutpostThreadRegistry(runtime.store.threadRegistry, runtime.store.inventory, runtime.store.acpSessions, runtime.store.claudeSessions, runtime.store.retainedOwners);
    this.threadRegistry = this.threads;
    this.providerMutationVersion = 0;
    this.naming = new ThreadNamingLifecycle({
      readName: async ({ threadId }) => this.threads.get(threadId)?.title,
      readTitle: async ({ threadId }) => this.summary(this.owned(threadId)),
      renameProvider: async ({ threadId, name }, titleSource) => {
        if (!this.threads.has(threadId)) throw new Error("Thread is not owned by this outpost");
        const result = await this.runtime.codex.renameThread({ threadId, name });
        this.providerMutationVersion++;
        try {
          await this.threadRegistry.updateThreadMetadata({ backend: "codex", threadId }, {
            title: { text: name.trim(), source: titleSource, nativeName: name.trim() },
          });
        } catch (error) { this.runtime.onFailure(error); throw error; }
        this.threads.observeNativeTitle(threadId, name.trim(), titleSource);
        return result;
      },
      getAgent: async () => undefined, setAgent: async () => {},
      invalidate: () => {},
      emit: async event => {
        this.publish(event, "transcript");
        this.invalidate(event.notification.params.threadId, event.notification.method);
      },
      now: () => Date.now(),
    });
    const titleGeneration = new ThreadTitleGenerationService({ generators: {
      codex: { generateTitle: params => runtime.codex.generateTitle(params) },
    } });
    this.titles = new ThreadTitleLifecycle(this.naming, {
      canGenerateTitle: backend => backend === "codex" && !runtime.stopping && typeof runtime.codex?.generateTitle === "function",
      generateTitle: params => titleGeneration.generateTitle(params),
      readTitle: async ({ threadId }) => {
        const thread = this.threads.get(threadId);
        return thread && !thread.archived ? this.summary(thread) : undefined;
      },
      // Outpost has no desktop helper cards or accounting storage. The Codex
      // client owns ephemeral execution, isolation, model selection and cleanup.
      prepareHelper: async () => {}, persistHelper: async () => {}, log: () => {},
    });
    runtime.settleTitles = () => this.titles.whenSettled();
    runtime.ownsThread = (id) => this.threads.has(id) && !this.threads.get(id).archived;
    runtime.threadCwd = (id) => this.owned(id).cwd || runtime.workspace;
    runtime.listOwnedThreads = () => [...this.threads.values()].filter((thread) => !thread.archived);
    this.latestJobs = new Map();
    this.syncJobs();
  }

  async initialize() {
    await this.threads.refreshClaudeThreads();
    await this.refreshThreads();
    this.initialized = true;
  }

  async refreshThreads() {
    if (this.discovery) return this.discovery;
    const discover = async () => {
      let generation = this.providerMutationVersion;
      const observedAt = Date.now();
      // A retained inventory is a startup projection, never proof of current
      // provider membership. Both complete walks must succeed before replacement.
      const active = await this.runtime.codex.listThreads({ archived: false, enrichDirectories: false, requireComplete: true, skipArchivedMetadataRefresh: true });
      const archived = await this.runtime.codex.listThreads({ archived: true, enrichDirectories: false, requireComplete: true });
      const threads = [...active, ...archived.map(thread => ({ ...thread, archivedAt: thread.archivedAt ?? 0 }))]
        .map(projectProviderThreadSummary).sort((a, b) => a.id.localeCompare(b.id));
      if (generation !== this.providerMutationVersion) return;
      for (const native of threads) {
        const identity = { backend: "codex", threadId: native.id };
        const record = await this.threadRegistry.getThreadMetadata(identity);
        const title = record?.title;
        // A legacy/imported owner name has not yet reached Codex. Publish it
        // once, then retain the acknowledgement so a later native rename wins.
        if (title && title.source !== "fallback" && title.nativeName === undefined) {
          // Both native walks completed. Naming may use this positive member
          // even when the preceding owner already settled import retention.
          this.threads.observeCreatedNativeThread(native);
          await this.naming.renameThread({ ...identity, name: title.text, expectedName: title.text }, { titleSource: title.source });
          if (this.providerMutationVersion !== generation + 1) return;
          generation = this.providerMutationVersion;
          native.title = title.text;
          // Codex's native name has no provenance field. The owner retains
          // derived/explicit intent separately from this provider inventory.
          native.titleSource = "explicit";
        }
      }
      if (generation !== this.providerMutationVersion) return;
      const retiredThreadIds = this.threads.absentConfirmedCodexThreadIds(threads);
      const previous = this.runtime.store.inventory.list().find(snapshot => snapshot.backend === "codex");
      if (retiredThreadIds.length || !isDeepStrictEqual(previous?.threads, threads)) {
        this.runtime.store.inventory.replace({ backend: "codex", observedAt, threads }, retiredThreadIds);
      }
      this.threads.replaceInventory(threads, observedAt);
    };
    this.discovery = discover();
    try { await this.discovery; } finally { this.discovery = undefined; }
  }

  persist(thread) {
    try { this.threads.set(thread.id, thread); }
    catch (error) { this.runtime.onFailure(error); throw error; }
  }

  persistCreatedNativeThread(thread) {
    this.persist({ ...thread, nativeMembershipRetired: false });
    this.providerMutationVersion++;
    this.threads.observeCreatedNativeThread(this.summary(thread));
  }

  syncJobs(jobs = this.runtime.store.jobs.values()) {
    for (const job of jobs) {
      if (!job.threadId) continue;
      this.threads.retainAcceptedJobThread(job.threadId);
      const previous = this.latestJobs.get(job.threadId);
      if (!previous || previous.id === job.id || job.createdAt > previous.createdAt) this.latestJobs.set(job.threadId, job);
      // Acceptance keeps its existing metadata boundary even when a read-only
      // job projection can already resolve the identity before finalization.
      if (this.threads.storage.getThreadMetadata({ backend: "codex", threadId: job.threadId })
        || this.threads.inventory.has(buildThreadIdentityKey("codex", job.threadId))) continue;
      this.threads.set(job.threadId, { id: job.threadId, title: `Thread ${job.threadId.slice(0, 8)}`, titleSource: "fallback",
        createdAt: Date.parse(job.createdAt), messagingFileTools: job.messagingFileTools === true, cwd: job.cwd || this.runtime.workspace, sandbox: job.sandbox, model: job.model });
    }
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
    const backend = thread.source ?? "codex";
    const cwd = thread.cwd || (backend === "codex" ? this.runtime.workspace : undefined);
    const job = backend === "codex" ? this.latest(thread.id) : undefined;
    const createdAt = thread.createdAt ?? 0;
    const updatedAt = Math.max(thread.updatedAt ?? createdAt, job ? Date.parse(job.updatedAt) : 0);
    const projected = projectProviderThreadSummary({ ...thread, linkedDirectories: thread.linkedDirectories ?? [] });
    if (!(thread.archived ?? thread.archivedAt !== undefined)) delete projected.archivedAt;
    return { ...projected,
      id: thread.id, title: thread.title ?? "Untitled thread", titleSource: thread.titleSource ?? "fallback", source: backend,
      createdAt, updatedAt, projectKey: cwd,
      threadStatus: backend === "codex" ? (job && ACTIVE.has(job.status) ? "active" : "idle") : projected.threadStatus ?? "idle",
      linkedDirectories: thread.linkedDirectories?.length ? thread.linkedDirectories : cwd ? [{ id: cwd, kind: "local", path: cwd, label: path.basename(cwd) }] : [],
      executionMode: thread.executionMode ?? mode(thread.sandbox), model: thread.model || undefined,
      reasoningEffort: thread.reasoningEffort, serviceTier: thread.serviceTier,
      fastMode: thread.fastMode,
      pinnedRank: thread.pinnedRank, parentThreadId: thread.parentThreadId, parentThreadBackend: thread.parentThreadBackend,
      parentThreadInstanceId: thread.parentThreadInstanceId, subthreadOrder: thread.subthreadOrder, subthreadsCollapsed: thread.subthreadsCollapsed,
      inbox: { inInbox: updatedAt > this.threads.seenWatermark(thread), reason: "updated-since-seen" },
      workspaceHandoff: { available: false, unavailableReason: "Workspace handoff is unavailable on this outpost" } };
  }

  event(message) {
    if (["thread/started", "thread/name/updated", "thread/archived", "thread/unarchived", "turn/completed"].includes(message.method)) this.providerMutationVersion++;
    if (message.method === "headless/turnStarted") {
      const { threadId, jobId, prompt } = message.params;
      const earlier = [...this.runtime.store.jobs.values()].some(job => job.threadId === threadId && job.id !== jobId && job.turnId);
      if (!earlier) {
        this.deriveTitle(threadId, prompt);
        const schedule = () => this.titles.schedule({ backend: "codex", threadId, input: [{ type: "text", text: prompt }] });
        if (this.runtime.codex.runOptionalTitleWork) this.runtime.codex.runOptionalTitleWork(schedule);
        else schedule();
      }
      return;
    }
    if (message.method === "headless/jobChanged") {
      this.syncJobs([message.params]);
      const job = message.params;
      if (job.threadId && this.latest(job.threadId) === job) {
        const active = ACTIVE.has(job.status);
        // An accepted job starts before Codex assigns its turn ID. Let the
        // shared reducer adopt that ID without allocating another start rank.
        this.navigation.observeAttentionEvent({ backend: "codex", notification: {
          method: active ? "turn/started" : "turn/completed",
          params: { threadId: job.threadId, turnId: job.turnId || (active ? undefined : job.id) },
        } });
      }
      this.publish({ backend: "codex", notification: { method: "navigation/invalidated", params: { threadId: message.params.threadId, sourceMethod: "turn/completed" } } }, "navigation");
      return;
    }
    const id = message.params?.threadId || message.params?.thread?.id;
    if (!this.threads.has(id)) return;
    if (message.method === "thread/name/updated") {
      const thread = this.threads.get(id);
      const source = message.params.titleSource || "explicit";
      if (thread.titleSource === "explicit" && source !== "explicit") return;
      this.setTitle(thread, message.params.threadName, source);
      return;
    }
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
    const name = method.replace(/^backend\./, "");
    if (params.backend !== undefined && params.backend !== "all" && (typeof params.backend !== "string" || !isAppServerBackendKind(params.backend))) throw new Error("Unsupported backend");
    if (params.ref && (typeof params.ref.backend !== "string" || !isAppServerBackendKind(params.ref.backend))) throw new Error("Unsupported backend");
    if (!RETAINED_READ_METHODS.includes(name)
      && ((params.backend && params.backend !== "codex") || (params.ref && params.ref.backend !== "codex"))) throw new Error("This outpost executes Codex only");
    if (params.cwd) this.runtime.projects.resolve(params.cwd);
    const scope = params.backend ?? "all";
    const readBackend = params.ref?.backend ?? scope;
    const retainedNavigationPage = name === "getNavigationQueryPage" && Boolean(params.cursor);
    if (!retainedNavigationPage && RETAINED_READ_METHODS.includes(name) && (readBackend === "all" || readBackend === "claude")) {
      await this.threads.refreshClaudeThreads();
    }
    if (!retainedNavigationPage && this.initialized && (scope === "all" || scope === "codex")
      && ["listThreads", "getNavigationQueryPage", "lookupArchivedThreads"].includes(name)) await this.refreshThreads();
    switch (name) {
      case "listBackends": return this.listBackends();
      case "listThreads": return { backend: scope, fetchedAt: Date.now(), threads: [...this.threads.values(scope)].filter((thread) => !thread.archived).map((thread) => this.summary(thread)), workspaceRoots: this.runtime.projects.list().map((project) => project.path) };
      case "getNavigationQueryPage": {
        if (params.inventory === "viewer") throw new Error("Expected owner navigation protocol 2");
        return this.navigation.readPage({ request: params, scopeKey: envelope.sourceInstanceId || "local",
          loadIndex: async () => this.navigationIndex(scope) });
      }
      case "getNavigationLaunchpadConfig": {
        if (params.protocol !== 2) throw new Error("Unsupported navigation protocol");
        if (params.directoryKey !== undefined) this.runtime.projects.resolve(params.directoryKey);
        return { protocol: 2, revision: "headless-v1", ...(params.directoryKey ? { directoryKey: params.directoryKey } : {}),
          ...(params.knownRevision === "headless-v1" ? { unchanged: true } : { defaults: { backend: "codex", executionMode: "default", workMode: "local" } }) };
      }
      case "getNavigationSelectedDetail": {
        const thread = this.threads.get(params.ref.threadId, params.ref.backend);
        if (!thread) return { protocol: 2, ref: params.ref, revision: "absent", readiness: "ready", identity: "unresolved", collections: [] };
        const summary = this.summary(thread);
        return { protocol: 2, ref: params.ref, revision: digest(summary), readiness: "ready", identity: thread.archived ? "archived" : "present", thread: summary, collections: [] };
      }
      case "getNavigationQueueProjection": return { protocol: 2, ref: params.ref, revision: "no-queue", readiness: "ready", complete: true, entries: [] };
      case "releaseNavigationAttentionView": this.navigation.releaseAttentionView(envelope.sourceInstanceId || "local", params.viewId); return {};
      case "resolveThread": {
        const thread = this.threads.get(params.threadId, params.backend ?? "codex");
        return thread ? { thread: this.summary(thread) } : {};
      }
      case "resolveThreadAdmissionState": {
        const thread = this.summary(this.owned(params.threadId));
        const job = this.latest(params.threadId);
        return { thread, threadStatus: thread.threadStatus,
          ...(job?.turnId && ACTIVE.has(job.status) ? { activeTurn: { backend: "codex", threadId: thread.id, turnId: job.turnId } } : {}) };
      }
      case "lookupArchivedThreads": {
        if (!Array.isArray(params.threadIds) || params.threadIds.length > 100
          || params.threadIds.some(id => typeof id !== "string" || !id || id.length > 1024)
          || (params.includeParent !== undefined && params.includeParent !== true)) throw new Error("Archived lookup requires at most 100 non-empty thread IDs");
        const requested = new Set(params.threadIds);
        const threads = [...this.threads.values(scope)].filter(thread => thread.archived && requested.has(thread.id));
        return { threads: threads.map(thread => ({ ...this.summary(thread), archivedAt: thread.archivedAt ?? 0 })),
          ...(params.includeParent ? { parentLinks: [...this.threads.values(scope)].filter(thread => requested.has(thread.id)).map(thread => ({
            backend: thread.source, threadId: thread.id, parentThreadId: thread.parentThreadId,
            parentThreadBackend: thread.parentThreadBackend, parentThreadInstanceId: thread.parentThreadInstanceId,
          })) } : {}) };
      }
      case "getProjectPage": return { backend: scope, fetchedAt: Date.now(),
        launchpadDefaults: { backend: "codex", executionMode: "default", workMode: "local" },
        directories: this.navigationIndex(scope).directories.filter(directory => (!params.projectKey || params.projectKey === directory.key)
          && (!params.afterKey || directory.key > params.afterKey)) };
      case "readTurnAssistantReply": {
        const history = await this.readThread(params.threadId);
        const messages = history.replay.entries.filter((entry) => entry.type === "message" && entry.role === "assistant" && entry.turn?.id === params.turnId);
        return { message: messages.find((message) => params.itemId ? message.id === params.itemId : message.text === params.text) || null };
      }
      case "readThread": {
        // Viewers take the newest page as returned. Page and fit it to one
        // frame here, as desktop owners do.
        const history = await this.readThread(params.threadId);
        return { ...history, replay: fitThreadReplayWithinByteBudget({ cursorIdSpace: "entry-id",
          replay: pageThreadReplay(history.replay, params), maxBytes: this.replayByteBudget,
          measureBytes: (replay) => Buffer.byteLength(JSON.stringify({ ...history, replay }), "utf8") }) };
      }
      case "supportsMessagingPdfTools": return params.backend === "codex" && this.owned(params.threadId).messagingFileTools === true;
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
        const result = await this.runtime.codex.steerTurn({ threadId: params.threadId, expectedTurnId: params.expectedTurnId || job.turnId, input });
        return { backend: "codex", threadId: params.threadId, turnId: result.turnId || job.turnId, disposition: "steered",
          ...(name === "controlActiveTurn" ? { ok: true, requestId: params.requestId } : {}) };
      }
      case "renameThread": {
        const thread = this.owned(params.threadId);
        const title = params.title || params.name;
        if (typeof title !== "string" || !title.trim() || title.length > 200) throw new Error("Invalid title");
        await this.naming.renameThread({ backend: "codex", threadId: thread.id, name: title.trim(),
          ...(params.expectedName !== undefined ? { expectedName: params.expectedName } : {}) });
        return { backend: "codex", threadId: thread.id, title: title.trim() };
      }
      case "markThreadSeen": {
        const thread = this.owned(params.threadId);
        for (const key of ["seenAt", "seenUpdatedAt"]) {
          if (params[key] !== undefined && (!Number.isFinite(params[key]) || params[key] < 0)) throw new Error(`Invalid ${key}`);
        }
        // An omitted watermark keeps the stored one (see MarkThreadSeenRequest).
        // A thread never given one is pinned to the baseline/seenAt it was judged by,
        // so recording a new seenAt cannot change its unread state.
        thread.seenUpdatedAt = params.seenUpdatedAt ?? this.threads.seenWatermark(thread);
        thread.seenAt = params.seenAt ?? Date.now();
        this.persist(thread);
        this.publish({ backend: "codex", notification: { method: "navigation/thread/seen",
          params: { threadId: thread.id, ...(params.seenUpdatedAt !== undefined ? { seenUpdatedAt: params.seenUpdatedAt } : {}) } } }, "transcript");
        this.invalidate(thread.id, "navigation/thread/seen");
        return { backend: "codex", threadId: thread.id, seenAt: thread.seenAt,
          ...(params.seenUpdatedAt !== undefined ? { seenUpdatedAt: params.seenUpdatedAt } : {}) };
      }
      case "setThreadExecutionMode": {
        const thread = this.owned(params.threadId);
        thread.sandbox = sandboxFor({ executionMode: params.executionMode });
        this.persist(thread);
        this.invalidate(thread.id);
        return { backend: "codex", threadId: thread.id, executionMode: mode(thread.sandbox) };
      }
      case "setThreadModelSettings": {
        const thread = this.owned(params.threadId);
        for (const key of ["model", "reasoningEffort", "serviceTier"]) {
          if (params[key] !== undefined && (typeof params[key] !== "string" || params[key].length > 200)) throw new Error(`Invalid ${key}`);
          if (params[key] !== undefined) thread[key] = params[key];
        }
        this.persist(thread);
        this.invalidate(thread.id);
        return { backend: "codex", threadId: thread.id, model: thread.model, reasoningEffort: thread.reasoningEffort, serviceTier: thread.serviceTier };
      }
      case "listSkills": case "listThreadMcpServers": throw new Error("This inventory is not exposed by the headless adapter");
      default: throw new Error(`Unsupported outpost operation: ${method}`);
    }
  }

  invalidate(threadId, sourceMethod) {
    this.publish({ backend: "codex", notification: { method: "navigation/invalidated", params: { threadId, ...(sourceMethod ? { sourceMethod } : {}) } } }, "navigation");
  }

  // The canonical owner record retains title provenance, including explicit renames.
  setTitle(thread, title, titleSource) {
    this.providerMutationVersion++;
    Object.assign(thread, { title, titleSource, titleNativeName: title });
    this.persist(thread);
    this.threads.observeNativeTitle(thread.id, title, titleSource);
    this.publish({ backend: "codex", notification: { method: "thread/name/updated",
      params: { threadId: thread.id, threadName: title, titleSource } } }, "transcript");
    this.invalidate(thread.id, "thread/name/updated");
  }

  // Retain the immediate prompt/read fallback while the shared helper runs.
  deriveTitle(id, text) {
    const thread = this.threads.get(id);
    if (!thread || thread.archived || thread.titleSource !== "fallback" || typeof text !== "string") return;
    const title = shortenDerivedThreadTitle(text)?.slice(0, 200);
    if (title) this.setTitle(thread, title, "derived");
  }

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
      const result = await this.runtime.codex.startThread({ cwd, dynamicTools: this.runtime.messagingTools.buildDynamicToolSpecs(), approvalPolicy: "never", sandbox, ...(params.model ? { model: params.model } : {}), ephemeral: false });
      if (!result?.threadId || typeof result.threadId !== "string" || result.threadId.length > 256) throw new Error("Invalid thread/start response");
      this.runtime.loadedThreads.add(result.threadId);
      const thread = { id: result.threadId, messagingFileTools: true, nativeMembershipRetired: false, title: PLACEHOLDER_THREAD_TITLE, titleSource: "fallback", createdAt: Date.now(), cwd, sandbox,
        model: params.model, reasoningEffort: params.reasoningEffort, serviceTier: params.serviceTier };
      this.persistCreatedNativeThread(thread);
      this.invalidate(thread.id, "thread/started");
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
    const models = (await this.runtime.codex.listModels()).map((model) => ({
      id: model.id, label: model.label, current: model.current,
      reasoningEfforts: model.reasoningEfforts, defaultReasoningEffort: model.defaultReasoningEffort,
      supportsReasoning: model.supportsReasoning, supportsSteering: true,
      supportsImage: false, supportsFast: false,
    }));
    return { fetchedAt: Date.now(), backends: [{ kind: "codex", label: "Codex (headless outpost)", available: true,
      methods: Object.keys(METHOD_CAPABILITIES), capabilities: { listThreads: true, createThread: true, resumeThread: true,
        renameThread: true, readThread: true, startTurn: true, interruptTurn: true, steerTurn: true,
        transcriptPagination: false, toolUse: true, approvalRequests: false, multiDirectoryThreads: false },
      executionModes: [{ mode: "default", label: "Read-only", available: true, isDefault: true },
        { mode: "auto", label: "Workspace write", available: true }, { mode: "full-access", label: "Full access", available: false }],
      launchpadOptions: { models, supportsFastMode: false } }, ...[...new Set([...this.threads.values("all")].map(thread => thread.source))]
      .filter(backend => backend !== "codex").sort().map(kind => ({ kind, label: kind === "claude" ? "Claude" : kind.slice(4), available: false,
        methods: RETAINED_READ_METHODS.map(name => `backend.${name}`),
        capabilities: { listThreads: true, createThread: false, resumeThread: false, renameThread: false, readThread: false,
          startTurn: false, interruptTurn: false, steerTurn: false, transcriptPagination: false, toolUse: false,
          approvalRequests: false, multiDirectoryThreads: false }, executionModes: [] }))] };
  }

  async readThread(id) {
    this.owned(id);
    const replay = await this.runtime.codex.readThread({ threadId: id });
    const entries = replay.entries.map((entry) => {
      if (entry.type !== "message" || entry.role !== "user") return entry;
      const job = [...this.runtime.store.jobs.values()].find((job) => job.threadId === id && job.turnId === entry.turn?.id);
      return job?.messageOrigin ? { ...entry, origin: job.messageOrigin } : entry;
    });
    const origins = new Map(entries.filter((entry) => entry.type === "message" && entry.origin).map((entry) => [entry.id, entry.origin]));
    const messages = replay.messages.map((message) => origins.has(message.id) ? { ...message, origin: origins.get(message.id) } : message);
    const summary = await this.runtime.codex.readThreadSummary(id);
    const thread = this.owned(id);
    if (thread.titleSource === "fallback" && summary.titleSource !== "fallback") {
      this.setTitle(thread, summary.title, summary.titleSource);
    } else if (thread.titleSource === "fallback") {
      this.deriveTitle(id, replay.messages.find((message) => message.role === "user")?.text);
    }
    return { backend: "codex", threadId: id, fetchedAt: Date.now(), threadStatus: this.summary(thread).threadStatus,
      replay: { ...replay, entries, messages } };
  }

  navigationIndex(backend = "all") {
    const threads = [...this.threads.values(backend)].filter((thread) => !thread.archived).map((thread) => this.summary(thread));
    const byProject = new Map();
    for (const thread of threads) {
      let keys = byProject.get(thread.projectKey);
      if (!keys) { keys = []; byProject.set(thread.projectKey, keys); }
      keys.push(buildThreadIdentityKey(thread.source, thread.id));
    }
    const projects = new Map(this.runtime.projects.list().map(project => [project.path, project]));
    for (const thread of threads) for (const directory of thread.linkedDirectories) {
      const key = directory.worktreePath || directory.path;
      if (!projects.has(key)) projects.set(key, { path: key, label: directory.label });
    }
    return { threads, directories: [...projects.values()].map((project) => ({
      key: project.path, kind: "directory", label: project.label, path: project.path,
      threadKeys: byProject.get(project.path) || [], needsAttentionCount: 0,
      launchpad: { backend: "codex" },
    })) };
  }
}
