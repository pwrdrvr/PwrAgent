import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { captureReviewedWorkingTree, PrChangeIdentityReader } from "../pr-status/pr-change-identity";

/*
 * What docs/pr-review-readiness.md promises about a PR head's change
 * identity, with Git itself as the oracle for the history:
 *
 * - Rebasing the PR onto a target that moved, including edits near the PR's
 *   own lines, keeps the identity.
 * - Merging the target into the PR keeps it.
 * - A commit that changes what the PR changes moves it.
 * - A review of uncommitted changes covers the commit that records them,
 *   through a rebase, and nothing more.
 *
 * Each run builds a real repository under the OS temp directory.
 */

// An empty global config, not os.devNull: Git on Windows cannot open `\\.\nul`.
const configRoot = mkdtempSync(path.join(os.tmpdir(), "pwragent-pr-change-config-"));
const emptyGlobalConfig = path.join(configRoot, "gitconfig");
writeFileSync(emptyGlobalConfig, "");
afterAll(() => rmSync(configRoot, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: emptyGlobalConfig,
    },
  }).trim();
}

function write(cwd: string, file: string, lines: readonly string[]): void {
  writeFileSync(path.join(cwd, file), `${lines.join("\n")}\n`);
}

const line = fc.stringMatching(/^[a-z]{1,8}$/);

const scenario = fc.record({
  base: fc.array(line, { minLength: 6, maxLength: 12 }),
  /**
   * The PR replaces line 2, 3, or 4: two unchanged lines keep a target
   * insertion at the top from conflicting, while leaving it inside the
   * diff's default three lines of context, where it would change a
   * context-carrying patch-id.
   */
  prLine: fc.nat(),
  prText: line.map((text) => `pr-${text}`),
  prNewFile: fc.array(line, { minLength: 1, maxLength: 4 }),
  /** The target inserts lines at the top of the same file and edits another. */
  targetInsert: fc.array(line.map((text) => `main-${text}`), { minLength: 1, maxLength: 3 }),
  targetOther: fc.array(line, { minLength: 1, maxLength: 3 }),
  followUp: line.map((text) => `fix-${text}`),
});

