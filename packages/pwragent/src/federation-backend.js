import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { buildThreadIdentityKey, isAppServerBackendKind, NavigationQueryStore, NavigationQueryError, ThreadNamingLifecycle, projectProviderThreadSummary, FEDERATION_BACKEND_METHOD_CAPABILITIES, FEDERATION_MAX_FRAME_BYTES, fitThreadReplayWithinByteBudget, mergeCausalMessagingContext, pageThreadReplay, shortenDerivedThreadTitle } from "../dist/federation-core.js";
import { ACTIVE, digest } from "./store.js";
import { OutpostThreadRegistry } from "./owner-thread-registry.js";
import { ThreadCreationLifecycle, ThreadSteeringLifecycle, ThreadSteerSubmissionLifecycle, ThreadTitleGenerationService, ThreadTitleLifecycle } from "../dist/federation-core.js";
import { DurableTurnRequestService, DurableTurnRequestError, durableFederationCallerScope } from "../dist/federation-core.js";

// The owner methods this outpost serves. Each one's capability comes from the
// shared owner contract, so a grant means the same here as on desktop.
const OWNER_METHODS = [
  "resolveThreadAdmissionState", "supportsMessagingPdfTools",
  "getNavigationQueryPage", "getNavigationLaunchpadConfig", "getNavigationSelectedDetail", "getNavigationQueueProjection",
  "releaseNavigationAttentionView", "listThreads", "listBackends", "resolveThread", "markThreadSeen", "getProjectPage", "lookupArchivedThreads",
  "readThread", "readTurnAssistantReply", "listSkills", "listThreadMcpServers",
  "startThread", "materializeDirectoryLaunchpad", "startTurn", "interruptTurn", "steerTurn", "controlActiveTurn", "renameThread",
  "setThreadModelSettings", "setThreadExecutionMode",
  "readQueuedTurn", "replaceQueuedMessage", "releaseQueuedTurn", "cancelQueuedTurn", "setQueuedTurnPaused", "moveQueuedTurn",
  "submitTurnRequest", "getTurnRequest", "submitSteerRequest", "getSteerRequest",
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
  constructor(runtime, publish, ownerInstanceId) {
    this.runtime = runtime;
    this.ownerInstanceId = ownerInstanceId;
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
    this.threadCreations = new ThreadCreationLifecycle();
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
    runtime.threadCreationBusy = () => this.creating;
    this.latestJobs = new Map();
    this.syncJobs();
    this.steerSubmissions = new ThreadSteerSubmissionLifecycle({
      assertUnlocked: async (request) => this.assertSteerUnlocked(request),
      prepareInput: async (request) => [{ type: "text", text: textInput(request.input), text_elements: [] }],
      prepareCodex: async (request, input, origin) => {
        const job = this.activeJob(request);
        let releaseMessaging;
        return {
          submit: async () => {
            this.assertSteerUnlocked(request);
            if (this.activeJob(request).id !== job.id) throw new Error("Active turn changed");
            if (origin) releaseMessaging = runtime.fenceSteeringMessaging(job.id);
            const result = await runtime.codex.steerTurn({ threadId: request.threadId, expectedTurnId: request.expectedTurnId, input });
            return { threadId: request.threadId, turnId: result.turnId || job.turnId };
          },
          retain: async () => {
            if (!origin) return;
            // Merge at the acceptance boundary against this captured job's
            // current record. A terminal or another accepted steer may have
            // arrived while the provider was deciding; neither may be erased.
            const current = runtime.store.get(job.id);
            const messageOrigin = { ...origin, ...mergeCausalMessagingContext([current.messageOrigin, origin]) };
            if (!isDeepStrictEqual(current.messageOrigin, messageOrigin)) runtime.save({ ...current, messageOrigin });
            releaseMessaging?.();
          },
          forget: () => releaseMessaging?.(),
        };
      },
    });
    this.steering = new ThreadSteeringLifecycle({ submit: (request, origin) => this.steerSubmissions.submit(request, origin) });
    runtime.steerQueuedTurn = request => this.steering.steerTurn(request, request.messageOrigin);
    runtime.onTurnTerminal = (target) => this.steering.retireTurn(target);
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
    this.providerMutationVersion++;
    this.threads.observeCreatedNativeThread(this.summary(thread));
    this.persist({ ...thread, nativeMembershipRetired: false });
  }

  syncJobs(jobs = this.runtime.store.jobs.values()) {
    for (const job of jobs) {
      if (!job.threadId) continue;
      this.threads.retainAcceptedJobThread(job.threadId);
      const previous = this.latestJobs.get(job.threadId);
      // Waiting admissions cannot displace provider work. A refusal may still
      // return that same projected job from starting to held queued state.
      if ((job.status !== "queued" || previous?.id === job.id) && (!previous || previous.id !== this.runtime.active || previous.id === job.id)
        && (!previous || previous.id === job.id || this.runtime.active === job.id || job.createdAt > previous.createdAt)) this.latestJobs.set(job.threadId, job);
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

  queuedTurns(threadId) {
    return (this.runtime.turnQueue?.getQueuedEntries({ backend: "codex", threadId }) || []).map((entry, position) => {
      const text = entry.input.map(item => item.text).join("\n").trim();
      return { queueEntryId: entry.id, origin: entry.origin, displayText: text.length > 200 ? `${text.slice(0, 200)}…` : text,
        createdAt: entry.createdAt, position,
        ...(entry.manualReleaseRequired ? { manualReleaseRequired: true } : {}),
        ...(entry.holdReason ? { holdReason: entry.holdReason } : {}),
        ...(entry.paused ? { paused: true } : {}), ...(entry.pauseRevision ? { pauseRevision: entry.pauseRevision } : {}) };
    });
  }

  queueProjection(params) {
    if (params.protocol !== 2 || !params.ref || typeof params.ref.threadId !== "string" || !params.ref.threadId || params.ref.threadId.length > 1024) {
      throw new NavigationQueryError("navigation_invalid_request", "Expected owner navigation protocol 2 and thread identity");
    }
    const entries = this.queuedTurns(params.ref.threadId);
    const revision = digest(entries);
    if (!params.cursor && params.knownRevision === revision) return { protocol: 2, ref: params.ref, revision, readiness: "ready", complete: true, entries: [], unchanged: true };
    let offset = 0;
    if (params.cursor) {
      if (typeof params.cursor !== "string" || params.cursor.length > 512) throw new NavigationQueryError("navigation_invalid_request", "Invalid queue cursor");
      let cursor;
      try { cursor = JSON.parse(Buffer.from(params.cursor, "base64url").toString("utf8")); }
      catch { throw new NavigationQueryError("navigation_invalid_request", "Invalid queue cursor"); }
      if (!cursor || cursor.revision !== revision) throw new NavigationQueryError("navigation_cursor_expired", "Queue changed while paging; restart from its current revision");
      if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > entries.length) throw new NavigationQueryError("navigation_invalid_request", "Invalid queue cursor offset");
      offset = cursor.offset;
    }
    const end = Math.min(offset + 100, entries.length);
    return { protocol: 2, ref: params.ref, revision, readiness: "ready", complete: end === entries.length, entries: entries.slice(offset, end),
      ...(end < entries.length ? { nextCursor: Buffer.from(JSON.stringify({ revision, offset: end })).toString("base64url") } : {}) };
  }

  activeJob(params) {
    this.owned(params.threadId);
    const job = this.latest(params.threadId);
    if (!job || !ACTIVE.has(job.status) || !job.turnId) throw new Error("Thread has no active turn");
    if (params.expectedTurnId && params.expectedTurnId !== job.turnId) throw new Error("Active turn changed");
    return job;
  }

  assertSteerUnlocked(request) {
    if (this.runtime.stopping) throw new Error("Daemon is stopping");
    this.activeJob(request);
    if (this.runtime.threadLocked?.(request.threadId)) throw new Error("Thread handoff is in progress");
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
    if (message.method === "headless/queueReordered") {
      this.publish({ backend: "codex", notification: { method: "thread/turnQueue/reordered", params: message.params } }, "transcript");
      this.invalidate(message.params.threadId, "thread/turnQueue/reordered");
      return;
    }
    if (message.method === "headless/queueChanged") {
      const { entry, type, position, turnId, status, error, reason } = message.params;
      const outcome = type === "terminal" ? this.runtime.store.get(entry.id).status : undefined;
      this.durableRequests?.observeQueueEvent({ backend: entry.backend, threadId: entry.threadId, queueEntryId: entry.id,
        status: type === "cancelled" && this.runtime.stopping ? "failed" : type, turnId,
        terminalStatus: outcome === "interrupted" ? "turn/cancelled" : outcome === "blocked" ? "turn/failed" : status });
      const summary = this.queuedTurns(entry.threadId).find(item => item.queueEntryId === entry.id);
      this.publish({ backend: "codex", notification: { method: "thread/turnQueue/updated", params: {
        threadId: entry.threadId, queueEntryId: entry.id, queueEntryCreatedAt: entry.createdAt,
        origin: entry.origin, messageOrigin: entry.messageOrigin, status: type, position, turnId,
        ...(entry.pauseRevision ? { paused: entry.paused === true, pauseRevision: entry.pauseRevision } : {}),
        ...(summary ? { displayText: summary.displayText, manualReleaseRequired: summary.manualReleaseRequired } : {}),
        ...(error || reason ? { errorMessage: error?.message || reason } : {}), ...(status ? { terminalStatus: status } : {}),
      } } }, "transcript");
      this.invalidate(entry.threadId, "thread/turnQueue/updated");
      return;
    }
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
      if (job.status !== "queued" && job.threadId && this.latest(job.threadId)?.id === job.id) {
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
      case "getNavigationQueueProjection": return this.queueProjection(params);
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
      case "submitTurnRequest": return this.durableTurnRequests().submit(durableFederationCallerScope(envelope.sourceInstanceId, params.callerScope), params);
      case "getTurnRequest": return this.durableTurnRequests().get(durableFederationCallerScope(envelope.sourceInstanceId, params.callerScope), params);
      case "submitSteerRequest": return this.durableTurnRequests().submitSteer(durableFederationCallerScope(envelope.sourceInstanceId, params.callerScope), params);
      case "getSteerRequest": return this.durableTurnRequests().getSteer(durableFederationCallerScope(envelope.sourceInstanceId, params.callerScope), params);
      case "replaceQueuedMessage": return this.replaceQueuedMessage(params, envelope);
      case "readQueuedTurn": return this.runtime.readQueuedTurn(params);
      case "releaseQueuedTurn": return this.runtime.releaseQueuedTurn(params);
      case "cancelQueuedTurn": return this.runtime.cancelQueuedTurn(params);
      case "setQueuedTurnPaused": return this.runtime.setQueuedTurnPaused(params);
      case "moveQueuedTurn": return this.runtime.moveQueuedTurn(params);
      case "interruptTurn": {
        this.owned(params.threadId);
        const job = this.latest(params.threadId);
        if (!job || !ACTIVE.has(job.status)) throw new Error("Thread has no active turn");
        if (params.turnId && params.turnId !== job.turnId) throw new Error("Active turn changed");
        await this.runtime.handle("interrupt", { id: job.id });
        return { backend: "codex", threadId: params.threadId, turnId: job.turnId };
      }
      case "steerTurn": case "controlActiveTurn": {
        const job = this.activeJob(params);
        if (name === "controlActiveTurn" && params.operation === "stop") {
          await this.runtime.handle("interrupt", { id: job.id });
          return { ok: true, backend: "codex", threadId: params.threadId, requestId: params.requestId, turnId: job.turnId, disposition: "interrupted" };
        }
        if (name === "controlActiveTurn" && params.operation !== "steer") throw new Error("Unsupported active-turn operation");
        const incoming = this.authenticateOrigin?.(params.messageOrigin, envelope);
        if (params.requestId !== undefined && (typeof params.requestId !== "string" || !params.requestId || params.requestId.length > 256)) throw new Error("Invalid steer request ID");
        // Older peers omitted retry identity and/or expected turn. Each such
        // invocation remains independent; modern peers share the core admission.
        const result = await this.steering.steerTurn({ ...params, backend: "codex", expectedTurnId: params.expectedTurnId || job.turnId,
          requestId: params.requestId ?? randomUUID() }, incoming);
        return { ...result,
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
    if (this.runtime.active || this.runtime.dispatches?.size || this.runtime.uncertain || this.runtime.turnQueue?.getAllQueuedEntries().length || this.runtime.intakeBusy || this.creating) throw new Error("Outpost is busy");
    if (params.workMode && params.workMode !== "local") throw new Error("Outpost threads use the configured workspace; worktree creation is unavailable");
    if (this.threads.size >= 10000) throw new Error("Thread retention limit reached");
    const sandbox = sandboxFor(params);
    for (const key of ["model", "reasoningEffort", "serviceTier"]) {
      if (params[key] !== undefined && (typeof params[key] !== "string" || !params[key] || params[key].length > 200)) throw new Error(`Invalid ${key}`);
    }
    const cwd = this.runtime.projects.resolve(params.cwd || params.directoryPath || params.projectKey);
    this.creating = true;
    try {
      const created = await this.threadCreations.start({ backend: "codex" }, {
        providers: { codex: async () => {
          const result = await this.runtime.codex.startThread({ cwd, dynamicTools: this.runtime.messagingTools.buildDynamicToolSpecs(), approvalPolicy: "never", sandbox, ...(params.model ? { model: params.model } : {}), ephemeral: false });
          if (!result?.threadId || typeof result.threadId !== "string" || result.threadId.length > 256) throw new Error("Invalid thread/start response");
          this.runtime.loadedThreads.add(result.threadId);
          return result;
        } },
        rememberPending: async ({ threadId }) => this.persistCreatedNativeThread({ id: threadId, messagingFileTools: true,
          title: PLACEHOLDER_THREAD_TITLE, titleSource: "fallback", createdAt: Date.now(), cwd, sandbox,
          model: params.model, reasoningEffort: params.reasoningEffort, serviceTier: params.serviceTier }),
        invalidate: ({ threadId }) => this.invalidate(threadId, "thread/started"),
        failed: (_stage, error) => this.runtime.reportFailure(error),
      });
      return { ...created, executionMode: mode(sandbox) };
    } finally { this.creating = false; this.runtime.turnQueue.drainAll(); }
  }

  durableTurnRequests() {
    if (!this.durableRequests) {
      const ownerInstanceId = this.ownerInstanceId?.();
      if (!ownerInstanceId) throw new DurableTurnRequestError("request_destination_unavailable");
      this.durableRequests = new DurableTurnRequestService({
        storage: this.runtime.store.durableTurnRequests, ownerInstanceId,
        // The receipt, durable job, live FIFO and lifecycle events use one
        // immutable identity. Host job IDs are restricted to 80 safe bytes.
        queueEntryId: (scope, id) => `dturn-${digest([scope, id])}`,
        authorize: async (_scope, request) => {
          if (request.backend !== "codex" || !this.runtime.ownsThread(request.threadId)) throw new DurableTurnRequestError("request_destination_unavailable");
        },
        dispatch: (request, scope) => this.startTurn(request, { sourceInstanceId: JSON.parse(scope)[1] }, request.queueEntryId),
        steer: request => this.handle("backend.controlActiveTurn", { ...request, operation: "steer" }),
        isQueued: async receipt => {
          this.runtime.readQueuedTurn(receipt);
          return true;
        },
      });
    }
    return this.durableRequests;
  }

  async startTurn(params, envelope, acceptedJobId) {
    if (params.collaborationMode || params.fastMode || params.acpRuntime) throw new Error("Collaboration modes, fast mode and ACP settings are unavailable on this outpost");
    const thread = this.owned(params.threadId);
    if (params.cwd && params.cwd !== (thread.cwd || this.runtime.workspace)) throw new Error("Turn cwd differs from its owner thread project");
    const sandbox = sandboxFor(params, thread.sandbox);
    const prompt = textInput(params.input);
    const messageOrigin = this.authenticateOrigin?.(params.messageOrigin, envelope);
    const hasTurnSettings = [params.executionMode, params.approvalPolicy, params.sandbox, params.model,
      params.collaborationMode, params.serviceTier, params.reasoningEffort, params.fastMode, params.acpRuntime].some(value => value !== undefined);
    const queuedSteer = messageOrigin?.kind === "agent" && params.delivery !== "new_turn" && !hasTurnSettings;
    if (params.queueEntryId !== undefined && (typeof params.queueEntryId !== "string" || !params.queueEntryId || params.queueEntryId.length > 256)) throw new Error("Invalid submission identity");
    const job = this.runtime.submit({ id: acceptedJobId ?? `fed-${digest([envelope.sourceInstanceId, params.queueEntryId || envelope.id])}`, prompt,
      threadId: thread.id, cwd: thread.cwd || this.runtime.workspace, messageOrigin, sandbox, model: params.model || thread.model,
      reasoningEffort: params.reasoningEffort || thread.reasoningEffort, serviceTier: params.serviceTier || thread.serviceTier }, queuedSteer ? { delivery: "queued-steer" } : undefined);
    if (job.status === "queued") {
      const entry = this.queuedTurns(thread.id).find(entry => entry.queueEntryId === job.id);
      return { backend: "codex", threadId: thread.id, turnId: `queued:${job.id}`, queueStatus: "queued", queueEntryId: job.id,
        ...(entry ? { queueEntryCreatedAt: entry.createdAt } : {}) };
    }
    await this.runtime.dispatches.get(job.id);
    const started = this.runtime.store.get(job.id);
    if (!started.turnId) throw new Error(started.reason || "Turn was not started");
    return { backend: "codex", threadId: thread.id, turnId: started.turnId, queueStatus: "started", queueEntryId: job.id };
  }

  async replaceQueuedMessage(params, envelope) {
    if (params.backend !== "codex") throw new Error("This outpost executes Codex only");
    this.owned(params.threadId);
    const prompt = textInput(params.input);
    if (!prompt.trim() || Buffer.byteLength(prompt) > 256 * 1024) throw new Error("Prompt must be nonempty and at most 256 KiB");
    if (typeof envelope.id !== "string" || !envelope.id || !envelope.sourceInstanceId) throw new Error("Replacement requires an authenticated request identity");
    const messageOrigin = structuredClone(this.authenticateOrigin?.(params.messageOrigin, envelope));
    const waiting = this.runtime.queuedEntry(params.queueEntryId), release = this.runtime.queueRelease;
    // Like cancellation, let a reserved head finish admission before adding
    // another suspension to its FIFO. Recheck the live identity below.
    if (waiting && release && waiting.threadId === release.threadId && this.runtime.queuedEntry(release.entryId)) await release.done;
    return this.runtime.turnQueue.withDispatchSuspended(params, () => {
      const runtime = this.runtime;
      if (runtime.stopping || runtime.uncertain || runtime.intakeBusy || this.creating) throw new Error("Outpost cannot replace queued input now");
      const entry = runtime.queuedEntry(params.queueEntryId);
      if (!entry || entry.backend !== params.backend || entry.threadId !== params.threadId) throw new Error("Queued message not found or already started; no new turn was created.");
      const job = runtime.store.get(entry.id);
      runtime.assertQueuedIdentity(job, entry);
      const sender = messageOrigin?.sourceThread, owner = job.messageOrigin?.sourceThread;
      if (messageOrigin?.kind !== "agent" || job.messageOrigin?.kind !== "agent" || !sender || !owner
        || sender.backend !== owner.backend || sender.threadId !== owner.threadId || sender.instanceId !== owner.instanceId) {
        throw new Error("Only the sending thread can replace its own queued agent message.");
      }
      const id = `fed-${digest([envelope.sourceInstanceId, envelope.id])}`;
      if (runtime.store.jobs.get(id)) throw new Error("Replacement requires a new acceptance identity");
      if (runtime.store.jobs.size >= 10000) throw new Error("Job retention limit reached (10000); use a new profile");
      // Capture the live position after earlier serialized controls. Insert
      // fresh acceptance there before its queued event or any later dispatch.
      const queueIndex = runtime.turnQueue.getQueuedEntries(params).indexOf(entry);
      // Cancellation commits before removal or fresh acceptance. A refused
      // cancellation leaves the original waiting; a refused new acceptance
      // leaves it cancelled. Neither failure may replay the original input.
      runtime.finish(job.id, "interrupted", "Replaced before dispatch");
      runtime.turnQueue.cancelEntryWithDisposition(job.id, "Replaced before dispatch");
      const accepted = runtime.submit({ id, threadId: job.threadId, prompt, messageOrigin,
        cwd: job.cwd, sandbox: job.sandbox, model: job.model, reasoningEffort: job.reasoningEffort, serviceTier: job.serviceTier }, { ...entry, queueIndex });
      return { backend: "codex", threadId: job.threadId, turnId: `queued:${accepted.id}`, queueStatus: "queued", queueEntryId: accepted.id,
        queueEntryCreatedAt: Date.parse(accepted.createdAt) };
    });
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
