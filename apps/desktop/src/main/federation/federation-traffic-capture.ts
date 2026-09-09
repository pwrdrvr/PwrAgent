import { getMainLogger } from "../log";

const log = getMainLogger("pwragent:federation-transport");
let expiresAt = 0;

/** Process-local diagnostic window; never persisted or extended by activity reads. */
export function federationTrafficCaptureUntil(now = Date.now()): number | undefined {
  return now < expiresAt ? expiresAt : undefined;
}

export function setFederationTrafficCapture(enabled: boolean): void {
  expiresAt = enabled ? Date.now() + 60_000 : 0;
  log.info(enabled ? "federation detailed traffic capture started" : "federation detailed traffic capture stopped", {
    expiresAt: enabled ? expiresAt : undefined,
    durationMs: enabled ? 60_000 : 0,
  });
}
