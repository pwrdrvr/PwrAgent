import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ForgeReadError } from "../pr-status/forge-tool-contract";
import { runGithubAsyncMerge } from "../pr-status/github-async-merge";
import { GithubPrFetcher } from "../pr-status/github-pr-fetcher";
import { assertGithubStackMergeAllowed } from "../stacks/stack-merge-guard";

/**
 * GitHub's own stacked pull requests: the REST pull request carries `stack`,
 * `/stacks/{number}` lists its layers bottom first, and GitHub merges a layer
 * only through its asynchronous merge, landing every open layer below it too.
 */

const repository = { provider: "github" as const, host: "github.com", owner: "fixture", repo: "project" };
const STACK = 4402;
const headSha = "c".repeat(40);
const REFUSAL = "GraphQL: This pull request is part of a stack and must be merged using the asynchronous merge REST API."
  + " For more information, see https://docs.github.com/rest/pulls/pulls#merge-a-pull-request-asynchronously (mergePullRequest)";

type LayerState = "open" | "merged" | "closed";
const layerState = fc.constantFrom<LayerState>("open", "merged", "closed");

/** A stack of layers numbered from 101, with the candidate at `index`. */
const stackShape = fc.array(layerState, { minLength: 1, maxLength: 5 }).chain((states) =>
  fc.record({ states: fc.constant(states), index: fc.nat({ max: states.length - 1 }) }));

function stackRoutes(states: readonly LayerState[], index: number) {
  const number = 101 + index;
  const pull = {
    number, state: "open", created_at: "2026-11-25T10:00:00Z",
    head: { ref: `layer-${index}`, sha: headSha, repo: { full_name: "fixture/project" } },
    base: { ref: "main", repo: { default_branch: "main" } },
    stack: { id: 9, number: STACK, position: index + 1, size: states.length, base: { ref: "main", sha: "d".repeat(40) } },
  };
  const layers = states.map((state, at) => ({
    number: 101 + at,
    state: at === index ? "open" : state === "open" ? "open" : "closed",
    merged_at: at !== index && state === "merged" ? "2026-11-25T11:00:00Z" : null,
  }));
  return { number, pull, layers };
}

const history = { repository: { pullRequest: {
  baseRefName: "main", headRefOid: headSha, timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: [] },
} } };

