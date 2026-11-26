import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { ForgeCiClient } from "../pr-status/forge-ci-client";
import type { ForgeRepository } from "../pr-status/forge-tool-contract";
import { GithubPrFetcher, installGithubMergeStackTransport } from "../pr-status/github-pr-fetcher";

const repository: ForgeRepository = { provider: "github", host: "github.com", owner: "fixture", repo: "project" };
const headSha = "a".repeat(40);

async function expectOperatorMergeWithEmptySharedBudget(number: number): Promise<void> {
  const pullRequest = `https://github.com/fixture/project/pull/${number}`;
  const path = `repos/fixture/project/pulls/${number}`;
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const route = new URL(String(input)).pathname;
    requests.push(route);
    if (route === `/${path}`) return Response.json({
      number, state: "open", created_at: "2026-11-10T00:00:00Z",
      head: { ref: "patch", sha: headSha }, base: { ref: "main", repo: { default_branch: "main" } },
    });
    if (route === "/graphql") return Response.json({ data: { repository: { pullRequest: {
      baseRefName: "main", headRefOid: headSha, timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    } } } });
    throw new Error(`Unexpected request ${route}`);
  };
  const ci = new ForgeCiClient({
    githubToken: async () => "fixture-token", gitlab: { readApi: vi.fn() }, enabled: () => true,
    takeToken: () => false, fetch: fetcher,
  });
  const runGhCommand = vi.fn(async () => ({ stdout: "" }));
  const github = new GithubPrFetcher({
    discoverGhCommands: async () => ({ selectedCommand: "/fixture/gh" }) as never,
    runGhCommand,
  });
  const uninstall = installGithubMergeStackTransport(ci);
  try {
    await expect(ci.requestGithub(repository, { path })).rejects.toMatchObject({ code: "rate_limited" });
    await expect(github.mergePullRequest({ pullRequest, method: "squash", checkStackOrder: true }))
      .resolves.toMatchObject({ mergedUrl: pullRequest });
    expect(requests).toEqual([`/${path}`, "/graphql"]);
    expect(runGhCommand).toHaveBeenCalledExactlyOnceWith("/fixture/gh", ["pr", "merge", pullRequest, "--squash"], { timeout: 60_000 });
  } finally {
    uninstall();
  }
}

it("allows a direct merge to check stack order with an empty shared budget", async () => {
  // Polling and agent requests cannot consume the capacity that runs both stack checks for a click.
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 100_000 }), expectOperatorMergeWithEmptySharedBudget));
});

it("squash-merges an unstacked pull request when polling has exhausted the shared budget", async () => {
  await expectOperatorMergeWithEmptySharedBudget(1);
});

it("bounds the operator reserve and falls back to the shared budget when needed", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 1, max: 6 }), async (sharedTokens, refillTokens) => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let remainingShared = sharedTokens;
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
    const ci = new ForgeCiClient({
      githubToken: async () => "fixture-token", gitlab: { readApi: vi.fn() }, enabled: () => true,
      takeToken: () => {
        if (remainingShared === 0) return false;
        remainingShared--;
        return true;
      },
      fetch: fetcher,
    });
    const request = { path: "repos/fixture/project/pulls/1" };
    try {
      // The reserve supplies 20 requests at a fixed instant. Shared tokens
      // are only spent after those 20, and exhausting both refuses admission.
      for (let read = 0; read < 20; read++) {
        await ci.requestGithubForOperatorMergePreflight(repository, request);
      }
      expect(remainingShared).toBe(sharedTokens);
      for (let read = 0; read < sharedTokens; read++) {
        await ci.requestGithubForOperatorMergePreflight(repository, request);
      }
      await expect(ci.requestGithubForOperatorMergePreflight(repository, request)).rejects.toMatchObject({ code: "rate_limited" });
      expect(fetcher).toHaveBeenCalledTimes(20 + sharedTokens);

      now += refillTokens * 3_000;
      for (let read = 0; read < refillTokens; read++) {
        await ci.requestGithubForOperatorMergePreflight(repository, request);
      }
      await expect(ci.requestGithubForOperatorMergePreflight(repository, request)).rejects.toMatchObject({ code: "rate_limited" });
      expect(fetcher).toHaveBeenCalledTimes(20 + sharedTokens + refillTokens);
    } finally {
      clock.mockRestore();
    }
  }));
});

it("honors a provider cooldown started by a shared request", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 429, headers: { "retry-after": "60" } }));
  const ci = new ForgeCiClient({
    githubToken: async () => "fixture-token", gitlab: { readApi: vi.fn() }, enabled: () => true,
    takeToken: () => true, fetch: fetcher,
  });
  const request = { path: "repos/fixture/project/pulls/1" };
  await expect(ci.requestGithub(repository, request)).rejects.toMatchObject({ code: "rate_limited" });
  await expect(ci.requestGithubForOperatorMergePreflight(repository, request))
    .rejects.toMatchObject({ code: "rate_limited", message: expect.stringContaining("Provider cooldown is active") });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
