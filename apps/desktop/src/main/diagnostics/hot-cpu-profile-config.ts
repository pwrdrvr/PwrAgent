import path from "node:path";
import {
  migrateHotCpuCaptureRules,
  type EffectiveHotCpuRule,
  type HotCpuCaptureRules,
  type HotCpuRulePlan,
} from "@pwragent/shared/hot-cpu-rules";
import type { DesktopHotCpuProfileTriggerMode } from "@pwragent/shared/contracts/settings";
import {
  DESKTOP_HOT_CPU_PROFILE_START_DELAY_DEFAULT_MS,
  isDesktopHotCpuProfileTriggerMode,
} from "@pwragent/shared/contracts/settings";

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_CONSECUTIVE_SAMPLES = 2;
const DEFAULT_PROFILE_DURATION_MS = 15_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_PROFILES = 5;
const DEFAULT_HEAP_SNAPSHOT = false;
const DEFAULT_HEAP_SNAPSHOT_LIMIT = 2;
const MAX_HEAP_SNAPSHOT_LIMIT = 3;

export type HotCpuProfileConfig =
  | { enabled: false }
  | {
      enabled: true;
      repoRoot: string;
      outputRoot: string;
      startDelayMs: number;
      triggerMode: DesktopHotCpuProfileTriggerMode;
      intervalMs: number;
      rules: EffectiveHotCpuRule[];
      thresholdPercent: number;
      slowburnThresholdPercent: number;
      consecutiveSamples: number;
      profileDurationMs: number;
      cooldownMs: number;
      maxProfiles: number;
      captureHeapSnapshot: boolean;
      heapSnapshotLimit: number;
    };

function isEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveNumber(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampHeapSnapshotLimit(value: number): number {
  return Math.min(Math.max(Math.round(value), 1), MAX_HEAP_SNAPSHOT_LIMIT);
}

function clampPercent(value: number): number {
  return Math.min(Math.max(value, 1), 100);
}

const MODE_ENV = "PWRAGENT_HOT_CPU_PROFILING_TRIGGER_MODE";
const HIGH_THRESHOLD_ENV = "PWRAGENT_HOT_CPU_PROFILING_THRESHOLD_PERCENT";
const SLOWBURN_THRESHOLD_ENV = "PWRAGENT_HOT_CPU_PROFILING_SLOWBURN_THRESHOLD_PERCENT";
const INTERVAL_ENV = "PWRAGENT_HOT_CPU_PROFILING_INTERVAL_MS";
const COUNT_ENV = "PWRAGENT_HOT_CPU_PROFILING_CONSECUTIVE_SAMPLES";

export type HotCpuRuleOptions = {
  captureRules?: HotCpuCaptureRules;
  triggerMode?: DesktopHotCpuProfileTriggerMode;
  slowburnThresholdPercent?: number;
};

export function resolveHotCpuRulePlan(
  options: HotCpuRuleOptions,
  env: NodeJS.ProcessEnv,
): HotCpuRulePlan {
  return resolveHotCpuRules(options, env).plan;
}

function resolveHotCpuRules(options: HotCpuRuleOptions, env: NodeJS.ProcessEnv) {
  const configured = options.captureRules
    ?? migrateHotCpuCaptureRules(options.triggerMode, options.slowburnThresholdPercent);
  const envMode = env[MODE_ENV]?.trim().toLowerCase();
  const forcedMode = envMode && isDesktopHotCpuProfileTriggerMode(envMode) ? envMode : undefined;
  const rules = forcedMode ? migrateHotCpuCaptureRules(forcedMode) : configured;
  const forcedHighThreshold = parsePositiveNumber(env[HIGH_THRESHOLD_ENV], 0);
  const forcedSlowburnThreshold = parsePositiveNumber(env[SLOWBURN_THRESHOLD_ENV], 0);
  const forcedInterval = parsePositiveInteger(env[INTERVAL_ENV], 0);
  const forcedCount = parsePositiveInteger(env[COUNT_ENV], 0);
  const intervalMs = forcedInterval || (
    rules.highEnabled && rules.highMode === "spike" ? rules.spike.durationMs : DEFAULT_INTERVAL_MS
  );
  const legacyTiming = Boolean(forcedMode || (!options.captureRules && forcedInterval));
  const highThresholdPercent = forcedHighThreshold || rules[rules.highMode].thresholdPercent;
  const slowburnThresholdPercent = forcedSlowburnThreshold
    ? clampPercent(forcedSlowburnThreshold)
    : configured.slowburn.thresholdPercent;
  const activeRules: EffectiveHotCpuRule[] = [];
  const ids = [
    ...(rules.highEnabled ? [rules.highMode] : []),
    ...(rules.slowburn.enabled ? ["slowburn" as const] : []),
  ];
  for (const id of ids) {
    const sampleCount = id === "spike" ? 1
      : forcedCount || (legacyTiming ? DEFAULT_CONSECUTIVE_SAMPLES
        : Math.max(2, Math.ceil(rules[id].durationMs / intervalMs)));
    const thresholdPercent = id === "slowburn" ? slowburnThresholdPercent : highThresholdPercent;
    const durationMs = id === "spike" || forcedCount || legacyTiming
      ? sampleCount * intervalMs
      : rules[id].durationMs;
    activeRules.push({ id, thresholdPercent, durationMs, sampleCount });
  }
  const plan: HotCpuRulePlan = {
    intervalMs,
    rules: activeRules,
    overrides: {
      ...(forcedMode ? { mode: MODE_ENV } : {}),
      ...(forcedHighThreshold ? { highThreshold: HIGH_THRESHOLD_ENV } : {}),
      ...(forcedSlowburnThreshold ? { slowburnThreshold: SLOWBURN_THRESHOLD_ENV } : {}),
      ...(forcedInterval ? { interval: INTERVAL_ENV } : {}),
      ...(forcedCount ? { sampleCount: COUNT_ENV } : {}),
    },
  };
  return { plan, highThresholdPercent, slowburnThresholdPercent, forcedCount };
}

export function resolveHotCpuProfileConfig(options?: HotCpuRuleOptions & {
  captureHeapSnapshot?: boolean;
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
  heapSnapshotLimit?: number;
  outputRoot?: string;
  repoRoot?: string;
  startDelayMs?: number;
}): HotCpuProfileConfig {
  const env = options?.env ?? process.env;
  if (!options?.enabled && !isEnabled(env.PWRAGENT_HOT_CPU_PROFILING)) {
    return { enabled: false };
  }

  const repoRoot = path.resolve(
    env.PWRAGENT_HOT_CPU_PROFILING_ROOT ?? options?.repoRoot ?? process.cwd(),
  );
  const outputRoot = options?.outputRoot ?? path.join(repoRoot, ".local");
  const { plan, highThresholdPercent, slowburnThresholdPercent, forcedCount } = resolveHotCpuRules(options ?? {}, env);
  const [primary] = plan.rules;

  return {
    enabled: true,
    repoRoot,
    outputRoot,
    startDelayMs: parseNonNegativeInteger(
      env.PWRAGENT_HOT_CPU_PROFILING_START_DELAY_MS,
      options?.startDelayMs ?? DESKTOP_HOT_CPU_PROFILE_START_DELAY_DEFAULT_MS,
    ),
    triggerMode: primary.id,
    intervalMs: plan.intervalMs,
    rules: plan.rules,
    thresholdPercent: highThresholdPercent,
    slowburnThresholdPercent,
    consecutiveSamples: primary.id === "spike"
      ? forcedCount || DEFAULT_CONSECUTIVE_SAMPLES
      : primary.sampleCount,
    profileDurationMs: parsePositiveInteger(
      env.PWRAGENT_HOT_CPU_PROFILING_DURATION_MS,
      DEFAULT_PROFILE_DURATION_MS,
    ),
    cooldownMs: parsePositiveInteger(
      env.PWRAGENT_HOT_CPU_PROFILING_COOLDOWN_MS,
      DEFAULT_COOLDOWN_MS,
    ),
    maxProfiles: parsePositiveInteger(
      env.PWRAGENT_HOT_CPU_PROFILING_MAX_PROFILES,
      DEFAULT_MAX_PROFILES,
    ),
    captureHeapSnapshot:
      env.PWRAGENT_HOT_CPU_PROFILING_HEAP_SNAPSHOT === undefined
        ? options?.captureHeapSnapshot ?? DEFAULT_HEAP_SNAPSHOT
        : isEnabled(env.PWRAGENT_HOT_CPU_PROFILING_HEAP_SNAPSHOT),
    heapSnapshotLimit: clampHeapSnapshotLimit(
      parsePositiveInteger(
        env.PWRAGENT_HOT_CPU_PROFILING_HEAP_SNAPSHOT_LIMIT,
        options?.heapSnapshotLimit ?? DEFAULT_HEAP_SNAPSHOT_LIMIT,
      ),
    ),
  };
}
