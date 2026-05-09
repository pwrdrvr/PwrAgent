import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectPullRequestsForThread } from "../pr-status/pr-detection";
import type { GithubPrFetcher } from "../pr-status/github-pr-fetcher";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("detectPullRequestsForThread", () => {
  it("uses local branches pointing at HEAD when the thread is detached", async () => {
    const repo = await createDetachedRepoWithBranchAtHead("fix/messaging-nonblocking-startup");
    const fetchedBranches: string[] = [];
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async ({ branch }) => {
        fetchedBranches.push(branch);
        if (branch !== "fix/messaging-nonblocking-startup") {
          return [];
        }
        return [
          {
            number: 271,
            org: "pwrdrvr",
            repo: "PwrAgent",
            state: "passing",
            url: `https://github.com/pwrdrvr/PwrAgent/pull/${branch}`,
          },
        ];
      }),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch: "HEAD",
      directoryPaths: [repo],
    });

    expect(fetchedBranches).toEqual(
      expect.arrayContaining(["fix/messaging-nonblocking-startup"]),
    );
    expect(prs).toHaveLength(1);
  });
});

async function createDetachedRepoWithBranchAtHead(branch: string): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "pwragent-pr-detection-"));
  tempDirs.push(repo);
  await git(repo, "init");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "PwrAgent Test");
  await git(repo, "commit", "--allow-empty", "-m", "initial");
  const sha = (await git(repo, "rev-parse", "HEAD")).trim();
  await git(repo, "branch", branch, sha);
  await git(repo, "checkout", "--detach", sha);
  return repo;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
