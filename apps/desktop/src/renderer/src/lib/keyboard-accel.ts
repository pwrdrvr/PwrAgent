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
 * Whether `event` targets the given single letter, robust to the macOS
 * Option-compose quirk. Holding Option (Alt) on macOS rewrites `event.key`
 * into the composed character it would type (⌥B → "∫", ⌥V → "√", …), so any
 * chord that includes Alt can NEVER be matched against `event.key` — which is
 * why ⌘⌥B silently did nothing while ⌘B worked. Match the physical key via
 * `event.code` ("Key" + the uppercased letter) instead, which is independent
 * of modifiers and layout-composition; fall back to `event.key` for the rare
 * environment that doesn't populate `code`.
 */
export function isAccelLetter(event: KeyboardEvent, letter: string): boolean {
  const upper = letter.toUpperCase();
  return (
    event.code === `Key${upper}` ||
    event.key === upper ||
    event.key === upper.toLowerCase()
  );
}

/**
 * Classify a keydown as one of the two window-layout chords, or `null`:
 *   ⌘B / ⌃B   → "sidebar" (toggle the left sidebar)
 *   ⌘⌥B / ⌃⌥B → "rail"    (toggle the right context rail)
 * Returns `null` while typing in a field, without the primary modifier, or
 * for any other key.
 *
 * Pure + side-effect-free so a SINGLE owner can wire one window listener to it
 * (see `useLayoutChordHotkeys`). Previously each `PanelToggleButtons` instance
 * bound its own listener; on Windows the title bar and the thread header both
 * render the chips, so two listeners fired and the chord toggled twice — a
 * visible no-op.
 */
export function matchLayoutChord(
  event: KeyboardEvent,
): "sidebar" | "rail" | null {
  if (isEditableTarget(event)) {
    return null;
  }
  if (!isPrimaryAccel(event)) {
    return null;
  }
  if (!isAccelLetter(event, "b")) {
    return null;
  }
  return event.altKey ? "rail" : "sidebar";
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
