import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForgeCiClient } from "../pr-status/forge-ci-client";
import type { ForgeRepository } from "../pr-status/forge-tool-contract";
import { GitLabPrFetcher } from "../pr-status/gitlab-pr-fetcher";

/*
 * The admission a forge read promises (`ForgeCiClient.admit`):
 *
 *   1. No request reaches GitHub while the host's cooldown is active. A 429,
 *      or a 403 that reports an exhausted limit, starts a cooldown that lasts
 *      at least a minute and at least until the provider's Retry-After or
 *      reset time. A later success or an explained refusal never shortens it.
 *   2. A refused admission spends nothing: every shared-budget token taken
 *      is one request sent.
 *
 * The oracle is the cooldown deadline computed from the responses the fake
 * GitHub returned, not read from the client.
 */
afterEach(() => vi.restoreAllMocks());

const REPO: ForgeRepository = { provider: "github", host: "github.com", owner: "example", repo: "project" };
const START = Date.parse("2026-11-11T12:00:00Z");

const enterprise = vi.hoisted(() => ({ host: "", login: "" }));

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: () => ({
    resolveGithubEnterpriseHosts: () => [enterprise.host],
    resolveGithubEnterpriseAccount: () => enterprise.login,
  }),
}));

it("binds enterprise approval preflight and write to one credential and refuses account changes", async () => {
  await fc.assert(fc.asyncProperty(fc.nat(), fc.boolean(), async (id, changed) => {
    enterprise.host = `ghe${id}.example.com`;
    enterprise.login = "reviewer";
    const githubToken = vi.fn(async () => `fixture-${enterprise.login}`);
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      expect(new Headers(options.headers).get("authorization")).toBe("Bearer fixture-reviewer");
      return Response.json({});
    });
    const client = new ForgeCiClient({
      fetch: fetcher as unknown as typeof fetch, githubToken, gitlab: { readApi: vi.fn() },
      enabled: () => true, takeToken: () => true,
    });
    const repository = { ...REPO, host: enterprise.host };
    const approval = client.withCiDeploymentCredential(async (request) => {
      await request(repository, { path: "example/preflight" });
      if (changed) enterprise.login = "new-reviewer";
      return await request(repository, { path: "example/approve", method: "POST" });
    });
    if (changed) await expect(approval).rejects.toThrow("account changed during approval");
    else await expect(approval).resolves.toEqual({});
    expect(githubToken).toHaveBeenCalledExactlyOnceWith(enterprise.host);
    expect(fetcher).toHaveBeenCalledTimes(changed ? 1 : 2);
  }));
});

const response = fc.oneof(
  fc.constant({ kind: "ok" as const }),
  fc.constant({ kind: "not-found" as const }),
  fc.constant({ kind: "server-error" as const }),
  fc.integer({ min: 1, max: 600 }).map((seconds) => ({ kind: "retry-after" as const, seconds })),
  fc.integer({ min: -120, max: 900 }).map((seconds) => ({ kind: "reset" as const, seconds })),
);
const step = fc.record({
  advance: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 30_000 }), fc.integer({ min: 0, max: 400_000 })),
  response,
  budget: fc.boolean(),
});

