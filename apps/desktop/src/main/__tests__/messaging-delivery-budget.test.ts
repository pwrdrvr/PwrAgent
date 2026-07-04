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

  it("coalesces droppable traffic in slow mode with exponential backoff", () => {
    let now = 1_000;
    const budget = new MessagingDeliveryBudget({ now: () => now });
    const scope = testScope({ limit: 1, reserved: 0 });

    // Exhaust the sliding window to arm slow mode.
    expect(budget.admit({ scope, priority: "routine_status" })).toMatchObject({
      outcome: "admitted",
      slowMode: false,
    });
    expect(budget.admit({ scope, priority: "routine_status" })).toMatchObject({
      outcome: "dropped",
      reason: "budget-exhausted",
      slowMode: true,
    });

    // First droppable update in the slow-mode episode opens the coalescing
    // window; it is buffered (dropped) until the initial window elapses.
    expect(budget.admit({ scope, priority: "tool_progress" })).toEqual({
      outcome: "dropped",
      reason: "slow-mode",
      slowMode: true,
    });

    // Still inside the ~400ms initial window: coalesced (dropped).
    now += 200;
    expect(budget.admit({ scope, priority: "tool_progress" })).toEqual({
      outcome: "dropped",
      reason: "slow-mode",
      slowMode: true,
    });

    // Past the initial window: one coalesced update is released.
    now += 300;
    expect(budget.admit({ scope, priority: "tool_progress" })).toMatchObject({
      outcome: "admitted",
      slowMode: true,
    });

    // The next release is now a full second out; updates before it coalesce.
    now += 500;
    expect(budget.admit({ scope, priority: "tool_progress" })).toEqual({
      outcome: "dropped",
      reason: "slow-mode",
      slowMode: true,
    });

    // After the 1s backoff window, another release lands.
    now += 600;
    expect(budget.admit({ scope, priority: "tool_progress" })).toMatchObject({
      outcome: "admitted",
      slowMode: true,
    });

    // The following window is 2s — a release just after 1s still coalesces.
    now += 1_200;
    expect(budget.admit({ scope, priority: "tool_progress" })).toEqual({
      outcome: "dropped",
      reason: "slow-mode",
      slowMode: true,
    });
  });

  it("does not release coalesced slow-mode traffic for non-consuming probes", () => {
    let now = 1_000;
    const budget = new MessagingDeliveryBudget({ now: () => now });
    const scope = testScope({ limit: 1, reserved: 0 });

    budget.admit({ scope, priority: "routine_status" });
    budget.admit({ scope, priority: "routine_status" }); // arms slow mode
    // Open the window and step well past it.
    budget.admit({ scope, priority: "tool_progress" });
    now += 5_000;

    // A non-consuming probe observes slow mode but never consumes a release.
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

    // The real (consuming) update still gets its release.
    expect(budget.admit({ scope, priority: "tool_progress" })).toMatchObject({
      outcome: "admitted",
      slowMode: true,
    });
  });

  it("resets the slow-mode coalescing gate to the initial window on a new episode", () => {
    let now = 1_000;
    const budget = new MessagingDeliveryBudget({ now: () => now });
    // A short 1s window means slow mode lapses at the 5s floor, not the next
    // (minutes-away) window, so a second episode can be exercised in one test.
    const scope: MessagingDeliveryScope = {
      platform: "telegram",
      id: "telegram:group:reset-episode",
      kind: "group",
      budget: { limit: 1, intervalMs: 1_000, reserved: 0 },
    };

    budget.admit({ scope, priority: "routine_status" });
    budget.admit({ scope, priority: "routine_status" }); // arms slow mode
    budget.admit({ scope, priority: "tool_progress" }); // opens window
    now += 500;
    expect(budget.admit({ scope, priority: "tool_progress" })).toMatchObject({
      outcome: "admitted",
      slowMode: true,
    });

    // Let slow mode fully lapse (5s floor from the 1_000 arm point).
    now = 6_001;
    expect(budget.isScopeInSlowMode(scope)).toBe(false);

    // A fresh episode: exhaust the window again to re-arm slow mode.
    expect(budget.admit({ scope, priority: "routine_status" })).toMatchObject({
      outcome: "admitted",
      slowMode: false,
    });
    expect(budget.admit({ scope, priority: "routine_status" })).toMatchObject({
      outcome: "dropped",
      reason: "budget-exhausted",
      slowMode: true,
    });

    // The gate is back at the initial window: the first droppable is buffered
    // again rather than immediately released at a stale backoff step.
    expect(budget.admit({ scope, priority: "tool_progress" })).toEqual({
      outcome: "dropped",
      reason: "slow-mode",
      slowMode: true,
    });
    now += 500;
    expect(budget.admit({ scope, priority: "tool_progress" })).toMatchObject({
      outcome: "admitted",
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
