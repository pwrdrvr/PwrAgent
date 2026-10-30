import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FORGE_AGENT_TOOL_POLICY, FORGE_AGENT_WRITE_TOOL_GROUPS, permissionForDynamicTool, type ForgeAgentToolPolicy } from "@pwragent/shared";
import { ForgeCiClient } from "../pr-status/forge-ci-client";
import { ForgeReadError, type ForgeRepository } from "../pr-status/forge-tool-contract";
import { GithubPrToolClient, type GhRunner } from "../pr-status/github-pr-tool-client";
import { validateForgeAttachments, type ForgePrToolContext } from "../pr-status/forge-pr-tool-shared";
import { FORGE_PR_WRITE_OPERATIONS, forgePrToolGroup, validateForgePrToolArgs } from "../pr-status/forge-pr-tool-contract";
import { ForgePrToolService } from "../pr-status/forge-pr-tool-service";
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

describe("GitHub tool contract", () => {
  it("rejects unknown fields, missing requirements and cross-repository search", () => {
    expect(() => validateForgePrToolArgs("create_pull_request", { title: "x", threadId: "other" })).toThrow(/Unknown argument/);
    expect(() => validateForgePrToolArgs("merge_pull_request", { number: 1 })).toThrow(/requires expectedHeadSha/);
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
});

describe("GitHub tool client", () => {
  it.each(["github.com", "github.example.test"])("requests only failed jobs through %s and accepts an empty 201 response", async (host) => {
    const { calls, client } = harness(() => new Response(null, { status: 201 }));
    const result = await client.execute("rerun_failed_ci_jobs", { runId: 42 }, ctx({ repository: { ...repo, host } }));
    const root = host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
    expect(calls).toEqual([{ url: `${root}/repos/fixture/project/actions/runs/42/rerun-failed-jobs`, method: "POST", body: undefined, accept: "application/vnd.github+json" }]);
    expect(result).toMatchObject({ requested: true, runId: 42, providerRequests: 1, scope: "failed_jobs_and_dependents", url: `https://${host}/fixture/project/actions/runs/42` });
  });

  it("returns a refused rerun without falling back to rerunning the whole workflow", async () => {
    const { calls, client } = harness(() => json({ message: "This workflow run cannot be rerun." }, 403));
    await expect(client.execute("rerun_failed_ci_jobs", { runId: 42 }, ctx())).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("cannot be rerun") });
    expect(calls).toHaveLength(1);
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
    const { calls, client } = harness(() => json({ message: "Head branch was modified. Review and try the merge again." }, 409));
    await expect(client.execute("merge_pull_request", { number: 9, expectedHeadSha: "c".repeat(40) }, ctx())).rejects.toMatchObject({ code: "head_changed" });
    expect(calls[0]).toMatchObject({ method: "PUT", body: { merge_method: "squash", sha: "c".repeat(40) } });
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
});
