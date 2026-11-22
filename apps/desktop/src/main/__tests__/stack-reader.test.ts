import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StackReader, readStackClones } from "../stacks/stack-reader";

describe("stack catalog reads", () => {
  it("resolves linked worktrees through Git and derives drift without changing refs or the catalog", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent-stacks-"));
    const root = path.join(sandbox, "catalog-clone");
    const worktree = path.join(sandbox, "linked checkout");
    await mkdir(root);
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    try {
      git(root, "init", "-b", "main");
      git(root, "config", "user.name", "Stack Fixture");
      git(root, "config", "user.email", "stacks@example.invalid");
      git(root, "commit", "--allow-empty", "-m", "trunk");
      const base = git(root, "rev-parse", "HEAD");
      git(root, "worktree", "add", "-b", "feature/model", worktree);
      git(worktree, "commit", "--allow-empty", "-m", "feature");
      const head = git(worktree, "rev-parse", "HEAD");
      const catalogPath = path.join(root, ".git", "gh-stack");
      const bytes = JSON.stringify({
        schemaVersion: 1, repository: "github.com:fixture/project",
        stacks: [{ trunk: { branch: "main", head: base }, branches: [{ branch: "feature/model", head, base }] }],
      });
      await writeFile(catalogPath, bytes);
      const clones = await readStackClones([root, worktree]);
      expect(clones).toHaveLength(1);
      expect(clones[0]?.catalog.status).toBe("ok");
      const reader = new StackReader();
      const threads = [{
        id: "model", source: "codex" as const, title: "Model",
        linkedDirectories: [{ id: worktree, label: "Model", kind: "worktree" as const, path: root, worktreePath: worktree }],
      }];
      expect((await reader.read(threads, [])).stacks[0]?.layers[0]).toMatchObject({ health: "in_sync", role: "layer", thread: { key: "codex:model" } });

      git(root, "commit", "--allow-empty", "-m", "advance trunk");
      const refs = git(root, "show-ref");
      expect((await reader.read(threads, [])).stacks[0]?.layers[0]).toMatchObject({ health: "needs_restack" });
      expect(git(root, "show-ref")).toBe(refs);
      expect(await readFile(catalogPath, "utf8")).toBe(bytes);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
