import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SOURCE_HOOKS_SNAPSHOT_ENV,
  checkSourceCheckoutHooks,
  describeHookChanges,
  recordSourceCheckoutHooks,
  resolveHooksDir,
} from "../../../e2e/fixtures/source-checkout-hooks-guard";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("source checkout hooks guard", () => {
  let root: string;
  let repo: string;
  let savedSnapshot: string | undefined;

  beforeEach(() => {
    savedSnapshot = process.env[SOURCE_HOOKS_SNAPSHOT_ENV];
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pwragent-hooks-guard-")));
    repo = path.join(root, "repo");
    execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
    git(
      repo,
      "-c",
      "user.name=PwrAgent Tests",
      "-c",
      "user.email=pwragent-tests@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "seed",
    );
  });

  afterEach(() => {
    if (savedSnapshot === undefined) delete process.env[SOURCE_HOOKS_SNAPSHOT_ENV];
    else process.env[SOURCE_HOOKS_SNAPSHOT_ENV] = savedSnapshot;
    rmSync(root, { recursive: true, force: true });
  });

  it("passes when the run leaves the hooks alone", () => {
    recordSourceCheckoutHooks(repo);
    expect(() => checkSourceCheckoutHooks()).not.toThrow();
  });

  it("names an LFS hook installed during the run", () => {
    recordSourceCheckoutHooks(repo);
    writeFileSync(path.join(repo, ".git", "hooks", "pre-push"), "#!/bin/sh\ngit lfs pre-push \"$@\"\n");
    expect(() => checkSourceCheckoutHooks()).toThrow(/added pre-push/);
  });

  it("watches the shared hooks of a linked worktree, where E2E lanes run", () => {
    const worktree = path.join(root, "lane2");
    git(repo, "worktree", "add", "-q", "--detach", worktree);
    expect(resolveHooksDir(worktree)).toBe(path.join(repo, ".git", "hooks"));

    recordSourceCheckoutHooks(worktree);
    writeFileSync(path.join(repo, ".git", "hooks", "post-checkout"), "#!/bin/sh\n");
    expect(() => checkSourceCheckoutHooks()).toThrow(/added post-checkout/);
  });

  it("skips the check outside a repository", () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), "pwragent-hooks-guard-plain-"));
    try {
      expect(resolveHooksDir(plain)).toBeUndefined();
      recordSourceCheckoutHooks(plain);
      expect(process.env[SOURCE_HOOKS_SNAPSHOT_ENV]).toBeUndefined();
      expect(() => checkSourceCheckoutHooks()).not.toThrow();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("reports added, changed and removed hooks", () => {
    const before = { hooksDir: "/hooks", files: { "pre-commit": "a", "post-merge": "b" } };
    const after = { hooksDir: "/hooks", files: { "pre-commit": "c", "pre-push": "d" } };
    expect(describeHookChanges(before, after)).toEqual([
      "removed post-merge",
      "changed pre-commit",
      "added pre-push",
    ]);
  });
});
