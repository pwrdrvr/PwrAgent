import { FEDERATION_RECONNECT_MAX_DELAY_MS } from "./federation-reconnect-policy";

const LOG_INTERVALS_MS = [5 * 60_000, 30 * 60_000, 60 * 60_000];

function outageDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
  }
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

function intervalDuration(ms: number): string {
  return ms < 60_000 ? `${ms / 1_000}s` : `${ms / 60_000}m`;
}

/** Log backoff is independent of dialing; each outage starts with three warnings. */
export class FederationConnectionFailureLog {
  private firstFailureAt?: number;
  private lastLoggedAt?: number;
  private loggedFailures = 0;
  private logIntervalMs = 0;

  reset(): void {
    this.firstFailureAt = undefined;
    this.lastLoggedAt = undefined;
    this.loggedFailures = 0;
    this.logIntervalMs = 0;
  }

  recordFailure(now: number, retryDelayMs: number): string | undefined {
    this.firstFailureAt ??= now;
    if (
      this.loggedFailures >= 3
      && this.lastLoggedAt !== undefined
      && now - this.lastLoggedAt < this.logIntervalMs
    ) {
      return undefined;
    }
    this.lastLoggedAt = now;
    this.loggedFailures += 1;
    this.logIntervalMs = this.loggedFailures < 3
      ? retryDelayMs
      : LOG_INTERVALS_MS[Math.min(this.loggedFailures - 3, LOG_INTERVALS_MS.length - 1)];
    const retry = retryDelayMs >= FEDERATION_RECONNECT_MAX_DELAY_MS ? "every" : "in";
    const logging = this.loggedFailures <= 3 ? "again in" : "every";
    return `Couldn't connect to federation gateway for ${outageDuration(now - this.firstFailureAt)}; `
      + `retrying ${retry} ${intervalDuration(retryDelayMs)}; `
      + `logging ${logging} ${intervalDuration(this.logIntervalMs)}.`;
  }
}
