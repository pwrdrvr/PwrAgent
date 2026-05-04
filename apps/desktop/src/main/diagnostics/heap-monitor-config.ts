import path from "node:path";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_SETTLE_DELAY_MS = 1_000;
const DEFAULT_DELTA_THRESHOLD_BYTES = 100 * 1024 * 1024;
const DEFAULT_SNAPSHOT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_SNAPSHOTS = 5;

export type HeapMonitorConfig =
  | { enabled: false }
  | {
      enabled: true;
      repoRoot: string;
      outputRoot: string;
      intervalMs: number;
      settleDelayMs: number;
      deltaThresholdBytes: number;
      snapshotCooldownMs: number;
      maxSnapshots: number;
    };

function isEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

export function resolveHeapMonitorConfig(options?: {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}): HeapMonitorConfig {
  const env = options?.env ?? process.env;
  if (!isEnabled(env.PWRAGENT_HEAP_DIAGNOSTICS)) {
    return { enabled: false };
  }

  const repoRoot = path.resolve(
    env.PWRAGENT_HEAP_DIAGNOSTICS_ROOT ?? options?.repoRoot ?? process.cwd(),
  );

  return {
    enabled: true,
    repoRoot,
    outputRoot: path.join(repoRoot, ".local"),
    intervalMs: parsePositiveInteger(
      env.PWRAGENT_HEAP_DIAGNOSTICS_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
    ),
    settleDelayMs: parseNonNegativeInteger(
      env.PWRAGENT_HEAP_DIAGNOSTICS_SETTLE_MS,
      DEFAULT_SETTLE_DELAY_MS,
    ),
    deltaThresholdBytes: parsePositiveInteger(
      env.PWRAGENT_HEAP_DIAGNOSTICS_DELTA_BYTES,
      DEFAULT_DELTA_THRESHOLD_BYTES,
    ),
    snapshotCooldownMs: parseNonNegativeInteger(
      env.PWRAGENT_HEAP_DIAGNOSTICS_COOLDOWN_MS,
      DEFAULT_SNAPSHOT_COOLDOWN_MS,
    ),
    maxSnapshots: parsePositiveInteger(
      env.PWRAGENT_HEAP_DIAGNOSTICS_MAX_SNAPSHOTS,
      DEFAULT_MAX_SNAPSHOTS,
    ),
  };
}
