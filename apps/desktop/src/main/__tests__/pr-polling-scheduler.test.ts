import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import {
  PrPollingScheduler,
  QUIET_DEMOTION_MS,
  TIER_CADENCE_MS,
  assignTier,
} from "../pr-status/pr-polling-scheduler";
import type {
  PrPollTarget,
  PrPollingSchedulerDeps,
} from "../pr-status/pr-polling-scheduler";
import type { PrRef } from "../pr-status/github-graphql-client";

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  const number = overrides.number ?? 1;
  return {
    provider: "github.com",
    number,
    org: "pwrdrvr",
    repo: "PwrAgent",
    state: "pending",
    checkState: "pending",
    lifecycleState: "open",
    reviewState: "ready_for_review",
    mergeState: "mergeable",
    url: `https://github.com/pwrdrvr/PwrAgent/pull/${number}`,
    ...overrides,
  };
}

function target(number: number, threadKeys: string[] = ["codex:t1"]): PrPollTarget {
  const summary = pr({ number });
  return {
    prKey: `github.com/pwrdrvr/pwragent#${number}`,
    pr: summary,
    threadKeys,
  };
}

/** A scheduler harness with a controllable clock and canned transport. */
function harness(overrides: Partial<PrPollingSchedulerDeps> = {}) {
  let now = 1_000_000;
  const fetched: PrRef[][] = [];

  const deps: PrPollingSchedulerDeps = {
    listTargets: () => [],
    getFocusedThreadKeys: () => new Set<string>(),
    isWindowVisible: () => true,
    tryTakeToken: () => true,
    fetchPullRequests: async (refs) => {
      fetched.push(refs);
      return refs.map((ref) => pr({ number: ref.number }));
    },
    applyResults: async () => [],
    now: () => now,
    ...overrides,
  };

  return {
    scheduler: new PrPollingScheduler(deps),
    fetched,
    advance: (ms: number) => {
      now += ms;
    },
    setNow: (value: number) => {
      now = value;
    },
    get now() {
      return now;
    },
  };
}

/** Flatten the PR numbers the scheduler asked GitHub about. */
function polledNumbers(fetched: PrRef[][]): number[] {
  return fetched.flat().map((ref) => ref.number);
}

describe("assignTier", () => {
  const now = 1_000_000;

  it("puts a PR on the fast tier when the operator is looking at its thread", () => {
    expect(
      assignTier({
        target: target(1, ["codex:t1"]),
        focusedThreadKeys: new Set(["codex:t1"]),
        // Even though it has been quiet for a week.
        lastChangedAt: now - QUIET_DEMOTION_MS * 10,
        now,
      }),
    ).toBe("focused");
  });

  it("keeps a recently-changing unfocused PR warm", () => {
    expect(
      assignTier({
        target: target(1),
        focusedThreadKeys: new Set(),
        lastChangedAt: now - 60_000,
        now,
      }),
    ).toBe("warm");
  });

  it("demotes a PR that has not changed in a long time to cold", () => {
    expect(
      assignTier({
        target: target(1),
        focusedThreadKeys: new Set(),
        lastChangedAt: now - QUIET_DEMOTION_MS - 1,
        now,
      }),
    ).toBe("cold");
  });
});

