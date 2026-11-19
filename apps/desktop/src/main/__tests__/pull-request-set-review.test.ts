import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppServerReviewTarget, PrSummary } from "@pwragent/shared";
import { resolvePullRequestSetReview } from "../app-server/pull-request-review";
import { resolveReviewProvenance } from "../app-server/review-provenance";
import { buildManagedReviewPrompt } from "../app-server/managed-review";
import { reviewFindingPullRequests } from "../../shared/pull-request-review";

const exec = promisify(execFile);
let cwd: string;
let commits: string[];
let prs: PrSummary[];
let seen: string[][];
const git = async (...args: string[]): Promise<string> =>
  (await exec("git", args, { cwd })).stdout.trim();
const runGit = async (_cwd: string, args: string[]): Promise<{ stdout: string }> => {
  seen.push(args);
  return { stdout: (await exec("git", args, { cwd })).stdout };
};
async function commit(files: Record<string, string>, message: string): Promise<string> {
  for (const [file, text] of Object.entries(files)) {
    await writeFile(path.join(cwd, file), text);
    await git("add", file);
  }
  await git("commit", "-m", message);
  return git("rev-parse", "HEAD");
}

// A three-PR stack: #1 on main, #2 on #1, #3 on #2. #2 and #3 both change
// shared.ts, so a finding there belongs to both.
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "pr-set-review-"));
  await git("init", "-b", "main");
  await git("config", "user.email", "fixture@example.test");
  await git("config", "user.name", "Review Fixture");
  await git("remote", "add", "origin", "https://github.com/fixture/project.git");
  const base = await commit({ "base.txt": "base" }, "base");
  await git("switch", "-c", "one");
  const one = await commit({ "one.ts": "one" }, "one");
  await git("switch", "-c", "two");
  const two = await commit({ "two.ts": "two", "shared.ts": "two" }, "two");
  await git("switch", "-c", "three");
  const three = await commit({ "shared.ts": "three", "three.ts": "three" }, "three");
  commits = [base, one, two, three];
  const branches = ["main", "one", "two", "three"];
  prs = [1, 2, 3].map((number) => ({
    provider: "github.com", org: "fixture", repo: "project", number,
    url: `https://github.com/fixture/project/pull/${number}`,
    state: "passing", title: `PR ${number}`, lifecycleState: "open",
    baseRefName: branches[number - 1], headRefName: branches[number],
    baseSha: commits[number - 1], headSha: commits[number],
  }));
  seen = [];
});
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

const setTarget = (numbers: number[]): Extract<AppServerReviewTarget, { type: "pullRequests" }> => ({
  type: "pullRequests",
  pullRequests: numbers.map((number) => ({ url: prs[number - 1]!.url })),
});
const resolve = (target: Extract<AppServerReviewTarget, { type: "pullRequests" }>, trustedSnapshot = false) =>
  resolvePullRequestSetReview({
    cwd, prs, runGit, target, trustedSnapshot,
    fetchPullRequest: async (url) => prs.find((pr) => pr.url === url),
  });

describe("combined pull request review", () => {
  it("pins every pull request to its own head and records the paths each diff changes", async () => {
    const resolved = await resolve(setTarget([3, 1, 2]));
    expect(resolved.pullRequests.map((member) => member.snapshot)).toMatchObject([
      { headCommit: commits[3], mergeBaseCommit: commits[2], changedPaths: ["shared.ts", "three.ts"] },
      { headCommit: commits[1], mergeBaseCommit: commits[0], changedPaths: ["one.ts"] },
      { headCommit: commits[2], mergeBaseCommit: commits[1], changedPaths: ["shared.ts", "two.ts"] },
    ]);
  });

  it("reads the stack bottom first and tags findings by the pull requests that changed their file", async () => {
    const target = await resolve(setTarget([3, 1, 2]));
    const context = await resolveReviewProvenance({ cwd, prs, runGit, target });
    expect(context?.pullRequests?.map((pr) => pr.number)).toEqual([1, 2, 3]);
    expect(context?.pullRequest?.number).toBe(1);
    // Several diffs have no one branch or commit.
    expect(context).not.toHaveProperty("gitBranch");
    expect(context).not.toHaveProperty("headCommit");
    const tags = (file: string) => reviewFindingPullRequests(path.join(cwd, file), context)?.map((pr) => pr.number);
    expect(tags("one.ts")).toEqual([1]);
    expect(tags("shared.ts")).toEqual([2, 3]);
    expect(tags("base.txt")).toEqual([]);
    const prompt = buildManagedReviewPrompt(target);
    expect(prompt.indexOf("/pull/1;")).toBeLessThan(prompt.indexOf("/pull/2;"));
    expect(prompt.indexOf("/pull/2;")).toBeLessThan(prompt.indexOf("/pull/3;"));
    expect(prompt).toContain("They form a stack, listed bottom first");
  });

  it("replaces incoming snapshots, including forged changed paths", async () => {
    const forged = setTarget([1, 2]);
    forged.pullRequests[0]!.snapshot = {
      pullRequest: { provider: "github.com", org: "fixture", repo: "project", number: 1, url: prs[0]!.url },
      baseCommit: commits[0]!, headCommit: commits[3]!, mergeBaseCommit: commits[0]!, capturedAt: 1,
      changedPaths: ["forged.ts"],
    };
    const resolved = await resolve(forged);
    expect(resolved.pullRequests[0]!.snapshot).toMatchObject({ headCommit: commits[1], changedPaths: ["one.ts"] });
  });

  it("releases a queued combined review at its captured commits without reading them again", async () => {
    const captured = await resolve(setTarget([1, 2]));
    prs[1] = { ...prs[1]!, headSha: commits[3] };
    seen = [];
    const released = await resolve(captured, true);
    expect(released).toEqual(captured);
    expect(seen.some((args) => args[0] === "diff")).toBe(false);
  });

  it("fails the whole review when one pull request cannot be resolved", async () => {
    prs = prs.filter((pr) => pr.number !== 2);
    await expect(resolve({
      type: "pullRequests",
      pullRequests: [{ url: "https://github.com/fixture/project/pull/1" }, { url: "https://github.com/fixture/project/pull/2" }],
    })).rejects.toThrow(/attached pull request/);
  });

  it("refuses one pull request, a repeated one, or pull requests of two repositories", async () => {
    await expect(resolve(setTarget([1]))).rejects.toThrow(/at least two/);
    await expect(resolve(setTarget([1, 1]))).rejects.toThrow(/once/);
    await expect(resolve({
      type: "pullRequests",
      pullRequests: [{ url: prs[0]!.url }, { url: "https://github.com/fixture/other/pull/2" }],
    })).rejects.toThrow(/one repository/);
  });
});
