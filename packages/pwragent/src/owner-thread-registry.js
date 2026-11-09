import path from "node:path";
import { buildThreadIdentityKey, outpostThreadMetadata, outpostThreadProjection, projectOwnerThreadTitle, projectAcpSessionThread } from "../dist/federation-core.js";

/** Retained provider discovery and live canonical metadata, qualified by backend. */
export class OutpostThreadRegistry {
  constructor(storage, inventory, acpSessions) {
    this.storage = storage;
    this.unreadBaseline = storage?.readUnreadBaseline?.() ?? {};
    this.acpSessions = acpSessions;
    // Provider discovery is separate from owner metadata. Retain the last
    // complete provider inventory, with canonical owner facts read live.
    this.inventory = new Map((inventory?.list() ?? [])
      .flatMap(snapshot => snapshot.threads.map(thread => [buildThreadIdentityKey(snapshot.backend, thread.id), { ...thread, observedAt: snapshot.observedAt }])));
  }

  identity(identity) {
    if (identity.backend !== "codex") throw new Error("This outpost stores Codex threads only");
  }

  async getThreadMetadata(identity) { return this.storage.getThreadMetadata(identity); }
  async listThreadMetadata() { return this.storage.listThreadMetadata(); }
  async updateThreadMetadata(identity, patch) { this.identity(identity); return this.storage.updateThreadMetadata(identity, patch); }

  seenWatermark(thread) {
    return thread.seenUpdatedAt ?? this.unreadBaseline[buildThreadIdentityKey("codex", thread.id)] ?? thread.seenAt ?? 0;
  }

  get(id, backend = "codex") {
    const record = this.storage.getThreadMetadata({ backend, threadId: id });
    const session = backend.startsWith("acp:") ? this.acpSessions?.getSession(backend, id) : undefined;
    if (session?.hidden) return undefined;
    const native = session ? this.acpThread(session) : this.inventory.get(buildThreadIdentityKey(backend, id));
    return this.project(id, record, native, backend);
  }

  acpThread(session) {
    return { ...projectAcpSessionThread(session, undefined, session.cwd ? path.basename(session.cwd) : ""), observedAt: Date.now() };
  }

  project(id, record, native, backend) {
    if (!record && !native) return undefined;
    const thread = record ? outpostThreadProjection(record) : { id };
    if (native) {
      Object.assign(thread, projectOwnerThreadTitle(native, record));
      if (record?.title?.nativeName !== undefined && record.title.nativeName !== native.title) thread.titleNativeName = native.title;
      // Only a fresh walk may supersede durable owner archive observations;
      // the retained inventory is never authority for restoring ownership.
      if (native.observedAt > Math.max(record?.archivedAt ?? -Infinity, record?.archiveRetentionStartedAt ?? -Infinity, record?.restoredAt ?? -Infinity)) {
        thread.archived = native.archivedAt !== undefined;
        thread.archivedAt = native.archivedAt;
      }
    }
    const projected = { ...(native ? { ...native, id, title: native.title, titleSource: native.titleSource,
      createdAt: native.createdAt, updatedAt: native.updatedAt, cwd: native.projectKey || native.linkedDirectories[0]?.path,
      archived: native.archivedAt !== undefined, archivedAt: native.archivedAt,
      sandbox: native.executionMode === "auto" ? "workspace-write" : "read-only", model: native.model,
      reasoningEffort: native.reasoningEffort, serviceTier: native.serviceTier, fastMode: native.fastMode } : {}),
      ...Object.fromEntries(Object.entries(thread).filter(([, value]) => value !== undefined)), source: backend,
      executionMode: record?.executionMode ?? native?.executionMode ?? "default" };
    if (projected.title === undefined) {
      projected.title = "Untitled thread";
      projected.titleSource = "fallback";
    }
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
    const records = this.storage.listThreadMetadata().filter(record => backend === "all" || record.backend === backend);
    const byId = new Map(records.map(record => [buildThreadIdentityKey(record.backend, record.threadId), record]));
    const natives = new Map([...this.inventory].filter(([, thread]) => backend === "all" || thread.source === backend));
    for (const session of this.acpSessions?.listAllSessions() ?? []) {
      if (backend === "all" || session.backendId === backend) natives.set(buildThreadIdentityKey(session.backendId, session.sessionId), this.acpThread(session));
    }
    const identities = new Map([...natives].map(([key, thread]) => [key, { backend: thread.source, threadId: thread.id }]));
    for (const [key, record] of byId) identities.set(key, record);
    return [...identities].map(([key, identity]) => this.project(identity.threadId, byId.get(key), natives.get(key), identity.backend)).values();
  }
  set(id, thread) {
    if (id !== thread.id) throw new Error("Thread registry identity changed");
    this.storage.updateThreadMetadata({ backend: "codex", threadId: id }, outpostThreadMetadata(thread));
  }
}
