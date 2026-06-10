/**
 * Small keyboard-accelerator helpers shared by window-chrome controls
 * (the panel toggle chips today). Mirrors the convention used across the
 * renderer: the primary accelerator is ⌘ on macOS and Ctrl elsewhere,
 * and chords never fire while the user is typing in a field.
 */
import { getDesktopApi } from "./desktop-api";

export function isPrimaryAccel(event: KeyboardEvent): boolean {
  // macOS uses Cmd (metaKey); Windows/Linux use Ctrl. We don't read the
  // platform here — accepting either keeps the check simple and matches
  // how the rest of the app treats accelerators.
  return event.metaKey !== event.ctrlKey;
}

export function isEditableTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (target === null) {
    return false;
  }
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

/**
 * Render the display label for a primary-accelerator chord, adjusted for
 * the current platform: ⌘/⌥ glyphs on macOS, "Ctrl"/"Alt" words joined
 * with "+" on Windows/Linux. This is presentation only — {@link
 * isPrimaryAccel} accepts either Cmd or Ctrl at runtime, so the binding
 * works regardless of which label we show. Falls back to the Windows/Linux
 * form when the platform is unknown (the desktop bridge is unavailable).
 */
export function formatPrimaryAccel(
  key: string,
  options: { alt?: boolean } = {},
): string {
  const isMac = getDesktopApi()?.platform === "darwin";
  if (isMac) {
    return `⌘${options.alt ? "⌥" : ""}${key}`;
  }
  const parts = ["Ctrl"];
  if (options.alt) {
    parts.push("Alt");
  }
  parts.push(key);
  return parts.join("+");
}
