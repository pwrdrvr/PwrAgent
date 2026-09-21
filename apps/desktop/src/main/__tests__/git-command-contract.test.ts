import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGitCommand, streamGitCommand } from "../app-server/git-executable";
import { GitWorkingStateService } from "../app-server/git-working-state-service";
import { WorktreeArchiveService } from "../app-server/worktree-archive-service";

// Exercise the production runner against disposable repositories. In particular,
// a mocked execFile cannot expose output trimming or alternate-index leakage.
describe("Git command contract", () => {
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  const run = (args: string[], overrides?: NodeJS.ProcessEnv) =>
    runGitCommand(repo, args, { env: { ...env, ...overrides } });

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "pwragent-git-contract-"));
    repo = path.join(root, "repository with spaces & punctuation");
    await mkdir(repo);
    env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    };
    // Do not inherit a caller's repository or alternate index.
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
      delete env[key];
    }
    await writeFile(env.GIT_CONFIG_GLOBAL!, "");
    await run(["init", "-b", "main"]);
    await run(["config", "core.autocrlf", "false"]);
    await writeFile(path.join(repo, "tracked.txt"), "base\n");
    await run(["add", "--", "tracked.txt"]);
    await run(["commit", "-m", "base"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("passes shell metacharacters and Unicode as literal arguments", async () => {
    const value = "café & echo unexpected; $(echo substituted) `echo substituted`";
    await run(["config", "fixture.literal", value]);
    expect((await run(["config", "--get", "fixture.literal"])).stdout.trim()).toBe(value);
  });

  it("preserves nonzero exit status and Git diagnostics", async () => {
    await expect(run(["rev-parse", "--verify", "refs/heads/missing"])).rejects.toMatchObject({
      code: 128,
      stderr: expect.stringContaining("fatal:"),
    });
    // Expected probe misses must remain distinguishable from a spawn failure.
    await expect(run(["config", "--get", "fixture.missing"])).rejects.toMatchObject({
      code: 1,
    });
  });

  it("closes stdin after revision input and enforces the output budget", async () => {
    const head = (await run(["rev-parse", "HEAD"])).stdout.trim();
    expect((await runGitCommand(repo, ["rev-list", "--count", "HEAD", "--stdin"], {
      env, input: `^${head}\n`,
    })).stdout.trim()).toBe("0");
    await writeFile(path.join(repo, "large.txt"), "x".repeat(16_384));
    await run(["add", "--", "large.txt"]);
    await expect(runGitCommand(repo, ["show", ":large.txt"], {
      env, maxBuffer: 1_024,
    })).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  });

  it.skipIf(process.platform === "win32")("reaps a stream helper that ignores SIGTERM when the consumer stops", async () => {
    const script = path.join(root, "stubborn.cjs");
    await writeFile(script, 'process.on("SIGTERM", () => {}); process.stdout.write(`${process.pid}\\n`); setInterval(() => {}, 1000);');
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    let pid = 0;
    try {
      const result = await streamGitCommand(repo, [
        "-c", `alias.fixture=!${quote(process.execPath)} ${quote(script)}`, "fixture",
      ], {
        env,
        timeout: 2_000,
        onStdout: (chunk) => { pid = Number(chunk.trim()); return false; },
      });
      expect(result.stopped).toBe(true);
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ }
      }
    }
  });

  it("isolates snapshot staging from the real index and subsequent commands", async () => {
    const index = path.join(repo, ".git", "index");
    const originalIndex = await readFile(index);
    await writeFile(path.join(repo, "tracked.txt"), "snapshot content\n");
    const alternate = { GIT_INDEX_FILE: path.join(root, "snapshot-index") };
    await run(["read-tree", "HEAD"], alternate);
    await run(["add", "--", "tracked.txt"], alternate);
    const tree = (await run(["write-tree"], alternate)).stdout.trim();
    expect((await run(["show", `${tree}:tracked.txt`])).stdout.trim()).toBe("snapshot content");
    expect(await readFile(index)).toEqual(originalIndex);
    expect((await run(["diff", "--cached", "--name-only"])).stdout).toBe("");
    expect((await run(["diff", "--name-only"])).stdout.trim()).toBe("tracked.txt");
  });

  it("preserves the leading porcelain status column", async () => {
    await writeFile(path.join(repo, "tracked.txt"), "changed\n");
    expect((await run(["status", "--porcelain=v1", "-z"])).stdout).toBe(" M tracked.txt\0");
  });

  it("preserves leading and trailing blob whitespace", async () => {
    await writeFile(path.join(repo, "tracked.txt"), "  content with whitespace \n\n");
    await run(["add", "--", "tracked.txt"]);
    expect((await run(["show", ":tracked.txt"])).stdout).toBe("  content with whitespace \n\n");
  });

  it("streams past excluded untracked files before applying the result cap", async () => {
    await mkdir(path.join(repo, "untracked"));
    const names = Array.from({ length: 40 }, (_, index) => `file-${String(index).padStart(3, "0")}.txt`);
    await Promise.all(names.map((name) => writeFile(path.join(repo, "untracked", name), "new\n")));
    const service = new GitWorkingStateService({ gitEnv: env });
    const result = await service.listOtherChanges(repo, {
      excludePaths: names.slice(0, 30).map((name) => path.join(repo, "untracked", name)),
      maxFiles: 3,
    });
    expect(result.truncated).toBe(true);
    expect(result.changes.map((entry) => entry.repoPath)).toEqual([
      "untracked/file-030.txt", "untracked/file-031.txt", "untracked/file-032.txt",
    ]);
    // A stopped stream must not poison the next repository read.
    expect((await run(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe("main");
  });

  it("keeps the worktree and real index when a required clean filter rejects a snapshot", async () => {
    const worktree = path.join(root, "dirty worktree");
    await run(["worktree", "add", "--detach", worktree, "HEAD"]);
    await run(["config", "filter.reject.clean", "exit 1"]);
    await run(["config", "filter.reject.required", "true"]);
    await writeFile(path.join(worktree, ".gitattributes"), "*.txt filter=reject\n");
    await writeFile(path.join(worktree, "tracked.txt"), "irreplaceable changes\n");
    const indexPath = (await runGitCommand(worktree, ["rev-parse", "--git-path", "index"], { env })).stdout.trim();
    const indexBefore = await readFile(indexPath);
    await expect(new WorktreeArchiveService({ gitEnv: env }).archive({
      backend: "codex",
      threadId: "fixture",
      repositoryPath: repo,
      worktreePath: worktree,
    })).rejects.toThrow();
    expect(await readFile(path.join(worktree, "tracked.txt"), "utf8")).toBe("irreplaceable changes\n");
    expect(await readFile(indexPath)).toEqual(indexBefore);
    expect((await run(["worktree", "list", "--porcelain"])).stdout).toContain("dirty worktree");
    expect((await run(["for-each-ref", "--format=%(refname)", "refs/codex/snapshots/"])).stdout).toBe("");
  });
});
