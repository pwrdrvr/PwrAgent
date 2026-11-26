import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type { BackendRateLimitSummary } from "@pwragent/shared/contracts/backend";
import { PlanLimitStore } from "../app-server/plan-limit-store";
import {
  CLAUDE_RESET_TOLERANCE_MS, canonicalClaudeRateLimit, claudeCreditsRenewTogether, claudeRateLimits,
  claudeStreamRateLimits,
} from "../claude/claude-usage";

const hour = 3_600_000;

function storeAt(start: number) {
  let now = start;
  const store = new PlanLimitStore({ now: () => now });
  return { store, advance: (ms: number) => { now += ms; }, now: () => now };
}

/** Claude's readings, as ClaudeBackend records them. */
function claude(store: PlanLimitStore, limits: BackendRateLimitSummary[], precise = false): boolean {
  return store.record("claude", {
    limits: limits.map(canonicalClaudeRateLimit), precise, resetToleranceMs: CLAUDE_RESET_TOLERANCE_MS,
    creditsRenewTogether: claudeCreditsRenewTogether,
    ...(precise ? { dated: true } : {}),
  });
}

/** A probe whose request was overtaken by another CLI's probe: precise but not the newest. */
function overtakenProbe(store: PlanLimitStore, limits: BackendRateLimitSummary[]): boolean {
  const since = store.mark("claude");
  claude(store, [], true);
  return store.record("claude", {
    limits: limits.map(canonicalClaudeRateLimit), precise: true, since, dated: true,
    resetToleranceMs: CLAUDE_RESET_TOLERANCE_MS, creditsRenewTogether: claudeCreditsRenewTogether,
  });
}

afterEach(() => { vi.useRealTimers(); });

