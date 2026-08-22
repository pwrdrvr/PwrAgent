export const E2E_FAST_FEDERATION_RECONNECT_ENV =
  "PWRAGENT_E2E_FAST_FEDERATION_RECONNECT";

export const FEDERATION_RECONNECT_DEFAULT_MAX_DELAY_MS = 30_000;
export const FEDERATION_RECONNECT_E2E_MAX_DELAY_MS = 1_000;

/**
 * Electron E2E repeatedly stops and restores a loopback gateway in one test.
 * Keep those reconnect attempts dense enough to observe the restored gateway
 * without changing the production backoff or increasing normal network load.
 * Packaged startup clears the opt-in variable before the runtime is created.
 */
export function resolveFederationReconnectMaxDelayMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return env.PWRAGENT_E2E === "1"
    && env[E2E_FAST_FEDERATION_RECONNECT_ENV] === "1"
    ? FEDERATION_RECONNECT_E2E_MAX_DELAY_MS
    : FEDERATION_RECONNECT_DEFAULT_MAX_DELAY_MS;
}
