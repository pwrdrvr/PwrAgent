import { describe, expect, it, vi } from "vitest";
import { ForgeCiClient, redactForgeLog } from "../pr-status/forge-ci-client";
import { GitLabPrFetcher } from "../pr-status/gitlab-pr-fetcher";
import { FORGE_LOG_MAX_BYTES } from "../pr-status/forge-read-limits";
import { ForgeReadService } from "../pr-status/forge-read-service";
import { type ForgeReadArgs, type ForgeRepository } from "../pr-status/forge-tool-contract";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import { searchPwrAgentTools } from "../agent-tools/pwragent-tool-search";
import { buildForgeReadToolDefinitions } from "../agent-tools/pwragent-forge-agent-tools";

const sha = "a".repeat(40);
const github: ForgeRepository = { provider: "github", host: "github.com", owner: "fixture", repo: "project" };
const gitlab: ForgeRepository = { provider: "gitlab", host: "code.example.test", owner: "team/sub", repo: "project" };
const context = { backend: "codex" as const, threadId: "fixture", transport: "mcp" as const };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function githubClient(fetcher: typeof fetch, enabled = () => true) {
  return new ForgeCiClient({ fetch: fetcher, githubToken: async () => "fixture-token", gitlab: { readApi: vi.fn() }, enabled, takeToken: () => true });
}
function gitlabClient(run: (command: string, args: string[]) => Promise<string>) {
  const transport = new GitLabPrFetcher({ discover: async () => ({ selectedCommand: "glab-fixture", candidates: [], checkedAt: 0 }), run });
  return new ForgeCiClient({ gitlab: transport, enabled: () => true, takeToken: () => true });
}

