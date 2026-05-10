import { describe, expect, it } from "vitest";
import type { MessagingDeliveryScope } from "@pwragent/messaging-interface";
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
