import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import * as attachments from "../app-server/turn-input-attachment-files";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { CountingBackendClient, createThreadReadRegistry, publishNotification } from "./fixtures/thread-read-harness";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const identities = [
  { backend: "codex" as const, threadId: "watcher" },
  { backend: "claude" as const, threadId: "watcher" },
  { backend: "acp:grok" as const, threadId: "other-watcher" },
];

async function checkLifecycle(steps: Array<{ target: number; archived: boolean }>): Promise<void> {
  const { registry } = createThreadReadRegistry([]);
  // Admission is the boundary under test. Starting a provider turn would
  // obscure whether an archived wake reached the queue at all.
  const admit = vi.spyOn(registry["threadTurnQueue"], "submitIfIdle")
    .mockImplementation(async (entry) => ({
      status: "started", turnId: "wake",
      entry: { ...entry, id: "wake", createdAt: 1 },
    }));
  const archived = identities.map(() => false);
  try {
    for (const step of steps) {
      const identity = identities[step.target]!;
      // The owning provider's lifecycle events are the oracle. Same-id
      // threads on another backend must keep their own eligibility.
      archived[step.target] = step.archived;
      await publishNotification(registry, step.archived
        ? { method: "thread/archived", params: { threadId: identity.threadId } }
        : { method: "thread/unarchived", params: { threadId: identity.threadId } }, identity.backend);
      for (const [index, target] of identities.entries()) {
        admit.mockClear();
        const result = await registry.submitTurnIfIdle({
          ...target, input: [{ type: "text", text: "The watched PR merged." }], origin: "automation",
        });
        expect(result.status).toBe(archived[index] ? "busy" : "started");
        expect(admit).toHaveBeenCalledTimes(archived[index] ? 0 : 1);
      }
    }
  } finally {
    await registry.close();
  }
}

describe("automatic turns respect provider archival", () => {
  it("does not admit a PR wake after archive, and admits it after restore", async () => {
    await checkLifecycle([{ target: 0, archived: true }, { target: 0, archived: false }]);
  });

  it("rejects an archived automatic turn after restart before any provider inventory has loaded", async () => {
    const db = openInMemoryStateDb();
    const store = new SqliteOverlayStore(db);
    const target = identities[0]!;
    await store.observeArchivedThreads([target], 1);
    const registry = new DesktopBackendRegistry({
      codexClient: new CountingBackendClient([]) as never, overlayStore: store, threadTitleGenerationService: null,
    });
    const admit = vi.spyOn(registry["threadTurnQueue"], "submitIfIdle")
      .mockResolvedValue({ status: "busy" });
    const wake = { ...target, input: [{ type: "text" as const, text: "The watched PR merged." }], origin: "automation" as const };
    try {
      expect(registry.getThreadInfo(target)).toBeUndefined();
      await expect(registry.submitTurnIfIdle(wake)).resolves.toEqual({ status: "busy" });
      expect(admit).not.toHaveBeenCalled();
      await store.setThreadArchiveTombstone({ ...target, restoredAt: 2 });
      await registry.submitTurnIfIdle(wake);
      expect(admit).toHaveBeenCalledTimes(1);
    } finally {
      await registry.close();
      db.close();
    }
  });

  it("follows each identity's latest archive or restore observation", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.record({
      target: fc.integer({ min: 0, max: identities.length - 1 }),
      archived: fc.boolean(),
    }), { minLength: 1, maxLength: 12 }), checkLifecycle), { numRuns: 25 });
  });

  it("rechecks an archive that arrives while attachments are being prepared", async () => {
    const { registry } = createThreadReadRegistry([]);
    const target = identities[0]!;
    const admit = vi.spyOn(registry["threadTurnQueue"], "submitIfIdle")
      .mockResolvedValue({ status: "busy" });
    const prepare = vi.spyOn(attachments, "ownThreadInputAttachments")
      .mockImplementationOnce(async (input) => {
        await publishNotification(registry, {
          method: "thread/archived", params: { threadId: target.threadId },
        });
        return [...input];
      });
    try {
      await expect(registry.submitTurnIfIdle({
        ...target, input: [{ type: "text", text: "The watched PR merged." }], origin: "automation",
      })).resolves.toEqual({ status: "busy" });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(admit).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      await registry.close();
    }
  });
});
