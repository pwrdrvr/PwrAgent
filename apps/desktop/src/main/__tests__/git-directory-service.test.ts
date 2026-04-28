import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitDirectoryService } from "../app-server/git-directory-service";

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function createFixtureRepo(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-git-directory-service-"));
  execFileSync("git", ["init", rootDir], { stdio: "ignore" });
  execFileSync("git", ["-C", rootDir, "checkout", "-B", "main"], { stdio: "ignore" });
  execFileSync("git", ["-C", rootDir, "config", "user.name", "PwrAgnt Tests"], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", rootDir, "config", "user.email", "pwragnt-tests@example.invalid"], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", rootDir, "commit", "--allow-empty", "-m", "Seed fixture repo"], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", rootDir, "branch", "release"], { stdio: "ignore" });
  return rootDir;
}

describe("GitDirectoryService", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
  });

  it("returns the original directory for local launchpads", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const service = new GitDirectoryService();

    await expect(
      service.prepareLaunchpadWorkspace({
        directoryLabel: "FixtureRepo",
        directoryPath: repoDir,
        workMode: "local",
      }),
    ).resolves.toEqual({
      cwd: repoDir,
      workMode: "local",
    });
  });

  it("creates a detached worktree from the selected base branch without creating a new branch", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const service = new GitDirectoryService();
    const branchesBefore = runGit(repoDir, ["branch", "--format=%(refname:short)"])
      .split("\n")
      .filter(Boolean);
    const releaseRevision = runGit(repoDir, ["rev-parse", "release"]);

    const workspace = await service.prepareLaunchpadWorkspace({
      directoryLabel: "FixtureRepo",
      directoryPath: repoDir,
      workMode: "worktree",
      branchName: "release",
    });

    expect(workspace.workMode).toBe("worktree");
    expect(workspace.cwd).toContain(`${path.sep}.worktrees${path.sep}launchpad-fixturerepo-release-`);
    expect(runGit(workspace.cwd!, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
    expect(runGit(workspace.cwd!, ["branch", "--show-current"])).toBe("");
    expect(runGit(workspace.cwd!, ["rev-parse", "HEAD"])).toBe(releaseRevision);

    const branchesAfter = runGit(repoDir, ["branch", "--format=%(refname:short)"])
      .split("\n")
      .filter(Boolean);
    expect(branchesAfter).toEqual(branchesBefore);
  });
});
