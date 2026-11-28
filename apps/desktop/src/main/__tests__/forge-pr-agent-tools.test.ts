import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FORGE_AGENT_TOOL_POLICY,
  FORGE_AGENT_WRITE_TOOL_GROUPS,
  type ForgeAgentToolPolicy,
} from "@pwragent/shared/contracts/forge-agent-tools";
import { permissionForDynamicTool } from "@pwragent/shared/contracts/rbac";
import { ForgeCiClient } from "../pr-status/forge-ci-client";
import { ForgeReadError, type ForgeRepository } from "../pr-status/forge-tool-contract";
import { GithubPrToolClient, type GhRunner } from "../pr-status/github-pr-tool-client";
import { validateForgeAttachments, type ForgePrToolContext } from "../pr-status/forge-pr-tool-shared";
import { FORGE_PR_WRITE_OPERATIONS, forgePrToolGroup, validateForgePrToolArgs } from "../pr-status/forge-pr-tool-contract";
import { ForgePrToolService } from "../pr-status/forge-pr-tool-service";
import * as gitExecutable from "../app-server/git-executable";
import { buildForgeToolDefinitions, buildForgePrToolDefinitions } from "../agent-tools/pwragent-forge-pr-agent-tools";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import { searchPwrAgentTools } from "../agent-tools/pwragent-tool-search";

const repo: ForgeRepository = { provider: "github", host: "github.com", owner: "fixture", repo: "project" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const pull = (number: number, extra: Record<string, unknown> = {}) => ({
  number, node_id: `PR_${number}`, title: "Fixture change", state: "open", draft: false, body: "Body text", user: { login: "octo" },
  head: { ref: "topic", sha: "a".repeat(40), repo: { full_name: "fixture/project" } }, base: { ref: "main", sha: "b".repeat(40) },
  labels: [{ name: "bug" }], requested_reviewers: [], assignees: [], html_url: `https://github.com/fixture/project/pull/${number}`, ...extra,
});
const stackHistory = (baseRefName: string) => json({ data: { repository: { pullRequest: {
  headRefOid: "a".repeat(40), baseRefName, timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: [] },
} } } });
const nativeStack = (numbers: number[]) => ({
  number: 42, open: true, base: { ref: "main" },
  pull_requests: numbers.map((number, index) => pull(number, {
    head: { ref: `layer-${index}` },
    base: { ref: index ? `layer-${index - 1}` : "main" },
  })),
});

type Call = { url: string; method: string; body?: unknown; accept?: string };
function harness(routes: (call: Call) => Response | Promise<Response>, runGh?: GhRunner) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, accept: headers.Accept };
    calls.push(call);
    return await routes(call);
  }) as unknown as typeof fetch;
  const ci = new ForgeCiClient({ fetch: fetcher, githubToken: async () => "fixture-secret", gitlab: { readApi: vi.fn() }, enabled: () => true, takeToken: () => true });
  const client = new GithubPrToolClient({ ci, runGh, tempRoots: [os.tmpdir()] });
  return { calls, client };
}
const ctx = (extra: Partial<ForgePrToolContext> = {}): ForgePrToolContext => ({
  repository: repo, branch: "topic", directories: [], attached: [], privateRoots: [], defaultMergeMethod: () => "squash", ...extra,
});

type StackReceipt = "complete" | "empty" | "server_error" | "disconnect";
type StackAttempt = { chain: "pair" | "longer"; receipt: StackReceipt };

async function replayStackRegistration(numbers: number[], attempts: readonly StackAttempt[]) {
  const chains = { pair: numbers.slice(0, 2), longer: numbers };
  // The fixture commits one of these overlapping chains at the forge, before
  // returning any response. A second write that overlaps it is rejected.
  let registered: number[] | undefined;
  const { calls, client } = harness((call) => {
    if (call.method === "GET") {
      expect(new URL(call.url).searchParams.get("pull_request")).toBe(String(numbers[0]));
      return json(registered ? [nativeStack(registered)] : []);
    }
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ pull_requests: chains[attempt.chain] });
    if (registered) return json({ message: "PRs already stacked" }, 422);
    registered = chains[attempt.chain];
    if (attempt.receipt === "empty") return new Response(null, { status: 201 });
    if (attempt.receipt === "server_error") return json({ message: "GitHub could not deliver the receipt" }, 500);
    if (attempt.receipt === "disconnect") throw new TypeError("connection closed before response");
    return json(nativeStack(registered), 201);
  });
  const definition = buildForgePrToolDefinitions((operation, args) => client.execute(operation, args, ctx()))
    .find((tool) => tool.name === "create_pull_request_stack")!;
  const winner = attempts[0]!;
  let attempt: StackAttempt;
  for (const [index, step] of attempts.entries()) {
    attempt = step;
    const before = calls.length;
    const result = await definition.dispatch({ pullRequests: chains[step.chain] }, { backend: "codex", threadId: "t", transport: "codex_dynamic_tool" });
    const context = { index, step, calls: calls.slice(before).map((call) => call.method), result };
    if (winner.receipt === "disconnect") {
      // The shared transport's cooldown stops all subsequent HTTP calls.
      expect(context).toMatchObject(index === 0 ? { calls: ["POST"], result: { ok: false, code: "provider_error" } }
        : { calls: [], result: { ok: false, code: "rate_limited" } });
    } else if (step.chain !== winner.chain) {
      expect(context).toMatchObject({ calls: ["POST", "GET"], result: { ok: false, code: "rejected" } });
    } else {
      const needsReadback = index !== 0 || step.receipt !== "complete";
      const created = index !== 0 ? false : step.receipt === "server_error" ? null : true;
      expect(context).toMatchObject({
        calls: needsReadback ? ["POST", "GET"] : ["POST"],
        result: { ok: true, data: { created, providerRequests: needsReadback ? 2 : 1, stack: { number: 42, pullRequests: chains[step.chain] } } },
      });
    }
  }
  expect(registered).toEqual(chains[winner.chain]);
}

