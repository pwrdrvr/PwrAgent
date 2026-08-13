import { describe, expect, it } from "vitest";
import { MessagingRateLimitGate } from "../rate-limit-gate";

describe("MessagingRateLimitGate", () => {
  it("tracks independent provider method budgets", () => {
    let now = 1_000;
    const gate = new MessagingRateLimitGate(() => now);
    const start = { id: "slack:start", limit: 1, intervalMs: 60_000 };
    const append = { id: "slack:append", limit: 2, intervalMs: 60_000 };

    expect(gate.admit(start)).toEqual({ admitted: true });
    expect(gate.admit(start)).toEqual({ admitted: false, retryAt: 61_000 });
    expect(gate.admit(append)).toEqual({ admitted: true });
    expect(gate.admit(append)).toEqual({ admitted: true });
    expect(gate.admit(append)).toEqual({ admitted: false, retryAt: 61_000 });

    now = 61_000;
    expect(gate.admit(start)).toEqual({ admitted: true });
    expect(gate.admit(append)).toEqual({ admitted: true });
  });

  it("honors method spacing and provider Retry-After cooldowns separately", () => {
    let now = 10_000;
    const gate = new MessagingRateLimitGate(() => now);
    const start = {
      id: "slack:start",
      limit: 20,
      intervalMs: 60_000,
      minIntervalMs: 1_000,
    };
    const stop = { ...start, id: "slack:stop" };

    expect(gate.admit(start)).toEqual({ admitted: true });
    expect(gate.admit(start)).toEqual({ admitted: false, retryAt: 11_000 });
    gate.recordRateLimit("slack:start", 5_000);
    expect(gate.admit(start)).toEqual({ admitted: false, retryAt: 15_000 });
    expect(gate.admit(stop)).toEqual({ admitted: true });

    now = 15_000;
    expect(gate.admit(start)).toEqual({ admitted: true });
  });
});
