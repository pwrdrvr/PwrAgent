import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadHandoffExport, ThreadHandoffPackage } from "@pwragent/shared";
import { ThreadInstanceHandoffService } from "../federation/thread-instance-handoff-service";
import type { ImportInstanceThreadRequest } from "../federation/thread-instance-handoff-service";
import { decodeThreadHandoff, encodeThreadHandoff, threadHistoryDigest } from "../federation/thread-handoff-package";

const roots: string[] = [];
const replay: ThreadHandoffExport["replay"] = {
  entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false },
};
const source: ThreadHandoffExport = { rolloutBase64: Buffer.from("opaque fixture history\n").toString("base64"), replay, title: "Windows fixture" };

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-handoff-"));
  roots.push(root);
  const archive = vi.fn(async () => {});
  const backend = {
    withThreadHandoff: async <T>(_threadId: string, work: () => Promise<T>) => await work(),
    exportThreadForHandoff: vi.fn(async () => source),
    archiveThread: archive,
    forkThread: vi.fn(async (_request: { directoryPath: string; importedWorktree?: { repositoryPath: string; worktreePath: string } }) => ({ threadId: "destination-thread" })),
    readThread: vi.fn(async () => ({ replay })),
    renameThread: vi.fn(async () => {}),
  };
  const receipt = vi.fn(() => true);
  const receiver = new ThreadInstanceHandoffService({
    backend, directory: path.join(root, "receiver"), localInstanceId: () => "pwr_receiver",
    push: vi.fn(), remoteImport: vi.fn(), assertTarget: vi.fn(), receipt,
  });
  const remoteImport = vi.fn(async (_instanceId: string, request: ImportInstanceThreadRequest) => await receiver.receive("pwr_sender", request));
  const sender = new ThreadInstanceHandoffService({
    backend, directory: path.join(root, "sender"), localInstanceId: () => "pwr_sender",
    assertTarget: vi.fn(), receipt: vi.fn(), remoteImport,
    push: async (_instanceId, file) => {
      const incoming = path.join(root, path.basename(file));
      await copyFile(file, incoming);
      const bytes = await readFile(incoming);
      return { path: incoming, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    },
  });
  return { root, backend, sender, receiver, receipt, remoteImport, archive };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("copies opaque history into a receiver workspace and retains the source", async () => {
  const { sender, backend, archive } = await setup();
  const result = await sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", operation: "copy" });
  expect(result).toMatchObject({ sourceThreadId: "source-thread", threadId: "destination-thread", instanceId: "pwr_receiver", sourceArchived: false });
  expect(backend.forkThread).toHaveBeenCalledWith(expect.objectContaining({ sourceThreadId: "source-thread", directoryPath: result.directoryPath, backend: "codex" }));
  expect(backend.renameThread).toHaveBeenCalledWith({ backend: "codex", threadId: "destination-thread", name: "Windows fixture" });
  expect(archive).not.toHaveBeenCalled();
  expect(await stat(result.directoryPath)).toBeDefined();
});

it("moves only after validation and preserves the source worktree", async () => {
  const { sender, archive, backend } = await setup();
  const result = await sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", operation: "move" });
  expect(result.sourceArchived).toBe(true);
  expect(archive).toHaveBeenCalledWith({ backend: "codex", threadId: "source-thread", preserveWorktrees: true });
  expect(backend.readThread.mock.invocationCallOrder[0]).toBeLessThan(archive.mock.invocationCallOrder[0]);
});

it("transfers a Git workspace and keeps the thread's subdirectory cwd", async () => {
  const { sender, backend, root } = await setup();
  const repository = path.join(root, "source-repo");
  const subdirectory = path.join(repository, "packages", "example");
  await mkdir(subdirectory, { recursive: true });
  const execute = promisify(execFile);
  const git = async (cwd: string, ...args: string[]) => await execute("git", ["-C", cwd, ...args]);
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Fixture");
  await git(repository, "config", "user.email", "fixture@example.invalid");
  await git(repository, "config", "core.autocrlf", "false");
  await writeFile(path.join(subdirectory, "code.txt"), "committed\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "fixture");
  const destinationRepo = path.join(root, "destination-repo");
  await git(root, "clone", repository, destinationRepo);
  const canonicalDestinationRepo = await realpath(destinationRepo);
  await writeFile(path.join(subdirectory, "code.txt"), "unstaged\n");
  backend.exportThreadForHandoff.mockResolvedValue({ ...source, cwd: subdirectory });
  const result = await sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", targetRepositoryPath: destinationRepo, operation: "copy" });
  const worktree = path.dirname(path.dirname(result.directoryPath));
  expect(path.dirname(path.dirname(worktree))).toBe(path.join(canonicalDestinationRepo, ".worktrees"));
  expect(path.basename(worktree)).toBe("destination-repo");
  expect(result.directoryPath).toBe(path.join(worktree, "packages", "example"));
  expect(await readFile(path.join(result.directoryPath, "code.txt"), "utf8")).toBe("unstaged\n");
  expect(backend.forkThread).toHaveBeenCalledWith(expect.objectContaining({
    directoryPath: result.directoryPath, directoryLabel: "destination-repo", workMode: "worktree",
    importedWorktree: { repositoryPath: expect.any(String), worktreePath: worktree },
  }));
  const importedRepository = backend.forkThread.mock.calls[0]![0].importedWorktree!.repositoryPath;
  expect(path.resolve(importedRepository)).toBe(path.resolve(canonicalDestinationRepo));
});

it("retains the workspace when fork rejection leaves provider creation uncertain", async () => {
  const { sender, backend, archive } = await setup();
  backend.forkThread.mockRejectedValueOnce(new Error("overlay persistence failed"));
  await expect(sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", operation: "move" }))
    .rejects.toThrow("Workspace retained");
  const request = backend.forkThread.mock.calls[0]?.[0];
  expect(await stat(request!.directoryPath)).toBeDefined();
  expect(archive).not.toHaveBeenCalled();
});

it("retains a known destination workspace when retirement fails", async () => {
  const { sender, backend, archive } = await setup();
  backend.readThread.mockRejectedValueOnce(new Error("history read failed"));
  archive.mockRejectedValueOnce(new Error("retirement failed"));
  await expect(sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", operation: "move" }))
    .rejects.toThrow("retirement failed");
  expect(await stat(backend.forkThread.mock.calls[0]![0].directoryPath)).toBeDefined();
});

it("fails a missing source workspace instead of silently moving history alone", async () => {
  const { sender, backend, archive, root } = await setup();
  backend.exportThreadForHandoff.mockResolvedValue({ ...source, cwd: path.join(root, "missing") });
  await expect(sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", operation: "move" })).rejects.toMatchObject({ code: "ENOENT" });
  expect(backend.forkThread).not.toHaveBeenCalled();
  expect(archive).not.toHaveBeenCalled();
});

it("reports a ready destination when source archive fails", async () => {
  const { sender, archive } = await setup();
  archive.mockRejectedValue(new Error("source disconnected"));
  const result = await sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", operation: "move" });
  expect(result.sourceArchived).toBe(false);
  expect(result.threadId).toBe("destination-thread");
  expect(result.warnings).toContain("Destination is ready; source archival was not confirmed: source disconnected");
});

it("retires a mismatched destination, rolls back its workspace, and keeps the source", async () => {
  const { sender, archive, backend, root } = await setup();
  backend.readThread.mockResolvedValue({ replay: { ...replay, messages: [{ id: "changed", role: "user", text: "different" }] } });
  await expect(sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", operation: "move" })).rejects.toThrow("history did not match");
  expect(archive).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "destination-thread", preserveWorktrees: true });
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(path.join(root, "receiver", "workspaces"))).toEqual([]);
});

it("keeps the source when a completed receiver import loses its acknowledgement", async () => {
  const { sender, remoteImport, receiver, archive, backend } = await setup();
  remoteImport.mockImplementationOnce(async (_instanceId, request) => {
    await receiver.receive("pwr_sender", request);
    throw new Error("acknowledgement disconnected");
  });
  await expect(sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", operation: "move" })).rejects.toThrow("acknowledgement disconnected");
  expect(backend.forkThread).toHaveBeenCalledTimes(1);
  expect(archive).not.toHaveBeenCalled();
});

it("does not archive a source whose history changes through another protocol client", async () => {
  const { sender, backend, archive } = await setup();
  backend.exportThreadForHandoff.mockResolvedValueOnce(source).mockResolvedValueOnce({
    ...source, replay: { ...replay, messages: [{ id: "new", role: "user", text: "External change" }] },
  });
  const result = await sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", operation: "move" });
  expect(result.sourceArchived).toBe(false);
  expect(result.warnings).toContain("Destination is ready; source archival was not confirmed: Source history changed during transfer.");
  expect(archive).not.toHaveBeenCalled();
});

it("binds imports to the pushing peer and deduplicates repeated acknowledgements", async () => {
  const { receiver, backend, root, receipt } = await setup();
  const handoffId = randomUUID();
  const pkg: ThreadHandoffPackage = { version: 1, handoffId, sourceThreadId: "source-thread", rolloutBase64: source.rolloutBase64, historyDigest: threadHistoryDigest(replay) };
  const bytes = await encodeThreadHandoff(pkg);
  const filePath = path.join(root, "package.gz");
  await writeFile(filePath, bytes);
  const request = { handoffId, file: { path: filePath, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
  receipt.mockReturnValueOnce(false);
  await expect(receiver.receive("wrong-peer", request)).rejects.toThrow("verified file");
  const [first, second] = await Promise.all([receiver.receive("pwr_sender", request), receiver.receive("pwr_sender", request)]);
  expect(first).toEqual(second);
  expect(backend.forkThread).toHaveBeenCalledTimes(1);
  await expect(receiver.receive("pwr_sender", { ...request, targetRepositoryPath: root })).rejects.toThrow("reused");
});

it("rejects tampered checksums and unsafe file paths before importing", async () => {
  const { receiver, backend, root } = await setup();
  const handoffId = randomUUID();
  const file = path.join(root, "bad.gz");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "changed");
  await expect(receiver.receive("pwr_sender", { handoffId, file: { path: file, sizeBytes: 7, sha256: "incorrect" } })).rejects.toThrow("checksum");
  expect(backend.forkThread).not.toHaveBeenCalled();
  const pkg: ThreadHandoffPackage = {
    version: 1, handoffId, sourceThreadId: "source-thread", rolloutBase64: source.rolloutBase64, historyDigest: threadHistoryDigest(replay),
    git: { head: "a".repeat(40), indexCommit: "b".repeat(40), workingCommit: "c".repeat(40), bundleBase64: "", files: [{ path: ".git/config", mode: "100644", dataBase64: "" }] },
  };
  await expect(decodeThreadHandoff(await encodeThreadHandoff(pkg))).rejects.toThrow("Unsafe");
});
