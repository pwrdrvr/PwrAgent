import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { resolvePullRequestReview } from "../app-server/pull-request-review";
import { resolveReviewProvenance } from "../app-server/review-provenance";
import { attachedPullRequestsForWorkspace, nativeReviewTarget } from "../../shared/pull-request-review";

const exec = promisify(execFile);
let cwd: string;
let base: string;
let first: string;
let second: string;
let prs: PrSummary[];
let seen: string[][];
const git = async (...args: string[]): Promise<string> =>
  (await exec("git", args, { cwd })).stdout.trim();
const runGit = async (_cwd: string, args: string[]): Promise<{ stdout: string }> => {
  seen.push(args);
  return { stdout: await git(...args) };
};
async function commit(file: string, text: string): Promise<string> {
  await writeFile(path.join(cwd, file), text);
  await git("add", file);
  await git("commit", "-m", text);
  return git("rev-parse", "HEAD");
}

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "pr-review-"));
  await git("init", "-b", "main");
  await git("config", "user.email", "fixture@example.test");
  await git("config", "user.name", "Review Fixture");
  await git("remote", "add", "origin", "https://github.com/fixture/project.git");
  base = await commit("base.txt", "base");
  await git("switch", "-c", "first");
  await commit("first.txt", "first commit");
  first = await commit("first.txt", "second commit in first PR");
  await git("switch", "-c", "second");
  await commit("second.txt", "first commit in second PR");
  second = await commit("second.txt", "second commit in second PR");
  await writeFile(path.join(cwd, "first.txt"), "dirty checkout content");
  prs = [1, 2].map((number) => ({
    provider: "github.com", org: "fixture", repo: "project", number,
    url: `https://github.com/fixture/project/pull/${number}`,
    state: "passing", title: `PR ${number}`, lifecycleState: "open",
    baseRefName: number === 1 ? "main" : "first",
    headRefName: number === 1 ? "first" : "second",
    baseSha: number === 1 ? base : first,
    headSha: number === 1 ? first : second,
  }));
  seen = [];
});
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

function resolve(number = 1) {
  return resolvePullRequestReview({
    cwd, prs, runGit,
    target: { type: "pullRequest", url: prs[number - 1].url },
    fetchPullRequest: async () => prs[number - 1],
  });
}

