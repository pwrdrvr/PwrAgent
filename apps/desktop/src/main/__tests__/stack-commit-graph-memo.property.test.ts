import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { StackReader } from "../stacks/stack-reader";
import { isolateProcessGitEnvironment, runIsolatedGitSync } from "./helpers/isolated-git";

beforeEach(() => onTestFinished(isolateProcessGitEnvironment()));

const git = (cwd: string, ...args: string[]) => runIsolatedGitSync(cwd, args).trim();
const commit = (cwd: string, message: string) =>
  git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-q", "-m", message);

/** A gh-stack of `height` layers, each branch checked out in its own worktree with its own thread and PR. */
async function stackFixture(height: number, cataloged: boolean) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-commit-graph-")));
  const root = path.join(base, "repo");
  git(base, "init", "-q", "-b", "main", root);
  commit(root, "trunk");
  git(root, "remote", "add", "origin", "https://github.com/fixture/graph.git");
  const heads = [git(root, "rev-parse", "HEAD")];
  for (let index = 1; index <= height; index++) {
    git(root, "checkout", "-q", "-b", `s${index}`);
    commit(root, `layer ${index}`);
    heads.push(git(root, "rev-parse", "HEAD"));
    git(root, "update-ref", `refs/remotes/origin/s${index}`, heads[index]!);
    git(root, "config", `branch.s${index}.remote`, "origin");
    git(root, "config", `branch.s${index}.merge`, `refs/heads/s${index}`);
  }
  git(root, "checkout", "-q", "main");
  const worktrees: string[] = [];
  for (let index = 1; index <= height; index++) {
    git(root, "worktree", "add", "-q", path.join(base, `wt${index}`), `s${index}`);
    worktrees.push(await realpath(path.join(base, `wt${index}`)));
  }
  const writeCatalog = async () => {
    const tips = ["main", ...worktrees.map((_, index) => `s${index + 1}`)].map((branch) => git(root, "rev-parse", branch));
    await writeFile(path.join(root, ".git", "gh-stack"), JSON.stringify({
      schemaVersion: 1, repository: "github.com:fixture/graph",
      stacks: [{ trunk: { branch: "main", head: tips[0] }, branches: worktrees.map((_, index) => ({
        branch: `s${index + 1}`, head: tips[index + 1], base: tips[index], pullRequest: { number: 10 + index },
      })) }],
    }));
  };
  if (cataloged) await writeCatalog();
  const rows = worktrees.map((worktree, index) => {
    const pr: PrSummary = {
      provider: "github.com", org: "fixture", repo: "graph", number: 10 + index, state: "passing", lifecycleState: "open",
      url: `https://github.com/fixture/graph/pull/${10 + index}`, headRefName: `s${index + 1}`,
      baseRefName: index ? `s${index}` : "main", headSha: heads[index + 1], baseSha: heads[index],
      linkedDirectoryPaths: [worktree],
    };
    return {
      id: `layer-${index + 1}`, source: "codex" as const, title: `Layer ${index + 1}`, prs: [pr],
      linkedDirectories: [{ id: worktree, label: "graph", kind: "local" as const, path: worktree }],
    };
  });
  return { base, root, worktrees, rows, writeCatalog };
}

/** Git starts for stack status, by command, while `run` executes. */
async function stackStatusStarts(run: () => Promise<unknown>): Promise<string[]> {
  const original = gitSubprocessDiagnostics.startGit;
  const starts: string[] = [];
  const spy = vi.spyOn(gitSubprocessDiagnostics, "startGit").mockImplementation((cwd, args, purpose) => {
    if (purpose === "stack-status") starts.push(args[0]!);
    return original.call(gitSubprocessDiagnostics, cwd, args, purpose);
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return starts;
}

type Step =
  | { kind: "advance" | "rewind" | "push" | "restack"; layer: number }
  | { kind: "advance-trunk" | "sync-catalog" };

const histories: Array<{ name: string; height: number; cataloged: boolean; steps: Step[] }> = [
  { name: "a middle layer restacks against trunk", height: 3, cataloged: true,
    steps: [{ kind: "restack", layer: 2 }] },
  { name: "a cataloged layer advances, updates its catalog and rewinds", height: 2, cataloged: true,
    steps: [{ kind: "advance", layer: 1 }, { kind: "sync-catalog" }, { kind: "rewind", layer: 1 }] },
  { name: "a top layer advances, pushes and restacks", height: 2, cataloged: true,
    steps: [{ kind: "advance", layer: 2 }, { kind: "push", layer: 2 }, { kind: "restack", layer: 2 }] },
  { name: "uncataloged history changes at trunk and both layers", height: 2, cataloged: false,
    steps: [{ kind: "advance-trunk" }, { kind: "advance", layer: 1 }, { kind: "rewind", layer: 2 }] },
];
it.for(histories)(
  "matches a fresh reader after $name", { timeout: 120_000 }, async ({ height, cataloged, steps }) => {
    const fixture = await stackFixture(height, cataloged);
    try {
      const reader = new StackReader();
      const project = async (from: StackReader) => (await from.read(fixture.rows, [])).stacks;
      expect(await project(reader)).toEqual(await project(new StackReader()));
      for (const change of steps) {
        const worktree = "layer" in change ? fixture.worktrees[change.layer - 1]! : fixture.root;
        const branch = "layer" in change ? `s${change.layer}` : "main";
        if (change.kind === "advance" || change.kind === "advance-trunk") commit(worktree, change.kind);
        else if (change.kind === "rewind") {
          // The root commit has no parent to rewind to.
          if (git(worktree, "rev-list", "--count", "HEAD") !== "1") git(worktree, "reset", "-q", "--hard", "HEAD~1");
        }
        else if (change.kind === "push") git(worktree, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
        else if (change.kind === "restack") {
          git(worktree, "reset", "-q", "--hard", "main");
          commit(worktree, "restacked");
        } else if (cataloged) await fixture.writeCatalog();
        // The oracle has never answered a commit-graph question before.
        expect(await project(reader)).toEqual(await project(new StackReader()));
      }
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  },
);

it.for([
  { height: 1, cataloged: false },
  { height: 1, cataloged: true },
  { height: 4, cataloged: false },
  { height: 4, cataloged: true },
])("reuses warm clone status on background reads and memoizes commit-graph answers on scoped reads for height $height, cataloged=$cataloged", { timeout: 120_000 }, async ({ height, cataloged }) => {
  const fixture = await stackFixture(height, cataloged);
  try {
    const reader = new StackReader();
    const first = await reader.read(fixture.rows, []);
    expect(first.stacks).toHaveLength(cataloged || height > 1 ? 1 : 0);
    const backgroundStarts = await stackStatusStarts(() => reader.read(fixture.rows, []));
    expect(backgroundStarts).toEqual([]);
    const scopedStarts = await stackStatusStarts(() => reader.read(fixture.rows, [], [fixture.root]));
    expect(scopedStarts.toSorted()).toEqual(first.stacks.length ? ["for-each-ref", "worktree"] : []);
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});
