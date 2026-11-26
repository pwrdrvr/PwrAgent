export const DEFAULT_LOCAL_CPU_BUDGET: 4;

export type LocalCpuBudget = {
  units: number;
  source: "env" | "thread-checkout" | "directory-checkout" | "default";
  allocationId?: string;
  deadlineAt?: number;
};

export function resolvePwragentRootFromEnv(env?: NodeJS.ProcessEnv): string;

export function resolveLocalCpuBudget(options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  budgetDir?: string;
  platform?: NodeJS.Platform;
  fallback?: number | null;
}): LocalCpuBudget | undefined;

export function hasCliFlag(argv: readonly string[], names: readonly string[]): boolean;

export function buildBudgetThreadEnv(
  units: number,
  baseEnv?: NodeJS.ProcessEnv,
): Record<string, string>;

export function splitTypedLintBudget(units: number): {
  oxlintThreads: number;
  goMaxProcs: number;
};
