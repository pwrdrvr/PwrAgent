import path from "node:path";

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_THRESHOLD_PERCENT = 50;
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
      intervalMs: number;
      thresholdPercent: number;
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

export function resolveHotCpuProfileConfig(options?: {
  captureHeapSnapshot?: boolean;
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
  heapSnapshotLimit?: number;
  outputRoot?: string;
  repoRoot?: string;
}): HotCpuProfileConfig {
  const env = options?.env ?? process.env;
  if (!options?.enabled && !isEnabled(env.PWRAGENT_HOT_CPU_PROFILING)) {
    return { enabled: false };
  }

  const repoRoot = path.resolve(
    env.PWRAGENT_HOT_CPU_PROFILING_ROOT ?? options?.repoRoot ?? process.cwd(),
  );
  const outputRoot = options?.outputRoot ?? path.join(repoRoot, ".local");

  return {
    enabled: true,
    repoRoot,
    outputRoot,
    intervalMs: parsePositiveInteger(
      env.PWRAGENT_HOT_CPU_PROFILING_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
    ),
    thresholdPercent: parsePositiveNumber(
      env.PWRAGENT_HOT_CPU_PROFILING_THRESHOLD_PERCENT,
      DEFAULT_THRESHOLD_PERCENT,
    ),
    consecutiveSamples: parsePositiveInteger(
      env.PWRAGENT_HOT_CPU_PROFILING_CONSECUTIVE_SAMPLES,
      DEFAULT_CONSECUTIVE_SAMPLES,
    ),
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
