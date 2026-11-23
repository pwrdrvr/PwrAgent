import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  HOT_CPU_RULE_DURATIONS,
  isHotCpuCaptureRules,
  migrateHotCpuCaptureRules,
  primaryHotCpuRule,
  setHotCpuRuleEnabled,
  type HotCpuCaptureRules,
} from "@pwragent/shared/hot-cpu-rules";
import { resolveHotCpuRulePlan } from "../diagnostics/hot-cpu-profile-config";
import { HotCpuRuleEvaluator, type CpuInterval } from "../diagnostics/hot-cpu-rule-evaluator";

const mode = fc.constantFrom("spike", "sustained", "slowburn");
const cpuPercent = fc.integer({ min: 1, max: 400 });
const enabledChange = fc.tuple(fc.constantFrom("high", "slowburn"), fc.boolean());

describe("CPU capture rules", () => {
  it("keeps at least one group enabled and retains each edited rule through toggles", () => {
    fc.assert(fc.property(mode, fc.array(enabledChange, { maxLength: 30 }), cpuPercent, (legacy, changes, threshold) => {
      const migrated = migrateHotCpuCaptureRules(legacy, 25);
      const saved = { ...migrated, spike: { ...migrated.spike, thresholdPercent: threshold } };
      expect(primaryHotCpuRule(migrated)).toBe(legacy);
      expect(migrateHotCpuCaptureRules(primaryHotCpuRule(migrated), migrated.slowburn.thresholdPercent)).toEqual(migrated);

      // The independent model only stores the membership of the enabled set.
      const enabled = new Set([saved.highEnabled ? "high" : "slowburn"]);
      let actual = saved;
      for (const [group, enable] of changes) {
        if (enable) enabled.add(group);
        else if (enabled.size > 1) enabled.delete(group);
        actual = setHotCpuRuleEnabled(actual, group, enable);
        expect(isHotCpuCaptureRules(actual)).toBe(true);
        expect(actual).toEqual({
          ...saved,
          highEnabled: enabled.has("high"),
          slowburn: { ...saved.slowburn, enabled: enabled.has("slowburn") },
        });
      }
    }));
  });

  it("matches the legacy single-rule oracle on measured, uninterrupted default intervals", () => {
    fc.assert(fc.property(mode, fc.array(fc.integer({ min: 0, max: 85 }), { maxLength: 30 }), (triggerMode, percentages) => {
      const plan = resolveHotCpuRulePlan({ triggerMode, slowburnThresholdPercent: 21 }, {});
      const evaluator = new HotCpuRuleEvaluator(plan.rules, plan.intervalMs);
      const count = triggerMode === "spike" ? 1 : 2;
      const threshold = triggerMode === "slowburn" ? 21 : 50;
      percentages.forEach((cpuPercent, index) => {
        const window = percentages.slice(Math.max(0, index + 1 - count), index + 1);
        const match = window.length === count && window.every((sample) => sample >= threshold);
        expect(evaluator.observe({ elapsedMs: 2_000, cpuPercent, source: "cumulative" }).map((rule) => rule.id))
          .toEqual(match ? [triggerMode] : []);
      });
    }));
  });

  it("equals the trailing-window model for every rule and each independent target", () => {
    fc.assert(fc.property(
      fc.record({
        spike: fc.constantFrom(...HOT_CPU_RULE_DURATIONS.spike),
        sustained: fc.constantFrom(...HOT_CPU_RULE_DURATIONS.sustained),
        slowburn: fc.constantFrom(...HOT_CPU_RULE_DURATIONS.slowburn),
        mode: fc.constantFrom("spike" as const, "sustained" as const),
        highThreshold: fc.integer({ min: 1, max: 100 }),
        slowThreshold: fc.integer({ min: 1, max: 100 }),
      }),
      fc.array(fc.tuple(fc.integer({ min: 0, max: 1 }), fc.constantFrom(-1, 0.93, 1, 1.03, 2), cpuPercent), {
        minLength: 60, maxLength: 140, size: "max",
      }),
      (rules, sequence) => {
        const plan = resolveHotCpuRulePlan({
          captureRules: {
            highEnabled: true,
            highMode: rules.mode,
            spike: { thresholdPercent: rules.highThreshold, durationMs: rules.spike },
            sustained: { thresholdPercent: rules.highThreshold, durationMs: rules.sustained },
            slowburn: { enabled: true, thresholdPercent: rules.slowThreshold, durationMs: rules.slowburn },
          },
        }, {});
        const targets = Array.from({ length: 2 }, () => ({
          evaluator: new HotCpuRuleEvaluator(plan.rules, plan.intervalMs),
          history: [] as (CpuInterval | undefined)[],
        }));
        // Reach the longest supported window even if the random prefix
        // happens to contain frequent interruptions.
        const longHotRun = Array.from({ length: 122 }, (_, index) => [index % 2, 1, 100] as const);
        for (const [targetIndex, relativeDuration, cpuPercent] of [...sequence, ...longHotRun]) {
          const target = targets[targetIndex];
          const interval = relativeDuration < 0 ? undefined : {
            cpuPercent, elapsedMs: relativeDuration * plan.intervalMs, source: "cumulative" as const,
          };
          target.history.push(interval);
          const expected = plan.rules.filter((rule) => {
            const window = target.history.slice(-rule.sampleCount);
            return window.length === rule.sampleCount
              && window.every((sample) => sample && sample.elapsedMs <= plan.intervalMs * 1.5
                && sample.cpuPercent >= rule.thresholdPercent)
              && window.reduce((duration, sample) => duration + (sample?.elapsedMs ?? 0), 0) >= rule.durationMs - 50;
          }).map((rule) => rule.id);
          expect(target.evaluator.observe(interval).map((rule) => rule.id)).toEqual(expected);
        }
      },
    ));
  });

  it("honors scripted legacy timing while configured versions use the selected window", () => {
    const captureRules: HotCpuCaptureRules = {
      ...migrateHotCpuCaptureRules("spike"),
      spike: { thresholdPercent: 400, durationMs: 1_000 },
      slowburn: { enabled: true, thresholdPercent: 15, durationMs: 10_000 },
    };
    expect(resolveHotCpuRulePlan({ captureRules }, {}).rules).toEqual([
      { id: "spike", thresholdPercent: 400, durationMs: 1_000, sampleCount: 1 },
      { id: "slowburn", thresholdPercent: 15, durationMs: 10_000, sampleCount: 10 },
    ]);
    expect(resolveHotCpuRulePlan({ captureRules }, {
      PWRAGENT_HOT_CPU_PROFILING_TRIGGER_MODE: "SUSTAINED",
      PWRAGENT_HOT_CPU_PROFILING_THRESHOLD_PERCENT: "75.5",
      PWRAGENT_HOT_CPU_PROFILING_INTERVAL_MS: "250",
      PWRAGENT_HOT_CPU_PROFILING_CONSECUTIVE_SAMPLES: "1",
    })).toMatchObject({
      intervalMs: 250,
      rules: [{ id: "sustained", thresholdPercent: 75.5, durationMs: 250, sampleCount: 1 }],
    });
    expect(resolveHotCpuRulePlan({ captureRules }, {
      PWRAGENT_HOT_CPU_PROFILING_INTERVAL_MS: "2000",
    }).rules[0]).toMatchObject({ id: "spike", durationMs: 2_000, sampleCount: 1 });
  });
});
