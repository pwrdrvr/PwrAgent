import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeArchiveService } from "../app-server/worktree-archive-service";
import { WorktreeRecoveryService } from "../app-server/worktree-recovery-service";
import { PWRAGENT_WORKTREE_LOCK_REASON } from "../app-server/worktree-volume-lock";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-c", "maintenance.autoDetach=false", "-c", "gc.autoDetach=false",
    "-c", "user.email=test@example.com", "-c", "user.name=Test User",
    "-C", cwd, ...args,
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 * 10 });
  return stdout.trim();
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function records(repoPath: string): Promise<string[]> {
  return (await git(repoPath, ["worktree", "list", "--porcelain"]))
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)));
}

describe("WorktreeRecoveryService", () => {
  let root: string;
  let repoPath: string;
  let worktreePath: string;
  const service = new WorktreeRecoveryService();

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-recovery-")));
    repoPath = path.join(root, "atlas");
    worktreePath = path.join(root, "worktrees", "mf3k2q", "atlas");
    await mkdir(repoPath);
    await git(repoPath, ["init", "-b", "main"]);
    // Windows runners default to autocrlf, which would rewrite the fixture text on checkout.
    await git(repoPath, ["config", "core.autocrlf", "false"]);
    await writeFile(path.join(repoPath, "deliver.ts"), "export const delay = 1;\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "initial"]);
    await git(repoPath, ["branch", "fix/retry-backoff"]);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await git(repoPath, ["worktree", "add", worktreePath, "fix/retry-backoff"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function deleteOutsideGit(): Promise<void> {
    await rm(worktreePath, { recursive: true, force: true });
  }

  it("recreates a folder deleted outside Git on its branch, clearing only its stale record", async () => {
    const otherPath = path.join(root, "worktrees", "other", "atlas");
    await git(repoPath, ["worktree", "add", "--detach", otherPath]);
    await rm(otherPath, { recursive: true, force: true });
    await deleteOutsideGit();

    const result = await service.recreate({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
      branch: "fix/retry-backoff",
    });

    expect(result.status).toBe("recreated");
    if (result.status !== "recreated") return;
    expect(result.branch).toBe("fix/retry-backoff");
    expect(result.checkpoint).toBeUndefined();
    expect(result.steps.find((step) => step.id === "clear-record")?.status).toBe("done");
    expect(await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("fix/retry-backoff");
    // Another thread's stale record is not ours to clear.
    expect(await records(repoPath)).toContain(otherPath);
  });

  it("puts an archived checkpoint back as uncommitted changes on the branch", async () => {
    await writeFile(path.join(worktreePath, "deliver.ts"), "export const delay = 300;\n");
    await writeFile(path.join(worktreePath, "jitter.ts"), "export const jitter = true;\n");
    const tip = await git(worktreePath, ["rev-parse", "HEAD"]);
    const snapshot = await new WorktreeArchiveService().archive({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
    });
    expect(await exists(worktreePath)).toBe(false);

    const result = await service.recreate({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
      branch: "fix/retry-backoff",
      checkpoint: { snapshotRef: snapshot.snapshotRef, snapshotCommit: snapshot.snapshotCommit },
    });

    expect(result.status).toBe("recreated");
    if (result.status !== "recreated") return;
    expect(result.checkpoint).toEqual({
      snapshotCommit: snapshot.snapshotCommit, restored: true, changedFileCount: 2,
    });
    expect(await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("fix/retry-backoff");
    expect(await git(worktreePath, ["rev-parse", "HEAD"])).toBe(tip);
    expect(await readFile(path.join(worktreePath, "deliver.ts"), "utf8")).toBe("export const delay = 300;\n");
    expect(await readFile(path.join(worktreePath, "jitter.ts"), "utf8")).toBe("export const jitter = true;\n");
    // Uncommitted and unstaged, the way they were before the archive.
    const { stdout: status } = await execFileAsync("git", ["-C", worktreePath, "status", "--porcelain"], { encoding: "utf8" });
    expect(status.split("\n").filter(Boolean).sort()).toEqual([
      " M deliver.ts",
      "?? jitter.ts",
    ]);
  });

  it("finds a checkpoint by its ref when no record was kept", async () => {
    await writeFile(path.join(worktreePath, "deliver.ts"), "export const delay = 300;\n");
    await new WorktreeArchiveService().archive({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
    });

    const result = await service.recreate({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
      branch: "fix/retry-backoff",
    });

    expect(result.status === "recreated" && result.checkpoint?.restored).toBe(true);
    expect(await readFile(path.join(worktreePath, "deliver.ts"), "utf8")).toBe("export const delay = 300;\n");
  });

  describe.each(["ref only", "record without source HEAD"] as const)("checkpoint from %s", (provenance) => {
    // Git's HEAD and status before hibernating are the recovery oracle.
    it.each(["clean", "dirty", "dirty detached", "lookalike"] as const)("recreates the saved HEAD and state of a %s checkout", async (state) => {
      const file = path.join(worktreePath, "deliver.ts");
      await writeFile(file, "export const delay = 2;\n");
      const message = state === "lookalike"
        ? `Snapshot worktree for codex:t1\nWorktree: ${worktreePath}\nSource HEAD: ${"0".repeat(40)}`
        : "Change the delay";
      await git(worktreePath, ["commit", "-am", message]);
      if (state === "dirty detached") await git(worktreePath, ["switch", "--detach"]);
      const dirty = state === "dirty" || state === "dirty detached";
      if (dirty) await writeFile(file, "export const delay = 300;\n");
      const head = await git(worktreePath, ["rev-parse", "HEAD"]);
      const status = await git(worktreePath, ["status", "--porcelain=v2"]);
      const contents = await readFile(file, "utf8");
      const request = { backend: "codex" as const, threadId: "t1", repositoryPath: repoPath, worktreePath };
      const { snapshotRef, snapshotCommit } = await new WorktreeArchiveService().hibernate({
        ...request, capSnapshotBytes: 1024, beforeRemove: async () => () => {},
      });
      await git(repoPath, ["branch", "-D", "fix/retry-backoff"]);

      const checkpoint = provenance === "ref only" ? undefined : { snapshotRef, snapshotCommit };
      await expect(service.recreate({ ...request, checkpoint, detached: true })).resolves.toMatchObject({
        status: "recreated", checkpoint: { snapshotCommit, restored: true, changedFileCount: dirty ? 1 : 0 },
      });
      expect(await git(worktreePath, ["rev-parse", "HEAD"])).toBe(head);
      expect(await git(worktreePath, ["status", "--porcelain=v2"])).toBe(status);
      expect(await readFile(file, "utf8")).toBe(contents);
      expect(await git(repoPath, ["rev-parse", snapshotRef])).toBe(snapshotCommit);
    });
  });

  it("refuses a path something now occupies and changes nothing", async () => {
    await deleteOutsideGit();
    await mkdir(worktreePath, { recursive: true });
    await writeFile(path.join(worktreePath, "notes.txt"), "mine");

    const result = await service.recreate({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
      branch: "fix/retry-backoff",
    });

    expect(result).toMatchObject({ status: "failed", reason: "path-occupied" });
    expect(await readFile(path.join(worktreePath, "notes.txt"), "utf8")).toBe("mine");
    expect(await records(repoPath)).toContain(worktreePath);
  });

  it("treats an empty folder at the path as free", async () => {
    await deleteOutsideGit();
    await mkdir(worktreePath, { recursive: true });

    const result = await service.recreate({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
      branch: "fix/retry-backoff",
    });

    expect(result.status).toBe("recreated");
  });

  it("stops at a locked record and leaves the lock alone", async () => {
    await git(repoPath, ["worktree", "lock", "--reason", "fixture", worktreePath]);
    await deleteOutsideGit();

    const result = await service.recreate({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
      branch: "fix/retry-backoff",
    });

    expect(result).toMatchObject({ status: "failed", reason: "record-locked" });
    expect(await git(repoPath, ["worktree", "list", "--porcelain"])).toContain("locked fixture");
  });

  it("keeps PwrAgent's drive lock and writes nothing while the drive is unplugged", async () => {
    await git(repoPath, ["worktree", "lock", "--reason", PWRAGENT_WORKTREE_LOCK_REASON, worktreePath]);
    // An unplugged drive takes the whole <hash> container with it.
    await rm(path.dirname(worktreePath), { recursive: true, force: true });

    const recreated = await service.recreate({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
      branch: "fix/retry-backoff",
    });
    await expect(service.releaseMissingWorktree({ repositoryPath: repoPath, worktreePath })).rejects.toThrow(/lock/);

    expect(recreated).toMatchObject({ status: "failed", reason: "record-locked" });
    expect(recreated.status === "failed" && recreated.message).toMatch(/drive .* is not connected/);
    expect(await exists(path.dirname(worktreePath))).toBe(false);
    expect(await git(repoPath, ["worktree", "list", "--porcelain"])).toContain(`locked ${PWRAGENT_WORKTREE_LOCK_REASON}`);
  });

  it("leaves PwrAgent's drive lock in place when it refuses for another reason", async () => {
    await git(repoPath, ["worktree", "lock", "--reason", PWRAGENT_WORKTREE_LOCK_REASON, worktreePath]);
    await deleteOutsideGit();

    const result = await service.recreate({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
      branch: "fix/retry-backoff", expectedHead: "0".repeat(40),
    });

    expect(result).toMatchObject({ status: "failed", reason: "branch-moved" });
    expect(await git(repoPath, ["worktree", "list", "--porcelain"])).toContain(`locked ${PWRAGENT_WORKTREE_LOCK_REASON}`);
  });

  it("clears PwrAgent's drive lock and recreates once the drive is back", async () => {
    await git(repoPath, ["worktree", "lock", "--reason", PWRAGENT_WORKTREE_LOCK_REASON, worktreePath]);
    await deleteOutsideGit();

    const result = await service.recreate({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
      branch: "fix/retry-backoff",
    });

    expect(result.status).toBe("recreated");
    expect(await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("fix/retry-backoff");
  });

  it("names where the branch is checked out, and can recreate detached at its tip", async () => {
    await deleteOutsideGit();
    await git(repoPath, ["worktree", "prune"]);
    const otherPath = path.join(root, "worktrees", "q7d0wn", "atlas");
    await git(repoPath, ["worktree", "add", otherPath, "fix/retry-backoff"]);

    const refused = await service.recreate({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
      branch: "fix/retry-backoff",
    });
    expect(refused).toMatchObject({
      status: "failed", reason: "branch-checked-out", branchCheckedOutAt: otherPath,
    });
    expect(await exists(worktreePath)).toBe(false);

    const detached = await service.recreate({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
      branch: "fix/retry-backoff", detached: true,
    });
    expect(detached.status).toBe("recreated");
    expect("branch" in detached).toBe(false);
    expect(await git(worktreePath, ["rev-parse", "HEAD"]))
      .toBe(await git(repoPath, ["rev-parse", "fix/retry-backoff"]));
    expect(await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
  });

  it("stops before writing when the recorded checkpoint was pruned, then goes ahead on consent", async () => {
    await writeFile(path.join(worktreePath, "deliver.ts"), "export const delay = 300;\n");
    const snapshot = await new WorktreeArchiveService().archive({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
    });
    await git(repoPath, ["update-ref", "-d", snapshot.snapshotRef]);
    const checkpoint = { snapshotRef: snapshot.snapshotRef, snapshotCommit: snapshot.snapshotCommit };

    const refused = await service.recreate({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
      branch: "fix/retry-backoff", checkpoint,
    });
    expect(refused).toMatchObject({ status: "failed", reason: "checkpoint-missing" });
    expect(await exists(worktreePath)).toBe(false);

    const recreated = await service.recreate({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
      branch: "fix/retry-backoff", checkpoint, skipCheckpoint: true,
    });
    expect(recreated.status).toBe("recreated");
    expect(recreated.status === "recreated" ? recreated.checkpoint : "x").toBeUndefined();
    expect(await readFile(path.join(worktreePath, "deliver.ts"), "utf8")).toBe("export const delay = 1;\n");
  });

  it("leaves the worktree clean and keeps the commit when the checkpoint conflicts", async () => {
    await writeFile(path.join(worktreePath, "deliver.ts"), "export const delay = 300;\n");
    const snapshot = await new WorktreeArchiveService().archive({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
    });
    // The branch moves on with a conflicting edit after the archive.
    const mover = path.join(root, "mover");
    await git(repoPath, ["worktree", "add", mover, "fix/retry-backoff"]);
    await writeFile(path.join(mover, "deliver.ts"), "export const delay = 60;\n");
    await git(mover, ["commit", "-am", "cap at a minute"]);
    await git(repoPath, ["worktree", "remove", mover]);

    const result = await service.recreate({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
      branch: "fix/retry-backoff",
      checkpoint: { snapshotRef: snapshot.snapshotRef, snapshotCommit: snapshot.snapshotCommit },
    });

    expect(result.status).toBe("recreated");
    if (result.status !== "recreated") return;
    expect(result.checkpoint).toMatchObject({ snapshotCommit: snapshot.snapshotCommit, restored: false });
    expect(result.warnings.join(" ")).toContain(snapshot.snapshotCommit.slice(0, 7));
    expect(await git(worktreePath, ["status", "--porcelain"])).toBe("");
    expect(await readFile(path.join(worktreePath, "deliver.ts"), "utf8")).toBe("export const delay = 60;\n");
    expect(await git(repoPath, ["rev-parse", snapshot.snapshotRef])).toBe(snapshot.snapshotCommit);
  });

  it("reports a deleted branch, and recreates detached at the main checkout without one", async () => {
    await deleteOutsideGit();
    await git(repoPath, ["worktree", "prune"]);
    await git(repoPath, ["branch", "-D", "fix/retry-backoff"]);

    const refused = await service.recreate({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
      branch: "fix/retry-backoff",
    });
    expect(refused).toMatchObject({ status: "failed", reason: "branch-missing" });

    const detached = await service.recreate({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
      branch: "fix/retry-backoff", detached: true,
    });
    expect(detached.status).toBe("recreated");
    expect("branch" in detached).toBe(false);
    expect(await git(worktreePath, ["rev-parse", "HEAD"])).toBe(await git(repoPath, ["rev-parse", "HEAD"]));
  });

  it("reports a missing main checkout", async () => {
    await deleteOutsideGit();
    await rm(repoPath, { recursive: true, force: true });

    expect(await service.recreate({
      backend: "codex", threadId: "t1", repositoryPath: repoPath, worktreePath,
      branch: "fix/retry-backoff",
    })).toMatchObject({ status: "failed", reason: "repository-missing" });
  });

  it("clears only the missing folder's own record", async () => {
    const otherPath = path.join(root, "worktrees", "other", "atlas");
    await git(repoPath, ["worktree", "add", "--detach", otherPath]);
    await rm(otherPath, { recursive: true, force: true });
    await deleteOutsideGit();

    expect(await service.releaseMissingWorktree({ repositoryPath: repoPath, worktreePath })).toBe(true);
    expect(await records(repoPath)).not.toContain(worktreePath);
    expect(await records(repoPath)).toContain(otherPath);
    // The branch is free to check out again.
    await git(repoPath, ["switch", "fix/retry-backoff"]);
    expect(await service.releaseMissingWorktree({ repositoryPath: repoPath, worktreePath })).toBe(false);
  });

  it("never clears the record of a folder that still exists", async () => {
    await expect(service.releaseMissingWorktree({ repositoryPath: repoPath, worktreePath }))
      .rejects.toThrow(/still exists/);
    expect(await records(repoPath)).toContain(worktreePath);
  });
});
