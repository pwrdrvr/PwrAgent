import { patchOwnerThreadMetadata } from "../dist/federation-core.js";

const FIELDS = [
  ["archived", "archived"],
  ["model", "model"], ["reasoningEffort", "reasoningEffort"], ["serviceTier", "serviceTier"], ["fastMode", "fastMode"],
  ["executionModeUpdatedAt", "executionModeUpdatedAt"], ["reasoningEffortsByModel", "reasoningEffortsByModel"],
  ["modelMigrationRevision", "modelMigrationRevision"], ["modelSettingsManuallyUpdatedAt", "modelSettingsManuallyUpdatedAt"],
  ["createdAt", "createdAt"], ["updatedAt", "updatedAt"], ["cwd", "cwd"],
  ["pinnedRank", "pinnedRank"], ["seenAt", "seenAt"], ["seenUpdatedAt", "seenUpdatedAt"],
  ["archivedAt", "archivedAt"], ["restoredAt", "restoredAt"],
  ["archiveRetentionStartedAt", "archiveRetentionStartedAt"],
  ["subthreadOrder", "subthreadOrder"], ["subthreadsCollapsed", "subthreadsCollapsed"],
];

/** Storage view over the backend's live threads.json map; no lifecycle calls. */
export class OutpostThreadRegistry {
  constructor(backend) {
    this.backend = backend;
  }

  identity(identity) {
    if (identity.backend !== "codex") throw new Error("This outpost stores Codex threads only");
  }

  record(thread) {
    const patch = {
      executionMode: thread.sandbox === "workspace-write" ? "auto" : thread.sandbox === "danger-full-access" ? "full-access" : "default",
      title: thread.title === undefined ? undefined : { text: thread.title, source: thread.titleSource ?? "fallback" },
      parent: thread.parentThreadId !== undefined ? { backend: thread.parentThreadBackend ?? "codex", threadId: thread.parentThreadId,
        ...(thread.parentThreadInstanceId !== undefined ? { instanceId: thread.parentThreadInstanceId } : {}) } : undefined,
    };
    for (const [field, stored] of FIELDS) patch[field] = thread[stored];
    return patchOwnerThreadMetadata(undefined, { backend: "codex", threadId: thread.id }, patch);
  }

  async getThreadMetadata(identity) {
    this.identity(identity);
    const thread = this.backend.threads.get(identity.threadId);
    return thread ? this.record(thread) : undefined;
  }

  async listThreadMetadata() {
    return [...this.backend.threads.values()].map((thread) => this.record(thread));
  }

  async updateThreadMetadata(identity, patch) {
    this.identity(identity);
    const thread = this.backend.threads.get(identity.threadId);
    const current = thread ? this.record(thread) : undefined;
    const next = patchOwnerThreadMetadata(current, identity, patch);
    if (!current || JSON.stringify(current) !== JSON.stringify(next)) {
      const stored = { ...thread, id: identity.threadId, title: next.title?.text, titleSource: next.title?.source,
        sandbox: next.executionMode === "auto" ? "workspace-write" : next.executionMode === "full-access" ? "danger-full-access" : "read-only",
        parentThreadId: next.parent?.threadId, parentThreadBackend: next.parent?.backend,
        parentThreadInstanceId: next.parent?.instanceId };
      for (const [field, key] of FIELDS) stored[key] = structuredClone(next[field]);
      // Keep the live registry unchanged if the durable write fails.
      this.backend.threads.set(identity.threadId, stored);
      try { this.backend.persist(); }
      catch (error) {
        if (thread) this.backend.threads.set(identity.threadId, thread);
        else this.backend.threads.delete(identity.threadId);
        throw error;
      }
    }
    return next;
  }
}
