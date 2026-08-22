export const FEDERATION_RECONNECT_INITIAL_DELAY_MS = 1_000;
export const FEDERATION_RECONNECT_MAX_DELAY_MS = 30_000;

export function federationReconnectDelayMs(attempt: number): number {
  return Math.min(
    FEDERATION_RECONNECT_INITIAL_DELAY_MS * 2 ** attempt,
    FEDERATION_RECONNECT_MAX_DELAY_MS,
  );
}
