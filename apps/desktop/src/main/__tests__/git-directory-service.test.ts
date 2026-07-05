import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitDirectoryService,
  MAX_TRACKED_COMMITS,
  MAX_TRACKED_BRANCHES,
  capRecentBranchDetails,
  computeWorktreePath,
} from "../app-server/git-directory-service";

// The service forward-slashes the directory/worktree identifiers it returns
// (no-op on POSIX; on Windows `C:\…` becomes `C:/…`). Expected path strings
// derived from native temp dirs must be normalized the same way so the
// comparisons hold on both platforms.
function toForwardSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function createFixtureRepo(): Promise<string> {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "pwragent-git-directory-service-"),
  );
  execFileSync("git", ["init", rootDir], { stdio: "ignore" });
  execFileSync("git", ["-C", rootDir, "checkout", "-B", "main"], {
    stdio: "ignore",
  });
  execFileSync(
    "git",
    ["-C", rootDir, "config", "user.name", "PwrAgent Tests"],
    {
      stdio: "ignore",
    },
  );
  execFileSync(
    "git",
    ["-C", rootDir, "config", "user.email", "pwragent-tests@example.invalid"],
    {
      stdio: "ignore",
    },
  );
  execFileSync(
    "git",
    ["-C", rootDir, "commit", "--allow-empty", "-m", "Seed fixture repo"],
    {
      stdio: "ignore",
    },
  );
  execFileSync("git", ["-C", rootDir, "branch", "release"], {
    stdio: "ignore",
  });
  return rootDir;
}

describe("capRecentBranchDetails", () => {
  const makeDetails = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      name: `branch-${index}`,
      lastCommitAt: 2_000_000 - index,
    }));

  it("returns the input unchanged when at or below the limit", () => {
    const details = makeDetails(MAX_TRACKED_BRANCHES);
    expect(
      capRecentBranchDetails(details, {
        keep: [],
        limit: MAX_TRACKED_BRANCHES,
      }),
    ).toBe(details);
  });

  it("keeps only the most recent `limit` branches when over the cap", () => {
    const details = makeDetails(MAX_TRACKED_BRANCHES + 25);
    const capped = capRecentBranchDetails(details, {
      keep: [],
      limit: MAX_TRACKED_BRANCHES,
    });
    expect(capped).toHaveLength(MAX_TRACKED_BRANCHES);
    expect(capped[0]?.name).toBe("branch-0");
    expect(capped.at(-1)?.name).toBe(`branch-${MAX_TRACKED_BRANCHES - 1}`);
  });

  it("retains anchor branches that fall outside the recency cutoff", () => {
    const details = makeDetails(MAX_TRACKED_BRANCHES + 25);
    const staleAnchor = details.at(-1)!.name; // oldest, well outside the cutoff
    const capped = capRecentBranchDetails(details, {
      keep: [undefined, staleAnchor],
      limit: MAX_TRACKED_BRANCHES,
    });
    expect(capped).toHaveLength(MAX_TRACKED_BRANCHES + 1);
    expect(capped.map((detail) => detail.name)).toContain(staleAnchor);
  });
});

