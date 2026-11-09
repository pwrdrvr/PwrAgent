import { buildThreadIdentityKey, outpostThreadMetadata, outpostThreadProjection, projectOwnerThreadTitle } from "../dist/federation-core.js";

/** Codex host projection over the profile's canonical owner storage port. */
export class OutpostThreadRegistry {
  constructor(storage, inventory) {
    this.storage = storage;
    this.unreadBaseline = storage?.readUnreadBaseline?.() ?? {};
    // Provider discovery is separate from owner metadata. Retain the last
    // complete provider inventory, with canonical owner facts read live.
    this.inventory = new Map((inventory?.list() ?? []).filter(snapshot => snapshot.backend === "codex")
      .flatMap(snapshot => snapshot.threads).map(thread => [thread.id, thread]));
  }

  identity(identity) {
    if (identity.backend !== "codex") throw new Error("This outpost stores Codex threads only");
  }

  async getThreadMetadata(identity) { this.identity(identity); return this.storage.getThreadMetadata(identity); }
  async listThreadMetadata() { return this.storage.listThreadMetadata().filter(record => record.backend === "codex"); }
  async updateThreadMetadata(identity, patch) { this.identity(identity); return this.storage.updateThreadMetadata(identity, patch); }

  seenWatermark(thread) {
    return thread.seenUpdatedAt ?? this.unreadBaseline[buildThreadIdentityKey("codex", thread.id)] ?? thread.seenAt ?? 0;
  }

  get(id) {
    const record = this.storage.getThreadMetadata({ backend: "codex", threadId: id });
    return this.project(id, record, this.inventory.get(id));
  }

  project(id, record, native) {
    if (!record && !native) return undefined;
    const thread = record ? outpostThreadProjection(record) : { id };
    if (native) Object.assign(thread, projectOwnerThreadTitle(native, record));
    const projected = { ...(native ? { id, title: native.title, titleSource: native.titleSource,
      createdAt: native.createdAt, updatedAt: native.updatedAt, cwd: native.projectKey || native.linkedDirectories[0]?.path,
      archived: native.archivedAt !== undefined, archivedAt: native.archivedAt,
      sandbox: native.executionMode === "auto" ? "workspace-write" : "read-only", model: native.model,
      reasoningEffort: native.reasoningEffort, serviceTier: native.serviceTier, fastMode: native.fastMode } : {}),
      ...Object.fromEntries(Object.entries(thread).filter(([, value]) => value !== undefined)) };
    if (projected.title === undefined) {
      projected.title = "Untitled thread";
      projected.titleSource = "fallback";
    }
    return projected;
  }

  replaceInventory(threads) {
    this.inventory = new Map(threads.map(thread => [thread.id, thread]));
  }

  observeNativeTitle(id, title, titleSource) {
    const native = this.inventory.get(id);
    if (native) this.inventory.set(id, { ...native, title, titleSource });
  }

  has(id) { return this.get(id) !== undefined; }
  get size() { return [...this.values()].length; }
  values() {
    const records = this.storage.listThreadMetadata().filter(record => record.backend === "codex");
    const byId = new Map(records.map(record => [record.threadId, record]));
    const ids = new Set([...this.inventory.keys(), ...byId.keys()]);
    return [...ids].map(id => this.project(id, byId.get(id), this.inventory.get(id))).values();
  }
  set(id, thread) {
    if (id !== thread.id) throw new Error("Thread registry identity changed");
    this.storage.updateThreadMetadata({ backend: "codex", threadId: id }, outpostThreadMetadata(thread));
  }
}
