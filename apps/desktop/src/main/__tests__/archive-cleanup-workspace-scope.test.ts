import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArchiveWorkspaceAdmission, archiveCleanupWorkspaceFilter } from "../app-server/archive-cleanup-workspace-scope";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, realpath: vi.fn(fs.realpath) };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.mocked(realpath).mockClear();
});

describe("archive admission workspace scope", () => {
  it("ignores unrelated activity but protects shared, unknown and newly assigned checkout users", async () => {
    const scope = new ArchiveWorkspaceAdmission("codex:target", "/fixture/target");
    scope.observeThread("codex:other", ["/fixture/other"]);
    scope.observeThread("claude:other", ["/fixture/other-claude"]);
    scope.changed("codex:other");
    scope.changed("claude:other");
    await scope.prepare([{ key: "codex:other", paths: [] }]);
    expect(() => scope.assertCurrent([{ key: "codex:other", paths: [] }])).not.toThrow();
    expect(() => scope.assertCurrent([{ key: "codex:other", paths: ["/fixture/target"] }])).toThrow("may use this worktree");
    scope.changed("codex:other", ["/fixture/target"]);
    await scope.prepare([]);
    expect(() => scope.assertCurrent([])).toThrow("workspace state changed");

    const unknown = new ArchiveWorkspaceAdmission("codex:target", "/fixture/target");
    unknown.changed("codex:unknown");
    await unknown.prepare([]);
    expect(() => unknown.assertCurrent([])).toThrow("workspace state changed");
  });

  it("classifies lifecycle destinations through symlinks and protects container descendants", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archive-admission-"));
    roots.push(root);
    const container = path.join(root, "container");
    await mkdir(container);
    const alias = path.join(root, "alias");
    await symlink(container, alias, process.platform === "win32" ? "junction" : "dir");
    const scope = new ArchiveWorkspaceAdmission("codex:target", container);
    scope.observeThread("codex:moving", [path.join(root, "other")]);
    const mutation = { key: "codex:moving", paths: [path.join(alias, "checkout")] };
    await scope.prepare([mutation]);
    expect(() => scope.assertCurrent([mutation])).toThrow("may use this worktree");
  });

  it("includes checkout roots, descendants, ancestors and aliases, but excludes unrelated and prefix-sibling workspaces", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archive-scope-"));
    roots.push(root);
    const checkout = path.join(root, "checkout");
    await mkdir(path.join(checkout, "src"), { recursive: true });
    const alias = path.join(root, "alias");
    await symlink(checkout, alias, process.platform === "win32" ? "junction" : "dir");
    const filter = archiveCleanupWorkspaceFilter(checkout);
    for (const cwd of [checkout, root, path.join(checkout, "src"), alias, path.join(alias, "missing")]) {
      expect(await filter(cwd), cwd).toBe(true);
    }
    expect(await filter(`${checkout}-other`)).toBe(false);
    expect(await filter(path.join(root, "unrelated", "missing"))).toBe(false);
    expect(await filter(undefined)).toBe(true);
    expect(await filter("relative")).toBe(true);
    const replaced = path.join(root, "replaced-checkout");
    await writeFile(replaced, "file, not a directory");
    expect(await filter(path.join(replaced, "missing-child"))).toBe(false);
  });

  it("resolves missing empty-container descendants through a symlinked root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archive-container-scope-"));
    roots.push(root);
    const canonical = path.join(root, "canonical");
    await mkdir(canonical);
    const alias = path.join(root, "alias");
    await symlink(canonical, alias, process.platform === "win32" ? "junction" : "dir");
    const filter = archiveCleanupWorkspaceFilter(path.join(canonical, "missing-id"));
    expect(await filter(path.join(alias, "missing-id", "missing-checkout"))).toBe(true);
    expect(await filter(path.join(alias, "another-id"))).toBe(false);
  });

  it("fails closed on ambiguous filesystem errors and forgets observations after each admission", async () => {
    const cwd = path.join(os.tmpdir(), "contrived-archive-scope-denied");
    vi.mocked(realpath).mockRejectedValueOnce(Object.assign(new Error("Denied"), { code: "EACCES" }));
    await expect(archiveCleanupWorkspaceFilter(cwd)(cwd)).rejects.toThrow("Denied");
    expect(await archiveCleanupWorkspaceFilter(cwd)(cwd)).toBe(true);
  });
});
