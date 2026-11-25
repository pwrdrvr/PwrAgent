import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { probeWorktreeWorkingState } from "../app-server/git-working-state-service";
import { createGitHubRepositoryParentLookup, type GitHubRepositoryParentLookup } from "../pr-status/github-repository-parent";
import gitSubprocessBudgets from "./fixtures/git-subprocess-budgets.json";

type ForkCheckout = {
  parentRemote: string;
  branch: string;
  behind: number;
  parentUrl: string;
  reverseRefs?: boolean;
  parentRefPresent?: boolean;
  baseOnParent?: boolean;
  parentLookupFails?: boolean;
  partialClone?: boolean;
  resolveRepositoryParent?: GitHubRepositoryParentLookup;
};

async function probeFork({
  parentRemote, branch, behind, parentUrl, reverseRefs,
  parentRefPresent = true, baseOnParent = false, parentLookupFails = false, partialClone = false,
  resolveRepositoryParent,
}: ForkCheckout) {
  const parentRef = `refs/remotes/${parentRemote}/${branch}`;
  const forkRef = `refs/remotes/origin/${branch}`;
  const distinctUpstream = parentRemote !== "upstream";
  const refs = [
    `${forkRef}\0${"a".repeat(40)}\x000 1`,
    ...(distinctUpstream ? [`refs/remotes/upstream/${branch}\0${"b".repeat(40)}\x001001 1`] : []),
    `refs/remotes/mirror/${branch}\0${"c".repeat(40)}\x001002 1`,
    ...(parentRefPresent ? [`${parentRef}\0${"d".repeat(40)}\0${behind} 1`] : []),
  ];
  const remotes = [
    "mirror\thttps://gitlab.com/project/engine.git (fetch)",
    `origin\thttps://github.com/contributor/engine.git (fetch)${partialClone ? " [blob:none]" : ""}`,
    `${parentRemote}\t${parentUrl} (fetch)`,
    ...(distinctUpstream ? [
      "upstream\thttps://github.com/unrelated/engine.git (fetch)",
      "upstream\thttps://github.com/project/engine.git (push)",
    ] : []),
  ];
  const calls: string[][] = [];
  const options = {
    runGit: async (_cwd: string, args: string[]) => {
      calls.push(args);
      switch (args[1]) {
        case "diff":
        case "status": return "";
        case "config": return baseOnParent ? parentRef : "";
        case "remote": return remotes.join("\n");
        case "rev-parse": return args.includes("--verify") ? "e".repeat(40) : "feature/fork-drift";
        case "symbolic-ref": return forkRef;
        case "for-each-ref": return (reverseRefs ? refs.reverse() : refs).join("\n");
        case "merge-base": return "a".repeat(40);
        case "rev-list": return "0";
        default: throw new Error(`Unexpected Git invocation ${args.join(" ")}`);
      }
    },
    resolveRepositoryParent: resolveRepositoryParent ?? ((fork) => {
      if (parentLookupFails) throw new Error("GitHub unavailable");
      return fork.owner === "contributor" ? { host: "github.com", owner: "Project", repo: "Engine" } : undefined;
    }),
  };
  const state = await probeWorktreeWorkingState("/repo/wt", options);
  expect(state).toMatchObject({ baseBranch: branch, baseBehindCommitCount: baseOnParent ? behind : 0 });
  expect(calls).toHaveLength(gitSubprocessBudgets.workingStateProbe.maxGitCommands);
  return state;
}