describe("PR change identity", () => {
  it("survives a rebase and a target merge, and moves with a real change", async () => {
    await fc.assert(fc.asyncProperty(scenario, async (input) => {
      const repo = mkdtempSync(path.join(os.tmpdir(), "pwragent-pr-change-"));
      try {
        git(repo, "init", "-q", "-b", "main");
        write(repo, "app.txt", input.base);
        write(repo, "other.txt", ["other"]);
        git(repo, "add", ".");
        git(repo, "commit", "-qm", "base");

        git(repo, "checkout", "-qb", "feature");
        const prLines = [...input.base];
        const index = 2 + (input.prLine % 3);
        prLines[index] = input.prText;
        write(repo, "app.txt", prLines);
        write(repo, "new.txt", input.prNewFile);
        git(repo, "add", ".");
        git(repo, "commit", "-qm", "pr");
        const reviewed = git(repo, "rev-parse", "HEAD");

        git(repo, "checkout", "-q", "main");
        write(repo, "app.txt", [...input.targetInsert, ...input.base]);
        write(repo, "other.txt", input.targetOther);
        git(repo, "commit", "-qam", "target moves");

        git(repo, "checkout", "-qb", "merged", reviewed);
        git(repo, "merge", "-q", "--no-edit", "main");
        const merged = git(repo, "rev-parse", "HEAD");

        git(repo, "checkout", "-q", "feature");
        git(repo, "rebase", "-q", "main");
        const rebased = git(repo, "rev-parse", "HEAD");

        write(repo, "new.txt", [...input.prNewFile, input.followUp]);
        git(repo, "commit", "-qam", "follow-up change");
        const changed = git(repo, "rev-parse", "HEAD");

        const reader = new PrChangeIdentityReader();
        const targetTip = await reader.resolveTargetTip({ cwd: repo, baseRefName: "main" });
        expect(targetTip).toBe(git(repo, "rev-parse", "main"));
        const identity = async (sha: string) =>
          await reader.changeIdentity({ cwd: repo, sha, targetTip: targetTip! });
        const original = await identity(reviewed);
        expect(original).toMatch(/^[0-9a-f]{40}$/);
        expect(await identity(rebased)).toBe(original);
        expect(await identity(merged)).toBe(original);
        expect(await identity(changed)).not.toBe(original);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }), { numRuns: 4 });
    // Each run starts about fifteen real Git processes; under a loaded full
    // suite that outlasts Vitest's default 5 s.
  }, 30_000);

  it("covers the commit that records a reviewed working tree, through a rebase, and nothing more", async () => {
    await fc.assert(fc.asyncProperty(scenario, line, async (input, wip) => {
      const repo = mkdtempSync(path.join(os.tmpdir(), "pwragent-pr-change-"));
      try {
        git(repo, "init", "-q", "-b", "main");
        write(repo, "app.txt", input.base);
        write(repo, "other.txt", ["other"]);
        write(repo, ".gitignore", ["*.log"]);
        git(repo, "add", ".");
        git(repo, "commit", "-qm", "base");

        git(repo, "checkout", "-qb", "feature");
        const prLines = [...input.base];
        prLines[2 + (input.prLine % 3)] = input.prText;
        write(repo, "app.txt", prLines);
        git(repo, "commit", "-qam", "pr");
        const reviewedHead = git(repo, "rev-parse", "HEAD");

        // The reviewed work: a staged new file, an unstaged edit, an
        // untracked file, and an ignored one no commit would carry.
        write(repo, "new.txt", input.prNewFile);
        git(repo, "add", "new.txt");
        write(repo, "app.txt", [...prLines, `wip-${wip}`]);
        write(repo, "untracked.txt", [wip]);
        write(repo, "build.log", ["noise"]);
        const index = readFileSync(path.join(repo, ".git", "index"));
        const status = git(repo, "status", "--porcelain");

        const captured = await captureReviewedWorkingTree(repo);
        expect(captured?.head).toBe(reviewedHead);
        expect(captured?.tree).toMatch(/^[0-9a-f]{40}$/);
        const tree = captured!.tree;
        // The operator's index, stash list, and working tree are untouched.
        expect(readFileSync(path.join(repo, ".git", "index")).equals(index)).toBe(true);
        expect(git(repo, "stash", "list")).toBe("");
        expect(git(repo, "status", "--porcelain")).toBe(status);

        git(repo, "add", "-A");
        git(repo, "commit", "-qm", "record the reviewed work");
        const recorded = git(repo, "rev-parse", "HEAD");
        expect(await captureReviewedWorkingTree(repo)).toBeUndefined();

        git(repo, "checkout", "-q", "main");
        write(repo, "app.txt", [...input.targetInsert, ...input.base]);
        write(repo, "other.txt", input.targetOther);
        git(repo, "commit", "-qam", "target moves");
        git(repo, "checkout", "-q", "feature");
        git(repo, "rebase", "-q", "main");
        const rebased = git(repo, "rev-parse", "HEAD");

        write(repo, "new.txt", [...input.prNewFile, input.followUp]);
        git(repo, "commit", "-qam", "follow-up change");
        const changed = git(repo, "rev-parse", "HEAD");

        const reader = new PrChangeIdentityReader();
        const targetTip = (await reader.resolveTargetTip({ cwd: repo, baseRefName: "main" }))!;
        const reviewed = await reader.changeIdentity({ cwd: repo, sha: reviewedHead, tree, targetTip });
        const identity = async (sha: string) => await reader.changeIdentity({ cwd: repo, sha, targetTip });
        expect(reviewed).toMatch(/^[0-9a-f]{40}$/);
        expect(await identity(reviewedHead)).not.toBe(reviewed);
        expect(await identity(recorded)).toBe(reviewed);
        expect(await identity(rebased)).toBe(reviewed);
        expect(await identity(changed)).not.toBe(reviewed);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }), { numRuns: 4 });
  }, 30_000);

  it("records nothing past its limits, before hashing anything", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "pwragent-pr-change-"));
    try {
      git(repo, "init", "-q", "-b", "main");
      write(repo, "app.txt", ["one"]);
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "base");
      write(repo, "app.txt", ["one", "two"]);
      write(repo, "data.txt", ["0123456789".repeat(10)]);
      const objects = git(repo, "count-objects");

      expect(await captureReviewedWorkingTree(repo, undefined, { maxBytes: 64, maxFiles: 10 })).toBeUndefined();
      expect(await captureReviewedWorkingTree(repo, undefined, { maxBytes: 1024, maxFiles: 1 })).toBeUndefined();
      // Nothing was written to the object store.
      expect(git(repo, "count-objects")).toBe(objects);
      expect(await captureReviewedWorkingTree(repo, undefined, { maxBytes: 1024, maxFiles: 10 }))
        .toMatchObject({ tree: expect.stringMatching(/^[0-9a-f]{40}$/) });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("prefers the forge's base commit, reads a missing commit as unknown, and caches by commit", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "pwragent-pr-change-"));
    try {
      git(repo, "init", "-q", "-b", "main");
      write(repo, "app.txt", ["one"]);
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "base");
      const base = git(repo, "rev-parse", "HEAD");
      write(repo, "app.txt", ["two"]);
      git(repo, "commit", "-qam", "next");
      const head = git(repo, "rev-parse", "HEAD");

      const reader = new PrChangeIdentityReader();
      expect(await reader.resolveTargetTip({ cwd: repo, baseSha: base, baseRefName: "main" })).toBe(base);
      expect(await reader.resolveTargetTip({ cwd: repo, baseSha: "0".repeat(40), baseRefName: "main" })).toBe(head);
      expect(await reader.changeIdentity({ cwd: repo, sha: "1".repeat(40), targetTip: base })).toBeUndefined();
      const first = await reader.changeIdentity({ cwd: repo, sha: head, targetTip: base });
      const before = reader.gitProcessCount;
      expect(await reader.changeIdentity({ cwd: repo, sha: head, targetTip: base })).toBe(first);
      expect(reader.gitProcessCount).toBe(before);
      // The target moved: the identity is read again against the new tip.
      expect(await reader.changeIdentity({ cwd: repo, sha: head, targetTip: head })).toBe("empty");
      expect(reader.gitProcessCount).toBeGreaterThan(before);
      expect(await reader.readReviewedBranchHead(repo, { sha: base, branch: "main" })).toBe(head);
      expect(await reader.readReviewedBranchHead(repo, { sha: base, branch: "feature" })).toBeUndefined();
      expect(await reader.readReviewedBranchHead(repo, { sha: base })).toBe(head);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
