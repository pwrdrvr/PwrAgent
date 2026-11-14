import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadInstanceHandoffService } from "../federation/thread-instance-handoff-service";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(sourceThreadId: string, historyMode: string | undefined) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-property-"));
  roots.push(root);
  const replay = { entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false } };
  const history = Buffer.from(`opaque fixture for ${sourceThreadId}\n`);
  const archiveThread = vi.fn(async () => {});
  const forkThread = vi.fn(async (request: { sourceThreadId: string; sourceThreadPath: string }) => {
    // The source exists only on the sender. The receiver's oracle is the
    // transferred PwrAgent-owned fixture, never a local thread-id lookup.
    expect(request.sourceThreadId).toBe(sourceThreadId);
    expect(await readFile(request.sourceThreadPath)).toEqual(history);
    return { threadId: "destination" };
  });
  const backend = {
    withThreadHandoff: async <T>(_id: string, work: () => Promise<T>) => await work(),
    exportThreadForHandoff: async () => ({ historyMode, replay, rolloutBase64: history.toString("base64") }),
    archiveThread, forkThread,
    readThread: async () => ({ replay }),
    renameThread: async () => {},
  };
  const createHistoryWorkspace = vi.fn(async () => {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    return workspace;
  });
  const receiver = new ThreadInstanceHandoffService({
    backend, directory: path.join(root, "receiver"), localInstanceId: () => "receiver",
    push: vi.fn(), remoteImport: vi.fn(), assertTarget: vi.fn(), receipt: () => true,
    prepareTarget: vi.fn(), createHistoryWorkspace,
  });
  const push = vi.fn(async (_id: string, file: string) => {
    const target = path.join(root, "incoming.gz");
    await copyFile(file, target);
    const bytes = await readFile(target);
    return { path: target, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const sender = new ThreadInstanceHandoffService({
    backend, directory: path.join(root, "sender"), localInstanceId: () => "sender",
    assertTarget: vi.fn(), receipt: () => true, push,
    prepareTarget: async (_id, request) => await receiver.prepare(request),
    remoteImport: async (_id, request) => await receiver.receive("sender", request),
  });
  return { sender, receiver, push, forkThread, archiveThread, createHistoryWorkspace };
}

it("refuses every unconfirmed or nonportable history mode before upload or destination/source mutation", async () => {
  await fc.assert(fc.asyncProperty(
    fc.uuid(), fc.constantFrom("copy", "move"), fc.constantFrom("paginated", "future-mode", undefined),
    async (sourceThreadId, operation, historyMode) => {
      const f = await fixture(sourceThreadId, historyMode);
      await expect(f.sender.send({ sourceThreadId, operation, targetInstanceId: "receiver" }))
        .rejects.toThrow(/history|preflight/i);
      expect(f.push).not.toHaveBeenCalled();
      expect(f.forkThread).not.toHaveBeenCalled();
      expect(f.createHistoryWorkspace).not.toHaveBeenCalled();
      expect(f.archiveThread).not.toHaveBeenCalled();
    },
  ), { numRuns: 25 });
});

it("refuses a paginated copy during receiver prepare", async () => {
  const f = await fixture("01a175be-07a0-7633-9c4d-be01aeef88c6", "paginated");
  await expect(f.sender.send({ sourceThreadId: "01a175be-07a0-7633-9c4d-be01aeef88c6", operation: "copy", targetInstanceId: "receiver" }))
    .rejects.toThrow(/paginated history/i);
  expect(f.push).not.toHaveBeenCalled();
});

it("forks portable history from its transferred path for arbitrary foreign source IDs", async () => {
  await fc.assert(fc.asyncProperty(fc.uuid(), async (sourceThreadId) => {
    const f = await fixture(sourceThreadId, "legacy");
    const result = await f.sender.send({ sourceThreadId, operation: "copy", targetInstanceId: "receiver" });
    expect(result.threadId).toBe("destination");
    expect(f.forkThread).toHaveBeenCalledOnce();
    expect(f.archiveThread).not.toHaveBeenCalled();
  }), { numRuns: 25 });
});