describe("working-state upstream drift", () => {
  const renamedParent = {
    parentRemote: "project-a",
    branch: "main",
    behind: 0,
    parentUrl: "https://github.com/Project/Engine.git",
  };

  it("uses project-a/main at zero behind when upstream/main is a different repository", async () => {
    expect(await probeFork(renamedParent)).toMatchObject({
      upstreamBranch: "project-a/main",
      upstreamBehindCommitCount: 0,
    });
  });

  it("returns local counts while the forge request is still pending", async () => {
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const resolveRepositoryParent = createGitHubRepositoryParentLookup(async () => {
      await gate;
      return { data: { repository: { isFork: true, parent: { nameWithOwner: "Project/Engine" } } } };
    });
    const probe = () => probeFork({ ...renamedParent, resolveRepositoryParent });
    const turn = () => new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined)));
    try {
      expect(await Promise.race([probe(), turn()])).toMatchObject({
        baseBehindCommitCount: 0, unpushedCommits: 0,
      });
    } finally {
      unblock();
    }
    await turn();
    expect(await probe()).toMatchObject({ upstreamBranch: "project-a/main", upstreamBehindCommitCount: 0 });
  });

  it("recognizes GitHub's SSH-over-443 fetch URL", async () => {
    expect(await probeFork({
      ...renamedParent, parentUrl: "ssh://git@ssh.github.com:443/Project/Engine.git",
    })).toMatchObject({ upstreamBranch: "project-a/main", upstreamBehindCommitCount: 0 });
  });

  it("reports the parent's count for any remote name, fetch URL spelling, and ref order", async () => {
    // The forge owns the fork relationship. Remote names, push destinations,
    // and a repository with the same path on another host cannot establish it.
    await fc.assert(fc.asyncProperty(
      fc.record({
        parentRemote: fc.tuple(fc.constantFrom("-", "/"), fc.stringMatching(/^[a-z]{1,8}$/))
          .map(([separator, name]) => `project${separator}${name}`),
        branch: fc.constantFrom("main", "master"),
        behind: fc.nat(1000),
        parentUrl: fc.constantFrom(
          "https://github.com/Project/Engine.git",
          "git@github.com:project/engine.git",
          "ssh://git@GitHub.com/PROJECT/engine",
          "ssh://git@ssh.github.com:443/Project/Engine.git",
        ),
        reverseRefs: fc.boolean(),
        partialClone: fc.boolean(),
      }),
      async (checkout) => {
        expect(await probeFork(checkout)).toMatchObject({
          upstreamBranch: `${checkout.parentRemote}/${checkout.branch}`,
          upstreamBehindCommitCount: checkout.behind,
        });
      },
    ));
  });

  it("falls back to the conventional remote when lookup fails or no fetch URL matches", async () => {
    const expected = { upstreamBranch: "upstream/main", upstreamBehindCommitCount: 1001 };
    expect(await probeFork({ ...renamedParent, parentLookupFails: true })).toMatchObject(expected);
    expect(await probeFork({ ...renamedParent, parentUrl: "https://github.com/other/engine" })).toMatchObject(expected);
  });

  it("omits a duplicate or unavailable parent comparison", async () => {
    expect(await probeFork({ ...renamedParent, parentRemote: "upstream", baseOnParent: true })).not.toHaveProperty("upstreamBranch");
    expect(await probeFork({ ...renamedParent, parentRefPresent: false })).not.toHaveProperty("upstreamBranch");
  });
});

describe("upstream drift against Git tracking refs", () => {
  it.each([
    { forkRemote: "origin", parentRemote: "project", branch: "next" },
    { forkRemote: "contributor/fork", parentRemote: "origin", branch: "main" },
  ])("compares $forkRemote/$branch with $parentRemote/$branch", async ({ forkRemote, parentRemote, branch }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-fork-drift-"));
    const exec = promisify(execFile);
    const git = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
    try {
      await git("init", "-b", "feature");
      await git("config", "user.name", "PwrAgent Test");
      await git("config", "user.email", "test@example.com");
      await git("commit", "--allow-empty", "-m", "fork tip");
      const forkTip = await git("rev-parse", "HEAD");
      await git("commit", "--allow-empty", "-m", "parent tip");
      const parentRef = `refs/remotes/${parentRemote}/${branch}`;
      await git("update-ref", parentRef, await git("rev-parse", "HEAD"));
      await git("reset", "--hard", forkTip);
      await git("remote", "add", forkRemote, "https://github.com/contributor/engine");
      await git("remote", "add", parentRemote, "https://github.com/project/engine");
      const forkRef = `refs/remotes/${forkRemote}/${branch}`;
      await git("update-ref", forkRef, forkTip);
      if (forkRemote === "origin") {
        await git("symbolic-ref", "refs/remotes/origin/HEAD", forkRef);
        // A local branch with the same abbreviated name cannot stand in for
        // the tracking ref selected by the remote's symbolic HEAD.
        await git("update-ref", `refs/heads/origin/${branch}`, forkTip);
      } else {
        await git("config", "branch.feature.vscode-merge-base", `${forkRemote}/${branch}`);
      }

      const expected = Number(await git("rev-list", "--count", `HEAD..${parentRef}`));
      const result = await probeWorktreeWorkingState(root, {
        runGit: async (_cwd, args) => git(...args),
        resolveRepositoryParent: (repository) => repository.owner === "contributor"
          ? { host: "github.com", owner: "project", repo: "engine" } : undefined,
      });
      expect(result).toMatchObject({
        baseBehindCommitCount: 0,
        upstreamBranch: `${parentRemote}/${branch}`,
        upstreamBehindCommitCount: expected,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