describe("explicit attached PR review", () => {
  it("isolates both multi-commit PRs while leaving a dirty newer checkout untouched", async () => {
    const before = await git("status", "--porcelain");
    const a = await resolve(1);
    const b = await resolve(2);
    expect(a.snapshot).toMatchObject({ baseCommit: base, headCommit: first, mergeBaseCommit: base });
    expect(b.snapshot).toMatchObject({ baseCommit: first, headCommit: second, mergeBaseCommit: first });
    expect(await git("diff", "--name-only", a.snapshot!.mergeBaseCommit, a.snapshot!.headCommit)).toBe("first.txt");
    expect(await git("diff", "--name-only", b.snapshot!.mergeBaseCommit, b.snapshot!.headCommit)).toBe("second.txt");
    expect(await git("rev-list", "--count", `${base}..${first}`)).toBe("2");
    expect(await git("rev-list", "--count", `${first}..${second}`)).toBe("2");
    expect(await git("rev-parse", "HEAD")).toBe(second);
    expect(await git("status", "--porcelain")).toBe(before);
    expect(await readFile(path.join(cwd, "first.txt"), "utf8")).toBe("dirty checkout content");
    const wire = nativeReviewTarget(a);
    expect(wire.type).toBe("custom");
    expect(wire).toMatchObject({ instructions: expect.stringContaining(`git show '${first}:path/to/file'`) });
    expect(wire).toMatchObject({ instructions: expect.stringContaining(`git diff --no-ext-diff ${base} ${first}`) });
    expect(JSON.stringify(wire)).not.toContain(second);
    const context = await resolveReviewProvenance({ cwd, target: a });
    expect(context).toMatchObject({ headCommit: first, baseCommit: base, pullRequest: { number: 1 }, pullRequestSnapshot: a.snapshot });
  });

  it("reuses a trusted queued snapshot after a push and rejects client-supplied pins", async () => {
    const captured = await resolve();
    prs[0] = { ...prs[0], headSha: second };
    const fetchPullRequest = vi.fn(async () => prs[0]);
    const queued = await resolvePullRequestReview({ cwd, prs, runGit, target: captured, trustedSnapshot: true, fetchPullRequest });
    expect(queued.snapshot).toEqual(captured.snapshot);
    expect(fetchPullRequest).not.toHaveBeenCalled();
    const incoming = await resolvePullRequestReview({ cwd, prs, runGit, target: captured, fetchPullRequest });
    expect(incoming.snapshot?.headCommit).toBe(second);
    expect(fetchPullRequest).toHaveBeenCalledOnce();
    await expect(resolvePullRequestReview({ cwd, prs: [], runGit, target: captured, trustedSnapshot: true })).rejects.toThrow("attached");
  });

  it("fails closed on unrelated repositories, absent metadata, ambiguous bases, and remote workspaces", async () => {
    const target = { type: "pullRequest" as const, url: prs[0].url };
    const fetchPullRequest = vi.fn(async () => undefined);
    await expect(resolvePullRequestReview({ cwd, prs, runGit, target, executionTarget: "remote", fetchPullRequest })).rejects.toThrow("owning execution host");
    expect(seen).toEqual([]);
    await expect(resolvePullRequestReview({ cwd, prs, runGit, target, fetchPullRequest })).rejects.toThrow("metadata");
    await git("remote", "set-url", "origin", "https://github.com/fixture/unrelated.git");
    await expect(resolve()).rejects.toThrow("selected repository");
    await git("remote", "set-url", "origin", "https://github.com/fixture/project.git");
    await expect(resolvePullRequestReview({ cwd, prs, target, fetchPullRequest: async () => prs[0],
      runGit: async (dir, args) => args[0] === "merge-base" ? { stdout: `${base}\n${first}` } : runGit(dir, args),
    })).rejects.toThrow("ambiguous merge base");
  });

  it("scopes unlabelled stacked attachments using repository identity", () => {
    const unrelated = { ...prs[0], url: "https://github.com/fixture/other/pull/3" };
    expect(attachedPullRequestsForWorkspace({ cwd, prs: [...prs, unrelated], repository: "github.com/fixture/project" })).toEqual(prs);
    expect(attachedPullRequestsForWorkspace({ cwd, prs: [prs[0], { ...prs[1], linkedDirectoryPaths: [cwd] }, unrelated] })).toHaveLength(2);
    expect(attachedPullRequestsForWorkspace({ cwd, prs })).toEqual([]);
  });

  it("fetches missing exact objects even after the provider branch advances without moving local refs", async () => {
    const clone = path.join(cwd, "clone");
    await exec("git", ["clone", "--no-local", "--single-branch", "--branch", "main", cwd, clone]);
    await git("update-ref", "refs/heads/first", second);
    const calls: string[][] = [];
    const cloneGit = async (_dir: string, args: string[]): Promise<{ stdout: string }> => {
      calls.push(args);
      if (args[0] === "remote" && args[1] === "get-url") return { stdout: "https://github.com/fixture/project.git" };
      return exec("git", args, { cwd: clone });
    };
    const target = await resolvePullRequestReview({
      cwd: clone, prs, runGit: cloneGit,
      target: { type: "pullRequest", url: prs[0].url }, fetchPullRequest: async () => prs[0],
    });
    expect(target.snapshot?.headCommit).toBe(first);
    expect(calls).toContainEqual(["fetch", "--no-tags", "--no-write-fetch-head", "--", "origin", first]);
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: clone })).stdout.trim()).toBe(base);
    await expect(readFile(path.join(clone, ".git", "FETCH_HEAD"), "utf8")).rejects.toThrow();
  });

  it("refuses a fetch that did not provide the exact provider commit", async () => {
    await expect(resolvePullRequestReview({
      cwd, prs, target: { type: "pullRequest", url: prs[0].url }, fetchPullRequest: async () => prs[0],
      runGit: async (dir, args) => {
        if (args[0] === "rev-parse") return { stdout: second };
        if (args[0] === "fetch") return { stdout: "" };
        return runGit(dir, args);
      },
    })).rejects.toThrow("unavailable after fetch");
  });
});
