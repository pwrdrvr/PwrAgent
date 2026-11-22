import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  isToolManagedWorktreePath,
  setConfiguredWorktreeFolder,
  toolWorktreeRootOwner,
} from "@pwragent/shared/worktree-paths";
import { computeWorktreePath } from "../app-server/git-directory-service";
import { WORKTREE_FOLDER_MARKER } from "../settings/worktree-folder-check";

const cleanupPaths: string[] = [];

afterEach(async () => {
  setConfiguredWorktreeFolder(undefined);
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

/**
 * Rules: an operator-chosen worktree folder is the root itself, used and never
 * created. With an external drive unplugged, creating `/Volumes/<drive>/...`
 * would put worktrees on the startup disk unnoticed, so allocation must fail
 * instead. A folder holding other files is refused, since its subfolders
 * would look like worktrees; an accepted one is marked before its first
 * worktree. In-repository worktrees ignore the folder; Codex worktrees use it
 * only when opted in, and then in its `codex` subfolder. Every path handed
 * out is recognized by path as a worktree of the right owner.
 */
describe("computeWorktreePath worktree folder", () => {
  it("places user-home worktrees straight into an existing folder and never creates a missing one", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("user-home", "in-repo") as fc.Arbitrary<"user-home" | "in-repo">,
        fc.constantFrom("claude", "codex", undefined) as fc.Arbitrary<"claude" | "codex" | undefined>,
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom("", "/", "/./"),
        fc.constantFrom("empty", "hidden", "foreign", "marked-foreign"),
        async (storage, backend, baseExists, includeCodex, spelling, contents) => {
          const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-worktree-base-"));
          cleanupPaths.push(sandbox);
          const homeDir = path.join(sandbox, "home");
          const repoRoot = path.join(sandbox, "repos", "Orbit");
          const baseDirectory = path.join(sandbox, "Volumes", "Dev");
          await mkdir(homeDir, { recursive: true });
          await mkdir(repoRoot, { recursive: true });
          if (baseExists) {
            await mkdir(baseDirectory, { recursive: true });
            if (contents === "hidden") await mkdir(path.join(baseDirectory, ".pwragent"));
            if (contents === "foreign" || contents === "marked-foreign") {
              await mkdir(path.join(baseDirectory, "Photos"));
            }
            if (contents === "marked-foreign") await writeFile(path.join(baseDirectory, WORKTREE_FOLDER_MARKER), "");
          }
          // A configured folder may carry a trailing slash or `.` segment.
          const directory = `${baseDirectory}${spelling}`;
          setConfiguredWorktreeFolder(directory);

          const usesFolder = storage === "user-home" && (backend !== "codex" || includeCodex);
          const allocation = computeWorktreePath({
            backend,
            codexHome: path.join(homeDir, ".codex"),
            homeDir,
            repoRoot,
            storage,
            worktreeFolder: { directory, includeCodex },
          });

          if (usesFolder && !baseExists) {
            await expect(allocation).rejects.toThrow(/is not available/);
            expect(existsSync(baseDirectory)).toBe(false);
            return;
          }
          if (usesFolder && contents === "foreign") {
            await expect(allocation).rejects.toThrow(/already holds other files/);
            expect(await readdir(baseDirectory)).toEqual(["Photos"]);
            return;
          }
          const worktreePath = await allocation;
          const expectedRoot = !usesFolder
            ? storage === "in-repo"
              ? path.join(repoRoot, ".worktrees")
              : path.join(homeDir, ".codex", "worktrees")
            : backend === "codex" ? path.join(baseDirectory, "codex") : baseDirectory;
          expect(path.dirname(path.dirname(worktreePath))).toBe(expectedRoot);
          expect(path.basename(worktreePath)).toBe("Orbit");
          expect(existsSync(baseDirectory)).toBe(baseExists);
          if (usesFolder) expect(existsSync(path.join(baseDirectory, WORKTREE_FOLDER_MARKER))).toBe(true);
          if (storage === "user-home") {
            expect(isToolManagedWorktreePath(worktreePath)).toBe(true);
            expect(toolWorktreeRootOwner(worktreePath)).toBe(backend === "codex" ? "codex" : "pwragent");
          }
        },
      ),
      { numRuns: 192 },
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
