import type { MessagingActivityStorage } from "@pwragent/owner-core/messaging-activity-storage";
import { createMessagingActivityStorage } from "../storage/desktop-messaging-storage";

let logOverride: MessagingActivityStorage | null = null;

/**
 * Singleton accessor for the desktop messaging activity log. Backed by
 * the same sqlite state DB as bindings + overlay so the log survives
 * restarts under the same FIFO / GC policy as the rest of the schema.
 */
export function getDesktopMessagingActivityLog(): MessagingActivityStorage {
  if (logOverride) return logOverride;
  return createMessagingActivityStorage();
}

export function setDesktopMessagingActivityLogForTests(
  log: MessagingActivityStorage | null,
): void {
  logOverride = log;
}
