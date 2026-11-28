import fc from "fast-check";
import { expect, it } from "vitest";
import { inferPullRequestStacks } from "@pwragent/shared/stacks/stack-status";
import { GithubPrFetcher } from "../pr-status/github-pr-fetcher";

const trunk = "main";
const parent = "lower";
const child = "upper";
const url = "https://github.com/fixture/detach-test/pull/2";
const timestamp = (step: number) => new Date(Date.UTC(2026, 0, 1, 0, step)).toISOString();

type Change = "keep" | "rebase" | "rebase-with-parent";
type Scenario = {
  change: Change;
  parentMove: "keep" | "advance" | "rewrite";
  trunkMoves: number;
  rewriteBeforeRetarget: boolean;
  extraChildCommits: number;
  rewriteAgain?: boolean;
  reintroduceParent?: boolean;
  omitHistory?: boolean;
  omitRange?: boolean;
  pushAtMerge?: boolean;
};

async function replay(scenario: Scenario) {
  // The GitHub mock implements commit reachability. The expected merge decision
  // comes from the modeled operations, independently of the REST response.
  const graph = new Map<string, readonly string[]>();
  function commit(...parents: string[]) {
    const sha = (graph.size + 1).toString(16).padStart(40, "0");
    graph.set(sha, parents);
    return sha;
  }
  function reachable(head: string) {
    const seen = new Set<string>([head]);
    for (const sha of seen) for (const ancestor of graph.get(sha)!) seen.add(ancestor);
    return seen;
  }
  const fork = commit();
  const originalParent = commit(fork);
  const originalChild = commit(originalParent);
  let target = fork;
  for (let index = 0; index < scenario.trunkMoves; index++) target = commit(target);
  const parentHead = scenario.parentMove === "rewrite" ? commit(target)
    : scenario.parentMove === "advance" ? commit(originalParent) : originalParent;
  let base = parent;
  let head = originalChild;
  const history: Array<{ previousRefName: string; currentRefName: string; createdAt: string }> = [];
  const rewrites: Array<{ beforeCommit: { oid: string }; createdAt: string }> = [];
  const routes: string[] = [];
  const mergedHeads: string[] = [];

  const fetcher = new GithubPrFetcher({
    graphqlClient: { fetchPullRequests: async () => [], fetchPullRequestsForBranches: async () => new Map() } as never,
    discoverGhCommands: async () => ({ selectedCommand: "/fixture/gh" }) as never,
    runGhCommand: async (_command, args) => {
      const json = (value: unknown) => ({ stdout: JSON.stringify(value) });
      if (args[0] === "pr" && args[1] === "merge") {
        if (scenario.pushAtMerge) head = commit(head, originalParent);
        const match = args.indexOf("--match-head-commit");
        if (match !== -1 && args[match + 1] !== head) throw new Error("GitHub refused to merge a changed head.");
        mergedHeads.push(head);
        return { stdout: "" };
      }
      if (args[0] !== "api") throw new Error(`Unexpected command ${args.join(" ")}`);
      if (args[1] === "graphql") {
        routes.push("graphql");
        return json({ data: { repository: { pullRequest: {
          baseRefName: base, headRefOid: head,
          timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: history },
          headRewrites: { pageInfo: { hasPreviousPage: scenario.omitHistory ?? false }, nodes: rewrites },
        } } } });
      }
      const route = args[3]!.replace("repos/fixture/detach-test", "");
      routes.push(route);
      if (route === "/pulls/2") return json({
        number: 2, created_at: timestamp(2), head: { ref: child, sha: head },
        base: { ref: base, sha: base === trunk ? target : parentHead, repo: { default_branch: trunk } },
      });
      if (route.startsWith("/pulls?") && new URLSearchParams(route.split("?")[1]).get("head") === `fixture:${parent}`) {
        return json([{ number: 1, state: "open", created_at: timestamp(1), base: { ref: trunk },
          head: { ref: parent, sha: parentHead, repo: { full_name: "fixture/detach-test" } } }]);
      }
      if (route.startsWith("/compare/")) {
        const [range, query] = route.slice(9).split("?");
        const [from, to] = range!.split("...") as [string, string];
        const before = reachable(from);
        const after = [...reachable(to)];
        const ahead = after.filter((sha) => !before.has(sha)).reverse();
        const pageSize = Number(new URLSearchParams(query).get("per_page"));
        return json({ merge_base_commit: { sha: after.find((sha) => before.has(sha)) },
          ahead_by: ahead.length, commits: ahead.slice(0, pageSize).map((sha) => ({ sha })) });
      }
      throw new Error(`Unexpected route ${route}`);
    },
  });
  const visible = () => inferPullRequestStacks([
    { number: 1, lifecycleState: "open", headRefName: parent, baseRefName: trunk },
    { number: 2, lifecycleState: "open", headRefName: child, baseRefName: base },
  ], new Set()).length > 0;

  expect(visible()).toBe(true);
  function rewrite(step: number) {
    if (scenario.change === "keep") return;
    rewrites.push({ beforeCommit: { oid: head }, createdAt: timestamp(step) });
    if (scenario.change === "rebase-with-parent") {
      // Retain the original parent but omit its newer tip (or a rewritten tip).
      head = commit(target, originalParent);
    } else {
      head = commit(target);
    }
  }
  if (scenario.rewriteBeforeRetarget) rewrite(3);
  history.push({ previousRefName: base, currentRefName: trunk, createdAt: timestamp(4) });
  base = trunk;
  if (!scenario.rewriteBeforeRetarget) rewrite(5);
  if (scenario.rewriteAgain) rewrite(6);
  for (let index = 0; index < scenario.extraChildCommits; index++) head = commit(head);
  if (scenario.reintroduceParent) head = commit(head, originalParent);
  expect(visible()).toBe(false);
  const checkedHead = head;

  const result = await fetcher.mergePullRequest({ pullRequest: url, method: "squash", checkStackOrder: true })
    .then((merged) => ({ merged: merged.mergedUrl }), (error: unknown) => ({ error }));

  // A detached head needs positive evidence, including the comparison page.
  const detached = scenario.change === "rebase" && !scenario.omitHistory && !scenario.reintroduceParent
    && !scenario.omitRange;
  if (detached && !scenario.pushAtMerge) {
    expect(result).toEqual({ merged: url });
    expect(mergedHeads).toEqual([checkedHead]);
  } else {
    expect(result).toMatchObject({ error: scenario.pushAtMerge
      ? { message: expect.stringContaining("changed head") } : { code: "stack_parent_open" } });
    expect(mergedHeads).toEqual([]);
  }
  return routes;
}

