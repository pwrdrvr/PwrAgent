import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { probeWorktreeWorkingState } from "../app-server/git-working-state-service";
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
};

async function probeFork({
  parentRemote, branch, behind, parentUrl, reverseRefs,
  parentRefPresent = true, baseOnParent = false, parentLookupFails = false, partialClone = false,
}: ForkCheckout) {
  const parentRef = `${parentRemote}/${branch}`;
  const forkRef = `origin/${branch}`;
  const refs = [
    `${forkRef}\0${"a".repeat(40)}\x000 1`,
    `upstream/${branch}\0${"b".repeat(40)}\x001001 1`,
    `mirror/${branch}\0${"c".repeat(40)}\x001002 1`,
    ...(parentRefPresent ? [`${parentRef}\0${"d".repeat(40)}\0${behind} 1`] : []),
  ];
  const remotes = [
    "mirror\thttps://gitlab.com/project/engine.git (fetch)",
    `origin\thttps://github.com/contributor/engine.git (fetch)${partialClone ? " [blob:none]" : ""}`,
    `${parentRemote}\t${parentUrl} (fetch)`,
    "upstream\thttps://github.com/unrelated/engine.git (fetch)",
    "upstream\thttps://github.com/project/engine.git (push)",
  ];
  const calls: string[][] = [];
  const options = {
    runGit: async (_cwd: string, args: string[]) => {
      calls.push(args);
      switch (args[1]) {
        case "diff":
        case "status":
        case "config": return "";
        case "remote": return args.includes("--verbose")
          ? remotes.join("\n") : `mirror\norigin\n${parentRemote}\nupstream\n`;
        case "rev-parse": return args.includes("--verify") ? "e".repeat(40) : "feature/fork-drift";
        case "symbolic-ref": return baseOnParent ? parentRef : forkRef;
        case "for-each-ref": return (reverseRefs ? refs.reverse() : refs).join("\n");
        case "merge-base": return "a".repeat(40);
        case "rev-list": return "0";
        default: throw new Error(`Unexpected Git invocation ${args.join(" ")}`);
      }
    },
    resolveRepositoryParent: async (fork: { host: string; owner: string; repo: string }) => {
      expect(fork).toEqual({ host: "github.com", owner: "contributor", repo: "engine" });
      if (parentLookupFails) throw new Error("GitHub unavailable");
      return { host: "github.com", owner: "Project", repo: "Engine" };
    },
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
    expect(await probeFork({ ...renamedParent, baseOnParent: true })).not.toHaveProperty("upstreamBranch");
    expect(await probeFork({ ...renamedParent, parentRefPresent: false })).not.toHaveProperty("upstreamBranch");
  });
});
