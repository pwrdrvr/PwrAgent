import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForgeCiClient } from "../pr-status/forge-ci-client";
import type { ForgeRepository } from "../pr-status/forge-tool-contract";

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
