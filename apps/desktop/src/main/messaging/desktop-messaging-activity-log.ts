import { MessagingActivityLog } from "./messaging-activity-log";
import { getAppStateDb } from "../state/app-state";

let logOverride: MessagingActivityLog | null = null;

/**
 * Singleton accessor for the desktop messaging activity log. Backed by
 * the same sqlite state DB as bindings + overlay so the log survives
 * restarts under the same FIFO / GC policy as the rest of the schema.
 */
export function getDesktopMessagingActivityLog(): MessagingActivityLog {
  if (logOverride) return logOverride;
  return new MessagingActivityLog(getAppStateDb());
}

export function setDesktopMessagingActivityLogForTests(
  log: MessagingActivityLog | null,
): void {
  logOverride = log;
}