const detached: Scenario = {
  change: "rebase", parentMove: "advance", trunkMoves: 1, rewriteBeforeRetarget: false, extraChildCommits: 1,
};

it("merges a former layer after it is rebuilt on trunk and its head advances", async () => {
  const routes = await replay(detached);
  expect(routes).toHaveLength(6);
  expect(new Set(routes).size).toBe(6);
});

it("merges a former layer rebuilt at the original trunk tip", async () => {
  await replay({ ...detached, parentMove: "keep", trunkMoves: 0, extraChildCommits: 0 });
});

it("keeps holding a former layer whose rewrite retains an older parent commit", async () => {
  await replay({ ...detached, change: "rebase-with-parent", parentMove: "rewrite" });
});

it("keeps holding when a later head brings back a parent dropped two rewrites ago", async () => {
  await replay({ ...detached, parentMove: "rewrite", rewriteAgain: true, reintroduceParent: true });
});

it("keeps holding when the bounded page cannot prove that the old parent commits are gone", async () => {
  await replay({ ...detached, extraChildCommits: 64, omitRange: true });
});

it("does not merge a different head from the one proved detached", async () => {
  await replay({ ...detached, pushAtMerge: true });
});

it("checks detached layers against a commit graph as their base and head change", async () => {
  const scenario = fc.record({
    change: fc.constantFrom("keep" as const, "rebase" as const, "rebase-with-parent" as const),
    parentMove: fc.constantFrom("keep" as const, "advance" as const, "rewrite" as const), trunkMoves: fc.nat({ max: 16 }),
    rewriteBeforeRetarget: fc.boolean(), extraChildCommits: fc.nat({ max: 4 }),
    rewriteAgain: fc.boolean(), omitHistory: fc.boolean(), reintroduceParent: fc.boolean(),
  });
  await fc.assert(fc.asyncProperty(scenario, async (input) => {
    await replay(input);
  }), { numRuns: Number(process.env.MBT_RUNS ?? 60) });
});
