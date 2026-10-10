import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadHandoffExport, ThreadHandoffPackage } from "@pwragent/shared";
import { computeWorktreePath } from "../app-server/git-directory-service";
import { userHomeWorktreesRoot } from "../settings/desktop-config";
import { ThreadInstanceHandoffService } from "../federation/thread-instance-handoff-service";
import type { ImportInstanceThreadRequest } from "../federation/thread-instance-handoff-service";
import { decodeThreadHandoff, encodeThreadHandoff, threadHistoryDigest } from "../federation/thread-handoff-package";

const roots: string[] = [];
const replay: ThreadHandoffExport["replay"] = {
  entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false },
};
const source: ThreadHandoffExport = { rolloutBase64: Buffer.from("opaque fixture history\n").toString("base64"), replay, title: "Windows fixture" };

async function setup(options: { createHistoryWorkspace?: () => Promise<string> } = {}) {
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
    allocateHandoffWorktreePath: undefined as ((repositoryPath: string) => Promise<string>) | undefined,
  };
  const receipt = vi.fn(() => true);
  const receiver = new ThreadInstanceHandoffService({
    backend, directory: path.join(root, "receiver"), localInstanceId: () => "pwr_receiver",
    push: vi.fn(), remoteImport: vi.fn(), assertTarget: vi.fn(), receipt, prepareTarget: vi.fn(), ...options,
  });
  const remoteImport = vi.fn(async (_instanceId: string, request: ImportInstanceThreadRequest) => await receiver.receive("pwr_sender", request));
  const prepareTarget = vi.fn(async (_instanceId: string, request: Parameters<typeof receiver.prepare>[0]) => await receiver.prepare(request));
  const push = vi.fn(async (_instanceId: string, file: string) => {
    const incoming = path.join(root, "downloads", path.basename(file));
    await mkdir(path.dirname(incoming), { recursive: true });
    await copyFile(file, incoming);
    const bytes = await readFile(incoming);
    return { path: incoming, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const sender = new ThreadInstanceHandoffService({
    backend, directory: path.join(root, "sender"), localInstanceId: () => "pwr_sender",
    assertTarget: vi.fn(), receipt: vi.fn(), remoteImport,
    prepareTarget, push,
  });
  return { root, backend, sender, receiver, receipt, remoteImport, archive, prepareTarget, push };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("copies opaque history into a receiver workspace and retains the source", async () => {
  const { sender, backend, archive, root } = await setup();
  const result = await sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", operation: "copy" });
  expect(result).toMatchObject({ sourceThreadId: "source-thread", threadId: "destination-thread", instanceId: "pwr_receiver", sourceArchived: false });
  expect(backend.forkThread).toHaveBeenCalledWith(expect.objectContaining({ sourceThreadId: "source-thread", directoryPath: result.directoryPath, backend: "codex" }));
  expect(backend.renameThread).toHaveBeenCalledWith({ backend: "codex", threadId: "destination-thread", name: "Windows fixture" });
  expect(archive).not.toHaveBeenCalled();
  expect(await stat(result.directoryPath)).toBeDefined();
  expect(await readdir(path.join(root, "downloads"))).toEqual([]);
});

it("starts a history-only import in the receiver's Workspaces folder", async () => {
  let scratch = "";
  const { sender, root } = await setup({
    createHistoryWorkspace: async () => {
      scratch = path.join(root, "projects", "2026-10-01-abc123");
      await mkdir(scratch, { recursive: true });
      return scratch;
    },
  });
  const result = await sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", operation: "copy" });
  expect(result.directoryPath).toBe(scratch);
});

it("moves only after validation and preserves the source worktree", async () => {
  const { sender, archive, backend } = await setup();
  const result = await sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", operation: "move" });
  expect(result.sourceArchived).toBe(true);
  expect(archive).toHaveBeenCalledWith({ backend: "codex", threadId: "source-thread", preserveWorktrees: true });
  expect(backend.readThread.mock.invocationCallOrder[0]).toBeLessThan(archive.mock.invocationCallOrder[0]);
});

async function gitFixture(root: string) {
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
  const remote = path.join(root, "origin.git");
  await git(root, "clone", "--bare", repository, remote);
  await git(repository, "remote", "add", "origin", remote);
  await git(root, "clone", remote, destinationRepo);
  await git(destinationRepo, "config", "core.autocrlf", "false");
  return { repository, subdirectory, destinationRepo, canonicalDestinationRepo: await realpath(destinationRepo), git };
}

it("transfers a Git workspace and keeps the thread's subdirectory cwd", async () => {
  const { sender, backend, root } = await setup();
  const { subdirectory, destinationRepo, canonicalDestinationRepo } = await gitFixture(root);
  backend.exportThreadForHandoff.mockResolvedValue({ ...source, cwd: subdirectory });
  const result = await sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", targetRepositoryPath: destinationRepo, operation: "copy" });
  const worktree = path.dirname(path.dirname(result.directoryPath));
  expect(path.dirname(path.dirname(worktree))).toBe(path.join(canonicalDestinationRepo, ".worktrees"));
  expect(path.basename(worktree)).toBe("destination-repo");
  expect(result.directoryPath).toBe(path.join(worktree, "packages", "example"));
  expect(await readFile(path.join(result.directoryPath, "code.txt"), "utf8")).toBe("committed\n");
  expect(backend.forkThread).toHaveBeenCalledWith(expect.objectContaining({
    directoryPath: result.directoryPath, directoryLabel: "destination-repo", workMode: "worktree",
    importedWorktree: { repositoryPath: expect.any(String), worktreePath: worktree },
  }));
  const importedRepository = backend.forkThread.mock.calls[0]![0].importedWorktree!.repositoryPath;
  expect(path.resolve(importedRepository)).toBe(path.resolve(canonicalDestinationRepo));
  expect(result.warnings).toContain("Workspace is detached at the source commit. Original branch: main.");
});

it("checks out a free source branch and reports no detached-workspace warning", async () => {
  const { sender, backend, root } = await setup();
  const { repository, subdirectory, destinationRepo, git } = await gitFixture(root);
  await git(repository, "switch", "-c", "feature/handoff");
  await git(repository, "push", "-u", "origin", "feature/handoff");
  backend.exportThreadForHandoff.mockResolvedValue({ ...source, cwd: subdirectory });
  const result = await sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", targetRepositoryPath: destinationRepo, operation: "copy" });
  expect((await git(result.directoryPath, "branch", "--show-current")).stdout.trim()).toBe("feature/handoff");
  expect(result.warnings.some((warning) => warning.includes("detached"))).toBe(false);
});

it("places a Git import where the receiver's Worktrees setting puts worktrees", async () => {
  const { sender, backend, root } = await setup();
  const { subdirectory, destinationRepo } = await gitFixture(root);
  const home = path.join(root, "home");
  const allocate = vi.fn(async (repositoryPath: string) =>
    await computeWorktreePath({ repoRoot: repositoryPath, storage: "user-home", homeDir: home }));
  backend.allocateHandoffWorktreePath = allocate;
  backend.exportThreadForHandoff.mockResolvedValue({ ...source, cwd: subdirectory });
  const result = await sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", targetRepositoryPath: destinationRepo, operation: "copy" });
  expect(allocate).toHaveBeenCalledTimes(1);
  const worktree = path.dirname(path.dirname(result.directoryPath));
  expect(path.dirname(path.dirname(worktree))).toBe(userHomeWorktreesRoot(home));
  expect(await readFile(path.join(result.directoryPath, "code.txt"), "utf8")).toBe("committed\n");
  expect(await readdir(destinationRepo)).not.toContain(".worktrees");
});

it.skipIf(process.platform === "win32")("moves a published Git thread with symlinks after validating its fork", async () => {
  const { sender, backend, archive, root, prepareTarget } = await setup();
  const { repository, subdirectory, destinationRepo, git } = await gitFixture(root);
  await writeFile(path.join(repository, "AGENTS.md"), "fixture guidance\n");
  await symlink("AGENTS.md", path.join(repository, "CLAUDE.md"));
  await git(repository, "add", "AGENTS.md", "CLAUDE.md");
  await git(repository, "commit", "-m", "guidance fixture");
  await git(repository, "push", "origin", "main");
  backend.exportThreadForHandoff.mockResolvedValue({ ...source, cwd: subdirectory });
  const result = await sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", targetRepositoryPath: destinationRepo, operation: "move" });
  const worktree = path.dirname(path.dirname(result.directoryPath));
  expect(await readlink(path.join(worktree, "CLAUDE.md"))).toBe("AGENTS.md");
  expect(result.sourceArchived).toBe(true);
  expect(prepareTarget).toHaveBeenCalledWith("pwr_receiver", expect.objectContaining({ repository: destinationRepo,
    git: expect.objectContaining({ ref: "refs/heads/main", cwdRelative: "packages/example" }) }));
  expect(backend.readThread.mock.invocationCallOrder[0]).toBeLessThan(archive.mock.invocationCallOrder[0]);
});

it.each(["dirty", "unpushed", "submodules", "missing receiver"])("stops before sending history for %s Git preflight", async (condition) => {
  const { sender, backend, root, push, remoteImport, archive } = await setup();
  const { repository, subdirectory, destinationRepo, git } = await gitFixture(root);
  backend.exportThreadForHandoff.mockResolvedValue({ ...source, cwd: subdirectory });
  if (condition === "dirty") await writeFile(path.join(subdirectory, "code.txt"), "uncommitted\n");
  if (condition === "unpushed") await git(repository, "commit", "--allow-empty", "-m", "unpublished");
  if (condition === "submodules") {
    const dependency = path.join(root, "dependency");
    await git(root, "clone", repository, dependency);
    await git(repository, "-c", "protocol.file.allow=always", "submodule", "add", dependency, "vendor/dependency");
    await git(repository, "commit", "-m", "submodule fixture");
    await git(repository, "push", "origin", "main");
  }
  await expect(sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver",
    targetRepositoryPath: condition === "missing receiver" ? path.join(root, "not-cloned") : destinationRepo, operation: "move" }))
    .rejects.toThrow(condition === "dirty" ? "Commit or stash" : condition === "unpushed" ? "Push branch"
      : condition === "submodules" ? "submodules" : "Clone it there");
  expect(push).not.toHaveBeenCalled();
  expect(remoteImport).not.toHaveBeenCalled();
  expect(archive).not.toHaveBeenCalled();
});

it("rejects a legacy receiver before pushing history", async () => {
  const { sender, prepareTarget, push } = await setup();
  prepareTarget.mockResolvedValueOnce([] as unknown as Awaited<ReturnType<typeof prepareTarget>>);
  await expect(sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", operation: "copy" }))
    .rejects.toThrow("Upgrade the receiving PwrAgent");
  expect(push).not.toHaveBeenCalled();
});

it("keeps the source when new workspace edits arrive after the receiver confirms its fork", async () => {
  const { sender, backend, root, remoteImport, archive } = await setup();
  const { subdirectory, destinationRepo } = await gitFixture(root);
  backend.exportThreadForHandoff.mockResolvedValue({ ...source, cwd: subdirectory });
  const importOne = remoteImport.getMockImplementation()!;
  remoteImport.mockImplementationOnce(async (instanceId, request) => {
    const destination = await importOne(instanceId, request);
    await writeFile(path.join(subdirectory, "code.txt"), "new source edit\n");
    return destination;
  });
  const result = await sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", targetRepositoryPath: destinationRepo, operation: "move" });
  expect(result.sourceArchived).toBe(false);
  expect(result.warnings.some((warning) => warning.includes("Commit or stash"))).toBe(true);
  expect(archive).not.toHaveBeenCalled();
});

it("transfers a non-Git workspace using the receiver's platform and restores the fork cwd", async () => {
  const { sender, backend, root, prepareTarget, receiver } = await setup();
  const directory = path.join(root, "non-git");
  await mkdir(directory);
  await writeFile(path.join(directory, "code.txt"), "workspace bytes\n");
  backend.exportThreadForHandoff.mockResolvedValue({ ...source, cwd: directory });
  prepareTarget.mockImplementationOnce(async (_instanceId, request) => ({ ...await receiver.prepare(request), platform: "win32" }));
  const result = await sender.send({ sourceThreadId: "source-thread", targetInstanceId: "pwr_receiver", operation: "copy" });
  expect(await readFile(path.join(result.directoryPath, "code.txt"), "utf8")).toBe("workspace bytes\n");
  expect(result.warnings).toContain("ZIP workspaces do not transfer symlinks.");
  expect(backend.forkThread).toHaveBeenCalledWith(expect.objectContaining({ directoryPath: result.directoryPath, workMode: "local" }));
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
  const pkg: ThreadHandoffPackage = { version: 2, handoffId, sourceThreadId: "source-thread", rolloutBase64: source.rolloutBase64, historyDigest: threadHistoryDigest(replay) };
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

it("keeps accepting imports after many settled ones", async () => {
  const { receiver, backend, root } = await setup();
  for (let index = 0; index < 130; index += 1) {
    const handoffId = randomUUID();
    const bytes = await encodeThreadHandoff({ version: 2, handoffId, sourceThreadId: "source-thread", rolloutBase64: source.rolloutBase64, historyDigest: threadHistoryDigest(replay) });
    const filePath = path.join(root, `${handoffId}.gz`);
    await writeFile(filePath, bytes);
    await receiver.receive("pwr_sender", { handoffId, file: { path: filePath, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } });
  }
  expect(backend.forkThread).toHaveBeenCalledTimes(130);
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
    version: 2, handoffId, sourceThreadId: "source-thread", rolloutBase64: source.rolloutBase64, historyDigest: threadHistoryDigest(replay),
    git: { head: "a".repeat(40), ref: "refs/heads/main", origin: "example/repo", cwdRelative: ".git/config" },
  };
  await expect(decodeThreadHandoff(await encodeThreadHandoff(pkg))).rejects.toThrow("Unsafe");
});