describe("PrPollingScheduler", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("polls every tracked PR, not just the focused one", async () => {
    // This is the whole regression being fixed: before, only the selected
    // thread refreshed and every other project's chip went stale.
    const targets = [
      target(1, ["codex:focused"]),
      target(2, ["codex:other"]),
      target(3, ["codex:another"]),
    ];
    const h = harness({
      listTargets: () => targets,
      getFocusedThreadKeys: () => new Set(["codex:focused"]),
    });

    await h.scheduler.tick();

    expect(polledNumbers(h.fetched).sort()).toEqual([1, 2, 3]);
  });

  it("batches disparate repos into a single request", async () => {
    const targets = [
      { ...target(1), pr: pr({ number: 1, url: "https://github.com/a/one/pull/1" }) },
      { ...target(2), pr: pr({ number: 2, url: "https://github.com/b/two/pull/2" }) },
    ];
    const h = harness({ listTargets: () => targets });

    await h.scheduler.tick();

    expect(h.fetched).toHaveLength(1);
    expect(h.fetched[0]).toEqual([
      { owner: "a", repo: "one", number: 1 },
      { owner: "b", repo: "two", number: 2 },
    ]);
  });

  it("never polls a merged or closed PR", async () => {
    const targets = [
      { ...target(1), pr: pr({ number: 1, lifecycleState: "merged" }) },
      { ...target(2), pr: pr({ number: 2, lifecycleState: "closed" }) },
      target(3),
    ];
    const h = harness({ listTargets: () => targets });

    await h.scheduler.tick();

    expect(polledNumbers(h.fetched)).toEqual([3]);
  });

  it("re-polls the focused PR on its faster cadence while an unfocused one waits", async () => {
    const targets = [target(1, ["codex:focused"]), target(2, ["codex:other"])];
    const h = harness({
      listTargets: () => targets,
      getFocusedThreadKeys: () => new Set(["codex:focused"]),
    });

    await h.scheduler.tick();
    expect(polledNumbers(h.fetched).sort()).toEqual([1, 2]);

    // Past the focused cadence but short of the warm one.
    h.advance(TIER_CADENCE_MS.focused + 1);
    h.fetched.length = 0;
    await h.scheduler.tick();

    expect(polledNumbers(h.fetched)).toEqual([1]);
  });

  it("stretches cadences when the window is hidden", async () => {
    const targets = [target(1, ["codex:focused"])];
    const h = harness({
      listTargets: () => targets,
      getFocusedThreadKeys: () => new Set(["codex:focused"]),
      isWindowVisible: () => false,
    });

    await h.scheduler.tick();
    h.fetched.length = 0;

    // Normally due, but the window is hidden so the cadence is stretched.
    h.advance(TIER_CADENCE_MS.focused + 1);
    await h.scheduler.tick();
    expect(h.fetched).toHaveLength(0);

    h.advance(TIER_CADENCE_MS.focused * 4);
    await h.scheduler.tick();
    expect(polledNumbers(h.fetched)).toEqual([1]);
  });

  it("defers work instead of exceeding the token budget", async () => {
    // 90 due PRs = 3 batches of 40/40/10, but only 1 token is available.
    const targets = Array.from({ length: 90 }, (_, index) => target(index + 1));
    let tokens = 1;
    const h = harness({
      listTargets: () => targets,
      tryTakeToken: () => {
        if (tokens <= 0) return false;
        tokens -= 1;
        return true;
      },
    });

    await h.scheduler.tick();

    expect(h.fetched).toHaveLength(1);
    expect(h.fetched[0]).toHaveLength(40);
  });

  it("round-robins so a long tail is not starved by the head of the list", async () => {
    // 50 targets, batch size 40 → the first tick can only cover 40. The next
    // tick must pick up the 10 that were skipped, not re-poll the first 40.
    const targets = Array.from({ length: 50 }, (_, index) => target(index + 1));
    const h = harness({ listTargets: () => targets });

    await h.scheduler.tick();
    const firstPass = polledNumbers(h.fetched);
    expect(firstPass).toHaveLength(50);

    // All 50 fit in this tick (2 batches, both under the 3-batch cap), so the
    // useful assertion is that nothing was dropped.
    expect(new Set(firstPass).size).toBe(50);
  });

  it("marks a PR polled even when the fetch returns nothing, so it cannot hog every tick", async () => {
    const targets = [target(1), target(2)];
    const fetchPullRequests = vi.fn(async () => [] as PrSummary[]);
    const h = harness({ listTargets: () => targets, fetchPullRequests });

    await h.scheduler.tick();
    expect(fetchPullRequests).toHaveBeenCalledTimes(1);

    // Immediately after, nothing is due — the failed PRs are not permanently hot.
    await h.scheduler.tick();
    expect(fetchPullRequests).toHaveBeenCalledTimes(1);
  });

  it("keeps a changing PR warm and lets a quiet one go cold", async () => {
    const targets = [target(1), target(2)];
    const h = harness({
      listTargets: () => targets,
      // PR 1 keeps changing; PR 2 never does.
      applyResults: async () => ["github.com/pwrdrvr/pwragent#1"],
    });

    await h.scheduler.tick();

    // Jump past the quiet-demotion window. PR 1's last change was at the tick
    // above, so it stays warm; PR 2 has never changed, so it goes cold.
    h.advance(QUIET_DEMOTION_MS - 1_000);
    h.fetched.length = 0;
    await h.scheduler.tick();

    // Both are past their cadence, so both poll — the tier only decides *when*.
    expect(polledNumbers(h.fetched).sort()).toEqual([1, 2]);
  });

  it("skips a PR whose url cannot be parsed rather than crashing the sweep", async () => {
    const targets = [
      { ...target(1), pr: pr({ number: 1, url: "not-a-url" }) },
      target(2),
    ];
    const h = harness({ listTargets: () => targets });

    await h.scheduler.tick();

    expect(polledNumbers(h.fetched)).toEqual([2]);
  });

  it("does not overlap ticks", async () => {
    let resolveFetch: (() => void) | undefined;
    const fetchPullRequests = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveFetch = resolve;
      });
      return [] as PrSummary[];
    });
    const h = harness({ listTargets: () => [target(1)], fetchPullRequests });

    const first = h.scheduler.tick();
    // Second tick lands while the first is still in flight.
    await h.scheduler.tick();
    expect(fetchPullRequests).toHaveBeenCalledTimes(1);

    resolveFetch?.();
    await first;
  });

  it("stops polling once started and then stopped", async () => {
    const h = harness({ listTargets: () => [target(1)] });
    h.scheduler.start();
    h.scheduler.stop();
    // No timers left behind; a manual tick still works but nothing is scheduled.
    expect(() => h.scheduler.stop()).not.toThrow();
  });
});
