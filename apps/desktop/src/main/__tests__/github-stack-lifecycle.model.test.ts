import fc from "fast-check";
import { expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { mapGraphqlPrNode } from "../pr-status/github-graphql-client";
import { GithubPrFetcher } from "../pr-status/github-pr-fetcher";
import {
  forgetGithubForgeStacks,
  GithubForgeStackDiscovery,
  githubForgeStackRepository,
  readGithubForgeStack,
} from "../stacks/github-forge-stacks";

/**
 * Model-based test of GitHub's own stacked pull requests against what
 * PwrAgent knows and does. The model is GitHub, as documented and as #4387 /
 * #4393 showed on 2026-11-25:
 *
 * - a stack forms over a chain of open pull requests, each based on the head
 *   of the one below, at any time and outside PwrAgent;
 * - merging the bottom layer retargets the layer above to trunk, and that
 *   layer stays in the stack;
 * - `gh pr merge` (the synchronous merge) refuses every layer of a stack;
 * - the asynchronous merge of a layer lands every open layer below it too.
 *
 * Against it run the real poll mapping (`mapGraphqlPrNode`) and the real card
 * merge (`GithubPrFetcher.mergePullRequest`) over a fake `gh` that answers
 * from the model.
 */

const OWNER = "fixture";
const REPO = "project";
const TRUNK = "main";
const START = Date.parse("2026-11-25T00:00:00Z");
const REFUSAL = "GraphQL: This pull request is part of a stack and must be merged using the asynchronous merge REST API."
  + " For more information, see https://docs.github.com/rest/pulls/pulls#merge-a-pull-request-asynchronously (mergePullRequest)";

type ModelPr = {
  number: number;
  head: string;
  sha: string;
  base: string;
  baseSha: string;
  createdAt: number;
  mergedAt?: number;
  stack?: number;
  retargets: Array<{ at: number; from: string; to: string }>;
};

type Model = { clock: number; prs: ModelPr[]; stacks: Map<number, number[]>; nextStack: number };

type Op =
  | { kind: "open"; on: number | null }
  | { kind: "form_stack"; at: number }
  | { kind: "merge_outside"; at: number }
  | { kind: "poll" }
  /**
   * `consent` is what the card sent about the open layers below: nothing,
   * the layers it listed, or a stale list missing one that opened since.
   */
  | { kind: "click"; at: number; checkStackOrder: boolean; consent: "none" | "listed" | "stale"; upper: boolean };

const op: fc.Arbitrary<Op> = fc.oneof(
  // Mostly chains, so stacks can form.
  { weight: 6, arbitrary: fc.record({ kind: fc.constant("open" as const), on: fc.option(fc.nat({ max: 3 }), { nil: null, freq: 4 }) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("form_stack" as const), at: fc.nat({ max: 7 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("merge_outside" as const), at: fc.nat({ max: 7 }) }) },
  { weight: 2, arbitrary: fc.constant({ kind: "poll" as const }) },
  { weight: 3, arbitrary: fc.record({
    kind: fc.constant("click" as const), at: fc.nat({ max: 7 }), checkStackOrder: fc.boolean(),
    consent: fc.constantFrom("none" as const, "listed" as const, "stale" as const),
    // Often an upper layer with open layers below, where consent decides the merge.
    upper: fc.boolean(),
  }) },
);

const iso = (at: number) => new Date(START + at * 60_000).toISOString();
const sha = (seed: number) => seed.toString(16).padStart(40, "0");
const open = (pr: ModelPr) => pr.mergedAt === undefined;

function membership(model: Model, pr: ModelPr) {
  if (pr.stack === undefined) return undefined;
  const members = model.stacks.get(pr.stack)!;
  return { number: pr.stack, position: members.indexOf(pr.number) + 1, size: members.length };
}

/** GitHub lands `pr` into its base. Layers based on its head retarget to trunk; stacks keep them. */
function land(model: Model, pr: ModelPr): void {
  model.clock++;
  pr.mergedAt = model.clock;
  for (const child of model.prs) {
    if (open(child) && child.base === pr.head) {
      child.retargets.push({ at: model.clock, from: child.base, to: TRUNK });
      child.base = TRUNK;
      child.baseSha = sha(0xa000 + model.clock);
    }
  }
}

function restPull(model: Model, pr: ModelPr) {
  const stack = membership(model, pr);
  return {
    number: pr.number,
    state: open(pr) ? "open" : "closed",
    merged: !open(pr),
    merged_at: open(pr) ? null : iso(pr.mergedAt!),
    closed_at: open(pr) ? null : iso(pr.mergedAt!),
    merge_commit_sha: open(pr) ? null : sha(0xb000 + pr.number),
    created_at: iso(pr.createdAt),
    head: { ref: pr.head, sha: pr.sha, repo: { full_name: `${OWNER}/${REPO}` } },
    base: { ref: pr.base, sha: pr.baseSha, repo: { default_branch: TRUNK } },
    stack: stack ? { id: stack.number, ...stack, base: { ref: TRUNK, sha: null } } : null,
  };
}

/** GitHub's `GET /stacks/{number}`: its members bottom first. */
function stackBody(model: Model, number: number) {
  return { number, base: { ref: TRUNK }, pull_requests: model.stacks.get(number)!.map((member) => {
    const pr = model.prs.find((candidate) => candidate.number === member)!;
    return {
      number: member, state: open(pr) ? "open" : "closed", merged_at: open(pr) ? null : iso(pr.mergedAt!),
      head: { ref: pr.head, sha: pr.sha }, base: { ref: pr.base, sha: pr.baseSha },
    };
  }) };
}

/** The operator's `gh`, answering from the model. Records every merge GitHub refused and every PR it landed. */
function fakeGh(model: Model, log: { refused: number; landed: number[] }) {
  const byNumber = (number: number) => model.prs.find((pr) => pr.number === number);
  return async (_command: string, args: string[]): Promise<{ stdout: string }> => {
    const json = (value: unknown) => ({ stdout: JSON.stringify(value) });
    if (args[0] === "pr" && args[1] === "merge") {
      const pr = byNumber(Number(args[2]!.split("/").at(-1)))!;
      if (pr.stack !== undefined) {
        log.refused++;
        throw Object.assign(new Error("exit 1"), { stderr: `${REFUSAL}\n` });
      }
      log.landed.push(pr.number);
      land(model, pr);
      return { stdout: "" };
    }
    if (args[1] === "graphql") {
      const number = Number(args[args.indexOf("-F") + 1]!.split("=")[1]);
      const pr = byNumber(number)!;
      return json({ data: { repository: { pullRequest: {
        baseRefName: pr.base, headRefOid: pr.sha,
        timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: pr.retargets.map((change) => ({
          createdAt: iso(change.at), previousRefName: change.from, currentRefName: change.to,
        })) },
      } } } });
    }
    const route = args.find((arg) => arg.startsWith(`repos/${OWNER}/${REPO}`))!.slice(`repos/${OWNER}/${REPO}`.length);
    if (args.includes("PUT")) {
      const pr = byNumber(Number(/^\/pulls\/(\d+)\/merge-async$/.exec(route)![1]))!;
      const expected = args.find((arg) => arg.startsWith("sha="))?.slice(4);
      if (!open(pr) || (expected && expected !== pr.sha)) return json({ status: "failed", details: { message: "not mergeable" } });
      // GitHub lands every open layer below with it.
      const members = pr.stack === undefined ? [pr.number] : model.stacks.get(pr.stack)!;
      for (const number of members.slice(0, members.indexOf(pr.number) + 1)) {
        const layer = byNumber(number)!;
        if (!open(layer)) continue;
        log.landed.push(layer.number);
        land(model, layer);
      }
      return json({ status: "merged", details: { sha: sha(0xc000 + pr.number) } });
    }
    let match = /^\/pulls\/(\d+)$/.exec(route);
    if (match) return json(restPull(model, byNumber(Number(match[1]))!));
    match = /^\/stacks\/(\d+)$/.exec(route);
    if (match) {
      return json(stackBody(model, Number(match[1])));
    }
    if (route.startsWith("/pulls?")) {
      const head = new URLSearchParams(route.split("?")[1]).get("head")!.split(":")[1];
      return json(model.prs.filter((pr) => pr.head === head).map((pr) => restPull(model, pr)));
    }
    throw new Error(`fake gh has no answer for ${args.join(" ")}`);
  };
}

/** A PR number in no stack: what a card listed about a layer that is gone. */
const STALE_LAYER = 9_999;
/** Clicks on a PR with open layers below, by what the card sent. */
const stats = { none: 0, listed: 0, stale: 0 };

async function run(ops: readonly Op[]): Promise<void> {
  const model: Model = { clock: 0, prs: [], stacks: new Map(), nextStack: 4402 };
  forgetGithubForgeStacks();
  // The poll's member reads, answered from the model and counted.
  const stackReads: number[] = [];
  const pendingReads: Promise<unknown>[] = [];
  const discovery = new GithubForgeStackDiscovery({
    read: (_repository, path) => {
      const number = Number(path.split("/").at(-1));
      stackReads.push(number);
      const answer = Promise.resolve(stackBody(model, number));
      pendingReads.push(answer);
      return answer;
    },
    learned: () => {},
    // Ten minutes a step, so the limiter never hides a read a step needs.
    now: () => START + model.clock * 600_000 + sincePoll,
  });
  let sincePoll = 0;
  const settleReads = async () => {
    while (pendingReads.length) await pendingReads.shift();
    await new Promise((resolve) => setImmediate(resolve));
  };
  // Each step picks among the PRs it can act on, so short runs still reach stacks.
  const pick = <T,>(rows: readonly T[], index: number): T | undefined => rows[index % Math.max(1, rows.length)];
  const openPrs = () => model.prs.filter(open);
  for (const step of ops) {
    model.clock++;
    if (step.kind === "open") {
      // Counted from the newest open PR, so low indexes grow one chain.
      const onParent = step.on === null ? undefined : pick(openPrs().reverse(), step.on);
      const number = 4387 + model.prs.length;
      model.prs.push({
        number, head: `layer-${number}`, sha: sha(number), createdAt: model.clock, retargets: [],
        base: onParent?.head ?? TRUNK, baseSha: onParent?.sha ?? sha(0xa000 + model.clock),
      });
    } else if (step.kind === "form_stack") {
      // GitHub stacks a chain of open PRs, bottom on trunk, each on the head of
      // the one below; at a fork the operator takes one path, here the oldest.
      const childrenOf = (pr: ModelPr) => model.prs.filter((child) => open(child) && child.stack === undefined && child.base === pr.head);
      const bottom = pick(openPrs().filter((pr) => pr.stack === undefined && pr.base === TRUNK && childrenOf(pr).length > 0), step.at);
      if (!bottom) continue;
      const chain = [bottom];
      for (let above = childrenOf(bottom)[0]; above; above = childrenOf(above)[0]) chain.push(above);
      const number = model.nextStack++;
      model.stacks.set(number, chain.map((pr) => pr.number));
      for (const pr of chain) pr.stack = number;
    } else if (step.kind === "merge_outside") {
      // The operator merges on github.com: only a PR on trunk, which in a stack is its lowest open layer.
      const pr = pick(openPrs().filter((candidate) => candidate.base === TRUNK), step.at);
      if (pr) land(model, pr);
    } else if (step.kind === "poll") {
      // What PwrAgent knows after a status poll: GitHub's stack membership, for every PR.
      const summaries: PrSummary[] = [];
      for (const pr of model.prs) {
        const summary = mapGraphqlPrNode({
          number: pr.number, url: `https://github.com/${OWNER}/${REPO}/pull/${pr.number}`,
          state: open(pr) ? "OPEN" : "MERGED", isDraft: false, mergeable: "MERGEABLE",
          baseRefName: pr.base, headRefName: pr.head, headRefOid: pr.sha,
          createdAt: iso(pr.createdAt), mergedAt: pr.mergedAt === undefined ? null : iso(pr.mergedAt),
          headRepository: { name: REPO }, headRepositoryOwner: { login: OWNER },
          stack: pr.stack === undefined ? null : { number: pr.stack, size: model.stacks.get(pr.stack)!.length },
          stackEntry: pr.stack === undefined ? null : { position: membership(model, pr)!.position },
        }, undefined, START + model.clock * 60_000);
        expect(summary.githubStack, `#${pr.number} after a poll`).toEqual(membership(model, pr));
        summaries.push(summary);
      }
      // Members are read once per changed stack, and then match GitHub.
      stackReads.length = 0;
      discovery.observe(summaries);
      await settleReads();
      expect(new Set(stackReads).size, "one member read per stack").toBe(stackReads.length);
      const repository = githubForgeStackRepository({ host: "github.com", owner: OWNER, repo: REPO });
      for (const [number, members] of model.stacks) {
        expect(readGithubForgeStack(repository, number)?.layers.map((layer) => [layer.number, layer.open]), `stack ${number}`)
          .toEqual(members.map((member) => [member, open(model.prs.find((pr) => pr.number === member)!)]));
      }
      // Nothing changed since: the same poll again, past the limiter, reads nothing.
      stackReads.length = 0;
      sincePoll = 300_000;
      discovery.observe(summaries);
      await settleReads();
      sincePoll = 0;
      expect(stackReads, "a poll with no stack change reads no members").toEqual([]);
    } else {
      // The synchronous fallback runs only for a PR on trunk; the order check covers the rest.
      const openBelowOf = (pr: ModelPr) => {
        const stack = membership(model, pr);
        return stack
          ? model.stacks.get(stack.number)!.slice(0, stack.position - 1).filter((number) => open(model.prs.find((p) => p.number === number)!))
          : [];
      };
      const clickable = openPrs().filter((candidate) => step.checkStackOrder || candidate.base === TRUNK);
      const upper = clickable.filter((candidate) => openBelowOf(candidate).length > 0);
      const pr = pick(step.upper && upper.length ? upper : clickable, step.at);
      if (!pr) continue;
      const stack = membership(model, pr);
      const openBelow = openBelowOf(pr);
      // What the card sent: nothing, the open layers it listed, or a stale list.
      // A stale list names layers, just not every one open now: the newest is
      // missing, and a layer that has merged since stands in its place.
      const consented = step.consent === "listed" ? openBelow
        : step.consent === "stale" && openBelow.length ? [...openBelow.slice(0, -1), STALE_LAYER] : [];
      if (openBelow.length) stats[step.consent] += 1;
      const coversBelow = openBelow.every((number) => consented.includes(number));
      const blocked = openBelow.length ? !coversBelow : pr.base !== TRUNK;
      const log = { refused: 0, landed: [] as number[] };
      const fetcher = new GithubPrFetcher({
        graphqlClient: { fetchPullRequests: async () => [], fetchPullRequestsForBranches: async () => new Map() } as never,
        discoverGhCommands: async () => ({ selectedCommand: "/fixture/gh" }) as never,
        runGhCommand: fakeGh(model, log),
      });
      const result = await fetcher.mergePullRequest({
        pullRequest: `https://github.com/${OWNER}/${REPO}/pull/${pr.number}`, method: "squash", checkStackOrder: step.checkStackOrder,
        ...(consented.length ? { mergeOpenLayersBelow: consented } : {}),
      }).then((merged) => ({ merged }), (error: unknown) => ({ error }));
      // Safety: a click lands only the PR clicked and the layers below it the operator chose.
      expect(log.landed.filter((number) => number !== pr.number && !consented.includes(number)),
        `merging #${pr.number} landed PRs nobody chose`).toEqual([]);
      if (blocked) {
        expect(result, `#${pr.number} has an open layer below it nobody chose`).toMatchObject({ error: { code: "stack_parent_open" } });
        expect(log.landed).toEqual([]);
      } else {
        expect(result, `#${pr.number} can merge`).toHaveProperty("merged");
        // GitHub lands the chosen layers bottom first, then the PR clicked.
        expect(log.landed).toEqual([...openBelow, pr.number]);
        if (openBelow.length && "merged" in result) {
          expect(result.merged.summary).toContain(`${openBelow.length + 1} PRs in a GitHub stack`);
        }
      }
      // A merge that read the PR first never sends GitHub one it will refuse; the fallback sends at most one.
      expect(log.refused).toBeLessThanOrEqual(step.checkStackOrder ? 0 : 1);
      // A stack learned from GitHub's refusal is read whole: the result names every layer still open above.
      if (log.refused && "merged" in result && stack) {
        const above = model.stacks.get(stack.number)!.slice(stack.position)
          .filter((number) => open(model.prs.find((p) => p.number === number)!));
        for (const number of above) expect(result.merged.summary, `merging #${pr.number}`).toContain(`#${number}`);
      }
    }
  }
}

it("knows a PR's GitHub stack after a poll, and merges only the PRs the operator chose, as GitHub allows", async () => {
  await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 8, maxLength: 30 }), async (ops) => await run(ops)), {
    numRuns: 500,
    examples: [[[
      // #4387 and #4393 on 2026-11-25: chained, stacked outside PwrAgent, bottom merged on github.com, top merged from the card.
      { kind: "open", on: null },
      { kind: "open", on: 0 },
      { kind: "form_stack", at: 0 },
      { kind: "merge_outside", at: 0 },
      { kind: "poll" },
      { kind: "click", at: 1, checkStackOrder: true, consent: "none", upper: false },
    ]]],
  });
  // The generator reaches every kind of consent on a PR with open layers below.
  expect(Math.min(stats.none, stats.listed, stats.stale), JSON.stringify(stats)).toBeGreaterThanOrEqual(15);
});
