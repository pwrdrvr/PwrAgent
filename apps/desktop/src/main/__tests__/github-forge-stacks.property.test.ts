import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import {
  forgetGithubForgeStacks,
  GithubForgeStackDiscovery,
  githubForgeStackCatalog,
  githubForgeStackReadReason,
  githubForgeStackRepository,
  githubForgeStacksIn,
  parseGithubForgeStack,
  readGithubForgeStack,
  recordGithubForgeStack,
} from "../stacks/github-forge-stacks";

/**
 * A stack made on github.com has no `gh stack` catalog. PwrAgent learns its
 * members from `GET /stacks/{number}`, read only when a poll shows the member
 * list may have changed, and projects it as a catalog the stack reader
 * already understands.
 */
const REPOSITORY = { host: "github.com", owner: "Octo", repo: "App" };
const KEY = "github.com:octo/app";

const member = fc.record({
  state: fc.constantFrom("open", "closed"),
  merged: fc.boolean(),
  sha: fc.option(fc.stringMatching(/^[0-9a-f]{40}$/), { nil: undefined }),
  retargeted: fc.boolean(),
});

function body(members: { state: string; merged: boolean; sha?: string; retargeted: boolean }[]) {
  return {
    number: 4402,
    base: { ref: "main" },
    pull_requests: members.map((layer, index) => ({
      number: 100 + index,
      state: layer.merged ? "closed" : layer.state,
      merged_at: layer.merged ? "2026-11-25T17:00:55Z" : null,
      head: { ref: `layer-${index + 1}`, ...(layer.sha ? { sha: layer.sha } : {}) },
      base: { ref: index && !layer.retargeted ? `layer-${index}` : "main" },
    })),
  };
}

function summary(number: number, place: { number: number; position: number; size: number }, overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com", org: "Octo", repo: "App", number,
    url: `https://github.com/Octo/App/pull/${number}`, lifecycleState: "open",
    githubStack: place, ...overrides,
  } as PrSummary;
}

beforeEach(() => forgetGithubForgeStacks());

describe("reading a GitHub stack", () => {
  it("keeps every member bottom first, and its catalog names each PR and whether it merged", () => {
    fc.assert(fc.property(fc.array(member, { minLength: 1, maxLength: 8 }), (members) => {
      const stack = parseGithubForgeStack(REPOSITORY, 4402, body(members))!;
      expect(stack.repository).toBe(KEY);
      expect(stack.trunk).toBe("main");
      expect(stack.layers.map((layer) => layer.number)).toEqual(members.map((_, index) => 100 + index));
      for (const [index, layer] of stack.layers.entries()) {
        const raw = members[index]!;
        expect(layer.merged).toBe(raw.merged);
        expect(layer.open).toBe(!raw.merged && raw.state === "open");
        expect(layer.head).toBe(raw.sha);
      }
      const catalog = githubForgeStackCatalog(stack);
      expect(catalog).toMatchObject({ id: "github-stack-4402", number: 4402, trunk: { branch: "main" } });
      expect(catalog.branches.map((branch) => [branch.branch, branch.pullRequest]))
        .toEqual(members.map((raw, index) => [`layer-${index + 1}`, { number: 100 + index, merged: raw.merged }]));
    }));
  });

  it("refuses an answer with a member it cannot place", () => {
    const whole = body([{ state: "open", merged: false, retargeted: false }]);
    expect(parseGithubForgeStack(REPOSITORY, 1, whole)).toBeDefined();
    for (const broken of [
      undefined, null, "text", {}, { ...whole, base: null }, { ...whole, pull_requests: [] },
      { ...whole, pull_requests: [{ ...whole.pull_requests[0], number: "1" }] },
      { ...whole, pull_requests: [{ ...whole.pull_requests[0], number: 0 }] },
      { ...whole, pull_requests: [{ ...whole.pull_requests[0], head: null }] },
    ]) expect(parseGithubForgeStack(REPOSITORY, 1, broken)).toBeUndefined();
  });

  it("keys stacks by repository, case-insensitively, and keeps the newest read", () => {
    const first = parseGithubForgeStack(REPOSITORY, 4402, body([{ state: "open", merged: false, retargeted: false }]))!;
    const second = parseGithubForgeStack(REPOSITORY, 4402, body([{ state: "open", merged: true, retargeted: false }]))!;
    expect(githubForgeStackRepository(REPOSITORY)).toBe(KEY);
    recordGithubForgeStack(first);
    recordGithubForgeStack(second);
    expect(readGithubForgeStack("GitHub.com:Octo/App", 4402)).toBe(second);
    expect(githubForgeStacksIn(KEY)).toEqual([second]);
    expect(githubForgeStacksIn("github.com:octo/other")).toEqual([]);
  });
});

