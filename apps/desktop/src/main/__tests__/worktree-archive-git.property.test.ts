import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import * as gitBoundary from "../app-server/git-executable";
import { WorktreeArchiveService } from "../app-server/worktree-archive-service";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-c", "maintenance.autoDetach=false", "-c", "gc.autoDetach=false",
    "-C", cwd, ...args,
  ]);
  return stdout.trim();
}

async function repository(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "-m", "initial");
  return repo;
}

// The Git boundary is measured, not replaced: every snapshot and removal runs
// against the owning Git repository. Archive-all must not read sibling entries
// for each checkout. This deliberately uses 200+ worktrees, so its process cost
// exceeds the ordinary single-checkout test timeout, especially on Windows.
it("bounds archive-all Git output independently of the remaining worktree fleet", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-archive-git-fleet-")));
  const count = 201;
  const measurements = { listings: 0, listingLines: 0, outputLines: 0, removals: 0 };
  let boundary: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const repo = await repository(root);
    const checkouts = Array.from({ length: count }, (_, i) => path.join(root, `checkout-${i}`));
    for (const checkout of checkouts) await git(repo, "worktree", "add", "--detach", checkout);
    const runGit = gitBoundary.runGitCommand;
    boundary = vi.spyOn(gitBoundary, "runGitCommand").mockImplementation(async (cwd, args, options) => {
      const result = await runGit(cwd, args, options);
      const lines = result.stdout.split("\n").length - 1;
      measurements.outputLines += lines;
      if (args[0] === "worktree" && args[1] === "list") {
        measurements.listings++;
        measurements.listingLines += lines;
      }
      if (args[0] === "worktree" && args[1] === "remove") measurements.removals++;
      return result;
    });
    const service = new WorktreeArchiveService();
    for (const [i, checkout] of checkouts.entries()) {
      const snapshot = await service.archive({ backend: "codex", threadId: `fleet-${i}`, repositoryPath: repo, worktreePath: checkout });
      expect(snapshot.sourceHead).toMatch(/^[0-9a-f]{40,64}$/);
    }
    boundary.mockRestore();
    expect((await git(repo, "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(1);
    expect((await git(repo, "for-each-ref", "--format=%(refname)", "refs/codex/snapshots/")).split("\n")).toHaveLength(count);
    console.info("archive-all Git boundary", { checkouts: count, ...measurements });
    expect(measurements.removals).toBe(count);
    expect(measurements.listings, JSON.stringify(measurements)).toBe(0);
    expect(measurements.listingLines).toBe(0);
    expect(measurements.outputLines).toBeLessThanOrEqual(8 * count);
  } finally {
    boundary?.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, process.platform === "win32" ? 300_000 : 120_000);
