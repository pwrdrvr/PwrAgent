import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { canonicalizeNavigationPath } from "@pwragent/shared/directory-navigation";
import type { DirectoryRegistrationDeps } from "../app-server/directory-registration-service";
import { registerDirectoryFromDisk } from "../app-server/directory-registration-service";
import { runGitCommand } from "../app-server/git-executable";

it("registers Git's primary checkout from any folder inside a linked worktree", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-project-registration-")));
  try {
    const repo = path.join(root, "parent-repo");
    const checkouts = [
      path.join(root, ".codex", "worktrees", "session", "parent-repo"),
      path.join(root, "custom folder", "different checkout name"),
    ];
    await mkdir(repo);
    await runGitCommand(repo, ["init", "-b", "main"]);
    await runGitCommand(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture"]);
    for (const checkout of checkouts) {
      await runGitCommand(repo, ["worktree", "add", "--detach", checkout]);
      await mkdir(path.join(checkout, "source", "nested"), { recursive: true });
    }
    const [primary] = (await runGitCommand(repo, ["worktree", "list", "--porcelain"])).stdout.split("\n");
    expect(primary).toBe(`worktree ${canonicalizeNavigationPath(repo)}`);
    const directoryPath = primary!.slice("worktree ".length);

    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...checkouts), fc.constantFrom([], ["source"], ["source", "nested"]),
      async (checkout, relative) => {
        const ensureDirectoryLaunchpad = vi.fn<DirectoryRegistrationDeps["ensureDirectoryLaunchpad"]>(async (request) => ({
          launchpad: { ...request, backend: "codex", executionMode: "default", workMode: "local", prompt: "", createdAt: 1, updatedAt: 1 },
          defaults: { backend: "codex", executionMode: "default" },
        }));
        const result = await registerDirectoryFromDisk({ path: path.join(checkout, ...relative) }, { ensureDirectoryLaunchpad });
        const expected = { directoryPath, directoryKey: `directory:${directoryPath}`, directoryLabel: "parent-repo", currentBranch: "main" };
        expect(result).toMatchObject({ ok: true, ...expected });
        expect(ensureDirectoryLaunchpad).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(expected));
      },
    ), { numRuns: 12 });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