describe("Forge CI client cooldown (model)", () => {
  it("skips a cancelled waiter and applies a new cooldown before spending queued tokens", async () => {
    const rateLimited = Promise.withResolvers<Response>();
    const holds = Promise.withResolvers<void>();
    const saturated = Promise.withResolvers<void>();
    const paths: string[] = [];
    const takeToken = vi.fn(() => true);
    const client = new ForgeCiClient({
      githubToken: async () => "fixture-token", gitlab: { readApi: vi.fn() },
      enabled: () => true, takeToken,
      fetch: async (input) => {
        const path = new URL(String(input)).pathname.split("/").at(-1)!;
        paths.push(path);
        if (paths.length === 3) saturated.resolve();
        if (path === "first") return await rateLimited.promise;
        if (path === "held") await holds.promise;
        return Response.json({});
      },
    });
    const first = client.requestGithub(REPO, { path: "first" });
    const held = [client.requestGithub(REPO, { path: "held" }), client.requestGithub(REPO, { path: "held" })];
    await saturated.promise;
    const controller = new AbortController();
    const cancelled = client.requestGithub(REPO, { path: "cancelled" }, controller.signal);
    const cooled = client.requestGithub(REPO, { path: "cooled" });
    const otherHost = client.requestGithub({ ...REPO, host: "ghe.example.com" }, { path: "other" });
    const cancelledCheck = expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    const cooledCheck = expect(cooled).rejects.toMatchObject({
      code: "rate_limited", message: expect.stringContaining("Provider cooldown is active"),
    });
    const otherCheck = expect(otherHost).resolves.toEqual({});
    const firstCheck = expect(first).rejects.toMatchObject({ code: "rate_limited" });

    controller.abort();
    expect(takeToken).toHaveBeenCalledTimes(3);
    rateLimited.resolve(new Response(null, { status: 429 }));
    await Promise.all([firstCheck, cancelledCheck, cooledCheck, otherCheck]);
    expect(paths).toEqual(["first", "held", "held", "other"]);
    expect(takeToken).toHaveBeenCalledTimes(4);
    holds.resolve();
    await Promise.all(held);
  });

  it("can start a GitLab read as soon as the local budget permits it", async () => {
    let budgetAvailable = false;
    const run = vi.fn(async () => "{}");
    const gitlab = new GitLabPrFetcher({
      discover: async () => ({ candidates: [], selectedCommand: "/fixture/glab" }),
      tryTakeRequestToken: () => budgetAvailable,
      run,
    });
    const client = new ForgeCiClient({ gitlab, enabled: () => true, takeToken: () => true });
    const repository: ForgeRepository = { ...REPO, provider: "gitlab", host: "gitlab.com" };
    await expect(client.readGitlab(repository, "fixture")).rejects.toMatchObject({ code: "rate_limited" });
    expect(run).not.toHaveBeenCalled();

    budgetAvailable = true;
    await expect(client.readGitlab(repository, "fixture")).resolves.toEqual({});
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps the longest retry deadline across overlapping provider responses", async () => {
    let now = START;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const slowerResponse = Promise.withResolvers<Response>();
    const sent = Promise.withResolvers<void>();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/slow")) {
        sent.resolve();
        return await slowerResponse.promise;
      }
      return new Response(null, { status: 429, headers: { "retry-after": "120" } });
    });
    const client = new ForgeCiClient({
      fetch: fetcher, githubToken: async () => "fixture-token", gitlab: { readApi: vi.fn() },
      enabled: () => true, takeToken: () => true,
    });
    const slower = client.requestGithub(REPO, { path: "slow" });
    await sent.promise;
    await expect(client.requestGithub(REPO, { path: "fast" })).rejects.toMatchObject({ code: "rate_limited" });
    slowerResponse.resolve(new Response(null, { status: 429, headers: { "retry-after": "60" } }));
    await expect(slower).rejects.toMatchObject({ code: "rate_limited" });

    now += 90_000;
    await expect(client.requestGithub(REPO, { path: "retry" })).rejects.toMatchObject({
      code: "rate_limited", message: expect.stringContaining(new Date(START + 120_000).toISOString()),
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("sends nothing during a cooldown and spends a token only on a sent request", async () => {
    await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 30 }), async (steps) => {
      let now = START;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      let next = steps[0]!;
      let sent = 0;
      let tokensTaken = 0;
      // The deadline the promise sets, from the responses alone.
      let cooldownUntil = Number.NEGATIVE_INFINITY;
      // The client catches what the fetcher throws, so record and assert after.
      const early: number[] = [];
      const fetcher = vi.fn(async () => {
        if (now < cooldownUntil) early.push(cooldownUntil - now);
        sent += 1;
        const reply = next.response;
        if (reply.kind === "ok") return new Response("{}", { status: 200 });
        if (reply.kind === "not-found") return new Response("{}", { status: 404 });
        cooldownUntil = Math.max(cooldownUntil, now + 60_000);
        if (reply.kind === "server-error") return new Response("{}", { status: 502 });
        if (reply.kind === "retry-after") {
          cooldownUntil = Math.max(cooldownUntil, now + reply.seconds * 1000);
          return new Response("{}", { status: 429, headers: { "retry-after": String(reply.seconds) } });
        }
        const reset = Math.floor(now / 1000) + reply.seconds;
        cooldownUntil = Math.max(cooldownUntil, reset * 1000);
        return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } });
      });
      const client = new ForgeCiClient({
        fetch: fetcher as unknown as typeof fetch,
        githubToken: async () => "fixture-token",
        gitlab: { readApi: vi.fn() },
        enabled: () => true,
        takeToken: () => {
          if (!next.budget) return false;
          tokensTaken += 1;
          return true;
        },
      });
      for (const item of steps) {
        now += item.advance;
        next = item;
        await client.requestGithub(REPO, { path: "repos/example/project/actions/runs" }).catch(() => undefined);
        expect(early, "a request went out during the cooldown").toEqual([]);
        expect(tokensTaken, "a refused admission spent a token").toBe(sent);
      }
    }));
  });
});
