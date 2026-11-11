import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type {
  MessagingDeliveryScope,
  MessagingRateLimitInfo,
} from "@pwragent/messaging-interface";
import { MessagingDeliveryBudget } from "../messaging/core/messaging-delivery-budget";

describe("MessagingDeliveryBudget", () => {
  it("admits traffic under budget and reserves capacity for final turns", () => {
    let now = 1_000;
    const budget = new MessagingDeliveryBudget({ now: () => now });
    const scope = testScope({ limit: 3, reserved: 1 });

    expect(budget.admit({ scope, priority: "routine_status" })).toMatchObject({
      outcome: "admitted",
    });
    expect(budget.admit({ scope, priority: "tool_progress" })).toMatchObject({
      outcome: "admitted",
    });
    expect(budget.admit({ scope, priority: "stream_partial" })).toMatchObject({
      outcome: "dropped",
      reason: "budget-exhausted",
      slowMode: true,
    });
    expect(budget.admit({ scope, priority: "final_turn" })).toMatchObject({
      outcome: "admitted",
      slowMode: true,
    });

    now += 60_001;
    expect(budget.admit({ scope, priority: "stream_partial" })).toMatchObject({
      outcome: "admitted",
    });
  });

  it("enters cool-off after a provider rate limit and then slow mode", () => {
    let now = 10_000;
    const budget = new MessagingDeliveryBudget({ now: () => now });
    const scope = testScope({ limit: 20, reserved: 5 });

    budget.recordRateLimit({
      scope,
      retryAfterMs: 16_000,
      observedAt: now,
    });

    expect(budget.admit({ scope, priority: "stream_partial" })).toEqual({
      outcome: "dropped",
      reason: "cool-off",
      slowMode: true,
    });
    expect(budget.admit({ scope, priority: "final_turn" })).toEqual({
      outcome: "deferred",
      reason: "cool-off",
      retryAt: 28_000,
      slowMode: true,
    });

    now = 28_001;
    expect(budget.admit({ scope, priority: "tool_progress" })).toEqual({
      outcome: "dropped",
      reason: "slow-mode",
      slowMode: true,
    });
    expect(budget.admit({ scope, priority: "final_turn" })).toMatchObject({
      outcome: "admitted",
      slowMode: true,
    });
  });

  it("checks cool-off and slow mode for non-consuming activity", () => {
    let now = 10_000;
    const budget = new MessagingDeliveryBudget({ now: () => now });
    const scope = testScope({ limit: 20, reserved: 5 });

    budget.recordRateLimit({
      scope,
      retryAfterMs: 16_000,
      observedAt: now,
    });

    expect(
      budget.admit({
        consumeCapacity: false,
        scope,
        priority: "routine_status",
      }),
    ).toEqual({
      outcome: "dropped",
      reason: "cool-off",
      slowMode: true,
    });

    now = 28_001;
    expect(
      budget.admit({
        consumeCapacity: false,
        scope,
        priority: "routine_status",
      }),
    ).toEqual({
      outcome: "dropped",
      reason: "slow-mode",
      slowMode: true,
    });
  });

  it("does not consume capacity for non-consuming activity", () => {
    const budget = new MessagingDeliveryBudget({ now: () => 1_000 });
    const scope = testScope({ limit: 1, reserved: 0 });

    expect(
      budget.admit({
        consumeCapacity: false,
        scope,
        priority: "routine_status",
      }),
    ).toMatchObject({
      outcome: "admitted",
      slowMode: false,
    });
    expect(budget.admit({ scope, priority: "routine_status" })).toMatchObject({
      outcome: "admitted",
      slowMode: false,
    });
  });

  it("enters slow mode when the local budget is exhausted", () => {
    let now = 1_000;
    const budget = new MessagingDeliveryBudget({ now: () => now });
    const scope = testScope({ limit: 1, reserved: 0 });

    expect(budget.admit({ scope, priority: "routine_status" })).toMatchObject({
      outcome: "admitted",
      slowMode: false,
    });
    expect(budget.admit({ scope, priority: "routine_status" })).toEqual({
      outcome: "dropped",
      reason: "budget-exhausted",
      slowMode: true,
    });
    expect(budget.admit({ scope, priority: "stream_partial" })).toEqual({
      outcome: "dropped",
      reason: "slow-mode",
      slowMode: true,
    });
    expect(budget.admit({ scope, priority: "final_turn" })).toEqual({
      outcome: "deferred",
      reason: "budget-exhausted",
      retryAt: 61_000,
      slowMode: true,
    });

    now = 61_001;
    expect(budget.admit({ scope, priority: "routine_status" })).toMatchObject({
      outcome: "admitted",
      slowMode: false,
    });
  });

  it("allows bursts within a sliding minute budget", () => {
    let now = 1_000;
    const budget = new MessagingDeliveryBudget({ now: () => now });
    const scope = testScope({ limit: 60, reserved: 0 });

    for (let index = 0; index < 20; index += 1) {
      now = 1_000 + (index * 500);
      expect(budget.admit({ scope, priority: "routine_status" })).toEqual({
        outcome: "admitted",
        slowMode: false,
      });
    }

    expect(budget.isScopeInSlowMode(scope)).toBe(false);
  });

  it("enters slow mode when a sliding minute budget is exhausted", () => {
    let now = 1_000;
    const budget = new MessagingDeliveryBudget({ now: () => now });
    const scope = testScope({ limit: 60, reserved: 0 });

    for (let index = 0; index < 60; index += 1) {
      now = 1_000 + (index * 500);
      expect(budget.admit({ scope, priority: "routine_status" })).toEqual({
        outcome: "admitted",
        slowMode: false,
      });
    }

    now = 31_000;
    expect(budget.admit({ scope, priority: "routine_status" })).toEqual({
      outcome: "dropped",
      reason: "budget-exhausted",
      slowMode: true,
    });
    expect(budget.admit({ scope, priority: "stream_partial" })).toEqual({
      outcome: "dropped",
      reason: "slow-mode",
      slowMode: true,
    });
  });

  it("admits a normal Slack turn burst without slow mode but throttles at the minute total", () => {
    let now = 1_000;
    const budget = new MessagingDeliveryBudget({ now: () => now });
    // The Slack channel budget shape produced by rateLimitScopeForTarget.
    const scope: MessagingDeliveryScope = {
      platform: "slack",
      id: "slack:channel:C012ABCDEF0",
      kind: "channel",
      budget: { limit: 30, intervalMs: 60_000, reserved: 5 },
    };

    // A single agent turn's burst: status update, streaming partial, then the
    // final assistant message — all within ~1s. None should trip slow mode.
    expect(budget.admit({ scope, priority: "routine_status" })).toMatchObject({
      outcome: "admitted",
      slowMode: false,
    });
    now = 1_200;
    expect(budget.admit({ scope, priority: "stream_partial" })).toMatchObject({
      outcome: "admitted",
      slowMode: false,
    });
    now = 1_400;
    expect(budget.admit({ scope, priority: "final_turn" })).toMatchObject({
      outcome: "admitted",
      slowMode: false,
    });
    expect(budget.isScopeInSlowMode(scope)).toBe(false);

    // Fill the non-reserved capacity (25 = limit 30 - reserved 5) with chatter.
    for (let sent = 3; sent < 25; sent += 1) {
      now += 100;
      expect(budget.admit({ scope, priority: "routine_status" })).toMatchObject({
        outcome: "admitted",
      });
    }

    // Chatter beyond the non-reserved capacity is dropped and arms slow mode,
    // but the reserved slots still admit the final answer.
    now += 100;
    expect(budget.admit({ scope, priority: "routine_status" })).toMatchObject({
      outcome: "dropped",
      reason: "budget-exhausted",
    });
    expect(budget.admit({ scope, priority: "final_turn" })).toMatchObject({
      outcome: "admitted",
    });
  });

  it("defers to the next window, not the slow-mode floor, when capacity frees sooner", () => {
    let now = 1_000;
    const budget = new MessagingDeliveryBudget({ now: () => now });
    // A short 1s window frees capacity well before the 5s slow-mode floor.
    const scope: MessagingDeliveryScope = {
      platform: "telegram",
      id: "telegram:group:short-window",
      kind: "group",
      budget: { limit: 1, intervalMs: 1_000, reserved: 0 },
    };

    expect(budget.admit({ scope, priority: "routine_status" })).toMatchObject({
      outcome: "admitted",
    });

    // Deferred retry points at the next window (2_000 = oldest 1_000 + 1_000),
    // even though slow mode is armed for the full 5s floor.
    expect(budget.admit({ scope, priority: "final_turn" })).toEqual({
      outcome: "deferred",
      reason: "budget-exhausted",
      retryAt: 2_000,
      slowMode: true,
    });

    // Slow mode still holds until the 5s floor (1_000 + 5_000).
    now = 4_999;
    expect(budget.isScopeInSlowMode(scope)).toBe(true);
    now = 6_001;
    expect(budget.isScopeInSlowMode(scope)).toBe(false);
  });

  it("keeps independent scopes from throttling each other", () => {
    const budget = new MessagingDeliveryBudget({ now: () => 1_000 });
    const first = testScope({ id: "telegram:group:1", limit: 1, reserved: 0 });
    const second = testScope({ id: "telegram:group:2", limit: 1, reserved: 0 });

    expect(budget.admit({ scope: first, priority: "routine_status" }))
      .toMatchObject({ outcome: "admitted" });
    expect(budget.admit({ scope: first, priority: "routine_status" }))
      .toMatchObject({ outcome: "dropped" });
    expect(budget.admit({ scope: second, priority: "routine_status" }))
      .toMatchObject({ outcome: "admitted" });
  });
});

