import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { CodexAppServerClient } from "../codex-app-server/client";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { ArchiveWorktreeTransport, type ArchiveWorktreeThread } from "./fixtures/archive-worktree-transport";

vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("../codex-app-server/stdio-transport", async () => ({
  StdioJsonRpcTransport: (await import("./fixtures/archive-worktree-transport")).ArchiveWorktreeTransport,
}));

const execute = promisify(execFile);
const registries: DesktopBackendRegistry[] = [];
const databases: StateDb[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  ArchiveWorktreeTransport.threads = [];
  ArchiveWorktreeTransport.requests = [];
  ArchiveWorktreeTransport.onList = undefined;
  ArchiveWorktreeTransport.rejectSafetySources = false;
});

async function createFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-archive-restart-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  await mkdir(repo);
  const git = async (cwd: string, args: string[]) => (await execute("git", ["-C", cwd, ...args])).stdout;
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "core.autocrlf", "false"]);
  await git(repo, ["config", "core.eol", "lf"]);
  await writeFile(path.join(repo, "file.txt"), "original\n");
  await git(repo, ["add", "file.txt"]);
  await git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
  await git(repo, ["worktree", "add", "-b", "owned", worktree]);
  const directory = { id: "owned", kind: "worktree" as const, label: "repo", path: repo, worktreePath: worktree };
  const reopen = (workspace = directory) => {
    const db = StateDb.open(path.join(root, "state.db"));
    databases.push(db);
    const store = new SqliteOverlayStore(db);
    const client = new CodexAppServerClient({ directoryResolver: async (cwd) => cwd === workspace.worktreePath ? [workspace] : [] });
    const registry = new DesktopBackendRegistry({ codexClient: client, overlayStore: store, messagingStore: null, threadTitleGenerationService: null });
    registries.push(registry);
    return { db, store, client, registry };
  };
  return { repo, worktree, directory, git, reopen };
}

