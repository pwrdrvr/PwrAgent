import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StackReader, readStackClones } from "../stacks/stack-reader";

describe("stack catalog reads", () => {
  it.each(["github.com:fixture/project", ""])("reads linked worktrees and derives health for repository %j", async (repository) => {
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
        schemaVersion: 1, repository,
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
      const nextTrunk = git(root, "rev-parse", "HEAD");
      const refs = git(root, "show-ref");
      expect((await reader.read(threads, [])).stacks[0]?.layers[0]).toMatchObject({ health: "needs_restack" });
      expect(git(root, "show-ref")).toBe(refs);
      expect(await readFile(catalogPath, "utf8")).toBe(bytes);
      if (repository) {
        git(root, "branch", "feature/upper", nextTrunk);
        const childPr = {
          number: 2, provider: "github.com", org: "fixture", repo: "project", state: "passing", lifecycleState: "open",
          headRefName: "feature/upper", headSha: nextTrunk, baseRefName: "feature/model", url: "https://github.com/fixture/project/pull/2",
        } as const;
        const unnumberedCatalog = {
          schemaVersion: 1, repository, stacks: [{
            trunk: { branch: "main", head: base },
            branches: [{ branch: "feature/model", head, base }, { branch: "feature/upper", head: nextTrunk, base: head }],
          }],
        };
        await writeFile(catalogPath, JSON.stringify(unnumberedCatalog));
        const parentPr = {
          ...childPr, number: 1, baseRefName: "main", headRefName: "feature/model", headSha: head,
          url: "https://github.com/fixture/project/pull/1",
        };
        const reusedName = { ...parentPr, number: 3, lifecycleState: "merged" as const, headSha: base };
        for (const lifecycleState of ["open", "merged"] as const) {
          const observed = await reader.read(threads, [reusedName, { ...parentPr, lifecycleState }, childPr]);
          expect(observed.stacks[0]?.layers[0]?.pullRequest).toEqual({ number: 1, lifecycleState });
          if (lifecycleState === "merged") {
            expect(observed.stacks[0]?.layers[1]).toMatchObject({ health: "parent_merged", unsettled: "needs sync" });
            expect(observed.stacks[0]?.layers[1]?.heldBy).toBeUndefined();
          }
        }
        await writeFile(catalogPath, JSON.stringify({
          schemaVersion: 1, repository, stacks: [{
            trunk: { branch: "main", head: base },
            branches: [
              { branch: "feature/model", head, base, pullRequest: { number: 1, merged: true } },
              { branch: "feature/upper", head: nextTrunk, base: head, pullRequest: { number: 2 } },
            ],
          }],
        }));
        const retargeted = await reader.read(threads, [{
          number: 2, provider: "github.com", org: "fixture", repo: "project", state: "passing", lifecycleState: "open",
          headRefName: "feature/upper", headSha: nextTrunk, baseRefName: "main", url: "https://github.com/fixture/project/pull/2",
        }]);
        expect(retargeted.stacks[0]?.layers[1]).toMatchObject({ parent: "feature/model", activeBase: "main", health: "parent_merged" });
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
