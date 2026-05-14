import path from "node:path";

const DEFAULT_POST_LOAD_DURATION_MS = 5_000;
const DEFAULT_HARD_TIMEOUT_MS = 15_000;

export type StartupCpuProfileConfig =
  | { enabled: false }
  | {
      enabled: true;
      repoRoot: string;
      outputRoot: string;
      postLoadDurationMs: number;
      hardTimeoutMs: number;
    };

function isEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function resolveStartupCpuProfileConfig(options?: {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}): StartupCpuProfileConfig {
  const env = options?.env ?? process.env;
  if (!isEnabled(env.PWRAGENT_STARTUP_CPU_PROFILING)) {
    return { enabled: false };
  }

  const repoRoot = path.resolve(
    env.PWRAGENT_STARTUP_CPU_PROFILE_ROOT ?? options?.repoRoot ?? process.cwd(),
  );

  return {
    enabled: true,
    repoRoot,
    outputRoot: path.join(repoRoot, ".local"),
    postLoadDurationMs: parsePositiveInteger(
      env.PWRAGENT_STARTUP_CPU_PROFILE_POST_LOAD_MS,
      DEFAULT_POST_LOAD_DURATION_MS,
    ),
    hardTimeoutMs: parsePositiveInteger(
      env.PWRAGENT_STARTUP_CPU_PROFILE_HARD_TIMEOUT_MS,
      DEFAULT_HARD_TIMEOUT_MS,
    ),
  };
}