describe("archive worktrees across a desktop restart", () => {
  it.each(["cli", "vscode", "appServer", "exec", "unknown"])("archives and restores an old %s thread after closing and reopening the registry and SQLite store", async (source) => {
    const fixture = await createFixture();
    const first = fixture.reopen();
    const started = await first.registry.startThread({
      backend: "codex", cwd: fixture.worktree, linkedDirectories: [fixture.directory], mcpConnectionIds: [],
    });
    await writeFile(path.join(fixture.worktree, "file.txt"), "uncommitted work from days ago\n");
    await first.registry.close();
    first.db.close();
    databases.splice(databases.indexOf(first.db), 1);
    ArchiveWorktreeTransport.threads[0]!.source = source;
    // Recreating the process-owned registry removes every pending-start row.
    const second = fixture.reopen();

    const result = await second.registry.archiveThread({ backend: "codex", threadId: started.threadId });

    expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: true, worktreePath: fixture.worktree })]);
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fixture.git(fixture.repo, ["worktree", "list", "--porcelain"])).not.toContain(fixture.worktree);
    const snapshots = (await second.store.getThreadOverlayState({ backend: "codex", threadId: started.threadId }))?.worktreeSnapshots ?? [];
    expect(snapshots).toHaveLength(1);
    expect(await fixture.git(fixture.repo, ["show", `${snapshots[0]!.snapshotRef}:file.txt`])).toBe("uncommitted work from days ago\n");
    expect(await readFile(path.join(fixture.repo, "file.txt"), "utf8")).toBe("original\n");
    await second.registry.restoreThread({ backend: "codex", threadId: started.threadId });
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("uncommitted work from days ago\n");
  });

  it.each([
    { source: "subAgentThreadSpawn", originator: "codex", name: "worker" },
    { source: "subAgent", originator: "codex", name: "generic worker" },
    { source: "subAgentReview", originator: "codex", name: "review worker" },
    { source: "subAgentCompact", originator: "codex", name: "compact worker" },
    { source: "subAgentOther", originator: "codex", name: "other worker" },
    { source: "appServer", originator: "companion-app", name: "companion" },
    { source: "exec", originator: "codex", name: "exec checkout user" },
    { source: "unknown", originator: "codex", name: "unknown checkout user" },
    { source: "cli", originator: "codex", name: "PwrSnap Capture Metadata Worker" },
  ])("keeps a worktree used by a navigation-hidden $name thread after restart", async (user) => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [
      { id: "old-target", cwd: fixture.worktree, source: "cli", originator: "codex" },
      { id: "hidden-user", cwd: fixture.worktree, status: { type: "notLoaded" }, ...user },
    ];
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup[0]?.skippedReason).toContain("another active thread: hidden-user");
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
    expect((await instance.store.getThreadOverlayState({ backend: "codex", threadId: "old-target" }))?.worktreeSnapshots ?? []).toEqual([]);
  });

  it.each([
    { kind: "source", status: "notLoaded" },
    { kind: "source", status: "idle" },
    { kind: "threadSource", status: "notLoaded" },
    { kind: "threadSource", status: "idle" },
  ] as const)("archives and restores a worktree with a $status Guardian review identified by $kind", async ({ kind, status }) => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [
      { id: "old-target", cwd: fixture.worktree, source: "cli" },
      {
        id: "guardian-review", cwd: fixture.worktree, source: "subAgentOther", status: { type: status },
        // thread/list omits threadSource; thread/read can return guardian_review.
        wireSource: kind === "source" ? { subAgent: { other: "guardian" } } : undefined,
        threadSource: kind === "threadSource" ? "guardian_review" : null,
      },
    ];
    await writeFile(path.join(fixture.worktree, "file.txt"), "work preserved past the approval review\n");
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: true, worktreePath: fixture.worktree })]);
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(ArchiveWorktreeTransport.threads.find((thread) => thread.id === "guardian-review")?.archived).toBeUndefined();
    await instance.registry.restoreThread({ backend: "codex", threadId: "old-target" });
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("work preserved past the approval review\n");
  });

  it.each([
    { type: "active", activeFlags: [] },
    { type: "systemError" },
    undefined,
  ] satisfies ArchiveWorktreeThread["status"][])("keeps a worktree when a Guardian review has active or uncertain status %j", async (status) => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [
      { id: "old-target", cwd: fixture.worktree, source: "cli" },
      {
        id: "guardian-review", cwd: fixture.worktree, source: "subAgentOther",
        wireSource: { subAgent: { other: "guardian" } }, threadSource: null, status,
      },
    ];
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup[0]?.skippedReason).toContain("another active thread: guardian-review");
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
  });

  it("rechecks Guardian activity before removing the worktree", async () => {
    const fixture = await createFixture();
    const guardian: ArchiveWorktreeThread = {
      id: "guardian-review", cwd: fixture.worktree, source: "subAgentOther",
      wireSource: { subAgent: { other: "guardian" } }, threadSource: null, status: { type: "notLoaded" },
    };
    ArchiveWorktreeTransport.threads = [
      { id: "old-target", cwd: fixture.worktree, source: "cli" }, guardian,
    ];
    let activeReads = 0;
    ArchiveWorktreeTransport.onList = (params) => {
      if (!params.archived && ++activeReads === 2) guardian.status = { type: "active", activeFlags: [] };
    };
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(activeReads).toBe(2);
    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.error).toContain("Worktree is still used by another active thread");
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
  });

  it("continues past a page containing only inactive Guardian reviews to find a real checkout user", async () => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [
      { id: "old-target", cwd: fixture.worktree, source: "cli" },
      ...Array.from({ length: 25 }, (_, index): ArchiveWorktreeThread => ({
        id: `guardian-review-${index}`, cwd: fixture.worktree, source: "subAgentOther",
        wireSource: { subAgent: { other: "guardian" } }, threadSource: null, status: { type: "notLoaded" },
      })),
      { id: "real-user", cwd: fixture.worktree, source: "cli", status: { type: "notLoaded" } },
    ];
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup[0]?.skippedReason).toBe("Worktree is still used by another active thread: real-user.");
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
  });

  it("finds an old target on a later archived page and retains its recovery snapshot", async () => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [
      ...Array.from({ length: 30 }, (_, index) => ({ id: `older-archive-${index}`, cwd: fixture.repo, source: "cli", archived: true })),
      { id: "old-target", cwd: fixture.worktree, source: "cli" },
    ];
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup[0]?.removedWorktree).toBe(true);
    const pages = ArchiveWorktreeTransport.requests.filter((request) => request.method === "thread/list");
    expect(pages.filter((request) => request.params.archived && request.params.cursor)).toHaveLength(2);
    expect(pages.every((request) => request.params.limit === 25 && request.params.useStateDbOnly === true)).toBe(true);
  });

  it("accepts a delayed matching archive notification through the production provider subscriber", async () => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [{ id: "old-target", cwd: fixture.worktree, source: "cli" }];
    let activeReads = 0;
    ArchiveWorktreeTransport.onList = (params, transport) => {
      if (!params.archived && ++activeReads === 2) transport.emitNotification({ method: "thread/archived", params: { threadId: "old-target" } });
    };
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup[0]?.removedWorktree).toBe(true);
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { method: "thread/name/updated", params: { threadId: "unrelated", threadName: "Updated title" } },
    { method: "thread/status/changed", params: { threadId: "unrelated", status: { type: "notLoaded" } } },
  ] as const)("archives and restores real work despite an unrelated $method notification during removal admission", async (notification) => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [{ id: "old-target", cwd: fixture.worktree, source: "cli" }];
    await writeFile(path.join(fixture.worktree, "file.txt"), "work retained by the snapshot\n");
    let activeReads = 0;
    ArchiveWorktreeTransport.onList = (params, transport) => {
      if (!params.archived && ++activeReads === 2) transport.emitNotification(notification);
    };
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup).toEqual([expect.objectContaining({ removedWorktree: true, worktreePath: fixture.worktree })]);
    await expect(stat(fixture.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fixture.git(fixture.repo, ["worktree", "list", "--porcelain"])).not.toContain(fixture.worktree);
    await instance.registry.restoreThread({ backend: "codex", threadId: "old-target" });
    expect(await readFile(path.join(fixture.worktree, "file.txt"), "utf8")).toBe("work retained by the snapshot\n");
  });

  it("keeps a worktree with an external ownership marker on a navigation-hidden archived user", async () => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [
      { id: "old-target", cwd: fixture.worktree, source: "cli" },
      { id: "external-owner", cwd: fixture.worktree, source: "appServer", originator: "companion-app", archived: true },
    ];
    const instance = fixture.reopen();
    await instance.store.addLinkedDirectory({
      backend: "codex", threadId: "external-owner", directory: { ...fixture.directory, worktreeOwnership: "external" },
    });

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup[0]?.skippedReason).toContain("Externally managed worktree");
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
  });

  it("refuses to remove a primary checkout mislabeled as the archived thread's worktree", async () => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [{ id: "old-target", cwd: fixture.repo, source: "cli" }];
    const instance = fixture.reopen({ ...fixture.directory, worktreePath: fixture.repo });

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.error).toMatch(/primary|main/i);
    expect(await readFile(path.join(fixture.repo, "file.txt"), "utf8")).toBe("original\n");
  });

  it("does not fall back to a partial interactive inventory when the provider rejects safety source filters", async () => {
    const fixture = await createFixture();
    ArchiveWorktreeTransport.threads = [
      { id: "old-target", cwd: fixture.worktree, source: "cli" },
      { id: "hidden-user", cwd: fixture.worktree, source: "subAgentThreadSpawn" },
    ];
    ArchiveWorktreeTransport.rejectSafetySources = true;
    const instance = fixture.reopen();

    const result = await instance.registry.archiveThread({ backend: "codex", threadId: "old-target" });

    expect(result.cleanup[0]?.removedWorktree).toBe(false);
    expect(result.cleanup[0]?.skippedReason).toContain("Unsupported safety source filter");
    expect((await stat(fixture.worktree)).isDirectory()).toBe(true);
  });
});