describe("GitDirectoryService", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map((target) =>
        rm(target, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        }),
      ),
    );
  });

  it("returns the original directory for local launchpads", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const service = new GitDirectoryService();

    await expect(
      service.prepareLaunchpadWorkspace({
        directoryKind: "directory",
        directoryLabel: "FixtureRepo",
        directoryPath: repoDir,
        workMode: "local",
      }),
    ).resolves.toEqual({
      cwd: toForwardSlashes(repoDir),
      workMode: "local",
    });
  });

  it("falls back to local mode when a worktree launchpad targets a non-git directory", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "pwragent-non-git-directory-"),
    );
    cleanupPaths.push(directory);
    const service = new GitDirectoryService();

    await expect(
      service.prepareLaunchpadWorkspace({
        directoryKind: "directory",
        directoryLabel: "Projects",
        directoryPath: directory,
        workMode: "worktree",
        branchName: "main",
      }),
    ).resolves.toEqual({
      cwd: toForwardSlashes(directory),
      workMode: "local",
    });
  });

  it("falls back to local mode when a worktree launchpad targets an unborn git HEAD", async () => {
    const repoDir = await mkdtemp(
      path.join(os.tmpdir(), "pwragent-unborn-git-directory-"),
    );
    cleanupPaths.push(repoDir);
    execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "ignore" });
    const service = new GitDirectoryService();

    await expect(
      service.prepareLaunchpadWorkspace({
        directoryKind: "directory",
        directoryLabel: "FixtureRepo",
        directoryPath: repoDir,
        workMode: "worktree",
      }),
    ).resolves.toEqual({
      cwd: toForwardSlashes(repoDir),
      workMode: "local",
    });
  });

  it("reports unborn git directories without surfacing raw HEAD errors", async () => {
    const repoDir = await mkdtemp(
      path.join(os.tmpdir(), "pwragent-unborn-status-"),
    );
    cleanupPaths.push(repoDir);
    execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "ignore" });
    const service = new GitDirectoryService();

    await expect(
      service.readDirectoryStatus({ path: repoDir }),
    ).resolves.toMatchObject({
      branches: [],
      handoffBranches: [],
      syncState: "untracked",
    });
  });

  it("creates a worktree from the default branch when the checked-out branch is unborn", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const mainRevision = runGit(repoDir, ["rev-parse", "main"]);
    runGit(repoDir, ["checkout", "--orphan", "scratch"]);
    const service = new GitDirectoryService({
      resolveWorktreeStorage: () => "in-repo",
    });
    const status = await service.readDirectoryStatus({ path: repoDir });
    expect(status).toMatchObject({
      branches: expect.arrayContaining(["main"]),
      defaultBranch: "main",
      syncState: "untracked",
    });
    expect(status).not.toHaveProperty("currentBranch");

    const workspace = await service.prepareLaunchpadWorkspace({
      directoryKind: "directory",
      directoryLabel: "FixtureRepo",
      directoryPath: repoDir,
      workMode: "worktree",
    });

    expect(workspace.workMode).toBe("worktree");
    await expect(realpath(workspace.repositoryPath!)).resolves.toBe(
      await realpath(repoDir),
    );
    expect(workspace.cwd).toBeDefined();
    expect(runGit(workspace.cwd!, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      "HEAD",
    );
    expect(runGit(workspace.cwd!, ["rev-parse", "HEAD"])).toBe(mainRevision);
  });

  it("falls back to local mode when an explicit worktree base branch is stale", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const service = new GitDirectoryService({
      resolveWorktreeStorage: () => "in-repo",
    });

    const workspace = await service.prepareLaunchpadWorkspace({
      directoryKind: "directory",
      directoryLabel: "FixtureRepo",
      directoryPath: repoDir,
      workMode: "worktree",
      branchName: "missing-base-branch",
    });

    expect(workspace).toEqual({
      cwd: toForwardSlashes(repoDir),
      workMode: "local",
    });
  });

  it("reports default and available handoff branches", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    runGit(repoDir, ["branch", "older"]);
    runGit(repoDir, ["checkout", "-B", "recent"]);
    execFileSync(
      "git",
      ["-C", repoDir, "commit", "--allow-empty", "-m", "Recent branch"],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2030-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z",
        },
        stdio: "ignore",
      },
    );
    runGit(repoDir, ["checkout", "main"]);
    const occupiedPath = path.join(repoDir, ".worktrees", "release");
    await mkdir(path.dirname(occupiedPath), { recursive: true });
    runGit(repoDir, ["worktree", "add", occupiedPath, "release"]);
    const service = new GitDirectoryService();

    const status = await service.readDirectoryStatus({ path: repoDir });

    expect(status).toMatchObject({
      currentBranch: "main",
      defaultBranch: "main",
    });
    expect(status?.branches).toEqual(
      expect.arrayContaining(["main", "release", "older"]),
    );
    expect(status?.handoffBranches).toEqual(["recent", "older"]);

    const detailByName = new Map(
      (status?.branchDetails ?? []).map((detail) => [detail.name, detail]),
    );
    // `release` is checked out by a separate worktree (current branch is main).
    expect(detailByName.get("release")?.inUse).toBe(true);
    // The current branch is reported via `currentBranch`, not `inUse`.
    expect(detailByName.get("main")?.inUse).toBeUndefined();
    expect(detailByName.get("older")?.inUse).toBeUndefined();
    // Every branch carries a numeric last-commit timestamp.
    for (const detail of status?.branchDetails ?? []) {
      expect(typeof detail.lastCommitAt).toBe("number");
    }
    // `branchDetails` mirrors the recency-ordered `branches` list; `recent`
    // (committed in 2030) sorts ahead of `older`.
    const detailNames = (status?.branchDetails ?? []).map(
      (detail) => detail.name,
    );
    expect(detailNames).toEqual(status?.branches);
    expect(detailNames.indexOf("recent")).toBeLessThan(
      detailNames.indexOf("older"),
    );
    expect(status?.recentCommits?.[0]).toMatchObject({
      subject: "Seed fixture repo",
    });
  });

  it("reports at most the newest recent commits for the current branch", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    for (let index = 0; index < MAX_TRACKED_COMMITS + 5; index += 1) {
      execFileSync(
        "git",
        ["-C", repoDir, "commit", "--allow-empty", "-m", `Commit ${index}`],
        { stdio: "ignore" },
      );
    }
    const service = new GitDirectoryService();

    const status = await service.readDirectoryStatus({ path: repoDir });

    expect(status?.recentCommits).toHaveLength(MAX_TRACKED_COMMITS);
    expect(status?.recentCommits?.[0]).toMatchObject({
      shortSha: expect.any(String),
      subject: `Commit ${MAX_TRACKED_COMMITS + 4}`,
    });
    expect(status?.recentCommits?.at(-1)?.subject).toBe("Commit 5");
  });

  it("reports remote-tracking refs as worktree base branch candidates", async () => {
    const remoteDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-remote-"));
    cleanupPaths.push(remoteDir);
    execFileSync("git", ["init", "--bare", remoteDir], { stdio: "ignore" });
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    runGit(repoDir, ["remote", "add", "origin", remoteDir]);
    runGit(repoDir, ["push", "-u", "origin", "main"]);
    runGit(repoDir, ["checkout", "release"]);
    runGit(repoDir, ["push", "-u", "origin", "release"]);
    runGit(repoDir, ["checkout", "main"]);
    runGit(repoDir, [
      "update-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    const service = new GitDirectoryService();

    const status = await service.readDirectoryStatus({ path: repoDir });

    expect(status?.branches).toEqual(
      expect.arrayContaining(["main", "release"]),
    );
    expect(status?.branches).not.toContain("origin/main");
    expect(status?.baseBranches).toEqual(
      expect.arrayContaining([
        "main",
        "release",
        "origin/main",
        "origin/release",
      ]),
    );
    expect(status?.baseBranches).not.toContain("origin");
    expect(status?.baseBranches).not.toContain("origin/HEAD");
    expect(status?.baseBranchDetails?.map((detail) => detail.name)).toEqual(
      status?.baseBranches,
    );
  });

  it("streams directory status lookups with bounded concurrency", async () => {
    const service = new GitDirectoryService({
      statusConcurrency: 2,
      statusMaxUnread: 2,
    });
    let active = 0;
    let maxActive = 0;
    vi.spyOn(service, "readDirectoryStatus").mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        currentBranch: "main",
        syncState: "in-sync",
      };
    });

    const results = [];
    for await (const entry of service.readDirectoryStatusEntries([
      {
        key: "directory:/repo/one",
        kind: "directory",
        label: "one",
        path: "/repo/one",
        threadKeys: [],
        needsAttentionCount: 0,
      },
      {
        key: "directory:/repo/two",
        kind: "directory",
        label: "two",
        path: "/repo/two",
        threadKeys: [],
        needsAttentionCount: 0,
      },
      {
        key: "directory:/repo/three",
        kind: "directory",
        label: "three",
        path: "/repo/three",
        threadKeys: [],
        needsAttentionCount: 0,
      },
    ])) {
      results.push(entry);
    }

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(results).toHaveLength(3);
    expect(results.map((entry) => entry.directoryKey).sort()).toEqual([
      "directory:/repo/one",
      "directory:/repo/three",
      "directory:/repo/two",
    ]);
  });

  it("creates a detached in-repo worktree at <hash>/<project-folder> from the selected base branch", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const service = new GitDirectoryService({
      resolveWorktreeStorage: () => "in-repo",
    });
    const branchesBefore = runGit(repoDir, [
      "branch",
      "--format=%(refname:short)",
    ])
      .split("\n")
      .filter(Boolean);
    const releaseRevision = runGit(repoDir, ["rev-parse", "release"]);

    const workspace = await service.prepareLaunchpadWorkspace({
      directoryKind: "directory",
      directoryLabel: "FixtureRepo",
      directoryPath: repoDir,
      workMode: "worktree",
      branchName: "release",
    });

    expect(workspace.workMode).toBe("worktree");
    const repoRealPath = await realpath(repoDir);
    const projectName = path.basename(repoRealPath);
    const expectedRoot = path.join(repoRealPath, ".worktrees");
    expect(workspace.cwd).not.toBeUndefined();
    expect(
      toForwardSlashes(workspace.cwd!).startsWith(
        `${toForwardSlashes(expectedRoot)}/`,
      ),
    ).toBe(true);
    expect(path.basename(workspace.cwd!)).toBe(projectName);
    const hashSegment = path.basename(path.dirname(workspace.cwd!));
    expect(hashSegment).toMatch(/^[0-9a-z]+(?:-\d+)?$/);
    expect(workspace.cwd).not.toContain("launchpad-");

    expect(runGit(workspace.cwd!, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      "HEAD",
    );
    expect(runGit(workspace.cwd!, ["branch", "--show-current"])).toBe("");
    expect(runGit(workspace.cwd!, ["rev-parse", "HEAD"])).toBe(releaseRevision);

    const branchesAfter = runGit(repoDir, [
      "branch",
      "--format=%(refname:short)",
    ])
      .split("\n")
      .filter(Boolean);
    expect(branchesAfter).toEqual(branchesBefore);
  });

  it("uses the default branch when a detached launchpad passes HEAD", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const mainRevision = runGit(repoDir, ["rev-parse", "main"]);
    runGit(repoDir, ["checkout", "release"]);
    execFileSync(
      "git",
      ["-C", repoDir, "commit", "--allow-empty", "-m", "Release branch"],
      { stdio: "ignore" },
    );
    const releaseRevision = runGit(repoDir, ["rev-parse", "release"]);
    runGit(repoDir, ["checkout", "-B", "feature-with-pr"]);
    execFileSync(
      "git",
      ["-C", repoDir, "commit", "--allow-empty", "-m", "Feature PR branch"],
      { stdio: "ignore" },
    );
    const featureRevision = runGit(repoDir, ["rev-parse", "HEAD"]);
    const sourceWorktree = path.join(
      await mkdtemp(
        path.join(os.tmpdir(), "pwragent-source-detached-worktree-"),
      ),
      "fixture",
    );
    cleanupPaths.push(path.dirname(sourceWorktree));
    runGit(repoDir, [
      "worktree",
      "add",
      "--detach",
      sourceWorktree,
      releaseRevision,
    ]);
    const service = new GitDirectoryService({
      resolveWorktreeStorage: () => "in-repo",
    });

    const workspace = await service.prepareLaunchpadWorkspace({
      directoryKind: "directory",
      directoryLabel: "FixtureRepo",
      directoryPath: sourceWorktree,
      workMode: "worktree",
      branchName: "HEAD",
    });

    expect(workspace.workMode).toBe("worktree");
    const repoRealPath = await realpath(repoDir);
    await expect(realpath(workspace.repositoryPath!)).resolves.toBe(
      repoRealPath,
    );
    expect(workspace.cwd).toBeDefined();
    expect(
      toForwardSlashes(workspace.cwd!).startsWith(
        `${toForwardSlashes(path.join(repoRealPath, ".worktrees"))}/`,
      ),
    ).toBe(true);
    expect(runGit(workspace.cwd!, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      "HEAD",
    );
    expect(runGit(workspace.cwd!, ["rev-parse", "HEAD"])).toBe(mainRevision);
    expect(runGit(workspace.cwd!, ["rev-parse", "HEAD"])).not.toBe(
      releaseRevision,
    );
    expect(runGit(workspace.cwd!, ["rev-parse", "HEAD"])).not.toBe(
      featureRevision,
    );
  });

  it("creates an attached branch worktree and reuses it for the same branch", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const service = new GitDirectoryService({
      resolveWorktreeStorage: () => "in-repo",
    });

    const workspace = await service.prepareLaunchpadWorkspace({
      directoryKind: "directory",
      directoryLabel: "FixtureRepo",
      directoryPath: repoDir,
      workMode: "worktree",
      branchName: "main",
      worktreeBranchMode: "attached",
    });

    expect(workspace.workMode).toBe("worktree");
    expect(await realpath(workspace.repositoryPath!)).toBe(
      await realpath(repoDir),
    );
    expect(runGit(repoDir, ["branch", "--show-current"])).toBe("");
    expect(runGit(workspace.cwd!, ["branch", "--show-current"])).toBe("main");

    const reused = await service.prepareLaunchpadWorkspace({
      directoryKind: "directory",
      directoryLabel: "FixtureRepo",
      directoryPath: repoDir,
      workMode: "worktree",
      branchName: "main",
      worktreeBranchMode: "attached",
    });

    expect(reused).toMatchObject({
      cwd: workspace.cwd,
      repositoryPath: workspace.repositoryPath,
      workMode: workspace.workMode,
    });
  });

  it("does not reuse an excluded source worktree when creating an attached branch worktree", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const sourceWorktree = path.join(
      await mkdtemp(path.join(os.tmpdir(), "pwragent-source-worktree-")),
      "fixture",
    );
    cleanupPaths.push(path.dirname(sourceWorktree));
    runGit(repoDir, ["worktree", "add", sourceWorktree, "release"]);
    const releaseRevision = runGit(repoDir, ["rev-parse", "release"]);
    const service = new GitDirectoryService({
      resolveWorktreeStorage: () => "in-repo",
    });

    const workspace = await service.prepareLaunchpadWorkspace({
      directoryKind: "directory",
      directoryLabel: "FixtureRepo",
      directoryPath: repoDir,
      excludedWorktreePaths: [sourceWorktree],
      workMode: "worktree",
      branchName: "release",
      worktreeBranchMode: "attached",
    });

    expect(workspace.workMode).toBe("worktree");
    const repoRealPath = await realpath(repoDir);
    expect(await realpath(workspace.repositoryPath!)).toBe(repoRealPath);
    expect(await realpath(workspace.cwd!)).not.toBe(
      await realpath(sourceWorktree),
    );
    expect(
      (await realpath(workspace.cwd!)).startsWith(
        `${path.join(repoRealPath, ".worktrees")}${path.sep}`,
      ),
    ).toBe(true);
    expect(runGit(sourceWorktree, ["branch", "--show-current"])).toBe("");
    expect(runGit(sourceWorktree, ["rev-parse", "HEAD"])).toBe(releaseRevision);
    expect(runGit(workspace.cwd!, ["branch", "--show-current"])).toBe(
      "release",
    );
  });

  it("rolls back an attached branch transfer to an excluded source worktree", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const sourceWorktree = path.join(
      await mkdtemp(
        path.join(os.tmpdir(), "pwragent-rollback-source-worktree-"),
      ),
      "fixture",
    );
    cleanupPaths.push(path.dirname(sourceWorktree));
    runGit(repoDir, ["worktree", "add", sourceWorktree, "release"]);
    const service = new GitDirectoryService({
      resolveWorktreeStorage: () => "in-repo",
    });

    const workspace = await service.prepareLaunchpadWorkspace({
      directoryKind: "directory",
      directoryLabel: "FixtureRepo",
      directoryPath: repoDir,
      excludedWorktreePaths: [sourceWorktree],
      workMode: "worktree",
      branchName: "release",
      worktreeBranchMode: "attached",
    });

    expect(workspace.rollback).toEqual(expect.any(Function));
    expect(runGit(sourceWorktree, ["branch", "--show-current"])).toBe("");
    expect(runGit(workspace.cwd!, ["branch", "--show-current"])).toBe(
      "release",
    );

    await workspace.rollback?.();

    expect(runGit(sourceWorktree, ["branch", "--show-current"])).toBe(
      "release",
    );
    await expect(stat(workspace.cwd!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores an excluded source branch when destination worktree creation fails", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const sourceWorktree = path.join(
      await mkdtemp(path.join(os.tmpdir(), "pwragent-failed-transfer-source-")),
      "fixture",
    );
    cleanupPaths.push(path.dirname(sourceWorktree));
    runGit(repoDir, ["worktree", "add", sourceWorktree, "release"]);
    const runGitWithFailedAdd = vi.fn(
      async (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => {
        if (args[0] === "worktree" && args[1] === "add") {
          throw new Error("simulated worktree add failure");
        }
        return execFileSync("git", ["-C", cwd, ...args], {
          encoding: "utf8",
          env: { ...process.env, ...env },
        }).trim();
      },
    );
    const service = new GitDirectoryService({
      resolveWorktreeStorage: () => "in-repo",
      runGit: runGitWithFailedAdd,
    });

    await expect(
      service.prepareLaunchpadWorkspace({
        directoryKind: "directory",
        directoryLabel: "FixtureRepo",
        directoryPath: repoDir,
        excludedWorktreePaths: [sourceWorktree],
        workMode: "worktree",
        branchName: "release",
        worktreeBranchMode: "attached",
      }),
    ).rejects.toThrow("simulated worktree add failure");

    expect(runGit(sourceWorktree, ["branch", "--show-current"])).toBe(
      "release",
    );
  });

  it("rolls back a detached destination worktree", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const service = new GitDirectoryService({
      resolveWorktreeStorage: () => "in-repo",
    });

    const workspace = await service.prepareLaunchpadWorkspace({
      directoryKind: "directory",
      directoryLabel: "FixtureRepo",
      directoryPath: repoDir,
      workMode: "worktree",
      branchName: "release",
    });

    expect(workspace.rollback).toEqual(expect.any(Function));
    expect(runGit(workspace.cwd!, ["branch", "--show-current"])).toBe("");

    await workspace.rollback?.();

    await expect(stat(workspace.cwd!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("blocks branch transfer when the excluded source worktree is dirty", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const sourceWorktree = path.join(
      await mkdtemp(path.join(os.tmpdir(), "pwragent-dirty-source-worktree-")),
      "fixture",
    );
    cleanupPaths.push(path.dirname(sourceWorktree));
    runGit(repoDir, ["worktree", "add", sourceWorktree, "release"]);
    await writeFile(path.join(sourceWorktree, "dirty.txt"), "dirty\n", "utf8");
    const service = new GitDirectoryService({
      resolveWorktreeStorage: () => "in-repo",
    });

    await expect(
      service.prepareLaunchpadWorkspace({
        directoryKind: "directory",
        directoryLabel: "FixtureRepo",
        directoryPath: repoDir,
        excludedWorktreePaths: [sourceWorktree],
        workMode: "worktree",
        branchName: "release",
        worktreeBranchMode: "attached",
      }),
    ).rejects.toThrow(
      // The product surfaces the worktree path from git's porcelain output, which
      // is forward-slashed on Windows. Normalize the expected path the same way
      // (no-op on POSIX) so the substring match holds on every platform.
      `Cannot move branch release to a destination worktree because ${(await realpath(sourceWorktree)).replace(/\\/g, "/")} has uncommitted changes.`,
    );
    expect(runGit(sourceWorktree, ["branch", "--show-current"])).toBe(
      "release",
    );
  });

  it("passes the prepared git environment to worktree creation commands", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-git-env-"));
    cleanupPaths.push(repoDir);
    const preparedEnv = {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    } as NodeJS.ProcessEnv;
    const calls: Array<{
      args: string[];
      cwd: string;
      env?: NodeJS.ProcessEnv;
    }> = [];
    const runGit = vi.fn(
      async (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => {
        calls.push({ args, cwd, env });
        if (args.join(" ") === "rev-parse --show-toplevel") {
          return repoDir;
        }
        if (args.join(" ") === "rev-parse --verify main^{commit}") {
          return "0123456789abcdef0123456789abcdef01234567";
        }
        if (args[0] === "worktree" && args[1] === "add") {
          return "";
        }
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      },
    );
    const service = new GitDirectoryService({
      gitEnv: preparedEnv,
      resolveWorktreeStorage: () => "in-repo",
      runGit,
    });

    const workspace = await service.prepareLaunchpadWorkspace({
      directoryKind: "directory",
      directoryLabel: "FixtureRepo",
      directoryPath: repoDir,
      workMode: "worktree",
      branchName: "main",
    });

    expect(workspace.workMode).toBe("worktree");
    // The product passes the native worktree path to git, then forward-slashes it
    // for the returned `workspace.cwd`. Normalize the recorded git path arg the
    // same way (no-op on POSIX) so the comparison holds on Windows too.
    const normalizedCalls = calls.map((call) => ({
      ...call,
      args: call.args.map((arg) => arg.replace(/\\/g, "/")),
    }));
    expect(normalizedCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          args: ["worktree", "add", "--detach", workspace.cwd, "main"],
          cwd: repoDir,
          env: preparedEnv,
        }),
      ]),
    );
    expect(calls.every((call) => call.env === preparedEnv)).toBe(true);
  });

  it("creates a worktree under a user-home root when storage is user-home", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const homeDir = await mkdtemp(
      path.join(os.tmpdir(), "pwragent-worktree-home-"),
    );
    cleanupPaths.push(homeDir);
    const service = new GitDirectoryService({
      resolveWorktreeStorage: () => "user-home",
      homeDir,
    });

    const workspace = await service.prepareLaunchpadWorkspace({
      directoryKind: "directory",
      directoryLabel: "FixtureRepo",
      directoryPath: repoDir,
      workMode: "worktree",
      branchName: "main",
    });

    const expectedRoot = path.join(homeDir, ".pwragent", "worktrees");
    expect(
      toForwardSlashes(workspace.cwd!).startsWith(
        `${toForwardSlashes(expectedRoot)}/`,
      ),
    ).toBe(true);
    expect(path.basename(workspace.cwd!)).toBe(path.basename(repoDir));
  });

  it("creates Codex user-home worktrees under the Codex worktree root", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const homeDir = await mkdtemp(
      path.join(os.tmpdir(), "pwragent-codex-home-"),
    );
    cleanupPaths.push(homeDir);
    const service = new GitDirectoryService({
      resolveWorktreeStorage: () => "user-home",
      homeDir,
    });

    const workspace = await service.prepareLaunchpadWorkspace({
      backend: "codex",
      directoryKind: "directory",
      directoryLabel: "FixtureRepo",
      directoryPath: repoDir,
      workMode: "worktree",
      branchName: "main",
    });

    const expectedRoot = path.join(homeDir, ".codex", "worktrees");
    expect(
      toForwardSlashes(workspace.cwd!).startsWith(
        `${toForwardSlashes(expectedRoot)}/`,
      ),
    ).toBe(true);
    expect(path.basename(workspace.cwd!)).toBe(path.basename(repoDir));
  });

  it("creates Codex user-home worktrees under the selected Codex profile home", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const homeDir = await mkdtemp(
      path.join(os.tmpdir(), "pwragent-codex-home-"),
    );
    cleanupPaths.push(homeDir);
    const codexHome = path.join(homeDir, "codex", "profiles", "work");
    const service = new GitDirectoryService({
      codexHome,
      resolveWorktreeStorage: () => "user-home",
      homeDir,
    });

    const workspace = await service.prepareLaunchpadWorkspace({
      backend: "codex",
      directoryKind: "directory",
      directoryLabel: "FixtureRepo",
      directoryPath: repoDir,
      workMode: "worktree",
      branchName: "main",
    });

    const expectedRoot = path.join(codexHome, "worktrees");
    expect(
      toForwardSlashes(workspace.cwd!).startsWith(
        `${toForwardSlashes(expectedRoot)}/`,
      ),
    ).toBe(true);
    expect(path.basename(workspace.cwd!)).toBe(path.basename(repoDir));
  });

  it("records Codex owner metadata in the worktree git directory", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const service = new GitDirectoryService({
      resolveWorktreeStorage: () => "in-repo",
    });
    const workspace = await service.prepareLaunchpadWorkspace({
      directoryKind: "directory",
      directoryLabel: "FixtureRepo",
      directoryPath: repoDir,
      workMode: "worktree",
      branchName: "main",
    });

    await service.recordCodexWorktreeOwnerThread({
      worktreePath: workspace.cwd!,
      threadId: "thread-1",
    });

    const ownerFile = runGit(workspace.cwd!, [
      "rev-parse",
      "--git-path",
      "codex-thread.json",
    ]);
    await expect(readFile(ownerFile, "utf8").then(JSON.parse)).resolves.toEqual(
      {
        version: 1,
        ownerThreadId: "thread-1",
      },
    );
  });

  it("computeWorktreePath suffixes the hash when the path already exists", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const fixedTimestamp = 1730000000000;
    const first = await computeWorktreePath({
      repoRoot: repoDir,
      storage: "in-repo",
      timestamp: fixedTimestamp,
    });
    await mkdir(first, { recursive: true });

    const second = await computeWorktreePath({
      repoRoot: repoDir,
      storage: "in-repo",
      timestamp: fixedTimestamp,
    });

    expect(second).not.toBe(first);
    expect(path.basename(second)).toBe(path.basename(first));
    expect(path.basename(path.dirname(second))).toMatch(/-2$/);
  });

  it("removes the worktree and prunes the empty hash parent on cleanup", async () => {
    const repoDir = await createFixtureRepo();
    cleanupPaths.push(repoDir);
    const service = new GitDirectoryService({
      resolveWorktreeStorage: () => "in-repo",
    });

    const workspace = await service.prepareLaunchpadWorkspace({
      directoryKind: "directory",
      directoryLabel: "FixtureRepo",
      directoryPath: repoDir,
      workMode: "worktree",
      branchName: "release",
    });
    const worktreePath = workspace.cwd!;
    const hashParent = path.dirname(worktreePath);

    const results = await service.cleanupThreadWorktrees({
      gitBranch: undefined,
      observedGitBranch: undefined,
      linkedDirectories: [
        {
          id: "fixture",
          label: "FixtureRepo",
          path: repoDir,
          worktreePath,
          kind: "worktree",
        },
      ],
    });

    expect(results[0].removedWorktree).toBe(true);
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(hashParent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not use the workspace root as the cwd for workspace launchpads", async () => {
    const service = new GitDirectoryService();

    await expect(
      service.prepareLaunchpadWorkspace({
        directoryKind: "workspace",
        directoryLabel: "Workspaces",
        directoryPath: "/Users/test/.pwragent/projects",
        workMode: "local",
      }),
    ).resolves.toEqual({
      cwd: undefined,
      workMode: "local",
    });
  });
});