describe("a pull request in a GitHub stack", () => {
  it("merges only once every layer below it has merged or closed, and names the open ones", async () => {
    await fc.assert(fc.asyncProperty(stackShape, async ({ states, index }) => {
      const { number, pull, layers } = stackRoutes(states, index);
      const lower: number[] = [];
      const guard = assertGithubStackMergeAllowed(repository, number, [], async (route) => {
        if (route === `/pulls/${number}`) return pull;
        if (route === `/stacks/${STACK}`) return { number: STACK, pull_requests: layers };
        throw new Error(`unexpected read ${route}`);
      }, async () => history, (layer) => lower.push(layer));
      const open = states.slice(0, index).flatMap((state, at) => state === "open" ? [101 + at] : []);
      if (open.length) {
        const error = await guard.then(() => undefined, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(ForgeReadError);
        expect(error).toMatchObject({ code: "stack_parent_open" });
        for (const layer of open) expect((error as Error).message).toContain(`#${layer}`);
      } else {
        await expect(guard).resolves.toBe("main");
      }
      expect(lower.slice(0, index)).toEqual(states.slice(0, index).map((_, at) => 101 + at));
    }), { examples: [[{ states: ["merged", "open"], index: 1 }], [{ states: ["open", "open"], index: 1 }]] });
  });

  it("refuses to merge when GitHub cannot list the stack", async () => {
    const { number, pull } = stackRoutes(["merged", "open"], 1);
    const guard = assertGithubStackMergeAllowed(repository, number, [], async (route) => {
      if (route === `/pulls/${number}`) return pull;
      throw new ForgeReadError("not_found", "GitHub returned HTTP 404.");
    }, async () => history);
    await expect(guard).rejects.toMatchObject({ code: "stack_parent_open" });
  });
});

describe("GitHub's asynchronous merge", () => {
  type Status = "pending" | "merged" | "enqueued" | "failed";
  const terminal = fc.constantFrom<Status>("merged", "enqueued", "failed");

  it("follows the merge request until GitHub settles it or the wait runs out", async () => {
    await fc.assert(fc.asyncProperty(
      fc.nat({ max: 8 }), fc.option(terminal, { nil: undefined }), fc.integer({ min: 1, max: 10 }),
      async (pendingReads, settled, budgetPolls) => {
        // The PUT answers pending, then `pendingReads` polls do, then `settled` (or pending forever).
        const answers: Status[] = ["pending", ...Array.from({ length: pendingReads }, () => "pending" as const), ...(settled ? [settled] : [])];
        let clock = 0;
        const requests: string[] = [];
        const result = runGithubAsyncMerge({
          number: 7, method: "squash", sha: headSha,
          pollMs: 1_000, deadlineMs: budgetPolls * 1_000,
          now: () => clock, sleep: async (ms) => { clock += ms; },
          isAlreadyRequested: () => false,
          request: async (method, route) => {
            requests.push(`${method} ${route}`);
            const status = answers[Math.min(requests.length - 1, answers.length - 1)]!;
            return { status, details: status === "failed" ? { message: "Head branch was modified." } : { uuid: "req-1", sha: "e".repeat(40) } };
          },
        });
        const reached = settled !== undefined && pendingReads + 1 <= budgetPolls;
        if (reached && settled === "failed") {
          await expect(result).rejects.toThrow("GitHub could not merge #7: Head branch was modified.");
        } else if (reached) {
          await expect(result).resolves.toMatchObject({ status: settled });
        } else {
          await expect(result).resolves.toEqual({ status: "pending", uuid: "req-1" });
        }
        expect(requests[0]).toBe("PUT /pulls/7/merge-async");
        expect(requests.slice(1).every((request) => request === "GET /pulls/7/merge-async/req-1")).toBe(true);
        expect(requests.length - 1).toBeLessThanOrEqual(budgetPolls);
      },
    ));
  });

  it("reports a merge GitHub is already running, not a failure", async () => {
    const conflict = new ForgeReadError("conflict", "GitHub returned HTTP 409: a merge request is already enqueued");
    await expect(runGithubAsyncMerge({
      number: 7, method: "squash",
      request: async () => { throw conflict; },
      isAlreadyRequested: (error) => error === conflict,
    })).resolves.toEqual({ status: "pending", alreadyRequested: true });
  });
});

describe("a card merge of a stacked pull request", () => {
  /** The operator's gh, answering the reads a stacked merge makes; `pr merge` is refused as GitHub refuses it. */
  function fetcherFor(states: readonly LayerState[], index: number, runs: string[][]) {
    const { pull, layers } = stackRoutes(states, index);
    return new GithubPrFetcher({
      graphqlClient: { fetchPullRequests: async () => [], fetchPullRequestsForBranches: async () => new Map() } as never,
      discoverGhCommands: async () => ({ selectedCommand: "/fixture/gh" }) as never,
      runGhCommand: async (_command, args) => {
        runs.push(args);
        if (args[0] === "pr" && args[1] === "view") return { stdout: `https://github.com/fixture/project/pull/${pull.number}\n` };
        if (args[0] === "pr" && args[1] === "merge") throw Object.assign(new Error("exit 1"), { stderr: `${REFUSAL}\n` });
        if (args[1] === "graphql") return { stdout: JSON.stringify({ data: history }) };
        const route = args.find((arg) => arg.startsWith("repos/"))!;
        if (route.endsWith(`/pulls/${pull.number}`)) return { stdout: JSON.stringify(pull) };
        if (route.endsWith(`/stacks/${STACK}`)) return { stdout: JSON.stringify({ number: STACK, pull_requests: layers }) };
        if (args.includes("PUT") && route.endsWith(`/pulls/${pull.number}/merge-async`)) {
          return { stdout: JSON.stringify({ status: "merged", details: { sha: "e".repeat(40) } }) };
        }
        throw new Error(`unexpected gh ${args.join(" ")}`);
      },
    });
  }

  it.each([true, false])("merges through GitHub's asynchronous merge, with the stack order checked first: %s", async (checkStackOrder) => {
    const runs: string[][] = [];
    const url = "https://github.com/fixture/project/pull/102";
    const result = await fetcherFor(["merged", "open"], 1, runs).mergePullRequest({ pullRequest: url, method: "squash", checkStackOrder });
    expect(result).toMatchObject({ mergedUrl: url });
    expect(runs).toContainEqual(["api", "--hostname", "github.com", "-X", "PUT", "repos/fixture/project/pulls/102/merge-async",
      "-f", "merge_method=squash", "-f", `sha=${headSha}`]);
    // The order check already knew it was stacked: gh pr merge never ran.
    if (checkStackOrder) expect(runs.some((args) => args[0] === "pr" && args[1] === "merge")).toBe(false);
  });

  it("merges a bottom layer without reading its stack, and says the layer above is still open", async () => {
    const runs: string[][] = [];
    const url = "https://github.com/fixture/project/pull/101";
    const result = await fetcherFor(["open", "open"], 0, runs).mergePullRequest({ pullRequest: url, method: "squash", checkStackOrder: true });
    expect(result).toMatchObject({ mergedUrl: url, summary: expect.stringContaining("#101 was layer 1 of 2 in a GitHub stack: the layer above it is still open") });
    expect(runs.some((args) => args.some((arg) => arg.includes("/stacks/")))).toBe(false);
  });

  it.each([true, false])("never lands an open lower layer with it, with the stack order checked first: %s", async (checkStackOrder) => {
    const runs: string[][] = [];
    const merge = fetcherFor(["open", "open"], 1, runs)
      .mergePullRequest({ pullRequest: "https://github.com/fixture/project/pull/102", method: "squash", checkStackOrder });
    await expect(merge).rejects.toMatchObject({ code: "stack_parent_open", message: expect.stringContaining("#101") });
    expect(runs.some((args) => args.includes("PUT"))).toBe(false);
  });
});
