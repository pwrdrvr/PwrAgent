import os from "node:os";
import { vi } from "vitest";
import { ForgeCiClient } from "../pr-status/forge-ci-client";
import type { ForgeRepository } from "../pr-status/forge-tool-contract";
import { GithubPrToolClient, type GhRunner } from "../pr-status/github-pr-tool-client";
import type { ForgePrToolContext } from "../pr-status/forge-pr-tool-shared";

export const repo: ForgeRepository = { provider: "github", host: "github.com", owner: "fixture", repo: "project" };
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
export const pull = (number: number, extra: Record<string, unknown> = {}) => ({
  number, node_id: `PR_${number}`, title: "Fixture change", state: "open", draft: false, body: "Body text", user: { login: "octo" },
  head: { ref: "topic", sha: "a".repeat(40), repo: { full_name: "fixture/project" } }, base: { ref: "main", sha: "b".repeat(40) },
  labels: [{ name: "bug" }], requested_reviewers: [], assignees: [], html_url: `https://github.com/fixture/project/pull/${number}`, ...extra,
});

type Call = { url: string; method: string; body?: unknown; accept?: string };
export function harness(routes: (call: Call) => Response | Promise<Response>, runGh?: GhRunner) {
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
export const ctx = (extra: Partial<ForgePrToolContext> = {}): ForgePrToolContext => ({
  repository: repo, branch: "topic", directories: [], attached: [], privateRoots: [], defaultMergeMethod: () => "squash", ...extra,
});
