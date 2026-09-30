import { describe, expect, it } from "vitest";
import { CodexAppServerRestartPolicy } from "../codex-app-server/app-server-restart-policy";

function createPolicy(options: { random?: () => number } = {}) {
  let now = 1_000_000;
  const policy = new CodexAppServerRestartPolicy({
    now: () => now,
    random: options.random ?? (() => 0),
  });
  return {
    policy,
    advance: (ms: number) => { now += ms; },
  };
}

describe("CodexAppServerRestartPolicy", () => {
  it("doubles the delay after each consecutive exit up to the cap", () => {
    const { policy, advance } = createPolicy();
    const delays: number[] = [];
    for (let exit = 0; exit < 4; exit += 1) {
      const decision = policy.recordExit();
      expect(decision.kind).toBe("restart");
      if (decision.kind === "restart") delays.push(decision.delayMs);
      // Spread the exits out so the breaker window never fills.
      advance(4 * 60_000);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);

    const capped = createPolicy();
    let last = 0;
    for (let exit = 0; exit < 8; exit += 1) {
      const decision = capped.policy.recordExit();
      if (decision.kind === "restart") last = decision.delayMs;
      capped.advance(4 * 60_000);
    }
    expect(last).toBe(30_000);
  });

  it("jitters each delay down by at most a fifth", () => {
    const { policy } = createPolicy({ random: () => 1 });
    expect(policy.recordExit()).toMatchObject({ kind: "restart", delayMs: 800 });
  });

  it("reports the remaining delay until a restart may start", () => {
    const { policy, advance } = createPolicy();
    expect(policy.remainingDelayMs()).toBe(0);
    policy.recordExit();
    expect(policy.remainingDelayMs()).toBe(1_000);
    advance(400);
    expect(policy.remainingDelayMs()).toBe(600);
    advance(600);
    expect(policy.remainingDelayMs()).toBe(0);
  });

  it("starts the doubling over after the server stayed up for a stable period", () => {
    const { policy, advance } = createPolicy();
    policy.recordExit();
    advance(1_000);
    policy.recordStarted();
    advance(10_000);
    expect(policy.recordExit()).toMatchObject({ kind: "restart", delayMs: 2_000 });
    advance(2_000);
    policy.recordStarted();
    advance(2 * 60_000);
    expect(policy.recordExit()).toMatchObject({ kind: "restart", delayMs: 1_000 });
  });

  it("stops restarting after five exits in ten minutes, however long each run lasted", () => {
    const { policy, advance } = createPolicy();
    for (let exit = 0; exit < 4; exit += 1) {
      policy.recordStarted();
      advance(2 * 60_000);
      expect(policy.recordExit().kind).toBe("restart");
    }
    policy.recordStarted();
    advance(60_000);
    expect(policy.recordExit()).toEqual({ kind: "stopped", exits: 5, windowMs: 600_000 });
    expect(policy.isStopped()).toBe(true);

    policy.reset();
    expect(policy.isStopped()).toBe(false);
    expect(policy.remainingDelayMs()).toBe(0);
    expect(policy.recordExit()).toMatchObject({ kind: "restart", delayMs: 1_000 });
  });

  it("lets exits older than the window age out", () => {
    const { policy, advance } = createPolicy();
    for (let exit = 0; exit < 4; exit += 1) policy.recordExit();
    advance(10 * 60_000);
    expect(policy.recordExit().kind).toBe("restart");
  });
});
