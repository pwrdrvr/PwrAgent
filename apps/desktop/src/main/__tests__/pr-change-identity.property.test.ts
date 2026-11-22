import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PrChangeIdentityReader } from "../pr-status/pr-change-identity";

/*
 * What docs/pr-review-readiness.md promises about a PR head's change
 * identity, with Git itself as the oracle for the history:
 *
 * - Rebasing the PR onto a target that moved, including edits near the PR's
 *   own lines, keeps the identity.
 * - Merging the target into the PR keeps it.
 * - A commit that changes what the PR changes moves it.
 *
 * Each run builds a real repository under the OS temp directory.
 */

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
      GIT_CONFIG_GLOBAL: os.devNull,
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
          await reader.changeIdentity({ cwd: repo, sha, targetTip: targetTip!, targetName: "main" });
        const original = await identity(reviewed);
        expect(original).toMatch(/^[0-9a-f]{40}$/);
        expect(await identity(rebased)).toBe(original);
        expect(await identity(merged)).toBe(original);
        expect(await identity(changed)).not.toBe(original);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }), { numRuns: 4 });
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
      expect(await reader.readReviewedBranchHead(repo, { sha: base, branch: "main" })).toBe(head);
      expect(await reader.readReviewedBranchHead(repo, { sha: base, branch: "feature" })).toBeUndefined();
      expect(await reader.readReviewedBranchHead(repo, { sha: base })).toBe(head);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
