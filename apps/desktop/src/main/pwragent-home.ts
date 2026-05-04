import path from "node:path";

export const PWRAGENT_HOME_ENV = "PWRAGENT_HOME";

export type PwragentHomeOptions = {
  env?: NodeJS.ProcessEnv;
};

export function readPwragentHome(
  options?: PwragentHomeOptions,
): string | undefined {
  const env = options?.env ?? process.env;
  const value = env[PWRAGENT_HOME_ENV]?.trim();
  return value ? path.resolve(value) : undefined;
}
