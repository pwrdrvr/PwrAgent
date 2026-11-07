import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearGitHubRemoteCache } from "../pr-status/git-remote";
import { resolvePrimaryThreadRepoKey } from "../pr-status/primary-thread-repository";
import { isolateProcessGitEnvironment, runIsolatedGit } from "./helpers/isolated-git";

// The checkout owns repository identity. Session-start git metadata may
// predate a rename, and the same repository can live at unrelated paths.
describe("primary thread repository against Git", () => {
  let root: string;
  let checkout: string;
  let worktree: string;
  let restoreGitEnv: () => void;

  beforeEach(() => {
    restoreGitEnv = isolateProcessGitEnvironment();
    process.env.GIT_CONFIG_GLOBAL = path.join(root, "missing-global-config");
    process.env.GIT_CONFIG_SYSTEM = path.join(root, "missing-system-config");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    clearGitHubRemoteCache();
  });
  afterEach(() => restoreGitEnv());

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-primary-repo-")));
    checkout = path.join(root, "machine-a", "github", "disktree");
    worktree = path.join(root, "machine-b", "worktrees", "mw2h6pqb", "disktree");
    await mkdir(checkout, { recursive: true });
    await runIsolatedGit(checkout, ["init", "-q", "-b", "main"]);
    await runIsolatedGit(checkout, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "initial"]);
    await runIsolatedGit(checkout, ["remote", "add", "origin", "https://github.com/pwrdrvr/disktree.git"]);
    await runIsolatedGit(checkout, ["worktree", "add", "--detach", worktree]);
  });
  afterAll(async () => {
    clearGitHubRemoteCache();
    await rm(root, { recursive: true, force: true });
  });

  function thread(gitOriginUrl: string, worktreePath = worktree) {
    return {
      gitOriginUrl,
      linkedDirectories: [{
        id: checkout,
        kind: "worktree" as const,
        label: "disktree",
        path: checkout,
        worktreePath,
      }],
    };
  }

  async function gitRepositoryKey(cwd: string): Promise<string> {
    const { stdout } = await runIsolatedGit(cwd, ["remote", "get-url", "origin"]);
    // The fixture uses HTTPS GitHub remotes; URL is an independent oracle
    // rather than production's remote parser or identity comparison.
    const remote = new URL(stdout.trim());
    return `${remote.hostname}${remote.pathname.replace(/\.git$/, "")}`.toLowerCase();
  }

  it("uses PwrDisk for #115 when the session still records pwrdrvr/disktree", async () => {
    await runIsolatedGit(checkout, ["remote", "set-url", "origin", "https://github.com/pwrdrvr/PwrDisk.git"]);
    expect(await resolvePrimaryThreadRepoKey(thread("git@github.com:pwrdrvr/disktree.git")))
      .toBe(await gitRepositoryKey(worktree));
    expect(await gitRepositoryKey(worktree)).toBe("github.com/pwrdrvr/pwrdisk");
  });

  it("agrees with Git after remote changes regardless of the session origin or checkout path", async () => {
    const name = fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/);
    await fc.assert(fc.asyncProperty(
      name, name, fc.boolean(),
      async (owner, repo, useWorktree) => {
        // A session starts before the remote is changed, as in the report.
        const savedOrigin = "git@github.com:pwrdrvr/disktree.git";
        await runIsolatedGit(checkout, ["remote", "set-url", "origin", `https://github.com/${owner}/${repo}.git`]);
        clearGitHubRemoteCache();
        const cwd = useWorktree ? worktree : checkout;
        expect(await resolvePrimaryThreadRepoKey(thread(savedOrigin, cwd)))
          .toBe(await gitRepositoryKey(cwd));
      },
    ), { numRuns: 25 });
  });

  it("falls back to the session origin when its checkout is unavailable", async () => {
    expect(await resolvePrimaryThreadRepoKey(thread(
      "git@github.com:pwrdrvr/PwrDisk.git",
      path.join(root, "unavailable-machine", "disktree"),
    ))).toBe("github.com/pwrdrvr/pwrdisk");
  });

  it("does not fall back to the old project after a handoff to an unavailable checkout", async () => {
    const moved = thread("git@github.com:pwrdrvr/disktree.git");
    moved.linkedDirectories.push({
      id: "pwragent-handoff:codex:thread-1",
      kind: "worktree",
      label: "PwrAgent",
      path: path.join(root, "unavailable-project"),
      worktreePath: path.join(root, "unavailable-project", "worktree"),
    });
    expect(await resolvePrimaryThreadRepoKey(moved)).toBeUndefined();
  });

  it("shares the checkout probe but keeps each session's unavailable-checkout fallback", async () => {
    const missing = path.join(root, "missing-checkout");
    const resolutions = new Map<string, Promise<string | undefined>>();
    expect(await resolvePrimaryThreadRepoKey(thread("https://github.com/one/repo.git", missing), resolutions))
      .toBe("github.com/one/repo");
    const probe = resolutions.get(missing);
    expect(probe).toBeDefined();
    expect(await resolvePrimaryThreadRepoKey(thread("https://github.com/two/repo.git", missing), resolutions))
      .toBe("github.com/two/repo");
    expect(resolutions.get(missing)).toBe(probe);
  });
});