describe("PlanLimitStore", () => {
  describe("Claude readings", () => {
    it("merges Fable snapshots and stream readings into one weekly allowance", () => {
      const now = Date.parse("2026-10-21T14:30:00Z");
      const { store } = storeAt(now);
      const snapshot = claudeRateLimits({ rate_limits_available: true, rate_limits: {
        seven_day: { utilization: 11, resets_at: "2026-10-27T11:00:00Z" },
        model_scoped: [{ display_name: "Fable", utilization: 10.8, resets_at: "2026-10-27T10:20:00Z" }],
      } } as SDKControlGetUsageResponse);
      const stream = claudeStreamRateLimits({ status: "allowed", rateLimitType: "seven_day_overage_included",
        utilization: 0.11, resetsAt: Date.parse("2026-10-27T11:00:00Z") / 1000 });
      claude(store, snapshot, true);
      claude(store, stream);
      const merged = [snapshot[0], { ...snapshot[1], usedPercent: 11 }];
      expect(store.limits("claude")).toEqual(merged);
      expect(claude(store, stream)).toBe(false);
      const next = { ...stream[0], usedPercent: 1, resetAt: Date.parse("2026-11-03T11:00:00Z") };
      claude(store, [next]);
      expect(store.limits("claude")).toEqual([snapshot[0], next]);
    });

    it("collapses remembered Fable aliases and hides windows past their reset", () => {
      const { store, advance } = storeAt(1_000);
      const named = { name: "Weekly Fable limit", limitId: "model_scoped:Fable", usedPercent: 10.8,
        resetAt: 10_000, windowMinutes: 10_080 };
      const streamed = { ...named, name: "Weekly limit with extra usage", limitId: "seven_day_overage_included",
        usedPercent: 11 };
      store.restore("claude", { limits: [named, streamed].map(canonicalClaudeRateLimit),
        resetToleranceMs: CLAUDE_RESET_TOLERANCE_MS });
      expect(store.limits("claude")).toEqual([{ ...named, limitId: "seven_day_overage_included", usedPercent: 11 }]);
      advance(9_000);
      expect(store.limits("claude")).toEqual([]);
    });

    it("raises a live window from the stream but takes a reading from the next window", () => {
      const now = Date.parse("2026-10-21T14:30:00Z");
      const known = { name: "5-hour limit", limitId: "five_hour", usedPercent: 98, resetAt: now + hour / 2 };
      const { store } = storeAt(now);
      claude(store, [known]);
      claude(store, [{ ...known, usedPercent: 99 }]);
      expect(store.limits("claude")).toEqual([{ ...known, usedPercent: 99 }]);
      // Within the stream's rounding, a lower reading is an older one.
      claude(store, [{ ...known, usedPercent: 40, resetAt: known.resetAt + hour }]);
      expect(store.limits("claude")).toEqual([{ ...known, usedPercent: 99 }]);
      // The window reset early and a new one began: a far later reset replaces it.
      const next = { ...known, usedPercent: 2, resetAt: now + 5 * hour };
      claude(store, [next]);
      expect(store.limits("claude")).toEqual([next]);
    });

    it("keeps an unknown reading unknown when merging", () => {
      const { store } = storeAt(1_000);
      const known = { name: "Weekly limit", limitId: "seven_day", resetAt: 2_000 };
      claude(store, [known]);
      claude(store, [{ name: "Weekly limit", limitId: "seven_day" }]);
      expect(store.limits("claude")).toEqual([known]);
      claude(store, [{ ...known, usedPercent: 5 }]);
      expect(store.limits("claude")).toEqual([{ ...known, usedPercent: 5 }]);
    });

    it("only moves each window forward when readings arrive out of order", () => {
      const now = Date.parse("2026-11-01T20:00:00Z");
      const weeklyReset = Date.parse("2026-11-03T14:00:00Z");
      const credits = { name: "Cloud session credits", limitId: "iguana_necktie", usedPercent: 33,
        resetAt: Date.parse("2026-11-05T10:59:00Z"), expires: true };
      const fable = { name: "Weekly Fable limit", limitId: "seven_day_overage_included", usedPercent: 0,
        resetAt: weeklyReset, windowMinutes: 10_080 };
      const weekly = { name: "Weekly limit", limitId: "seven_day", usedPercent: 50, resetAt: weeklyReset,
        windowMinutes: 10_080 };
      const { store } = storeAt(now);
      claude(store, [weekly, credits, fable], true);
      // Another CLI's probe, taken before the reading above: one window, lower.
      // It cannot move the newer probe's usage or reset back.
      const older = { ...weekly, usedPercent: 49.4, resetAt: weeklyReset - 17 * 60_000 };
      expect(claude(store, [older], true)).toBe(false);
      const merged = [weekly, credits, fable];
      expect(store.limits("claude")).toEqual(merged);
      // A reading from the window before the reset is ignored outright.
      expect(claude(store, [{ ...older, usedPercent: 97, resetAt: weeklyReset - 7 * 24 * hour }], true)).toBe(false);
      expect(store.limits("claude")).toEqual(merged);
      // A higher reading of the same window moves it forward.
      claude(store, [{ ...older, usedPercent: 51.2 }], true);
      expect(store.limits("claude")?.[0].usedPercent).toBe(51.2);
    });

    it("lets a probe lower a window after a reset credit while other CLIs stream", () => {
      // The oracle: after a Fable reset credit the account's usage is the
      // probe's value. Stream readings that arrive while the probe is in
      // flight report the same post-credit account, so they never exceed it.
      // The shown value must be the probe's, however many streams overtook it.
      const now = Date.parse("2026-11-18T14:00:00Z");
      const reset = Date.parse("2026-11-24T11:00:00Z");
      const fable = (usedPercent: number, resetAt = reset) => ({ name: "Weekly Fable limit",
        limitId: "seven_day_overage_included", usedPercent, resetAt, windowMinutes: 10_080 });
      fc.assert(fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 0, max: 99 }),
        fc.array(fc.integer({ min: 0, max: 100 }), { maxLength: 6 }),
        (before, probeRaw, streamRaw) => {
          const probed = Math.min(probeRaw, before - 1);
          const { store } = storeAt(now);
          claude(store, [fable(before, reset - 76)], true);
          const since = store.mark("claude");
          // Stream readings carry the hour-rounded reset; the probe's is exact.
          for (const used of streamRaw) claude(store, [fable(Math.min(used, probed))]);
          store.record("claude", { limits: [fable(probed, reset - 76)].map(canonicalClaudeRateLimit),
            precise: true, since, dated: true, resetToleranceMs: CLAUDE_RESET_TOLERANCE_MS });
          expect(store.limits("claude")?.[0].usedPercent).toBe(probed);
        },
      ));
    });

    it("believes a consistent run of lower readings after a credit no newest probe saw", () => {
      // The oracle: after a reset credit the account's usage restarts low and
      // only rises. Readings that agree on that new line describe the account,
      // even when every one is a stream reading or an overtaken probe. By the
      // second such reading the shown value is the latest one.
      const now = Date.parse("2026-11-18T14:00:00Z");
      const reset = Date.parse("2026-11-24T11:00:00Z");
      const fable = (usedPercent: number) => ({ name: "Weekly Fable limit",
        limitId: "seven_day_overage_included", usedPercent, resetAt: reset, windowMinutes: 10_080 });
      fc.assert(fc.property(
        fc.integer({ min: 10, max: 100 }),
        fc.integer({ min: 0, max: 20 }),
        fc.array(fc.record({ rise: fc.integer({ min: 0, max: 3 }), probe: fc.boolean() }),
          { minLength: 2, maxLength: 8 }),
        (before, startRaw, steps) => {
          const { store } = storeAt(now);
          claude(store, [fable(before)], true);
          let used = Math.min(startRaw, before - 10);
          const seen: number[] = [];
          for (const { rise, probe } of steps) {
            if (used + rise <= before - 10) used += rise;
            seen.push(used);
            if (probe) overtakenProbe(store, [fable(used)]);
            else claude(store, [fable(used)]);
          }
          expect(store.limits("claude")?.[0].usedPercent).toBe(seen.at(-1));
        },
      ));
    });

    it("still ignores lower readings that are late or alone", () => {
      // The forward-only rule's purpose: readings a few points low are older
      // ones arriving late, and one far-low reading alone proves nothing.
      const now = Date.parse("2026-11-18T14:00:00Z");
      const weekly = (usedPercent: number) => ({ name: "Weekly limit", limitId: "seven_day", usedPercent,
        resetAt: Date.parse("2026-11-24T11:00:00Z"), windowMinutes: 10_080 });
      fc.assert(fc.property(
        fc.integer({ min: 5, max: 100 }),
        fc.array(fc.record({ drop: fc.integer({ min: 0, max: 4 }), probe: fc.boolean() }), { maxLength: 8 }),
        fc.integer({ min: 0, max: 100 }),
        (before, late, alone) => {
          const { store } = storeAt(now);
          claude(store, [weekly(before)], true);
          for (const { drop, probe } of late) {
            if (probe) overtakenProbe(store, [weekly(before - drop)]);
            else claude(store, [weekly(before - drop)]);
          }
          claude(store, [weekly(Math.min(alone, before))]);
          expect(store.limits("claude")?.[0].usedPercent).toBe(before);
        },
      ));
    });

    it("drops a Fable window no reading names once a credit lowers the weekly window", () => {
      // A Fable reset gives back what Fable used on the weekly limit. A CLI
      // running another model never names Fable, so the held Fable value is
      // stale from that credit on, until a Fable reading names it again.
      const now = Date.parse("2026-11-18T14:00:00Z");
      const reset = Date.parse("2026-11-24T11:00:00Z");
      const weekly = { name: "Weekly limit", limitId: "seven_day", usedPercent: 73, resetAt: reset,
        windowMinutes: 10_080 };
      const fable = { name: "Weekly Fable limit", limitId: "seven_day_overage_included", usedPercent: 99,
        resetAt: reset, windowMinutes: 10_080 };
      const fiveHour = { name: "5-hour limit", limitId: "five_hour", usedPercent: 40, resetAt: now + 2 * hour,
        windowMinutes: 300 };
      // Renews with the weekly window, but a Fable reset does not credit it.
      const sonnet = { name: "Weekly Sonnet limit", limitId: "seven_day_sonnet", usedPercent: 60, resetAt: reset,
        windowMinutes: 10_080 };
      for (const lower of [
        (store: PlanLimitStore) => store.record("claude", { limits: [{ ...weekly, usedPercent: 25 }],
          precise: true, since: store.mark("claude"), dated: true, resetToleranceMs: CLAUDE_RESET_TOLERANCE_MS,
          creditsRenewTogether: claudeCreditsRenewTogether }),
        (store: PlanLimitStore) => {
          overtakenProbe(store, [{ ...weekly, usedPercent: 25 }]);
          claude(store, [{ ...weekly, usedPercent: 25 }]);
        },
      ]) {
        const { store } = storeAt(now);
        claude(store, [weekly, fable, fiveHour, sonnet], true);
        lower(store);
        expect(store.limits("claude")).toEqual([{ ...weekly, usedPercent: 25 }, fiveHour, sonnet]);
        claude(store, [{ ...weekly, usedPercent: 25 }, { ...fable, usedPercent: 4 }]);
        expect(store.limits("claude")).toEqual([
          { ...weekly, usedPercent: 25 }, fiveHour, sonnet, { ...fable, usedPercent: 4 },
        ]);
      }
    });

    it("counts one reading of a window once, even when it names the window twice", () => {
      // Fable's snapshot name and stream name are one window, so a probe that
      // carries both is still one lower reading, and one proves nothing.
      const now = Date.parse("2026-11-18T14:00:00Z");
      const reset = Date.parse("2026-11-24T11:00:00Z");
      const named = { name: "Weekly Fable limit", limitId: "model_scoped:Fable", usedPercent: 4, resetAt: reset,
        windowMinutes: 10_080 };
      const streamed = { ...named, limitId: "seven_day_overage_included" };
      const { store } = storeAt(now);
      claude(store, [{ ...streamed, usedPercent: 99 }], true);
      overtakenProbe(store, [named, streamed]);
      expect(store.limits("claude")?.[0].usedPercent).toBe(99);
      claude(store, [streamed]);
      expect(store.limits("claude")?.[0].usedPercent).toBe(4);
    });

    it("keeps a run of lower readings when an older probe refines the window's reset", () => {
      const now = Date.parse("2026-11-18T14:00:00Z");
      const fable = (usedPercent: number, resetAt: number) => ({ name: "Weekly Fable limit",
        limitId: "seven_day_overage_included", usedPercent, resetAt, windowMinutes: 10_080 });
      const streamReset = Date.parse("2026-11-24T12:00:00Z");
      const { store } = storeAt(now);
      claude(store, [fable(99, streamReset)]);
      claude(store, [fable(4, streamReset)]);
      // A slower CLI's probe, close to the held value, refines the reset.
      overtakenProbe(store, [fable(97, streamReset - hour)]);
      claude(store, [fable(4, streamReset)]);
      expect(store.limits("claude")).toEqual([fable(4, streamReset - hour)]);
    });

    it("keeps windows that renew apart, or a provider that does not share credits", () => {
      const now = Date.parse("2026-11-18T14:00:00Z");
      const reset = Date.parse("2026-11-24T11:00:00Z");
      const weekly: BackendRateLimitSummary = { name: "Weekly limit", limitId: "codex", windowKey: "secondary",
        usedPercent: 73, resetAt: reset };
      const other: BackendRateLimitSummary = { name: "Weekly limit", limitId: "codex_other",
        windowKey: "secondary", usedPercent: 99, resetAt: reset };
      const { store } = storeAt(now);
      store.record("codex", { limits: [weekly, other], since: store.mark("codex") });
      store.record("codex", { limits: [{ ...weekly, usedPercent: 25 }], since: store.mark("codex") });
      expect(store.limits("codex")).toEqual([{ ...weekly, usedPercent: 25 }, other]);
    });

    it("still lets another CLI's probe overtake one in flight", () => {
      const now = Date.parse("2026-11-18T14:00:00Z");
      const fable = { name: "Weekly Fable limit", limitId: "seven_day_overage_included", usedPercent: 100,
        resetAt: Date.parse("2026-11-24T11:00:00Z"), windowMinutes: 10_080 };
      const { store } = storeAt(now);
      claude(store, [fable], true);
      const since = store.mark("claude");
      claude(store, [{ ...fable, usedPercent: 100 }], true);
      store.record("claude", { limits: [{ ...fable, usedPercent: 80 }], precise: true, since,
        dated: true, resetToleranceMs: CLAUDE_RESET_TOLERANCE_MS });
      expect(store.limits("claude")?.[0].usedPercent).toBe(100);
    });

    it("never lets a probe from the last window replace one a stream started meanwhile", () => {
      // The oracle: once any reading names a later window, the earlier one is
      // gone, however the readings interleave with a probe in flight.
      const now = Date.parse("2026-11-18T14:00:00Z");
      const reset = Date.parse("2026-11-24T11:00:00Z");
      const nextReset = reset + 7 * 24 * hour;
      const weekly = (usedPercent: number, resetAt: number) => ({ name: "Weekly limit", limitId: "seven_day",
        usedPercent, resetAt, windowMinutes: 10_080 });
      fc.assert(fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (before, fresh, probed) => {
          const { store } = storeAt(now);
          claude(store, [weekly(before, reset)], true);
          const since = store.mark("claude");
          // A weekly reset credit starts the next window while the probe is out.
          claude(store, [weekly(fresh, nextReset)]);
          store.record("claude", { limits: [weekly(probed, reset)], precise: true, since,
            dated: true, resetToleranceMs: CLAUDE_RESET_TOLERANCE_MS });
          expect(store.limits("claude")).toEqual([weekly(fresh, nextReset)]);
        },
      ));
    });

    it("lets a precise reading refine a stream window's reset but not the reverse", () => {
      const now = Date.parse("2026-11-01T20:00:00Z");
      const streamed = { name: "5-hour limit", limitId: "five_hour", usedPercent: 12,
        resetAt: Date.parse("2026-11-01T23:00:00Z") };
      const probed = { ...streamed, usedPercent: 11.6, resetAt: Date.parse("2026-11-01T22:21:00Z") };
      const first = storeAt(now).store;
      claude(first, [streamed]);
      claude(first, [probed], true);
      expect(first.limits("claude")).toEqual([{ ...probed, usedPercent: 12 }]);
      const second = storeAt(now).store;
      claude(second, [probed], true);
      claude(second, [streamed]);
      expect(second.limits("claude")).toEqual([{ ...probed, usedPercent: 12 }]);
    });

    it("clears the limits when the plan changes, and adopts a first account", () => {
      const now = Date.parse("2026-11-01T20:00:00Z");
      const { store } = storeAt(now);
      const weekly = { name: "Weekly limit", limitId: "seven_day", usedPercent: 50, resetAt: now + 24 * hour };
      claude(store, [weekly], true);
      // Limits remembered before accounts were recorded join the first one.
      expect(store.setAccount("claude", { account: "a", plan: "pro" })).toBe(true);
      expect(store.limits("claude")).toEqual([weekly]);
      expect(store.setAccount("claude", { account: "a", plan: "pro" })).toBe(false);
      // A new plan has a new allowance, so usage can fall within the window.
      store.setAccount("claude", { account: "a", plan: "max" });
      expect(store.limits("claude")).toEqual([]);
      claude(store, [{ ...weekly, usedPercent: 25 }], true);
      expect(store.limits("claude")).toEqual([{ ...weekly, usedPercent: 25 }]);
      // A reading that does not name the plan is not a plan change.
      expect(store.setAccount("claude", { account: "a" })).toBe(false);
      expect(store.limits("claude")).toEqual([{ ...weekly, usedPercent: 25 }]);
      store.setAccount("claude", { account: "b", plan: "max" });
      expect(store.snapshot("claude")).toEqual({ limits: [], account: "b", plan: "max" });
    });

    it("fills the remembered account in when a reading arrived before the file loaded", () => {
      const now = Date.parse("2026-11-01T20:00:00Z");
      const { store } = storeAt(now);
      const weekly = { name: "Weekly limit", limitId: "seven_day", usedPercent: 50, resetAt: now + 24 * hour };
      claude(store, [weekly]);
      expect(store.restore("claude", { limits: [{ ...weekly, usedPercent: 40 }], account: "a", plan: "max",
        observedAt: now - hour })).toBe(false);
      expect(store.snapshot("claude")).toEqual({ limits: [weekly], account: "a", plan: "max", observedAt: now });
    });

    it("dates the limits only when a reading names them all", () => {
      const now = Date.parse("2026-11-01T20:00:00Z");
      const { store, advance } = storeAt(now);
      const five = { name: "5-hour limit", limitId: "five_hour", usedPercent: 10, resetAt: now + hour };
      const weekly = { name: "Weekly limit", limitId: "seven_day", usedPercent: 50, resetAt: now + 24 * hour };
      claude(store, [five, weekly], true);
      advance(60_000);
      claude(store, [{ ...five, usedPercent: 20 }]);
      expect(store.snapshot("claude")?.observedAt).toBe(now);
      claude(store, [{ ...five, usedPercent: 30 }, { ...weekly, usedPercent: 60 }]);
      expect(store.snapshot("claude")?.observedAt).toBe(now + 60_000);
    });
  });

  describe("Codex readings", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    const fiveHour: BackendRateLimitSummary = {
      name: "5h limit", limitId: "codex", limitName: "Codex", windowKey: "primary",
      usedPercent: 49, remaining: 51, resetAt: now + 3 * hour, windowMinutes: 300, windowSeconds: 18_000,
    };
    const weekly: BackendRateLimitSummary = {
      name: "Weekly limit", limitId: "codex", limitName: "Codex", windowKey: "secondary",
      usedPercent: 9, remaining: 91, resetAt: now + 72 * hour, windowMinutes: 10_080, windowSeconds: 604_800,
    };
    const credits: BackendRateLimitSummary = {
      name: "Credits", limitId: "credits", windowKey: "credits", hasCredits: true, unlimited: false, remaining: 100,
    };
    // A rolling update leaves out the window length, so its name is generic.
    const rolling = (usedPercent: number, resetAt?: number): BackendRateLimitSummary => ({
      name: "Primary limit", limitId: "codex", limitName: "Codex", windowKey: "primary",
      usedPercent, remaining: 100 - usedPercent, resetAt, windowMinutes: undefined,
    });
    const named = (limit: BackendRateLimitSummary) =>
      limit.windowKey === "primary" && limit.windowMinutes === 300 ? { ...limit, name: "5h limit" } : limit;
    const notify = (store: PlanLimitStore, limits: BackendRateLimitSummary[]) =>
      store.record("codex", { limits, precise: true, dated: true, describe: named });

    it("never steps back when turns report out of order", () => {
      const { store } = storeAt(now);
      store.record("codex", { limits: [fiveHour, weekly, credits], since: store.mark("codex"), dated: true });
      expect(notify(store, [rolling(50, fiveHour.resetAt)])).toBe(true);
      // An older turn's reset, a second off, does not replace the newer one.
      expect(notify(store, [rolling(49, fiveHour.resetAt! - 1_000)])).toBe(false);
      // A turn whose request started earlier reports 49% after the 50%.
      expect(notify(store, [rolling(49, fiveHour.resetAt)])).toBe(false);
      expect(notify(store, [rolling(49)])).toBe(false);
      expect(store.limits("codex")).toEqual([{ ...fiveHour, usedPercent: 50, remaining: 50 }, weekly, credits]);
    });

    it("keeps every window a sparse update leaves out, and its labels", () => {
      const { store } = storeAt(now);
      store.record("codex", { limits: [fiveHour, weekly, credits], since: store.mark("codex"), dated: true });
      notify(store, [rolling(60)]);
      const shown = store.limits("codex");
      expect(shown).toEqual([{ ...fiveHour, usedPercent: 60, remaining: 40 }, weekly, credits]);
      // A full read that leaves a window out does not flash it away.
      store.record("codex", { limits: [{ ...fiveHour, usedPercent: 61, remaining: 39 }], since: store.mark("codex") });
      expect(store.limits("codex")).toEqual([{ ...fiveHour, usedPercent: 61, remaining: 39 }, weekly, credits]);
    });

    it("starts a new window at a later reset and drops a reading from the last one", () => {
      const { store, advance } = storeAt(now);
      store.record("codex", { limits: [fiveHour], since: store.mark("codex") });
      const next = { ...fiveHour, usedPercent: 3, remaining: 97, resetAt: fiveHour.resetAt! + 4 * hour };
      notify(store, [next]);
      expect(store.limits("codex")).toEqual([next]);
      expect(notify(store, [{ ...fiveHour, usedPercent: 80, remaining: 20 }])).toBe(false);
      expect(store.limits("codex")).toEqual([next]);
      // Past its reset the window is hidden until Codex reports it again.
      advance(8 * hour);
      expect(store.limits("codex")).toEqual([]);
    });

    it("lets the newest full read lower a window, as a reset credit does", () => {
      const { store } = storeAt(now);
      store.record("codex", { limits: [{ ...fiveHour, usedPercent: 98, remaining: 2 }], since: store.mark("codex") });
      const since = store.mark("codex");
      store.record("codex", { limits: [{ ...fiveHour, usedPercent: 0, remaining: 100 }], since });
      expect(store.limits("codex")).toEqual([{ ...fiveHour, usedPercent: 0, remaining: 100 }]);
      // A read overtaken by another reading is no longer known to be newest.
      const stale = store.mark("codex");
      notify(store, [rolling(5, fiveHour.resetAt)]);
      store.record("codex", { limits: [{ ...fiveHour, usedPercent: 1, remaining: 99 }], since: stale });
      expect(store.limits("codex")?.[0]).toMatchObject({ usedPercent: 5, remaining: 95 });
    });

    it("drops a read requested before the account changed", () => {
      const { store } = storeAt(now);
      store.record("codex", { limits: [fiveHour], since: store.mark("codex"), account: "first" });
      const since = store.mark("codex");
      store.clear("codex");
      expect(store.record("codex", { limits: [weekly], since, account: "first" })).toBe(false);
      expect(store.snapshot("codex")).toEqual({ limits: [], account: "first" });
    });

    it("replaces a credits balance with the last reading, up or down", () => {
      const { store } = storeAt(now);
      notify(store, [credits]);
      notify(store, [{ ...credits, remaining: 250 }]);
      notify(store, [{ ...credits, remaining: undefined, hasCredits: false }]);
      expect(store.limits("codex")).toEqual([
        { name: "Credits", limitId: "credits", windowKey: "credits", hasCredits: false, unlimited: false },
      ]);
    });

    it("returns the same array until the limits change", () => {
      const { store } = storeAt(now);
      store.record("codex", { limits: [fiveHour, weekly], since: store.mark("codex") });
      const shown = store.limits("codex");
      notify(store, [rolling(49, fiveHour.resetAt)]);
      expect(store.limits("codex")).toBe(shown);
      notify(store, [rolling(55, fiveHour.resetAt)]);
      expect(store.limits("codex")).not.toBe(shown);
    });
  });

  describe("Grok readings", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    const monthly: BackendRateLimitSummary = { name: "Monthly limit", usedPercent: 40, resetAt: now + 10 * 24 * hour };
    const read = (store: PlanLimitStore, plan: string, limits: BackendRateLimitSummary[]) => {
      let since = store.mark("acp:grok");
      if (store.setAccount("acp:grok", { plan })) since = store.mark("acp:grok");
      return store.record("acp:grok", { limits, since, dated: true });
    };

    it("keeps the limit when a read leaves out the plan", () => {
      const { store } = storeAt(now);
      const readAt = (plan: string | undefined, limits: BackendRateLimitSummary[]) => {
        let since = store.mark("acp:grok");
        if (store.setAccount("acp:grok", { plan })) since = store.mark("acp:grok");
        return store.record("acp:grok", { limits, since, dated: true });
      };
      readAt("SuperGrok", [monthly]);
      readAt(undefined, []);
      expect(store.limits("acp:grok")).toEqual([monthly]);
      expect(store.snapshot("acp:grok")?.plan).toBe("SuperGrok");
    });

    it("keeps the period's limit when a read leaves it out", () => {
      const { store } = storeAt(now);
      read(store, "SuperGrok", [monthly]);
      read(store, "SuperGrok", []);
      expect(store.limits("acp:grok")).toEqual([monthly]);
      expect(store.snapshot("acp:grok")).toMatchObject({ plan: "SuperGrok", observedAt: now });
    });

    it("starts the next billing period over and clears the limit on a plan change", () => {
      const { store } = storeAt(now);
      read(store, "SuperGrok", [monthly]);
      const nextPeriod = { ...monthly, usedPercent: 2, resetAt: monthly.resetAt! + 30 * 24 * hour };
      read(store, "SuperGrok", [nextPeriod]);
      expect(store.limits("acp:grok")).toEqual([nextPeriod]);
      // Each read is the newest, so a credit top-up may lower the period's use.
      read(store, "SuperGrok", [{ ...nextPeriod, usedPercent: 1 }]);
      expect(store.limits("acp:grok")).toEqual([{ ...nextPeriod, usedPercent: 1 }]);
      read(store, "SuperGrok Heavy", [{ ...nextPeriod, usedPercent: 0.5 }]);
      expect(store.limits("acp:grok")).toEqual([{ ...nextPeriod, usedPercent: 0.5 }]);
      expect(store.snapshot("acp:grok")?.plan).toBe("SuperGrok Heavy");
    });
  });

  describe("Antigravity complete snapshots", () => {
    const now = Date.parse("2026-11-26T14:00:00Z");

    it("clears a prior resetAt and keeps the bucket live when a complete newest read resets a 5h pool to idle", () => {
      fc.assert(fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1_000, max: 5 * 60_000 }),
        (priorUsed, skewMs) => {
          const { store, advance } = storeAt(now);
          const staleResetAt = now + skewMs;
          const active = {
            name: "5h Gemini limit",
            limitId: "gemini-5h",
            usedPercent: priorUsed,
            windowMinutes: 300,
            resetAt: staleResetAt,
          };
          const idle = {
            name: "5h Gemini limit",
            limitId: "gemini-5h",
            usedPercent: 0,
            windowMinutes: 300,
          };
          store.record("acp:antigravity", {
            limits: [active],
            since: store.mark("acp:antigravity"),
            precise: true,
            dated: true,
            complete: true,
          });
          // Bucket rolls back to idle before the local clock passes the prior resetAt.
          store.record("acp:antigravity", {
            limits: [idle],
            since: store.mark("acp:antigravity"),
            precise: true,
            dated: true,
            complete: true,
          });
          expect(store.limits("acp:antigravity")).toEqual([idle]);
          expect("resetAt" in store.limits("acp:antigravity")![0]!).toBe(false);
          // Passing the old reset timestamp must not evict the freshly-idle bucket.
          advance(skewMs + 1_000);
          expect(store.limits("acp:antigravity")).toEqual([idle]);
        },
      ));
    });

    it("does not carry forward omitted non-usage fields across a window rollover on a complete newest read", () => {
      fc.assert(fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        fc.constantFrom(300, 10_080),
        fc.integer({ min: 100, max: 100_000 }),
        fc.boolean(),
        (priorUsed, nextUsed, priorWindowMinutes, priorLimit, priorExpires) => {
          const { store } = storeAt(now);
          const firstReset = now + hour;
          const nextReset = now + 6 * hour;
          const prior: BackendRateLimitSummary = {
            name: "5h Gemini limit",
            limitId: "gemini-5h",
            limitName: "Gemini Models",
            usedPercent: priorUsed,
            limit: priorLimit,
            windowMinutes: priorWindowMinutes,
            expires: priorExpires,
            resetAt: firstReset,
          };
          const rolled: BackendRateLimitSummary = {
            name: "5h Gemini limit",
            limitId: "gemini-5h",
            usedPercent: nextUsed,
            resetAt: nextReset,
          };
          store.record("acp:antigravity", {
            limits: [prior],
            since: store.mark("acp:antigravity"),
            precise: true,
            dated: true,
            complete: true,
          });
          store.record("acp:antigravity", {
            limits: [rolled],
            since: store.mark("acp:antigravity"),
            precise: true,
            dated: true,
            complete: true,
          });
          expect(store.limits("acp:antigravity")).toEqual([rolled]);
        },
      ));
    });
  });

  it("tells subscribers when a window passes its reset", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const store = new PlanLimitStore();
    const expired = vi.fn();
    store.subscribe(expired);
    store.record("codex", { limits: [
      { name: "5h limit", limitId: "codex", windowKey: "primary", usedPercent: 90, resetAt: Date.now() + 400 },
      { name: "Weekly limit", limitId: "codex", windowKey: "secondary", usedPercent: 10, resetAt: Date.now() + hour },
    ] });
    store.record("claude", { limits: [{ name: "Weekly limit", limitId: "seven_day", usedPercent: 5 }] });
    await vi.advanceTimersByTimeAsync(401);
    expect(expired.mock.calls).toEqual([["codex"]]);
    expect(store.limits("codex")).toEqual([expect.objectContaining({ windowKey: "secondary" })]);
    store.close();
    await vi.advanceTimersByTimeAsync(hour);
    expect(expired).toHaveBeenCalledOnce();
  });

  it("separates providers and reports nothing for a provider that never reported", () => {
    const { store } = storeAt(1_000);
    expect(store.limits("claude")).toBeUndefined();
    expect(store.clear("claude")).toBe(true);
    expect(store.limits("claude")).toEqual([]);
    store.record("codex", { limits: [{ name: "5h limit", limitId: "codex", windowKey: "primary", usedPercent: 1 }] });
    expect(store.limits("claude")).toEqual([]);
    store.forget("codex");
    expect(store.limits("codex")).toBeUndefined();
  });
});
