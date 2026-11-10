import path from "node:path";
import { buildThreadIdentityKey, projectRetainedOwnerThread, projectOwnerThreadTitle, projectAcpSessionThread, retainsOwnerThread } from "../dist/federation-core.js";

/** Retained provider discovery and live canonical metadata, qualified by backend. */
export class OutpostThreadRegistry {
  constructor(storage, inventory, acpSessions, claudeSessions, retainedOwners) {
    this.storage = storage;
    this.unreadBaseline = storage?.readUnreadBaseline?.() ?? {};
    this.acpSessions = acpSessions;
    this.claudeSessions = claudeSessions;
    // The committed import's identities cannot change during this admitted
    // owner's lifetime. Canonical facts remain live; accepted jobs enter via
    // the existing syncJobs boundary. Never rescan all jobs/overlays per item.
    this.retainedOwnerIds = new Set((retainedOwners?.list() ?? []).map(thread => thread.id));
    this.acceptedJobThreadIds = new Set();
    // Provider discovery is separate from owner metadata. Retain the last
    // complete provider inventory, with canonical owner facts read live.
    this.inventory = new Map((inventory?.list() ?? [])
      .flatMap(snapshot => snapshot.threads.map(thread => [buildThreadIdentityKey(snapshot.backend, thread.id), thread])));
  }

  identity(identity) {
    if (identity.backend !== "codex") throw new Error("This outpost stores Codex threads only");
  }

  async getThreadMetadata(identity) { return this.storage.getThreadMetadata(identity); }
  async listThreadMetadata() { return this.storage.listThreadMetadata(); }
  async updateThreadMetadata(identity, patch) { this.identity(identity); return this.storage.updateThreadMetadata(identity, patch); }

  async refreshClaudeThreads() {
    if (!this.claudeSessions) return;
    if (this.claudeDiscovery) return this.claudeDiscovery;
    this.claudeDiscovery = (async () => {
      const threads = await this.claudeSessions.listThreads();
      this.claudeThreadIds = new Set(threads.map(thread => thread.id));
      this.replaceInventory(threads, Date.now(), "claude");
    })();
    try { await this.claudeDiscovery; } finally { this.claudeDiscovery = undefined; }
  }

  get(id, backend = "codex") {
    if (backend === "claude" && this.claudeThreadIds && !this.claudeThreadIds.has(id)) return undefined;
    const record = this.storage.getThreadMetadata({ backend, threadId: id });
    const session = backend.startsWith("acp:") ? this.acpSessions?.getSession(backend, id) : undefined;
    // ACP's complete local session store owns membership, including deletion.
    // Neither a retained inventory nor an overlay can create a native session.
    if (backend.startsWith("acp:") && (!session || session.hidden)) return undefined;
    const native = session ? this.acpThread(session) : this.inventory.get(buildThreadIdentityKey(backend, id));
    if (backend === "codex" && !native && record?.nativeMembershipRetired && !this.acceptedJobThreadIds.has(id)) return undefined;
    if (backend === "codex" && !native && !retainsOwnerThread(record, this.retainedOwnerIds.has(id))
      && !this.acceptedJobThreadIds.has(id)) return undefined;
    return this.project(id, record, native, backend);
  }

  retainAcceptedJobThread(id) { this.acceptedJobThreadIds.add(id); }

  observeCreatedNativeThread(thread) {
    this.inventory.set(buildThreadIdentityKey("codex", thread.id), { ...thread, observedAt: Date.now() });
  }

  absentConfirmedCodexThreadIds(threads) {
    const present = new Set(threads.map(thread => thread.id));
    const confirmed = new Set([...this.inventory.values()].filter(thread => thread.source === "codex").map(thread => thread.id));
    const records = new Map(this.storage.listThreadMetadata().filter(record => record.backend === "codex").map(record => [record.threadId, record]));
    for (const record of records.values()) {
      if (record.nativeMembershipRetired === false || record.title?.nativeName !== undefined) confirmed.add(record.threadId);
    }
    // Pending imports have no positive native observation. Retired metadata
    // remains available without manufacturing a member on the next restart.
    return [...confirmed].filter(id => !present.has(id) && !records.get(id)?.nativeMembershipRetired);
  }

  acpThread(session) {
    return projectAcpSessionThread(session, undefined, session.cwd ? path.basename(session.cwd) : "");
  }