function testScope(options: {
  id?: string;
  limit: number;
  reserved: number;
}): MessagingDeliveryScope {
  return {
    platform: "telegram",
    id: options.id ?? "telegram:supergroup:-1003841603622",
    kind: "group",
    budget: {
      limit: options.limit,
      intervalMs: 60_000,
      reserved: options.reserved,
    },
  };
}

// Model: a scope is in cool-off while any recorded limit covers it. A limit
// covers its own scope, and with `appliesTo: "bucket"` every scope with the
// same platform and bucketId. Nothing else is covered.
describe("MessagingDeliveryBudget bucket cool-offs", () => {
  const SAFETY_BUFFER_MS = 2_000;
  const SCOPES: MessagingDeliveryScope[] = [
    { platform: "mattermost", id: "mattermost:channel:a", kind: "channel", bucketId: "bot" },
    { platform: "mattermost", id: "mattermost:channel:b", kind: "channel", bucketId: "bot" },
    { platform: "mattermost", id: "mattermost:channel:c", kind: "channel" },
    { platform: "line", id: "line:a", kind: "dm", bucketId: "bot" },
    { platform: "line", id: "line:b", kind: "group", bucketId: "other-bot" },
    { platform: "discord", id: "discord:channel:a", kind: "channel", bucketId: "bot" },
  ];

  type Limit = { at: number; appliesTo?: "scope" | "bucket"; retryAfterMs: number; scope: number };

  function covers(limit: Limit, scope: MessagingDeliveryScope): boolean {
    const limited = SCOPES[limit.scope]!;
    if (limited.id === scope.id) return true;
    return (
      limit.appliesTo === "bucket"
      && limited.bucketId !== undefined
      && limited.platform === scope.platform
      && limited.bucketId === scope.bucketId
    );
  }

  it("admits a scope exactly when no covering limit is still cooling off", () => {
    const limitArb = fc.record({
      at: fc.integer({ min: 0, max: 600_000 }),
      appliesTo: fc.constantFrom<Limit["appliesTo"]>(undefined, "scope", "bucket"),
      retryAfterMs: fc.integer({ min: 0, max: 300_000 }),
      scope: fc.integer({ min: 0, max: SCOPES.length - 1 }),
    });
    fc.assert(
      fc.property(
        fc.array(limitArb, { maxLength: 6 }),
        fc.array(
          fc.record({
            at: fc.integer({ min: 0, max: 1_000_000 }),
            scope: fc.integer({ min: 0, max: SCOPES.length - 1 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (limits, probes) => {
          let now = 0;
          const budget = new MessagingDeliveryBudget({ now: () => now });
          for (const limit of limits) {
            const info: MessagingRateLimitInfo = {
              observedAt: limit.at,
              retryAfterMs: limit.retryAfterMs,
              scope: SCOPES[limit.scope]!,
              ...(limit.appliesTo ? { appliesTo: limit.appliesTo } : {}),
            };
            budget.recordRateLimit(info);
          }
          for (const probe of [...probes].sort((a, b) => a.at - b.at)) {
            now = probe.at;
            const scope = SCOPES[probe.scope]!;
            const coolOffUntil = Math.max(
              0,
              ...limits
                .filter((limit) => covers(limit, scope))
                .map((limit) => limit.at + limit.retryAfterMs + SAFETY_BUFFER_MS),
            );
            // A final answer that consumes no capacity is held back only by
            // a cool-off, never by slow mode or the sliding window.
            const admission = budget.admit({
              consumeCapacity: false,
              priority: "final_turn",
              scope,
            });
            if (coolOffUntil > now) {
              expect(admission).toMatchObject({
                outcome: "deferred",
                reason: "cool-off",
                retryAt: coolOffUntil,
              });
            } else {
              expect(admission.outcome).toBe("admitted");
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
