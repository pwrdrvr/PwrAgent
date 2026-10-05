/**
 * Mid-turn, a composer's primary action queues behind the running turn and
 * the platform's primary accelerator + Enter steers into it instead: ⌘Enter
 * on macOS, Ctrl+Enter on Windows/Linux. Ctrl alone on macOS (and the
 * Windows key elsewhere) is not the chord — the strict check keeps it from
 * reading as one. Both composers share this so the chord and its tooltip
 * cannot drift apart.
 */
import {
  formatPrimaryAccel,
  isPlatformPrimaryAccel,
} from "../../lib/keyboard-accel";

export function isSteerShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">,
): boolean {
  return isPlatformPrimaryAccel(event);
}

/** Tooltip for a Queue button whose running turn can take a steer. */
export function formatQueueButtonTooltip(): string {
  return `Queue after this turn · ${formatPrimaryAccel("Enter")} to steer it in`;
}
