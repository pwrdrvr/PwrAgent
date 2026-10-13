import { afterEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorktreeContainerService } from "../app-server/worktree-container-service";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir), rmdir: vi.fn(actual.rmdir) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(readdir).mockRestore();
  vi.mocked(rmdir).mockRestore();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-container-")));
  roots.push(root);
  const codexHome = path.join(root, "selected-codex");
  const container = path.join(codexHome, "worktrees", "id");
  await mkdir(container, { recursive: true });
  const worktree = path.join(container, "repo");
  return { root, codexHome, container, worktree, service: new WorktreeContainerService({ codexHome }) };
}

describe("empty archived worktree containers", () => {
  it("removes exactly one empty id while preserving the worktree root and sibling ids", async () => {
    const f = await fixture();
    const sibling = path.join(f.codexHome, "worktrees", "sibling");
    await mkdir(sibling);
    expect(await f.service.inspect(f.worktree)).toMatchObject({ removed: false, containerPath: f.container });
    expect((await lstat(f.container)).isDirectory()).toBe(true);
    expect(await f.service.prune(f.worktree)).toMatchObject({ removed: true });
    await expect(lstat(f.container)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(sibling)).isDirectory()).toBe(true);
    expect(await f.service.prune(f.worktree)).toMatchObject({ removed: false, skippedReason: expect.any(String) });
  });

  it("preserves files, hidden entries, and other checkouts in the container", async () => {
    const f = await fixture();
    await writeFile(path.join(f.container, ".keep"), "preserve");
    expect(await f.service.prune(f.worktree)).toMatchObject({ removed: false, skippedReason: "Container is not empty." });
    expect(rmdir).not.toHaveBeenCalled();
    await rm(path.join(f.container, ".keep"));
    await mkdir(f.worktree);
    expect(await f.service.prune(f.worktree)).toMatchObject({ removed: false });
    expect(rmdir).not.toHaveBeenCalled();
  });

  it("refuses paths outside the selected root, its root itself, and additional nesting", async () => {
    const f = await fixture();
    for (const worktree of [f.root, f.container, path.join(f.root, "other", "id", "repo"), path.join(f.worktree, "nested")]) {
      expect(await f.service.prune(worktree)).toBeUndefined();
    }
    expect(rmdir).not.toHaveBeenCalled();
  });

  it("refuses a container symlink and preserves its target", async () => {
    const f = await fixture();
    const target = path.join(f.root, "unrelated");
    await mkdir(target);
    await rm(f.container, { recursive: true });
    await symlink(target, f.container, process.platform === "win32" ? "junction" : "dir");
    expect(await f.service.prune(f.worktree)).toMatchObject({ removed: false, skippedReason: expect.any(String) });
    expect((await lstat(target)).isDirectory()).toBe(true);
    expect(rmdir).not.toHaveBeenCalled();
  });

  it("retains content created after inspection and treats concurrent removal as a skip", async () => {
    const f = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const result = await f.service.prune(f.worktree, () => {
      vi.mocked(rmdir).mockImplementationOnce(async () => {
        await writeFile(path.join(f.container, "new-content"), "preserve");
        await actual.rmdir(f.container);
      });
    });
    expect(result).toMatchObject({ removed: false, skippedReason: expect.any(String) });
    expect((await lstat(path.join(f.container, "new-content"))).isFile()).toBe(true);
    await rm(f.container, { recursive: true });
    expect(await f.service.prune(f.worktree)).toMatchObject({ removed: false, skippedReason: expect.any(String) });
  });

  it("reports inspection and deletion errors without throwing or removing the directory", async () => {
    const f = await fixture();
    vi.mocked(readdir).mockRejectedValueOnce(Object.assign(new Error("Access denied"), { code: "EACCES" }));
    expect(await f.service.prune(f.worktree)).toMatchObject({ removed: false, error: "Access denied" });
    vi.mocked(rmdir).mockRejectedValueOnce(Object.assign(new Error("Locked by another process"), { code: "EPERM" }));
    expect(await f.service.prune(f.worktree)).toMatchObject({ removed: false, error: "Locked by another process" });
    expect((await lstat(f.container)).isDirectory()).toBe(true);
    expect(await f.service.prune(f.worktree, () => { throw new Error("Restore superseded archive"); }))
      .toMatchObject({ removed: false, error: "Restore superseded archive" });
  });

  it("retains a directory replaced during inspection", async () => {
    const f = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(readdir).mockImplementationOnce(async () => {
      await actual.rename(f.container, path.join(f.root, "old-container"));
      await mkdir(f.container);
      return [];
    });
    expect(await f.service.prune(f.worktree)).toMatchObject({ removed: false, skippedReason: "Container identity changed before removal." });
    expect(rmdir).not.toHaveBeenCalled();
    expect((await lstat(f.container)).isDirectory()).toBe(true);
  });

  it("retains a new reservation at a historical archived path after discovery", async () => {
    const f = await fixture();
    const inspected = await f.service.inspect(f.worktree);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await actual.rename(f.container, path.join(f.root, "previous-container"));
    await mkdir(f.container);
    expect(await f.service.prune(f.worktree, undefined, inspected!.identity))
      .toMatchObject({ removed: false, skippedReason: "Container identity changed since discovery." });
    expect(rmdir).not.toHaveBeenCalled();
  });
});