describe("GitHub tool contract", () => {
  it("rejects unknown fields, missing requirements and cross-repository search", () => {
    expect(() => validateForgePrToolArgs("create_pull_request", { title: "x", head: "topic", threadId: "other" })).toThrow(/Unknown argument/);
    expect(() => validateForgePrToolArgs("merge_pull_request", { number: 1 })).toThrow(/requires expectedHeadSha/);
    expect(() => validateForgePrToolArgs("create_pull_request", { title: "x" })).toThrow(/requires head/);
    expect(() => validateForgePrToolArgs("search_issues", { query: "repo:other/thing bug" })).toThrow(/this thread's repository only/);
    expect(() => validateForgePrToolArgs("create_pull_request", { title: "x", head: "topic; rm -rf" })).toThrow(/valid branch/);
    expect(() => validateForgePrToolArgs("update_pull_request", { number: 1, attachments: [{ path: "/tmp/a.png" }] })).toThrow(/full new body/);
    expect(() => validateForgePrToolArgs("add_issue_comment", { number: 1, body: "x", attachments: [{ path: "relative.png" }] })).toThrow(/absolute path/);
    expect(() => validateForgePrToolArgs("submit_pull_request_review", { number: 1, event: "REQUEST_CHANGES" })).toThrow(/needs a body/);
    expect(() => validateForgePrToolArgs("get_pull_request_diff", { number: 1, startChar: 10 })).toThrow(/diffSnapshot/);
    expect(() => validateForgePrToolArgs("submit_pull_request_review", { number: 1, event: "APPROVE" })).not.toThrow();
  });

  it("maps each write to a policy group, and an approving review to approve and merge", () => {
    expect(forgePrToolGroup("get_pull_request_diff", {})).toBe("read");
    expect(forgePrToolGroup("submit_pull_request_review", { event: "COMMENT" })).toBe("comments");
    expect(forgePrToolGroup("submit_pull_request_review", { event: "REQUEST_CHANGES" })).toBe("approve_merge");
    expect(forgePrToolGroup("merge_pull_request", {})).toBe("approve_merge");
    expect(forgePrToolGroup("rerun_failed_ci_jobs", {})).toBe("ci");
    expect(new Set(FORGE_PR_WRITE_OPERATIONS)).toEqual(new Set(Object.keys(FORGE_AGENT_WRITE_TOOL_GROUPS)));
  });

  it("gates messaging-started writes on their own permission", () => {
    expect(permissionForDynamicTool("forge", "get_pull_request")).toBe("tools.thread_inspection");
    expect(permissionForDynamicTool("forge", "list_ci_runs")).toBe("tools.thread_inspection");
    for (const tool of FORGE_PR_WRITE_OPERATIONS) expect(permissionForDynamicTool("forge", tool)).toBe("tools.forge_write");
  });
});

describe("GitHub tool catalog", () => {
  it("advertises reruns as writes and hides them independently from CI reads", () => {
    const definition = buildForgePrToolDefinitions().find((d) => d.name === "rerun_failed_ci_jobs")!;
    expect(definition.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(definition.inputSchema).toMatchObject({ required: ["runId"], additionalProperties: false });
    const policy: ForgeAgentToolPolicy = { enabled: true, access: { ...DEFAULT_FORGE_AGENT_TOOL_POLICY.access, ci: "off" } };
    const names = buildForgeToolDefinitions({ policy }).map((d) => d.name);
    expect(names).not.toContain("rerun_failed_ci_jobs");
    expect(names).toContain("get_ci_run");
  });

  it.each([{}, { runId: 0 }, { runId: 1.5 }, { runId: "42" }, { runId: Number.MAX_SAFE_INTEGER + 1 }, { runId: 42, threadId: "other" }, { runId: 42, instanceId: "peer" }, { runId: 42, jobId: 9 }])("rejects invalid rerun arguments %j before dispatch", async (args) => {
    const handler = vi.fn();
    const definition = buildForgePrToolDefinitions(handler).find((d) => d.name === "rerun_failed_ci_jobs")!;
    expect(await definition.dispatch(args, { backend: "codex", threadId: "t", transport: "codex_dynamic_tool" })).toMatchObject({ ok: false, code: "invalid_arguments" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("moves the forge family into its own catalog and offers what the policy allows", () => {
    const catalogs = resolveAgentToolCatalogs({});
    const forge = catalogs.find((c) => c.id === "forge")!;
    const names = forge.router.buildMcpTools().map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["get_forge_status", "read_ci_job_log", "create_pull_request", "get_pull_request_diff", "merge_pull_request"]));
    expect(catalogs.find((c) => c.id === "thread_inspection")!.router.buildMcpTools().map((tool) => tool.name)).not.toContain("get_forge_status");
    const off: ForgeAgentToolPolicy = { ...DEFAULT_FORGE_AGENT_TOOL_POLICY, enabled: false };
    expect(resolveAgentToolCatalogs({ forgeToolPolicy: off }).find((c) => c.id === "forge")!.summary).toMatchObject({ enabled: false, toolCount: 0 });
    const noIssues: ForgeAgentToolPolicy = { enabled: true, access: { ...DEFAULT_FORGE_AGENT_TOOL_POLICY.access, issues: "off", comments: "off" } };
    const offered = buildForgeToolDefinitions({ policy: noIssues }).map((d) => d.name);
    expect(offered).not.toContain("create_issue");
    expect(offered).not.toContain("add_issue_comment");
    expect(offered).toContain("submit_pull_request_review");
  });

  it.each([
    ["rerun failed CI jobs", "rerun_failed_ci_jobs"],
    ["open a pull request with screenshots", "create_pull_request"],
    ["read back the pull request", "get_pull_request"],
    ["reply to review comment", "reply_to_review_comment"],
    ["pull request diff", "get_pull_request_diff"],
    ["stacked PR", "list_stacks"],
  ])("finds %s through tool search", (query, name) => {
    const dynamic = resolveAgentToolCatalogs({}).flatMap((c) => c.dynamicTools);
    expect(searchPwrAgentTools(dynamic, query).map((tool) => tool.name)).toContain(name);
  });

  it("rejects bad arguments before the handler runs", async () => {
    const handler = vi.fn();
    const definition = buildForgePrToolDefinitions(handler).find((d) => d.name === "merge_pull_request")!;
    const result = await definition.dispatch({ number: 3, expectedHeadSha: "short" }, { backend: "codex", threadId: "t", transport: "codex_dynamic_tool" });
    expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("offers a GitHub registration tool when creating a native stack from existing PRs", () => {
    const dynamic = resolveAgentToolCatalogs({}).flatMap((catalog) => catalog.dynamicTools);
    const found = searchPwrAgentTools(dynamic, "register an existing GitHub PR chain as a native stack");
    expect(found[0]?.name).toBe("create_pull_request_stack");
    const create = searchPwrAgentTools(dynamic, "create_pull_request")[0];
    expect(create).toMatchObject({ name: "create_pull_request", description: expect.stringContaining("create_pull_request_stack") });
  });

  it("uses the Stack publishing write policy for registration", () => {
    expect(forgePrToolGroup("create_pull_request_stack", {})).toBe("stack_publish");
    expect(DEFAULT_FORGE_AGENT_TOOL_POLICY.access.stack_publish).toBe("ask");
    const policy: ForgeAgentToolPolicy = { enabled: true, access: { ...DEFAULT_FORGE_AGENT_TOOL_POLICY.access, stack_publish: "off" } };
    const offered = buildForgeToolDefinitions({ policy }).map((definition) => definition.name);
    expect(offered).not.toContain("create_pull_request_stack");
    expect(offered).toContain("create_pull_request");
  });

  it.each([{}, { pullRequests: [1] }, { pullRequests: [1, 1] }, { pullRequests: [1, "2"] }, { pullRequests: [1, 0] }, { pullRequests: [1, Number.MAX_SAFE_INTEGER + 1] }])("refuses invalid stack registration arguments %j", async (args) => {
    const handler = vi.fn();
    const definition = buildForgePrToolDefinitions(handler).find((tool) => tool.name === "create_pull_request_stack")!;
    expect(await definition.dispatch(args, { backend: "codex", threadId: "t", transport: "codex_dynamic_tool" })).toMatchObject({ ok: false, code: "invalid_arguments" });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("GitHub tool client", () => {
  async function expectNativeRegistration(numbers: number[]) {
    const { calls, client } = harness((call) => call.method === "POST" && call.url.endsWith("/repos/fixture/project/stacks")
      ? json(nativeStack(numbers), 201)
      : json({ message: "Unexpected route" }, 500));
    const service = new ForgePrToolService({
      enabled: () => true, clients: { github: client, gitlab: { execute: vi.fn() } }, defaultMergeMethod: () => "squash",
    });
    const scope = { remotes: [repo], attached: [], directories: [], privateRoots: [] };
    const definition = buildForgePrToolDefinitions(async (operation, args) => {
      const prepared = await service.prepare(operation, args, scope);
      return await service.execute(operation, { ...prepared.args, repository: prepared.repository }, scope);
    }).find((entry) => entry.name === "create_pull_request_stack");
    expect(definition, "A chain of published PRs needs a native GitHub registration tool").toBeDefined();
    const result = await definition!.dispatch({ pullRequests: numbers }, { backend: "codex", threadId: "t", transport: "codex_dynamic_tool" });
    expect(result).toMatchObject({ ok: true, data: { created: true, providerRequests: 1, stack: { number: 42, base: "main", pullRequests: numbers } } });
    expect(calls).toEqual([{ url: "https://api.github.com/repos/fixture/project/stacks", method: "POST", body: { pull_requests: numbers }, accept: "application/vnd.github+json" }]);
  }

  it("registers the terminal layout PR above its fix PR on GitHub", () => expectNativeRegistration([4658, 4665]));

  it("preserves the requested bottom-first order at a fixed provider request count", async () => {
    await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.integer({ min: 1, max: 10000 }), { minLength: 2, maxLength: 16 }), expectNativeRegistration), { numRuns: 5 });
    for (const size of [8, 16, 32]) {
      await expectNativeRegistration(Array.from({ length: size }, (_, index) => size - index));
    }
  });

  it("reads membership after GitHub creates the stack with an empty receipt", () =>
    replayStackRegistration([4658, 4665, 4680], [{ chain: "pair", receipt: "empty" }]));

  it("confirms membership after a server error without claiming which write created it", () =>
    replayStackRegistration([1, 2, 3], [
      { chain: "pair", receipt: "server_error" },
      { chain: "pair", receipt: "complete" },
      { chain: "longer", receipt: "complete" },
    ]));

  it("matches GitHub membership across failed receipts, repeat calls and overlapping chains", async () => {
    const step = fc.record({
      chain: fc.constantFrom("pair", "longer"),
      receipt: fc.constantFrom("complete", "empty", "server_error", "disconnect"),
    });
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 1, max: 10000 }), { minLength: 3, maxLength: 3 }),
      fc.array(step, { minLength: 1, maxLength: 8, size: "max" }),
      replayStackRegistration,
    ), { numRuns: Number(process.env.MBT_RUNS ?? 5) });
  });

  it.each([false, true])("settles racing registrations while the winning receipt is pending (same chain %s)", async (sameChain) => {
    const firstCommitted = Promise.withResolvers<void>();
    const firstReceipt = Promise.withResolvers<Response>();
    const pair = [4658, 4665];
    const { calls, client } = harness((call) => {
      if (call.method === "GET") return json([nativeStack(pair)]);
      if (calls.length > 1) return json({ message: "PRs already stacked" }, 422);
      firstCommitted.resolve();
      return firstReceipt.promise;
    });
    const create = (pullRequests: number[]) => client.execute("create_pull_request_stack", { pullRequests }, ctx());
    const winner = create(pair);
    try {
      await firstCommitted.promise;
      if (sameChain) {
        await expect(create(pair)).resolves.toMatchObject({ created: false, stack: { number: 42, pullRequests: pair } });
      } else {
        await expect(create([...pair, 4680])).rejects.toMatchObject({ code: "rejected" });
      }
    } finally {
      firstReceipt.resolve(new Response(null, { status: 201 }));
    }
    await expect(winner).resolves.toMatchObject({ created: true, stack: { number: 42, pullRequests: pair } });
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "GET", "GET"]);
  });

  it("confirms an already registered chain after GitHub rejects a repeat", async () => {
    const { calls, client } = harness((call) => call.method === "POST"
      ? json({ message: "PRs already stacked" }, 422)
      : json([nativeStack([4658, 4665])]));
    await expect(client.execute("create_pull_request_stack", { pullRequests: [4658, 4665] }, ctx())).resolves.toMatchObject({
      created: false, providerRequests: 2, stack: { number: 42, base: "main", pullRequests: [4658, 4665] },
    });
    expect(calls.map((call) => [call.method, new URL(call.url).search])).toEqual([["POST", ""], ["GET", "?pull_request=4658"]]);
  });

  it("preserves the rejection when GitHub has different members", async () => {
    const { calls, client } = harness((call) => call.method === "POST"
      ? json({ message: "PRs already stacked" }, 422)
      : json([nativeStack([4658, 4665, 4680])]));
    await expect(client.execute("create_pull_request_stack", { pullRequests: [4658, 4665] }, ctx()))
      .rejects.toMatchObject({ code: "rejected", message: expect.stringContaining("PRs already stacked") });
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
  });

  it("reports GitHub write permission failures after one request", async () => {
    const { calls, client } = harness(() => json({ message: "Resource not accessible by integration" }, 403));
    await expect(client.execute("create_pull_request_stack", { pullRequests: [4658, 4665] }, ctx()))
      .rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("Pull requests write access") });
    expect(calls.map((call) => call.method)).toEqual(["POST"]);
  });

  it("requires GitHub to confirm the ordered members before reporting creation", async () => {
    const reversed = nativeStack([4665, 4658]);
    const { calls, client } = harness((call) => call.method === "POST" ? json(reversed, 201) : json([reversed]));
    await expect(client.execute("create_pull_request_stack", { pullRequests: [4658, 4665] }, ctx()))
      .rejects.toMatchObject({ code: "invalid_response" });
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
  });

  it.each(["github.com", "github.example.test"])("requests only failed jobs through %s and accepts an empty 201 response", async (host) => {
    const { calls, client } = harness(() => new Response(null, { status: 201 }));
    const result = await client.execute("rerun_failed_ci_jobs", { runId: 42 }, ctx({ repository: { ...repo, host } }));
    const root = host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
    expect(calls[0]).toEqual({ url: `${root}/repos/fixture/project/actions/runs/42/rerun-failed-jobs`, method: "POST", body: undefined, accept: "application/vnd.github+json" });
    // The follow-up read of the run returned no body: the accepted re-run is
    // still reported, without its attempt or head.
    expect(calls[1]).toMatchObject({ url: `${root}/repos/fixture/project/actions/runs/42`, method: "GET" });
    expect(result).toMatchObject({ requested: true, runId: 42, providerRequests: 2, scope: "failed_jobs_and_dependents", url: `https://${host}/fixture/project/actions/runs/42` });
    expect(result).not.toHaveProperty("runAttempt");
    expect(result).not.toHaveProperty("headSha");
  });

  it("reports the re-run's attempt and head from one follow-up read of the run", async () => {
    const { calls, client } = harness((call) => call.method === "POST"
      ? new Response(null, { status: 201 })
      : json({ id: 42, run_attempt: 2, head_sha: "c".repeat(40), status: "queued" }));
    const result = await client.execute("rerun_failed_ci_jobs", { runId: 42 }, ctx());
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
    expect(result).toMatchObject({ requested: true, runId: 42, runAttempt: 2, headSha: "c".repeat(40), providerRequests: 2 });
  });

  it("still reports an accepted re-run when the follow-up read fails", async () => {
    const { client } = harness((call) => call.method === "POST"
      ? new Response(null, { status: 201 })
      : json({ message: "Server Error" }, 500));
    const result = await client.execute("rerun_failed_ci_jobs", { runId: 42 }, ctx());
    expect(result).toMatchObject({ requested: true, runId: 42, providerRequests: 2 });
    expect(result).not.toHaveProperty("runAttempt");
  });

  it("returns a refused rerun without falling back to rerunning the whole workflow", async () => {
    const { calls, client } = harness(() => json({ message: "This workflow run cannot be rerun." }, 403));
    await expect(client.execute("rerun_failed_ci_jobs", { runId: 42 }, ctx())).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("cannot be rerun") });
    expect(calls).toHaveLength(1);
  });

  it("reads whether a pull request head is pushed, with slashes kept as path segments", async () => {
    const { calls, client } = harness((call) => call.url.endsWith("/git/ref/heads/fix/pushed") ? json({ ref: "refs/heads/fix/pushed" }) : json({ message: "Not Found" }, 404));
    await expect(client.headBranchExists(repo, "fix/pushed")).resolves.toBe(true);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/fixture/project/git/ref/heads/fix/pushed");
    await expect(client.headBranchExists(repo, "fix/local-only")).resolves.toBe(false);
    await expect(client.headBranchExists(repo, "someone:topic")).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("checks merge holds before issuing a provider write", async () => {
    const { client, calls } = harness(() => json({ merged: true }));
    const assertCanMerge = vi.fn(() => { throw new ForgeReadError("merge_held", "Merge held: Windows validation"); });
    await expect(client.execute("merge_pull_request", { number: 17, expectedHeadSha: "a".repeat(40) }, ctx({ assertCanMerge })))
      .rejects.toMatchObject({ code: "merge_held" });
    expect(assertCanMerge).toHaveBeenCalledWith(repo, 17);
    expect(calls).toEqual([]);
  });

  it("opens a pull request into the default branch and returns it read back", async () => {
    const { calls, client } = harness((call) => {
      if (call.method === "GET" && call.url.endsWith("/repos/fixture/project")) return json({ default_branch: "main" });
      if (call.method === "POST" && call.url.endsWith("/pulls")) return json(pull(12), 201);
      if (call.method === "POST" && call.url.endsWith("/issues/12/labels")) return json([]);
      if (call.method === "GET" && call.url.endsWith("/pulls/12")) return json(pull(12, { draft: true }));
      return json({ message: "unexpected" }, 500);
    });
    const result = await client.execute("create_pull_request", { title: "fix: tests", body: "Summary", draft: true, addLabels: ["bug"] }, ctx()) as Record<string, unknown>;
    expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/pulls"))!.body).toEqual({ title: "fix: tests", head: "topic", base: "main", body: "Summary", draft: true });
    expect(result).toMatchObject({ created: true, url: "https://github.com/fixture/project/pull/12", pullRequest: { number: 12, draft: true } });
    expect(JSON.stringify(result)).not.toContain("PR_12");
  });

  it("returns GitHub's reason when it refuses a write, without a cooldown", async () => {
    let attempts = 0;
    const { client } = harness(() => {
      attempts++;
      return json({ message: "Validation Failed", errors: [{ message: "A pull request already exists for fixture:topic." }] }, 422);
    });
    const refused = client.execute("create_pull_request", { title: "x", base: "main" }, ctx());
    await expect(refused).rejects.toMatchObject({ code: "rejected", message: expect.stringContaining("already exists for fixture:topic") });
    await expect(client.execute("create_pull_request", { title: "x", base: "main" }, ctx())).rejects.toMatchObject({ code: "rejected" });
    expect(attempts).toBe(2);
  });

  it("finds the thread's pull request by its branch", async () => {
    const { calls, client } = harness((call) => call.url.includes("/pulls?") ? json([pull(31)]) : json(pull(31)));
    const result = await client.execute("get_pull_request", {}, ctx()) as { pullRequest: { number: number; body: { text: string } }; trust: string };
    expect(calls[0]!.url).toContain("head=fixture%3Atopic");
    expect(result.pullRequest).toMatchObject({ number: 31, body: { text: "Body text" } });
    expect(result.trust).toBe("untrusted");
  });

  it("pages a diff, filters it by path and refuses to mix snapshots", async () => {
    let diff = "diff --git a/src/a.ts b/src/a.ts\n+one\ndiff --git a/docs/b.md b/docs/b.md\n+two\n";
    const { calls, client } = harness(() => new Response(diff));
    const first = await client.execute("get_pull_request_diff", { number: 4, path: "src", maxChars: 10 }, ctx()) as { diff: { text: string; next: { startChar: number; diffSnapshot: string } }; files: number };
    expect(calls[0]!.accept).toBe("application/vnd.github.diff");
    expect(first.files).toBe(1);
    expect(first.diff.text).toBe("diff --git");
    const second = await client.execute("get_pull_request_diff", { number: 4, path: "src", ...first.diff.next }, ctx()) as { diff: { text: string } };
    expect(second.diff.text).toBe(" a/src/a.ts b/src/a.ts\n+one\n");
    diff += "diff --git a/src/c.ts b/src/c.ts\n+three\n";
    await expect(client.execute("get_pull_request_diff", { number: 4, path: "src", ...first.diff.next }, ctx())).rejects.toMatchObject({ code: "diff_changed" });
  });

  it("merges only the head the agent checked", async () => {
    const { calls, client } = harness(({ method }) => {
      if (method === "POST") return stackHistory("main");
      if (method === "GET") return json(pull(9, {
        created_at: "2026-11-22T10:00:00Z", base: { ref: "main", repo: { default_branch: "main" } },
      }));
      return json({ message: "Head branch was modified. Review and try the merge again." }, 409);
    });
    await expect(client.execute("merge_pull_request", { number: 9, expectedHeadSha: "c".repeat(40) }, ctx())).rejects.toMatchObject({ code: "head_changed" });
    expect(calls[2]).toMatchObject({ method: "PUT", body: { merge_method: "squash", sha: "c".repeat(40) } });
  });

  it("merges a pull request in a GitHub stack through the asynchronous merge, at the checked head", async () => {
    const { calls, client } = harness(({ method, url }) => {
      if (method === "POST") return stackHistory("main");
      if (method === "GET" && url.endsWith("/stacks/4402")) return json({ number: 4402, pull_requests: [
        { number: 8, state: "closed", merged_at: "2026-11-25T11:00:00Z" }, { number: 9, state: "open", merged_at: null },
      ] });
      if (method === "GET" && url.endsWith("/merge-async/req-1")) return json({ status: "merged", details: { sha: "e".repeat(40) } });
      if (method === "GET") return json(pull(9, {
        created_at: "2026-11-22T10:00:00Z", base: { ref: "main", repo: { default_branch: "main" } },
        stack: { id: 1, number: 4402, position: 2, size: 2, base: { ref: "main", sha: "b".repeat(40) } },
      }));
      if (method === "PUT" && url.endsWith("/pulls/9/merge-async")) return json({ status: "pending", details: { uuid: "req-1" } }, 202);
      return json({ message: "This endpoint does not support stacked pull requests." }, 405);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const merge = client.execute("merge_pull_request", { number: 9, expectedHeadSha: "a".repeat(40) }, ctx());
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(merge).resolves.toMatchObject({ merged: true, number: 9, mergeCommitSha: "e".repeat(40) });
    } finally {
      vi.useRealTimers();
    }
    expect(calls.find((call) => call.method === "PUT")).toMatchObject({ body: { merge_method: "squash", sha: "a".repeat(40) } });
    expect(calls.some((call) => call.url.endsWith("/pulls/9/merge"))).toBe(false);
  });

  it("refuses an inferred child when its parent merged while it still targets the parent branch", async () => {
    const { calls, client } = harness((call) => {
      if (call.method === "POST") return stackHistory("topic");
      if (call.method !== "GET") return json({ merged: true });
      if (call.url.includes("/pulls?")) return json([pull(8, {
        state: "closed", created_at: "2026-11-22T09:00:00Z", merged_at: "2026-11-22T12:00:00Z",
      })]);
      return json(pull(9, {
        created_at: "2026-11-22T10:00:00Z",
        base: { ref: "topic", sha: "a".repeat(40), repo: { default_branch: "main" } },
      }));
    });
    await expect(client.execute("merge_pull_request", { number: 9, expectedHeadSha: "a".repeat(40) }, ctx()))
      .rejects.toMatchObject({ code: "stack_parent_open" });
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("resolves only review threads in this repository", async () => {
    const { calls, client } = harness((call) => {
      const query = String((call.body as { query: string }).query);
      if (query.startsWith("query")) return json({ data: { node: { id: "T1", isResolved: false, pullRequest: { number: 2, repository: { nameWithOwner: "someone/else" } } } } });
      return json({ data: { resolveReviewThread: { thread: { id: "T1", isResolved: true } } } });
    });
    await expect(client.execute("resolve_review_thread", { reviewThreadId: "T1", resolved: true }, ctx())).rejects.toMatchObject({ code: "forbidden" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/graphql");
  });

  it("lists review threads with ids for replying and resolving", async () => {
    const { client } = harness(() => json({ data: { repository: { pullRequest: { reviewThreads: {
      pageInfo: { hasNextPage: true, endCursor: "CUR" },
      nodes: [
        { id: "T1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 4, diffSide: "RIGHT", comments: { totalCount: 1, nodes: [{ databaseId: 77, author: { login: "rev" }, body: "Rename this.", createdAt: "2026-10-26T00:00:00Z", url: "https://github.com/fixture/project/pull/2#discussion_r77" }] } },
        { id: "T2", isResolved: true, isOutdated: false, path: "src/b.ts", line: 9, diffSide: "RIGHT", comments: { totalCount: 0, nodes: [] } },
      ],
    } } } } }));
    const result = await client.execute("list_pull_request_review_threads", { number: 2, unresolvedOnly: true }, ctx()) as { threads: Array<{ reviewThreadId: string; comments: Array<{ commentId: number }> }>; next: { after: string } };
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]).toMatchObject({ reviewThreadId: "T1", comments: [{ commentId: 77 }] });
    expect(result.next).toEqual({ after: "CUR" });
  });

  it("scopes search to the thread's repository", async () => {
    const { calls, client } = harness(() => json({ total_count: 0, incomplete_results: false, items: [] }));
    await client.execute("search_issues", { query: "label:bug flaky", kind: "pr", state: "open" }, ctx());
    expect(new URL(calls[0]!.url).searchParams.get("q")).toBe("repo:fixture/project is:pr is:open label:bug flaky");
  });
});

describe("GitHub attachments", () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "pwragent-attach-workspace-"));
    outside = mkdtempSync(path.join(os.tmpdir(), "pwragent-attach-outside-"));
    mkdirSync(path.join(root, "shots"));
    writeFileSync(path.join(root, "shots", "after.png"), "png");
    writeFileSync(path.join(outside, "secret.png"), "png");
    writeFileSync(path.join(root, "notes.txt"), "text");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("accepts images in the thread's directories and refuses everything else", async () => {
    const options = { directories: [root], privateRoots: [], tempRoots: [] };
    const image = path.join(root, "shots", "after.png");
    await expect(validateForgeAttachments([{ path: image, alt: "After" }], options)).resolves.toEqual([expect.objectContaining({ path: image, alt: "After", size: 3 })]);
    await expect(validateForgeAttachments([{ path: path.join(outside, "secret.png") }], options)).rejects.toMatchObject({ code: "forbidden" });
    await expect(validateForgeAttachments([{ path: path.join(root, "notes.txt") }], options)).rejects.toThrow(/not an image or video/);
    await expect(validateForgeAttachments([{ path: image }], { ...options, privateRoots: [root] })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("uploads through gh with a body file and reads the new pull request back", async () => {
    const image = path.join(root, "shots", "after.png");
    let bodyText = "";
    let uploaded = "";
    const runGh = vi.fn<GhRunner>(async (args) => {
      bodyText = readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8");
      uploaded = readFileSync(args[args.indexOf("--attach") + 1]!, "utf8");
      return { stdout: "https://github.com/fixture/project/pull/44\n", stderr: "", exitCode: 0 };
    });
    const { client } = harness(() => json(pull(44)), runGh);
    const result = await client.execute("create_pull_request", { title: "With screenshot", base: "main", body: `![After](${image})`, attachments: [{ path: image }] }, ctx({ directories: [root] })) as Record<string, unknown>;
    const args = runGh.mock.calls[0]![0];
    expect(args.slice(0, 7)).toEqual(["pr", "create", "--head", "topic", "--base", "main", "--title"]);
    // gh uploads a private copy of the checked bytes, and the body reference follows it.
    const copy = args[args.indexOf("--attach") + 1]!;
    expect(args).toEqual(expect.arrayContaining(["-R", "fixture/project"]));
    expect(copy).not.toBe(image);
    expect(path.basename(copy)).toBe("after.png");
    expect(uploaded).toBe("png");
    expect(bodyText).toBe(`![After](${copy})`);
    expect(result).toMatchObject({ created: true, url: "https://github.com/fixture/project/pull/44" });
  });

  it("refuses a link whose target is not an image", async () => {
    symlinkSync(path.join(root, "notes.txt"), path.join(root, "shots", "notes.png"));
    await expect(validateForgeAttachments([{ path: path.join(root, "shots", "notes.png") }], { directories: [root], privateRoots: [], tempRoots: [] }))
      .rejects.toThrow(/links to a file that is not an image or video/);
  });

  it("names the gh upgrade when gh is too old to attach", async () => {
    const image = path.join(root, "shots", "after.png");
    const runGh = vi.fn<GhRunner>(async () => ({ stdout: "", stderr: "unknown flag: --attach\n", exitCode: 1 }));
    const { client } = harness(() => json({ number: 9 }), runGh);
    await expect(client.execute("create_issue", { title: "Bug", attachments: [{ path: image }] }, ctx({ directories: [root] })))
      .rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("2.99") });
  });

  it("reports a partial attachment failure without losing the new item", async () => {
    const image = path.join(root, "shots", "after.png");
    const runGh = vi.fn<GhRunner>(async () => ({ stdout: "https://github.com/fixture/project/pull/9#issuecomment-5\n", stderr: "failed to upload after.png: too large\n", exitCode: 1 }));
    const { client } = harness(() => json({ number: 9, pull_request: {} }), runGh);
    const result = await client.execute("add_issue_comment", { number: 9, body: "See screenshot", attachments: [{ path: image }] }, ctx({ directories: [root] }));
    expect(runGh.mock.calls[0]![0].slice(0, 3)).toEqual(["pr", "comment", "9"]);
    expect(result).toMatchObject({ url: "https://github.com/fixture/project/pull/9#issuecomment-5", attachmentWarning: expect.stringContaining("too large") });
  });
});

describe("forge tool service", () => {
  const remotes = { github: { host: "github.com", owner: "fixture", repo: "project" }, gitlab: { host: "gitlab.com", owner: "group/sub", repo: "project" } };
  const scope = (list: Array<{ host: string; owner: string; repo: string }>) => ({ remotes: list, attached: [], directories: [], privateRoots: [] });
  it("rejects GitLab stack registration before requesting approval", async () => {
    const execute = vi.fn();
    const service = new ForgePrToolService({
      enabled: () => true, clients: { github: { execute }, gitlab: { execute } }, defaultMergeMethod: () => "squash",
    });
    await expect(service.prepare("create_pull_request_stack", { pullRequests: [1, 2] }, scope([remotes.gitlab])))
      .rejects.toMatchObject({ code: "unsupported_provider" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("blocks a merge on unavailable checkout evidence but accepts a confirmed absent catalog", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pwragent-forge-stack-merge-evidence-"));
    const execute = vi.fn(async () => ({ merged: true }));
    const service = new ForgePrToolService({
      enabled: () => true, clients: { github: { execute }, gitlab: { execute: vi.fn() } }, defaultMergeMethod: () => "merge",
    });
    const run = vi.spyOn(gitExecutable, "runGitCommand")
      .mockRejectedValueOnce(new Error("fixture Git Job startup failure"))
      .mockRejectedValueOnce(Object.assign(new Error("fixture confirmed no repository"), {
        code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
      }));
    try {
      const request = () => service.execute("merge_pull_request", { number: 9, expectedHeadSha: "a".repeat(40) },
        { ...scope([remotes.github]), directories: [cwd] }, new AbortController().signal);
      await expect(request()).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("stack evidence") });
      expect(execute).not.toHaveBeenCalled();
      await expect(request()).resolves.toEqual({ merged: true });
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      run.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("sends each call to its repository's provider and refuses repositories outside the thread", async () => {
    const github = { execute: vi.fn(async () => ({ via: "github" })) };
    const gitlab = { execute: vi.fn(async () => ({ via: "gitlab" })) };
    const service = new ForgePrToolService({ enabled: () => true, clients: { github, gitlab }, defaultMergeMethod: () => "merge" });
    await expect(service.execute("get_issue", { number: 1 }, scope([remotes.github]))).resolves.toEqual({ via: "github" });
    expect(github.execute).toHaveBeenCalledWith("get_issue", { number: 1 }, expect.objectContaining({ repository: repo }));
    await expect(service.execute("get_issue", { number: 1 }, scope([remotes.gitlab]))).resolves.toEqual({ via: "gitlab" });
    expect(gitlab.execute).toHaveBeenCalledWith("get_issue", { number: 1 }, expect.objectContaining({ repository: { provider: "gitlab", ...remotes.gitlab } }));
    await expect(service.execute("get_issue", { number: 1 }, scope([remotes.github, remotes.gitlab]))).rejects.toMatchObject({ code: "ambiguous_repository" });
    await expect(service.execute("get_issue", { number: 1, repository: { ...repo, owner: "elsewhere" } }, scope([remotes.github]))).rejects.toBeInstanceOf(ForgeReadError);
    expect(service.resolveRepository({}, scope([remotes.gitlab]))).toMatchObject({ provider: "gitlab", owner: "group/sub" });
  });
  it("honors a provider switched off in Settings → Git", async () => {
    const service = new ForgePrToolService({ enabled: (provider) => provider === "github", clients: { github: { execute: vi.fn() }, gitlab: { execute: vi.fn() } }, defaultMergeMethod: () => "merge" });
    await expect(service.execute("get_issue", { number: 1 }, scope([remotes.gitlab]))).rejects.toMatchObject({ code: "provider_disabled" });
  });
  it("refuses a pull request from an unpushed head before approval, and does not guess for forks or unknown answers", async () => {
    const headBranchExists = vi.fn(async (_repository: ForgeRepository, head: string) => head === "fix/pushed" ? true : head === "fix/local-only" ? false : undefined);
    const service = new ForgePrToolService({ enabled: () => true, clients: { github: { execute: vi.fn(), headBranchExists }, gitlab: { execute: vi.fn() } }, defaultMergeMethod: () => "merge" });
    await expect(service.prepare("create_pull_request", { title: "Fix", head: "fix/pushed" }, scope([remotes.github])))
      .resolves.toEqual({ repository: repo, args: { title: "Fix", head: "fix/pushed" } });
    await expect(service.prepare("create_pull_request", { title: "Fix", head: "fix/local-only" }, scope([remotes.github])))
      .rejects.toMatchObject({ code: "invalid_arguments", message: expect.stringContaining("Push it") });
    await expect(service.prepare("create_pull_request", { title: "Fix", head: "someone:topic" }, scope([remotes.github])))
      .resolves.toMatchObject({ args: { head: "someone:topic" } });
    await expect(service.prepare("add_issue_comment", { number: 1, body: "Hi" }, scope([remotes.github])))
      .resolves.toEqual({ repository: repo, args: { number: 1, body: "Hi" } });
    expect(headBranchExists).toHaveBeenCalledTimes(3);
  });
  it("settles a merge's method before approval the way a to-do merge card does", async () => {
    const service = new ForgePrToolService({ enabled: () => true, clients: { github: { execute: vi.fn() }, gitlab: { execute: vi.fn() } }, defaultMergeMethod: () => "squash" });
    const merge = { number: 9, expectedHeadSha: "a".repeat(40) };
    // The project's pick beats the Settings default, so the approval names
    // the merge that runs: the agent tool used to read the default alone.
    await expect(service.prepare("merge_pull_request", merge, scope([remotes.github]), undefined, { rememberedMergeMethod: "rebase" }))
      .resolves.toEqual({ repository: repo, args: { ...merge, method: "rebase" }, mergeMethods: { offered: ["squash", "rebase", "merge"] } });
    await expect(service.prepare("merge_pull_request", merge, scope([remotes.github])))
      .resolves.toMatchObject({ args: { method: "squash" } });
    await expect(service.prepare("merge_pull_request", { ...merge, method: "merge" }, scope([remotes.github]), undefined, { rememberedMergeMethod: "rebase" }))
      .resolves.toMatchObject({ args: { method: "merge" } });
    // GitLab takes merge and squash. A rebase request is refused before the
    // operator is asked; a remembered rebase falls through to the default.
    await expect(service.prepare("merge_pull_request", merge, scope([remotes.gitlab]), undefined, { rememberedMergeMethod: "rebase" }))
      .resolves.toMatchObject({ args: { method: "squash" }, mergeMethods: { offered: ["squash", "merge"] } });
    await expect(service.prepare("merge_pull_request", { ...merge, method: "rebase" }, scope([remotes.gitlab])))
      .rejects.toMatchObject({ code: "unsupported_operation" });
  });
});
