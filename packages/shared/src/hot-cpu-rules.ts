export const HOT_CPU_RULE_DURATIONS = {
  spike: [1_000, 2_000],
  sustained: [4_000, 6_000, 10_000, 20_000],
  slowburn: [4_000, 10_000, 30_000, 60_000],
} as const;

export type HotCpuRuleId = keyof typeof HOT_CPU_RULE_DURATIONS;
export type HighCpuMode = Exclude<HotCpuRuleId, "slowburn">;

type RuleSettings<Id extends HotCpuRuleId> = {
  thresholdPercent: number;
  durationMs: (typeof HOT_CPU_RULE_DURATIONS)[Id][number];
};

type LegacyIntervalTiming = {
  /** Retain the scripted two-sample window under an explicit cadence override until its duration is edited. */
  legacyIntervalTiming?: true;
};

export type HotCpuCaptureRules = {
  highEnabled: boolean;
  highMode: HighCpuMode;
  spike: RuleSettings<"spike">;
  sustained: RuleSettings<"sustained"> & LegacyIntervalTiming;
  slowburn: RuleSettings<"slowburn"> & LegacyIntervalTiming & { enabled: boolean };
};

export type EffectiveHotCpuRule = {
  id: HotCpuRuleId;
  thresholdPercent: number;
  durationMs: number;
  sampleCount: number;
};

export type HotCpuRulePlan = {
  intervalMs: number;
  rules: EffectiveHotCpuRule[];
  overrides: {
    mode?: string;
    highThreshold?: string;
    slowburnThreshold?: string;
    interval?: string;
    sampleCount?: string;
  };
};

export const HOT_CPU_RULE_LABELS: Record<HotCpuRuleId, string> = {
  spike: "Spike",
  sustained: "Sustained",
  slowburn: "Slow burn",
};

export function isHotCpuThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 400;
}

export function migrateHotCpuCaptureRules(
  mode: HotCpuRuleId = "sustained",
  slowburnThresholdPercent?: number,
): HotCpuCaptureRules {
  // The legacy setting rounded and clamped configured percentages to 1–100.
  const legacyThreshold = slowburnThresholdPercent !== undefined && Number.isFinite(slowburnThresholdPercent)
    ? Math.min(100, Math.max(1, Math.round(slowburnThresholdPercent)))
    : 15;
  return {
    highEnabled: mode !== "slowburn",
    highMode: mode === "spike" ? "spike" : "sustained",
    spike: { thresholdPercent: 50, durationMs: 2_000 },
    sustained: { thresholdPercent: 50, durationMs: 4_000 },
    slowburn: { enabled: mode === "slowburn", thresholdPercent: legacyThreshold, durationMs: 4_000 },
  };
}

export function primaryHotCpuRule(rules: HotCpuCaptureRules): HotCpuRuleId {
  return rules.highEnabled ? rules.highMode : "slowburn";
}

export function setHotCpuRuleEnabled(
  rules: HotCpuCaptureRules,
  group: "high" | "slowburn",
  enabled: boolean,
): HotCpuCaptureRules {
  if (group === "high") {
    return enabled || rules.slowburn.enabled ? { ...rules, highEnabled: enabled } : rules;
  }
  return enabled || rules.highEnabled
    ? { ...rules, slowburn: { ...rules.slowburn, enabled } }
    : rules;
}

export function isHotCpuCaptureRules(value: unknown): value is HotCpuCaptureRules {
  if (!value || typeof value !== "object") return false;
  const rules = value as Partial<HotCpuCaptureRules>;
  return typeof rules.highEnabled === "boolean"
    && (rules.highMode === "spike" || rules.highMode === "sustained")
    && typeof rules.slowburn?.enabled === "boolean"
    && (rules.highEnabled || rules.slowburn.enabled)
    && (rules.sustained?.legacyIntervalTiming === undefined || rules.sustained.legacyIntervalTiming === true)
    && (rules.slowburn.legacyIntervalTiming === undefined || rules.slowburn.legacyIntervalTiming === true)
    && (["spike", "sustained", "slowburn"] as const).every((id) => {
      const rule = rules[id];
      const durations: readonly number[] = HOT_CPU_RULE_DURATIONS[id];
      return rule && isHotCpuThreshold(rule.thresholdPercent) && durations.includes(rule.durationMs);
    });
}


export function assertHotCpuCaptureRules(value: unknown): asserts value is HotCpuCaptureRules {
  if (!isHotCpuCaptureRules(value)) {
    throw new Error("Invalid CPU capture rules. Enable at least one rule and use a valid threshold and duration.");
  }
}
