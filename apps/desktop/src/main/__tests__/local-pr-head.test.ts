import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readLocalHeadPastPrHead } from "../pr-status/local-pr-head";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A repository on `feature` with two commits; returns both heads. */
async function repoWithTwoCommits() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "pwragent-local-pr-head-"));
  tempDirs.push(repo);
  const git = async (...args: string[]) =>
    (await execFileAsync("git", ["-C", repo, ...args])).stdout.trim();
  await git("init", "-b", "feature");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test User");
  await writeFile(path.join(repo, "file.txt"), "one\n");
  await git("add", "file.txt");
  await git("commit", "-m", "one");
  const pushed = await git("rev-parse", "HEAD");
  await writeFile(path.join(repo, "file.txt"), "two\n");
  await git("commit", "-am", "two");
  const local = await git("rev-parse", "HEAD");
  return { repo, git, pushed, local };
}

describe("readLocalHeadPastPrHead", () => {
  it("returns the checkout head when it is past the cached PR head", async () => {
    const { repo, pushed, local } = await repoWithTwoCommits();
    await expect(readLocalHeadPastPrHead({
      directories: [repo], cachedHeadSha: pushed, headRefName: "feature",
    })).resolves.toBe(local);
  });

  it("returns nothing at the cached head, behind it, or on another branch", async () => {
    const { repo, git, pushed, local } = await repoWithTwoCommits();
    await expect(readLocalHeadPastPrHead({ directories: [repo], cachedHeadSha: local }))
      .resolves.toBeUndefined();
    // Another branch's checkout is not this PR's.
    await expect(readLocalHeadPastPrHead({
      directories: [repo], cachedHeadSha: pushed, headRefName: "other",
    })).resolves.toBeUndefined();
    // Behind: someone else pushed the cached head after this checkout.
    await git("checkout", "-q", pushed);
    await expect(readLocalHeadPastPrHead({ directories: [repo], cachedHeadSha: local }))
      .resolves.toBeUndefined();
  });

  it("returns nothing when Git cannot read the directory or knows no such head", async () => {
    const { repo } = await repoWithTwoCommits();
    await expect(readLocalHeadPastPrHead({
      directories: [path.join(repo, "missing")], cachedHeadSha: "a".repeat(40),
    })).resolves.toBeUndefined();
    // A head this checkout never fetched is not an ancestor it can prove.
    await expect(readLocalHeadPastPrHead({ directories: [repo], cachedHeadSha: "a".repeat(40) }))
      .resolves.toBeUndefined();
    await expect(readLocalHeadPastPrHead({ directories: [repo], cachedHeadSha: "not-a-sha" }))
      .resolves.toBeUndefined();
  });
});
