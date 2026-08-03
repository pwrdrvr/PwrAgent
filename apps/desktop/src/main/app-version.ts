export const PWRAGENT_E2E_APP_VERSION_ENV = "PWRAGENT_E2E_APP_VERSION";

export function resolveApplicationVersion(
  runtimeVersion: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const e2eVersion = env[PWRAGENT_E2E_APP_VERSION_ENV];
  if (
    env.PWRAGENT_E2E === "1"
    && e2eVersion !== undefined
    && e2eVersion !== ""
  ) {
    return e2eVersion;
  }
  return runtimeVersion;
}
