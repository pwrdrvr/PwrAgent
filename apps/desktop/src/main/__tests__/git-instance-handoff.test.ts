import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { assertGitHandoffUnchanged, exportGitHandoff, handoffRepositoryIdentity, importGitHandoff, prepareGitHandoff } from "../app-server/git-instance-handoff";
import * as gitExecutable from "../app-server/git-executable";

const execute = promisify(execFile);
const roots: string[] = [];
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout;
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-instance-handoff-"));
  roots.push(root);
  const source = path.join(root, "source");
  const receiver = path.join(root, "receiver");
  const remote = path.join(root, "origin.git");
  await mkdir(source);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.email", "test@example.invalid");
  await git(source, "config", "user.name", "Fixture");
  await git(source, "config", "core.autocrlf", "false");
  await writeFile(path.join(source, "code.txt"), "base\n");
  await writeFile(path.join(source, ".gitignore"), "ignored.txt\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "base");
  await git(root, "clone", "--bare", source, remote);
  await git(source, "remote", "add", "origin", remote);
  await git(root, "clone", remote, receiver);
  await git(receiver, "config", "core.autocrlf", "false");
  await git(source, "switch", "-c", "feature/handoff");
  await writeFile(path.join(source, "commit.txt"), "published feature\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "feature");
  await git(source, "push", "-u", "origin", "feature/handoff");
  return { root, source, receiver, remote };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("preflights a published ref and checks out the free source branch without transferring workspace bytes", async () => {
  const { source, receiver, root } = await fixture();
  await writeFile(path.join(source, "ignored.txt"), "never transferred\n");
  await writeFile(path.join(receiver, "code.txt"), "receiver changes\n");
  const sourceStatus = await git(source, "status", "--porcelain=v1", "-z");
  const sourceIndex = await git(source, "ls-files", "--stage", "-z");
  const sourceHead = (await git(source, "rev-parse", "HEAD")).trim();
  const receiverHead = await git(receiver, "rev-parse", "HEAD");
  const snapshot = await exportGitHandoff(source);
  expect(snapshot).toEqual({ head: sourceHead, ref: "refs/heads/feature/handoff", origin: expect.any(String), sourceBranch: "feature/handoff" });
  expect(await prepareGitHandoff(receiver, snapshot)).toEqual({ head: sourceHead });
  const worktree = path.join(root, "handoff");
  const rollback = await importGitHandoff({ repository: receiver, worktree, snapshot });
  expect((await git(worktree, "rev-parse", "HEAD")).trim()).toBe(sourceHead);
  expect((await git(worktree, "branch", "--show-current")).trim()).toBe("feature/handoff");
  expect((await git(worktree, "config", "--get", "branch.feature/handoff.remote")).trim()).toBe("origin");
  expect((await git(worktree, "config", "--get", "branch.feature/handoff.merge")).trim()).toBe(snapshot.ref);
  expect(await readFile(path.join(worktree, "commit.txt"), "utf8")).toBe("published feature\n");
  await expect(readFile(path.join(worktree, "ignored.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await git(source, "status", "--porcelain=v1", "-z")).toBe(sourceStatus);
  expect(await git(source, "ls-files", "--stage", "-z")).toBe(sourceIndex);
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(receiverHead);
  expect(await readFile(path.join(receiver, "code.txt"), "utf8")).toBe("receiver changes\n");
  expect(await git(source, "for-each-ref", "refs/pwragent/handoffs")).toBe("");
  expect(await git(receiver, "for-each-ref", "refs/pwragent/handoffs")).toBe("");
  await rollback();
  expect(await git(receiver, "worktree", "list")).not.toContain(worktree);
  expect(await git(receiver, "branch", "--list", "feature/handoff")).toBe("");
});

it("reuses a free local branch at the source commit and retains it on rollback", async () => {
  const { source, receiver, root } = await fixture();
  const snapshot = await exportGitHandoff(source);
  await git(receiver, "fetch", "origin");
  await git(receiver, "branch", "feature/handoff", snapshot.head);
  const worktree = path.join(root, "handoff");
  const rollback = await importGitHandoff({ repository: receiver, worktree, snapshot });
  expect((await git(worktree, "branch", "--show-current")).trim()).toBe("feature/handoff");
  expect((await git(worktree, "rev-parse", "HEAD")).trim()).toBe(snapshot.head);
  await rollback();
  expect((await git(receiver, "rev-parse", "feature/handoff")).trim()).toBe(snapshot.head);
});

it("uses detached HEAD when the source branch is already checked out on the receiver", async () => {
  const { source, receiver, root } = await fixture();
  const snapshot = await exportGitHandoff(source);
  await git(receiver, "fetch", "origin");
  await git(receiver, "branch", "feature/handoff", snapshot.head);
  const occupied = path.join(root, "occupied");
  await git(receiver, "worktree", "add", occupied, "feature/handoff");
  const worktree = path.join(root, "handoff");
  await importGitHandoff({ repository: receiver, worktree, snapshot });
  expect(await git(worktree, "branch", "--show-current")).toBe("");
  expect((await git(worktree, "rev-parse", "HEAD")).trim()).toBe(snapshot.head);
  expect((await git(occupied, "branch", "--show-current")).trim()).toBe("feature/handoff");
  expect((await git(receiver, "branch", "--show-current")).trim()).toBe("main");
});

it("removes a newly created branch and worktree when the imported cwd is unavailable", async () => {
  const { source, receiver, root } = await fixture();
  const snapshot = { ...await exportGitHandoff(source), cwdRelative: "missing-directory" };
  const worktree = path.join(root, "handoff");
  await expect(importGitHandoff({ repository: receiver, worktree, snapshot })).rejects.toMatchObject({ code: "ENOENT" });
  expect(await git(receiver, "worktree", "list")).not.toContain(worktree);
  expect(await git(receiver, "branch", "--list", "feature/handoff")).toBe("");
  expect(await git(receiver, "for-each-ref", "refs/pwragent/handoffs")).toBe("");
});

it.each(["feature", "feature/handoff/nested"])("detaches when receiver branch %s conflicts with the source branch namespace", async (conflictingBranch) => {
  const { source, receiver, root } = await fixture();
  const snapshot = await exportGitHandoff(source);
  const receiverHead = (await git(receiver, "rev-parse", "HEAD")).trim();
  await git(receiver, "branch", conflictingBranch, receiverHead);
  await git(receiver, "pack-refs", "--all");
  const worktree = path.join(root, "handoff");
  const rollback = await importGitHandoff({ repository: receiver, worktree, snapshot });
  expect(await git(worktree, "branch", "--show-current")).toBe("");
  expect((await git(worktree, "rev-parse", "HEAD")).trim()).toBe(snapshot.head);
  expect((await git(receiver, "rev-parse", conflictingBranch)).trim()).toBe(receiverHead);
  await rollback();
  expect((await git(receiver, "rev-parse", conflictingBranch)).trim()).toBe(receiverHead);
  expect(await git(receiver, "branch", "--list", "feature/handoff")).toBe("");
});

it("leaves no new branch after a required smudge filter rejects checkout and configures the branch on retry", async () => {
  const { source, receiver, root } = await fixture();
  await writeFile(path.join(source, ".gitattributes"), "code.txt filter=handoff-failure\n");
  await git(source, "add", ".gitattributes");
  await git(source, "commit", "-m", "checkout failure fixture");
  await git(source, "push");
  const snapshot = await exportGitHandoff(source);
  await git(receiver, "config", "filter.handoff-failure.smudge", "false");
  await git(receiver, "config", "filter.handoff-failure.required", "true");
  const worktree = path.join(root, "handoff");
  await expect(importGitHandoff({ repository: receiver, worktree, snapshot })).rejects.toThrow(/smudge filter .*failed/);
  expect(await git(receiver, "branch", "--list", "feature/handoff")).toBe("");
  expect(await git(receiver, "worktree", "list")).not.toContain(worktree);
  expect(await git(receiver, "for-each-ref", "refs/pwragent/handoffs")).toBe("");
  await git(receiver, "config", "--unset", "filter.handoff-failure.smudge");
  await git(receiver, "config", "filter.handoff-failure.required", "false");
  await importGitHandoff({ repository: receiver, worktree, snapshot });
  expect((await git(worktree, "branch", "--show-current")).trim()).toBe("feature/handoff");
  expect((await git(worktree, "config", "--get", "branch.feature/handoff.remote")).trim()).toBe("origin");
  expect((await git(worktree, "config", "--get", "branch.feature/handoff.merge")).trim()).toBe(snapshot.ref);
});

it("preserves a branch created concurrently before the import can claim its name", async () => {
  const { source, receiver, root } = await fixture();
  const snapshot = await exportGitHandoff(source);
  const worktree = path.join(root, "handoff");
  const runGit = gitExecutable.runGitCommand;
  let claimed = false;
  vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (cwd, args, options) => {
    if (!claimed && args.includes("switch") && args.includes("feature/handoff")) {
      claimed = true;
      await git(receiver, "branch", "feature/handoff", snapshot.head);
    }
    return await runGit(cwd, args, options);
  });
  const rollback = await importGitHandoff({ repository: receiver, worktree, snapshot });
  expect(claimed).toBe(true);
  expect(await git(worktree, "branch", "--show-current")).toBe("");
  await rollback();
  expect((await git(receiver, "rev-parse", "feature/handoff")).trim()).toBe(snapshot.head);
  await expect(git(receiver, "config", "--get", "branch.feature/handoff.remote")).rejects.toMatchObject({ code: 1 });
});

it("preserves a free receiver branch at a different commit and detaches at the source commit", async () => {
  const { source, receiver, root } = await fixture();
  const snapshot = await exportGitHandoff(source);
  const localHead = (await git(receiver, "rev-parse", "HEAD")).trim();
  await git(receiver, "branch", "feature/handoff", localHead);
  const worktree = path.join(root, "handoff");
  await importGitHandoff({ repository: receiver, worktree, snapshot });
  expect(await git(worktree, "branch", "--show-current")).toBe("");
  expect((await git(worktree, "rev-parse", "HEAD")).trim()).toBe(snapshot.head);
  expect((await git(receiver, "rev-parse", "feature/handoff")).trim()).toBe(localHead);
});

it("keeps a detached source detached even when its published branch is free", async () => {
  const { source, receiver, root } = await fixture();
  await git(source, "switch", "--detach");
  const snapshot = await exportGitHandoff(source);
  const worktree = path.join(root, "handoff");
  await importGitHandoff({ repository: receiver, worktree, snapshot });
  expect(await git(worktree, "branch", "--show-current")).toBe("");
  expect((await git(worktree, "rev-parse", "HEAD")).trim()).toBe(snapshot.head);
});

it.each(["unstaged", "staged", "untracked"])("blocks %s non-ignored changes before transfer", async (kind) => {
  const { source } = await fixture();
  await writeFile(path.join(source, kind === "untracked" ? "new.txt" : "code.txt"), "uncommitted\n");
  if (kind === "staged") await git(source, "add", "code.txt");
  await expect(exportGitHandoff(source)).rejects.toThrow("Commit or stash");
});

it("blocks unpushed commits even when the receiver has source objects", async () => {
  const { source } = await fixture();
  await git(source, "commit", "--allow-empty", "-m", "unpublished");
  await expect(exportGitHandoff(source)).rejects.toThrow("Push branch feature/handoff");
});

it("requires an existing receiver clone of the same remote", async () => {
  const { source, receiver, root } = await fixture();
  const snapshot = await exportGitHandoff(source);
  await expect(prepareGitHandoff(root, snapshot)).rejects.toThrow("Clone it there");
  await git(receiver, "remote", "set-url", "origin", path.join(root, "another.git"));
  await expect(prepareGitHandoff(receiver, snapshot)).rejects.toThrow("no remote matching the sender");
});

it("rejects a rewritten published branch even when the receiver already has the source objects", async () => {
  const { source, receiver, root } = await fixture();
  const snapshot = await exportGitHandoff(source);
  await prepareGitHandoff(receiver, snapshot);
  await git(source, "switch", "--detach", "HEAD~1");
  await git(source, "commit", "--allow-empty", "-m", "next commit");
  await git(source, "push", "--force", "origin", "HEAD:refs/heads/feature/handoff");
  const worktree = path.join(root, "handoff");
  await expect(importGitHandoff({ repository: receiver, worktree, snapshot })).rejects.toThrow("published branch no longer contains");
  expect(await git(receiver, "worktree", "list")).not.toContain(worktree);
  expect(await git(receiver, "for-each-ref", "refs/pwragent/handoffs")).toBe("");
});

it("keeps the exact source commit when the published branch advances", async () => {
  const { source, receiver, root } = await fixture();
  const head = (await git(source, "rev-parse", "HEAD")).trim();
  await git(source, "commit", "--allow-empty", "-m", "later published commit");
  await git(source, "push");
  await git(source, "reset", "--hard", head);
  const snapshot = await exportGitHandoff(source);
  expect(snapshot.head).toBe(head);
  const worktree = path.join(root, "handoff");
  await importGitHandoff({ repository: receiver, worktree, snapshot });
  expect((await git(worktree, "rev-parse", "HEAD")).trim()).toBe(head);
  expect((await git(source, "rev-parse", "HEAD")).trim()).toBe(head);
});

it("reports receiver fetch failures during preflight", async () => {
  const { source, receiver, remote } = await fixture();
  const snapshot = await exportGitHandoff(source);
  await git(remote, "update-ref", "-d", snapshot.ref);
  await expect(prepareGitHandoff(receiver, snapshot)).rejects.toThrow("receiving machine could not fetch");
  expect(await git(receiver, "for-each-ref", "refs/pwragent/handoffs")).toBe("");
});

it("uses a published branch for a detached source and checks for subsequent edits", async () => {
  const { source } = await fixture();
  await git(source, "switch", "--detach");
  const snapshot = await exportGitHandoff(source);
  expect(snapshot.ref).toBe("refs/heads/feature/handoff");
  expect(snapshot.sourceBranch).toBeUndefined();
  await writeFile(path.join(source, "code.txt"), "later edit\n");
  await expect(assertGitHandoffUnchanged(source, snapshot)).rejects.toThrow("Commit or stash");
});

it("hands off an imported detached commit again after its published branch advances", async () => {
  const { source, receiver, root } = await fixture();
  const snapshot = await exportGitHandoff(source);
  await git(receiver, "fetch", "origin");
  await git(receiver, "switch", "--track", "origin/feature/handoff");
  const imported = path.join(root, "first-handoff");
  await importGitHandoff({ repository: receiver, worktree: imported, snapshot });
  await git(source, "commit", "--allow-empty", "-m", "later published commit");
  await git(source, "push");
  // Try an unrelated advertised branch before the containing branch. Local
  // remote-tracking refs in the first import still have the old branch tip.
  await git(source, "push", "origin", "main:refs/heads/aaa-unrelated");
  const next = await exportGitHandoff(imported);
  expect(next).toEqual({ head: snapshot.head, ref: snapshot.ref, origin: snapshot.origin });
  const worktree = path.join(root, "second-handoff");
  await importGitHandoff({ repository: source, worktree, snapshot: next });
  expect((await git(worktree, "rev-parse", "HEAD")).trim()).toBe(snapshot.head);
  expect(await git(receiver, "for-each-ref", "refs/pwragent/handoffs")).toBe("");
});

it("rejects an unpublished detached commit even if its objects exist locally", async () => {
  const { source } = await fixture();
  await git(source, "switch", "--detach");
  await git(source, "commit", "--allow-empty", "-m", "unpublished detached commit");
  await expect(exportGitHandoff(source)).rejects.toThrow("Publish the detached source commit");
  expect(await git(source, "for-each-ref", "refs/pwragent/handoffs")).toBe("");
});

it.each(["initialized", "uninitialized"])("rejects %s submodules at export, preflight, and import before creating an incomplete worktree", async (state) => {
  const { source, receiver, root } = await fixture();
  const dependency = path.join(root, "dependency");
  await git(root, "clone", source, dependency);
  await git(source, "-c", "protocol.file.allow=always", "submodule", "add", dependency, "vendor/dependency");
  await git(source, "commit", "-m", "submodule fixture");
  await git(source, "push");
  if (state === "uninitialized") await git(source, "submodule", "deinit", "--all", "--force");
  expect(await git(source, "status", "--porcelain=v1")).toBe("");
  await expect(exportGitHandoff(source)).rejects.toThrow("submodules");
  // Also defend against a package from a sender that lacks this check.
  const snapshot = { head: (await git(source, "rev-parse", "HEAD")).trim(),
    ref: "refs/heads/feature/handoff", origin: handoffRepositoryIdentity((await git(source, "remote", "get-url", "origin")).trim())! };
  await expect(prepareGitHandoff(receiver, snapshot)).rejects.toThrow("submodules");
  const worktree = path.join(root, "handoff");
  await expect(importGitHandoff({ repository: receiver, worktree, snapshot })).rejects.toThrow("submodules");
  expect(await git(receiver, "worktree", "list")).not.toContain(worktree);
  expect(await git(receiver, "for-each-ref", "refs/pwragent/handoffs")).toBe("");
});

it.skipIf(process.platform === "win32")("lets Git restore tracked symlinks, including CLAUDE.md and dangling links", async () => {
  const { source, receiver, root } = await fixture();
  await writeFile(path.join(source, "AGENTS.md"), "fixture guidance\n");
  await symlink("AGENTS.md", path.join(source, "CLAUDE.md"));
  await symlink("missing-target", path.join(source, "dangling-link"));
  await git(source, "add", ".");
  await git(source, "commit", "-m", "link fixture");
  await git(source, "push");
  const snapshot = await exportGitHandoff(source);
  const worktree = path.join(root, "handoff");
  await importGitHandoff({ repository: receiver, worktree, snapshot });
  expect((await lstat(path.join(worktree, "CLAUDE.md"))).isSymbolicLink()).toBe(true);
  expect(await readlink(path.join(worktree, "CLAUDE.md"))).toBe("AGENTS.md");
  expect(await readlink(path.join(worktree, "dangling-link"))).toBe("missing-target");
});

it("normalizes SSH and HTTPS identities without credentials", () => {
  const identity = "github.com/example/repo";
  expect(handoffRepositoryIdentity("git@github.com:Example/Repo.git")).toBe(identity);
  expect(handoffRepositoryIdentity("ssh://git@github.com/Example/Repo.git")).toBe(identity);
  expect(handoffRepositoryIdentity("https://user:secret@github.com/Example/Repo.git")).toBe(identity);
});
