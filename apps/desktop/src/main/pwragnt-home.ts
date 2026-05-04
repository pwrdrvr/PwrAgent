import path from "node:path";

export const PWRAGNT_HOME_ENV = "PWRAGNT_HOME";

export type PwragntHomeOptions = {
  env?: NodeJS.ProcessEnv;
};

export function readPwragntHome(
  options?: PwragntHomeOptions,
): string | undefined {
  const env = options?.env ?? process.env;
  const value = env[PWRAGNT_HOME_ENV]?.trim();
  return value ? path.resolve(value) : undefined;
}
