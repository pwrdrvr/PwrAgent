import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArchiveWorkspaceAdmission, ArchiveWorkspaceOwnership, archiveCleanupWorkspaceFilter } from "../app-server/archive-cleanup-workspace-scope";

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
  it("reserves removal against controlled writers while retaining provider invalidation", async () => {
    const scope = new ArchiveWorkspaceAdmission("codex:target", "/fixture/target");
    scope.observeThread("codex:other", ["/fixture/other"]);
    await scope.prepare([]);
    scope.reserve([]);
    const ownership = new ArchiveWorkspaceOwnership(() => [scope]);
    const finish = ownership.beginMutation("codex:other", true);
    await expect(ownership.assertAvailable(["/fixture/target"])).rejects.toThrow("removal is reserved");
    await expect(ownership.assertAvailable(["/fixture/other"])).resolves.toBeUndefined();
    await ownership.refresh(finish(), async () => ["/fixture/other"]);
    expect(() => scope.assertCurrent([])).not.toThrow();
    // A raw provider notification is outside the controlled writer contract.
    ownership.invalidate("codex:other");
    expect(() => scope.assertCurrent([])).toThrow("workspace state changed");
  });

  it("cannot reserve midway through an earlier writer's asynchronous boundary", async () => {
    const scopes: ArchiveWorkspaceAdmission[] = [];
    const ownership = new ArchiveWorkspaceOwnership(() => scopes);
    const finish = ownership.beginMutation("codex:other", true);
    const scope = new ArchiveWorkspaceAdmission("codex:target", "/fixture/target");
    scopes.push(scope);
    ownership.beginAdmission(scope);
    scope.observeThread("codex:other", ["/fixture/other"]);
    await scope.prepare([]);
    expect(() => scope.reserve([])).toThrow("workspace state changed");
    await ownership.refresh(finish(), async () => ["/fixture/other"]);
    expect(() => scope.reserve([])).not.toThrow();
  });

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

  it("can establish an initial proof when ordinary activity arrives before its inventory row", async () => {
    const scope = new ArchiveWorkspaceAdmission("codex:target", "/fixture/target");
    scope.changed("codex:other");
    await scope.prepare([]);
    expect(() => scope.assertCurrent([])).toThrow("workspace state changed");
    scope.observeThread("codex:other", ["/fixture/other"]);
    await scope.prepare([]);
    expect(() => scope.assertCurrent([])).not.toThrow();
  });

  it("keeps removal fenced until a new checkout user's overlay is known", async () => {
    const scope = new ArchiveWorkspaceAdmission("codex:target", "/fixture/target");
    const token = scope.invalidateOwnership("codex:new");
    await scope.prepare([]);
    expect(() => scope.assertCurrent([])).toThrow("workspace state changed");
    await scope.completeOwnership("codex:new", token, ["/fixture/other"]);
    expect(() => scope.assertCurrent([])).not.toThrow();
  });

  it("does not let an older observation validate a newer ownership change", async () => {
    const scope = new ArchiveWorkspaceAdmission("codex:target", "/fixture/target");
    scope.observeThread("codex:other", ["/fixture/other"]);
    await scope.prepare([]);
    const ownership = new ArchiveWorkspaceOwnership(() => [scope]);
    let release!: (paths: string[]) => void;
    const old = ownership.refresh(ownership.invalidate("codex:other"), () => new Promise((resolve) => { release = resolve; }));
    const current = ownership.invalidate("codex:other");
    release(["/fixture/other"]);
    await old;
    expect(() => scope.assertCurrent([])).toThrow("workspace state changed");
    await ownership.refresh(current, async () => ["/fixture/target"]);
    expect(() => scope.assertCurrent([])).toThrow("workspace state changed");
  });

  it("does not let an older canonicalization complete a newer generation", async () => {
    const scope = new ArchiveWorkspaceAdmission("codex:target", "/fixture/target");
    let release!: (value: string) => void;
    vi.mocked(realpath).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const old = scope.completeOwnership("codex:other", scope.invalidateOwnership("codex:other"), ["/fixture/other"]);
    const current = scope.invalidateOwnership("codex:other");
    release("/fixture/target");
    await old;
    expect(() => scope.assertCurrent([])).toThrow("workspace state changed");
    await scope.completeOwnership("codex:other", current, ["/fixture/unrelated"]);
    expect(() => scope.assertCurrent([])).not.toThrow();
  });

  it("inherits active writers and keeps identities fenced independently", async () => {
    const scopes: ArchiveWorkspaceAdmission[] = [];
    const ownership = new ArchiveWorkspaceOwnership(() => scopes);
    const finish = ownership.beginMutation("codex:first");
    const scope = new ArchiveWorkspaceAdmission("codex:target", "/fixture/target");
    scopes.push(scope);
    ownership.beginAdmission(scope);
    scope.observeThread("codex:first", ["/fixture/first"]);
    await scope.prepare([]);
    await ownership.refresh(ownership.invalidate("codex:first"), async () => ["/fixture/first"]);
    await ownership.refresh(ownership.invalidate("codex:second"), async () => ["/fixture/second"]);
    expect(() => scope.assertCurrent([])).toThrow("workspace state changed");
    await ownership.refresh(finish(), async () => ["/fixture/first"]);
    expect(() => scope.assertCurrent([])).not.toThrow();
  });

  it("renews canonical evidence when directory ownership changes through an alias", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "archive-ownership-alias-"));
    roots.push(root);
    const target = path.join(root, "target");
    const other = path.join(root, "other");
    const alias = path.join(root, "alias");
    await mkdir(target);
    await mkdir(other);
    await symlink(other, alias, process.platform === "win32" ? "junction" : "dir");
    const scope = new ArchiveWorkspaceAdmission("codex:target", target);
    scope.observeThread("codex:other", [alias]);
    scope.changed("codex:other");
    await scope.prepare([]);
    expect(() => scope.assertCurrent([])).not.toThrow();
    const token = scope.invalidateOwnership("codex:other");
    await rm(alias);
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    await scope.completeOwnership("codex:other", token, [alias]);
    expect(() => scope.assertCurrent([])).toThrow("workspace state changed");
  });

  it("keeps ambiguous aliases without interrupting lifecycle event delivery", async () => {
    const scope = new ArchiveWorkspaceAdmission("codex:target", "/fixture/target");
    scope.changed("codex:other", ["/fixture/denied"]);
    vi.mocked(realpath).mockRejectedValueOnce(Object.assign(new Error("Denied"), { code: "EACCES" }));
    await scope.prepare([]);
    expect(() => scope.assertCurrent([])).toThrow("workspace state changed");
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