  project(id, record, native, backend) {
    if (!record && !native) return undefined;
    const actualSession = backend.startsWith("acp:") || (backend === "claude" && this.claudeThreadIds?.has(id));
    const acpArchiveObservation = backend.startsWith("acp:") && (record?.archivedAt !== undefined
      || record?.archiveRetentionStartedAt !== undefined || record?.restoredAt !== undefined);
    const retained = projectRetainedOwnerThread(id, record, undefined);
    const projected = { ...retained, ...native, source: backend, archivedAt: native ? native.archivedAt : retained.archivedAt,
      ...(record ? { createdAt: record.createdAt ?? native?.createdAt, updatedAt: record.updatedAt ?? native?.updatedAt,
        projectKey: record.cwd ?? native?.projectKey,
        executionMode: record.executionMode, model: record.model ?? native?.model,
        reasoningEffort: record.reasoningEffort ?? native?.reasoningEffort, serviceTier: record.serviceTier ?? native?.serviceTier,
        fastMode: record.fastMode ?? native?.fastMode } : {}),
      ...(native ? actualSession ? { title: native.title, titleSource: native.titleSource } : projectOwnerThreadTitle(native, record) : {}),
    };
    if (actualSession) {
      Object.assign(projected, { createdAt: native.createdAt, updatedAt: native.updatedAt,
        projectKey: native.projectKey, executionMode: native.executionMode ?? record?.executionMode ?? "default" });
    }
    if (record && (!native || acpArchiveObservation || (!actualSession && !(native.observedAt > Math.max(
      record.archivedAt ?? -Infinity, record.archiveRetentionStartedAt ?? -Infinity, record.restoredAt ?? -Infinity))))) {
      projected.archivedAt = retained.archivedAt;
    }
    if (!projected.linkedDirectories?.length && projected.projectKey) {
      const cwd = projected.projectKey;
      projected.linkedDirectories = [{ id: cwd, kind: "local", path: cwd, label: path.basename(cwd) }];
    }
    delete projected.observedAt;
    return projected;
  }

  replaceInventory(threads, observedAt, backend = "codex") {
    for (const [key, thread] of this.inventory) if (thread.source === backend) this.inventory.delete(key);
    for (const thread of threads) this.inventory.set(buildThreadIdentityKey(backend, thread.id), { ...thread, observedAt });
  }

  observeNativeTitle(id, title, titleSource) {
    const key = buildThreadIdentityKey("codex", id);
    const native = this.inventory.get(key);
    if (native) this.inventory.set(key, { ...native, title, titleSource });
  }

  has(id) { return this.get(id) !== undefined; }
  get size() { return [...this.values()].length; }
  values(backend = "codex") {
    const sessions = backend === "all" || backend.startsWith("acp:") ? this.acpSessions?.listAllSessions() ?? [] : [];
    const acpThreads = new Map(sessions.filter(session => backend === "all" || session.backendId === backend)
      .map(session => [buildThreadIdentityKey(session.backendId, session.sessionId), this.acpThread(session)]));
    const records = this.storage.listThreadMetadata().filter(record => (backend === "all" || record.backend === backend)
      && (record.backend !== "claude" || !this.claudeThreadIds || this.claudeThreadIds.has(record.threadId))
      && (!record.backend.startsWith("acp:") || acpThreads.has(buildThreadIdentityKey(record.backend, record.threadId))));
    const byId = new Map(records.map(record => [buildThreadIdentityKey(record.backend, record.threadId), record]));
    const natives = new Map([...this.inventory].filter(([, thread]) => !thread.source.startsWith("acp:")
      && (backend === "all" || thread.source === backend)));
    for (const [key, thread] of acpThreads) natives.set(key, thread);
    const identities = new Map([...natives].map(([key, thread]) => [key, { backend: thread.source, threadId: thread.id }]));
    for (const [key, record] of byId) identities.set(key, record);
    return [...identities].filter(([key, identity]) => identity.backend !== "codex" || natives.has(key)
      || retainsOwnerThread(byId.get(key), this.retainedOwnerIds.has(identity.threadId)) || this.acceptedJobThreadIds.has(identity.threadId))
      .map(([key, identity]) => this.project(identity.threadId, byId.get(key), natives.get(key), identity.backend)).values();
  }
}
