import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { ClaudeBackend } from "../claude/claude-backend";
import { ClaudeSessionStore } from "../claude/claude-session-store";

const id = "a4444444-4444-4444-8444-444444444444";

async function restoreDuringDelete(deletingInstance: number, text: string, restoreFirst = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-retention-race-"));
  const stores = [new ClaudeSessionStore(root), new ClaudeSessionStore(root)];
  const backends = stores.map((store) => new ClaudeBackend({
    store, emit: vi.fn(), request: vi.fn(), cancelRequest: vi.fn(),
    inspectInstallation: async () => ({ authStatus: "unknown" }),
  }));
  const deleting = stores[deletingInstance]!;
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const remove = deleting.delete.bind(deleting);
  vi.spyOn(deleting, "delete").mockImplementation(async (...args) => {
    entered.resolve();
    await resume.promise;
    return await remove(...args);
  });
  try {
    await stores[0]!.save({ cwd: "/fixture/.pwragent/worktrees/race/repo", thread: {
      id, source: "claude", title: "Archived", titleSource: "explicit", linkedDirectories: [], archivedAt: 1,
    } });
    await stores[0]!.append(id, [{ type: "message", id: "message", role: "user", text }]);
    const originalHistory = await readFile(path.join(root, `${id}.jsonl`), "utf8");
    if (restoreFirst) {
      await backends[1 - deletingInstance]!.setArchived(id, false);
      await expect(backends[deletingInstance]!.deleteThread(id)).rejects.toThrow("Archive this Claude thread");
      expect((await stores[0]!.read(id)).thread.archivedAt).toBeUndefined();
      expect(await readFile(path.join(root, `${id}.jsonl`), "utf8")).toBe(originalHistory);
      return;
    }
    const deletion = backends[deletingInstance]!.deleteThread(id).then(() => true, () => false);
    await entered.promise;
    // Two instances must never both acknowledge these conflicting mutations.
    const restored = await backends[1 - deletingInstance]!.setArchived(id, false).then(() => true, () => false);
    resume.resolve();
    const deleted = await deletion;
    expect(restored && deleted).toBe(false);
    expect(restored || deleted).toBe(true);
    if (restored) {
      expect((await stores[0]!.read(id)).thread.archivedAt).toBeUndefined();
      expect(await readFile(path.join(root, `${id}.jsonl`), "utf8")).toBe(originalHistory);
    }
  } finally {
    resume.resolve();
    await Promise.all(backends.map((backend) => backend.close()));
    await rm(root, { recursive: true, force: true });
  }
}

describe("shared-profile Claude retention admission", () => {
  it("never acknowledges a restore whose conversation a concurrent deletion erases", async () => {
    await restoreDuringDelete(0, "Restored conversation");
  });

  it("serializes restore and permanent deletion regardless of the instance and conversation", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 1 }), fc.string({ maxLength: 100 }), fc.boolean(),
      restoreDuringDelete), { numRuns: 25 });
  });

  it.each(["metadata", "history", "truncate", "undo", "absent"])("shares deletion admission with %s writes and absence cleanup", async (operation) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-retention-writes-"));
    const store = new ClaudeSessionStore(root);
    const peer = new ClaudeSessionStore(root);
    const session = { cwd: "/fixture/repo", thread: {
      id, source: "claude" as const, title: "Fixture", titleSource: "explicit" as const, linkedDirectories: [], archivedAt: 1,
    } };
    const backend = new ClaudeBackend({ store: peer, emit: vi.fn(), request: vi.fn(), cancelRequest: vi.fn(),
      inspectInstallation: async () => ({ authStatus: "unknown" }) });
    const mutate = async () => {
      if (operation === "metadata") await peer.save(session);
      if (operation === "history") await peer.append(id, [{ type: "message", id: "message", role: "user", text: "Keep" }]);
      if (operation === "truncate") await peer.truncate(id, "message");
      if (operation === "undo") await peer.undoTruncation(id, "truncation");
      if (operation === "absent") await backend.confirmThreadAbsent(id);
    };
    try {
      await store.save(session);
      await store.withMutation(id, async () => {
        await expect(mutate()).rejects.toThrow("another PwrAgent instance");
        // The lock covers a thread, not the entire shared profile.
        await peer.save({ ...session, thread: { ...session.thread, id: "b4444444-4444-4444-8444-444444444444" } });
      });
      await expect(mutate()).resolves.toBeUndefined();
    } finally { await backend.close(); await rm(root, { recursive: true, force: true }); }
  });
});