describe("when a poll reads a stack's members", () => {
  const known = () => parseGithubForgeStack(REPOSITORY, 4402, body([
    { state: "open", merged: false, retargeted: false },
    { state: "open", merged: false, retargeted: false },
  ]))!;

  it("reads only when the poll shows the member list may have changed", () => {
    const place = { number: 4402, position: 2, size: 2 };
    expect(githubForgeStackReadReason(summary(101, place, { githubStack: undefined }), known())).toBeUndefined();
    expect(githubForgeStackReadReason(summary(101, place), undefined)).toBe("first seen");
    expect(githubForgeStackReadReason(summary(101, place, { baseRefName: "layer-1" }), known())).toBeUndefined();
    expect(githubForgeStackReadReason(summary(101, { ...place, size: 3 }), known())).toBe("size changed");
    expect(githubForgeStackReadReason(summary(105, place), known())).toBe("member missing");
    expect(githubForgeStackReadReason(summary(101, place, { lifecycleState: "merged" }), known())).toBe("member state changed");
    expect(githubForgeStackReadReason(summary(101, place, { baseRefName: "main" }), known())).toBe("member retargeted");
  });

  it("reads each stack once at a time and at most once a minute", async () => {
    let now = 0;
    const reads: string[] = [];
    let answer: (value: unknown) => void = () => {};
    const learned: number[] = [];
    const discovery = new GithubForgeStackDiscovery({
      read: (_repository, path) => {
        reads.push(path);
        return new Promise((resolve) => { answer = resolve; });
      },
      learned: (stack) => learned.push(stack.number),
      now: () => now,
    });
    const poll = [summary(100, { number: 4402, position: 1, size: 2 }), summary(101, { number: 4402, position: 2, size: 2 })];
    discovery.observe(poll);
    discovery.observe(poll);
    expect(reads).toEqual(["repos/Octo/App/stacks/4402"]);
    answer(body([{ state: "open", merged: false, retargeted: false }, { state: "open", merged: false, retargeted: false }]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(learned).toEqual([4402]);
    expect(readGithubForgeStack(KEY, 4402)?.layers).toHaveLength(2);

    // #100 merged: a reason to read again, but not within the minute.
    const merged = [{ ...poll[0]!, lifecycleState: "merged" as const }, poll[1]!];
    now = 30_000;
    discovery.observe(merged);
    expect(reads).toHaveLength(1);
    now = 60_000;
    discovery.observe(merged);
    expect(reads).toHaveLength(2);
  });

  it("reads an open stack again after ten minutes, when a layer no thread polls changed", async () => {
    let now = 0;
    // GitHub's answer: #100 below is open, then merges with nothing polled noticing.
    let lowerMerged = false;
    const reads: number[] = [];
    const discovery = new GithubForgeStackDiscovery({
      read: async () => {
        reads.push(now);
        return body([
          { state: "open", merged: lowerMerged, retargeted: false },
          { state: "open", merged: false, retargeted: false },
        ]);
      },
      learned: () => {},
      now: () => now,
    });
    // Only #101, the upper layer, is polled; its own view never changes.
    const poll = [summary(101, { number: 4402, position: 2, size: 2 }, { baseRefName: "layer-1" })];
    const settle = async () => await new Promise((resolve) => setImmediate(resolve));
    discovery.observe(poll);
    await settle();
    lowerMerged = true;
    for (now = 60_000; now < 600_000; now += 60_000) discovery.observe(poll);
    await settle();
    expect(reads).toEqual([0]);
    expect(readGithubForgeStack(KEY, 4402)?.layers[0]).toMatchObject({ number: 100, open: true });
    now = 600_000;
    discovery.observe(poll);
    await settle();
    expect(reads).toEqual([0, 600_000]);
    expect(readGithubForgeStack(KEY, 4402)?.layers[0]).toMatchObject({ number: 100, open: false, merged: true });
  });

  it("keeps what it knew when a read fails", async () => {
    recordGithubForgeStack(known());
    const discovery = new GithubForgeStackDiscovery({
      read: () => Promise.reject(new Error("HTTP 502")),
      learned: () => { throw new Error("nothing was learned"); },
    });
    discovery.observe([summary(101, { number: 4402, position: 2, size: 3 })]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(readGithubForgeStack(KEY, 4402)?.layers).toHaveLength(2);
  });
});