describe("individual checks and artifact contracts", () => {
  it.each([["commit checks status contexts", "get_commit_checks"], ["GitHub Actions artifact metadata", "list_ci_artifacts"]])("discovers %s", (query, name) => {
    const tools = resolveAgentToolCatalogs({}).flatMap((catalog) => catalog.dynamicTools);
    const found = searchPwrAgentTools(tools, query).find((tool) => tool.name === name);
    expect(found?.inputSchema).toMatchObject({ additionalProperties: false, required: [name === "get_commit_checks" ? "headSha" : "runId"] });
  });

  it.each(["mcp", "native"])("normal %s calls reach authenticated checks and artifact adapters", async (transport) => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).includes("check-runs")
      ? json({ check_runs: [] }) : String(url).includes("/status?") ? json({ statuses: [] }) : json({ artifacts: [] }));
    let enabled = true;
    const service = new ForgeReadService({ enabled: () => enabled, ci: githubClient(fetcher), refresh: vi.fn() });
    const catalog = resolveAgentToolCatalogs({ forgeReadHandler: (operation, args) => service.execute(operation, args, { remotes: [github], attached: [], observations: [] }) }).find((c) => c.id === "forge")!;
    const invoke = async (tool: string, args: ForgeReadArgs) => {
      const response = transport === "mcp"
        ? await catalog.router.handleMcpToolCall({ backend: "acp:fixture", threadId: "fixture", tool, args })
        : await catalog.router.handleDynamicToolCall({ backend: "codex", call: { namespace: "pwragent", tool, arguments: args, threadId: "fixture", turnId: "turn", callId: "call" } });
      if ("contentItems" in response) {
        const content = response.contentItems.find((item) => item.type === "inputText");
        return JSON.parse(content!.text);
      }
      return response.structuredContent;
    };
    expect(await invoke("get_commit_checks", { headSha: sha })).toMatchObject({ checks: [] });
    expect(await invoke("list_ci_artifacts", { runId: 9 })).toMatchObject({ artifacts: [] });
    expect(fetcher).toHaveBeenCalledTimes(3);
    enabled = false;
    expect(JSON.stringify(await invoke("get_commit_checks", { headSha: sha }))).toContain("provider_disabled");
    expect(JSON.stringify(await invoke("list_ci_artifacts", { runId: 9 }))).toContain("provider_disabled");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("combines independently paged GitHub check runs and status contexts without an overall passing claim", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).includes("check-runs") ? json({ check_runs: [{ id: 1, name: "security", status: "completed", conclusion: "failure", output: { title: "Failed", summary: "ERROR password=\"fixture secret\"", annotations_count: 3 } }] }) : json({ state: "success", statuses: [] }));
    const result = await githubClient(fetcher).execute("get_commit_checks", { ...github, host: "ghe.example.test" }, { headSha: sha, page: 2, perPage: 1 });
    expect(result).toMatchObject({ headSha: sha, providerRequests: 2, checks: [{ kind: "check_run", annotationsCount: 3, summary: "ERROR password=[REDACTED]" }], statuses: [], failedChecks: [{ id: 1 }], checksNextPage: 3, statusesNextPage: null, nextPage: 3 });
    expect(result).not.toHaveProperty("state");
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `https://ghe.example.test/api/v3/repos/fixture/project/commits/${sha}/check-runs?page=2&per_page=1&filter=latest`,
      `https://ghe.example.test/api/v3/repos/fixture/project/commits/${sha}/status?page=2&per_page=1`,
    ]);
    expect(JSON.stringify(result)).not.toContain("fixture secret");
  });

  it("does not turn a failed or malformed statuses lookup into an empty success", async () => {
    for (const response of [() => json({ message: "private upstream body" }, 403), () => json({})]) {
      const fetcher = vi.fn<typeof fetch>(async (url) => String(url).includes("check-runs") ? json({ check_runs: [] }) : response());
      await expect(githubClient(fetcher).execute("get_commit_checks", github, { headSha: sha })).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it("reports external GitHub status failures independently of check runs", async () => {
    const ci = githubClient(vi.fn<typeof fetch>(async (url) => String(url).includes("check-runs")
      ? json({ check_runs: [] })
      : json({ statuses: [{ id: 6, context: "external/security", state: "error", description: "Scanner unavailable" }] })));
    expect(await ci.execute("get_commit_checks", github, { headSha: sha, perPage: 1 })).toMatchObject({
      checks: [], statuses: [{ kind: "status_context", name: "external/security", status: "error" }],
      failedChecks: [{ id: 6 }], checksNextPage: null, statusesNextPage: 2,
    });
  });

  it("rechecks provider enablement between check collections", async () => {
    let enabled = true;
    const fetcher = vi.fn<typeof fetch>(async () => { enabled = false; return json({ check_runs: [] }); });
    await expect(githubClient(fetcher, () => enabled).execute("get_commit_checks", github, { headSha: sha })).rejects.toMatchObject({ code: "provider_disabled" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("lists paginated artifact metadata and preserves expiry without downloading content", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ artifacts: [{ id: 12, name: "test-report", size_in_bytes: 100, expired: true, expires_at: "2026-10-01T00:00:00Z", archive_download_url: "https://private.example/download?secret=hidden" }] }));
    expect(await githubClient(fetcher).execute("list_ci_artifacts", github, { runId: 9, page: 2, perPage: 1 })).toMatchObject({ providerRequests: 1, artifacts: [{ id: 12, name: "test-report", sizeBytes: 100, expired: true, url: "https://github.com/fixture/project/actions/runs/9/artifacts/12" }], nextPage: 3, paginationUnit: "artifacts" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://api.github.com/repos/fixture/project/actions/runs/9/artifacts?page=2&per_page=1");
  });

  it("uses nested GitLab project paths and pages jobs even when their artifact lists are empty", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => args.at(-1)!.includes("/statuses?")
      ? JSON.stringify([{ id: 5, name: "external CI", status: "failed", sha, allow_failure: true }])
      : JSON.stringify([{ id: 10, artifacts: [] }, { id: 11, artifacts: [{ filename: "report.xml", file_type: "junit", size: 120 }], artifacts_expire_at: "2026-11-01T00:00:00Z" }]));
    const ci = gitlabClient(run);
    expect(await ci.execute("get_commit_checks", gitlab, { headSha: sha, branch: "topic/test", page: 2, perPage: 1 })).toMatchObject({ providerRequests: 1, checks: [], statuses: [{ name: "external CI", status: "failed", allowFailure: true }], nextPage: 3 });
    expect(run.mock.calls[0]![1]).toEqual(["api", "--hostname", gitlab.host, "--method", "GET", "--include", `projects/team%2Fsub%2Fproject/repository/commits/${sha}/statuses?page=2&per_page=1&ref=topic%2Ftest&all=false`]);
    const result = await ci.execute("list_ci_artifacts", gitlab, { runId: 9, perPage: 2 });
    expect(result).toMatchObject({ artifacts: [{ jobId: 11, name: "report.xml", fileType: "junit", sizeBytes: 120 }], artifactsTruncated: false, nextPage: 2, paginationUnit: "jobs" });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("bounds unusually large GitLab artifact inventories explicitly", async () => {
    const ci = gitlabClient(async () => JSON.stringify([{ id: 1, artifacts: Array.from({ length: 105 }, (_, i) => ({ filename: `file-${i}`, size: 1 })) }]));
    const result = await ci.execute("list_ci_artifacts", gitlab, { runId: 9 }) as { artifacts: unknown[]; artifactsTruncated: boolean };
    expect(result.artifacts).toHaveLength(100);
    expect(result.artifactsTruncated).toBe(true);
  });

  it("validates required immutable identities and log cursors before accessing the provider", async () => {
    const handler = vi.fn();
    const definitions = buildForgeReadToolDefinitions(handler);
    for (const [tool, args] of [["get_commit_checks", {}], ["get_commit_checks", { headSha: "main" }], ["list_ci_artifacts", {}], ["read_ci_job_log", { jobId: 1, beforeChar: 5 }], ["read_ci_job_log", { jobId: 1, logSnapshot: sha }]] as const) {
      expect(await definitions.find((d) => d.name === tool)!.dispatch(args, context)).toMatchObject({ ok: false, code: "invalid_arguments" });
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("bounded large log reads", () => {
  type LogPage = { log: { text: string; next: { beforeChar: number; logSnapshot: string } | null; totalChars: number; startChar: number; endChar: number } };
  const ghJob = { id: 2, status: "completed", conclusion: "failure" };

  it.each(["github", "gitlab"] as const)("reads %s logs larger than 2 MiB while returning only a bounded page", async (provider) => {
    const log = "ordinary output\n".repeat(150_000) + "ERROR PASSWORD=\"fixture secret\"\n";
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith("/jobs/2") ? json(ghJob) : new Response(log));
    const ci = provider === "github" ? githubClient(fetcher) : gitlabClient(async (_command, args) => args.at(-1)!.endsWith("/trace") ? log : JSON.stringify({ id: 2, status: "failed" }));
    const result = await ci.execute("read_ci_job_log", provider === "github" ? github : gitlab, { jobId: 2, maxChars: 100 }) as LogPage;
    expect(result.log.text).toHaveLength(100);
    expect(result.log.text).toContain("PASSWORD=[REDACTED]");
    expect(result.log.totalChars).toBeGreaterThan(2 * 1024 * 1024);
    expect(result.log.next).not.toBeNull();
  });

  it("pages backwards through already-redacted text without gaps and rejects changed snapshots", async () => {
    let raw = "first line\nPASSWORD=\"secret with whitespace\"\nERROR final line\n";
    const ci = githubClient(vi.fn<typeof fetch>(async (url) => String(url).endsWith("/jobs/2") ? json(ghJob) : new Response(raw)));
    let page = await ci.execute("read_ci_job_log", github, { jobId: 2, maxChars: 12 }) as LogPage;
    const cursor = page.log.next!;
    let combined = page.log.text;
    while (page.log.next) {
      const end = page.log.startChar;
      page = await ci.execute("read_ci_job_log", github, { jobId: 2, maxChars: 12, ...page.log.next }) as LogPage;
      expect(page.log.endChar).toBe(end);
      combined = page.log.text + combined;
    }
    expect(combined).toBe(redactForgeLog(raw));
    expect(combined).not.toContain("secret with whitespace");
    raw += "more output\n";
    await expect(ci.execute("read_ci_job_log", github, { jobId: 2, ...cursor })).rejects.toMatchObject({ code: "log_changed" });
  });

  it.each(["github", "gitlab"] as const)("refuses %s logs beyond the hard download budget", async (provider) => {
    const raw = "x".repeat(FORGE_LOG_MAX_BYTES + 1);
    const ci = provider === "github"
      ? githubClient(vi.fn<typeof fetch>(async (url) => String(url).endsWith("/jobs/2") ? json(ghJob) : new Response(raw)))
      : gitlabClient(async (_command, args) => args.at(-1)!.endsWith("/trace") ? raw : JSON.stringify({ id: 2, status: "failed" }));
    await expect(ci.execute("read_ci_job_log", provider === "github" ? github : gitlab, { jobId: 2 })).rejects.toMatchObject({ code: "response_too_large" });
  });
});
