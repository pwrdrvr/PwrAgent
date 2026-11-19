import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { computeWorktreePath } from "../app-server/git-directory-service";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

/**
 * Rule: an operator-chosen worktree folder is used, never created. With an
 * external drive unplugged, creating `/Volumes/<drive>/...` would put
 * worktrees on the startup disk unnoticed, so allocation must fail instead.
 * In-repository worktrees ignore the folder; Codex worktrees use it only when
 * opted in, and then under `.codex/worktrees` so they stay recognizable.
 */
describe("computeWorktreePath worktree folder", () => {
  it("places user-home worktrees under an existing folder and never creates a missing one", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("user-home", "in-repo") as fc.Arbitrary<"user-home" | "in-repo">,
        fc.constantFrom("claude", "codex", undefined) as fc.Arbitrary<"claude" | "codex" | undefined>,
        fc.boolean(),
        fc.boolean(),
        async (storage, backend, baseExists, includeCodex) => {
          const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-worktree-base-"));
          cleanupPaths.push(sandbox);
          const homeDir = path.join(sandbox, "home");
          const repoRoot = path.join(sandbox, "repos", "Orbit");
          const baseDirectory = path.join(sandbox, "Volumes", "Dev");
          await mkdir(homeDir, { recursive: true });
          await mkdir(repoRoot, { recursive: true });
          if (baseExists) await mkdir(baseDirectory, { recursive: true });

          const usesFolder = storage === "user-home" && (backend !== "codex" || includeCodex);
          const allocation = computeWorktreePath({
            backend,
            codexHome: path.join(homeDir, ".codex"),
            homeDir,
            repoRoot,
            storage,
            worktreeFolder: { directory: baseDirectory, includeCodex },
          });

          if (usesFolder && !baseExists) {
            await expect(allocation).rejects.toThrow(/is not available/);
            expect(existsSync(baseDirectory)).toBe(false);
            return;
          }
          const worktreePath = await allocation;
          const expectedRoot = !usesFolder
            ? storage === "in-repo"
              ? path.join(repoRoot, ".worktrees")
              : path.join(homeDir, ".codex", "worktrees")
            : path.join(baseDirectory, backend === "codex" ? ".codex" : ".pwragent", "worktrees");
          expect(path.dirname(path.dirname(worktreePath))).toBe(expectedRoot);
          expect(path.basename(worktreePath)).toBe("Orbit");
          expect(existsSync(baseDirectory)).toBe(baseExists);
        },
      ),
      { numRuns: 48 },
    );
  });

  it("keeps the home folder when no worktree folder is set", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-worktree-home-"));
    cleanupPaths.push(homeDir);
    const worktreePath = await computeWorktreePath({
      homeDir,
      worktreeFolder: { directory: "  ", includeCodex: true },
      repoRoot: path.join(homeDir, "Orbit"),
      storage: "user-home",
    });

    expect(path.dirname(path.dirname(worktreePath))).toBe(path.join(homeDir, ".pwragent", "worktrees"));
  });
});
