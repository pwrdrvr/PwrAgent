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

/**
 * Stricter sibling of {@link isPrimaryAccel}, for chords that would otherwise
 * shadow a platform text-editing binding: ⌘ on macOS, Ctrl on Windows/Linux —
 * never "either one." {@link isPrimaryAccel}'s Cmd-or-Ctrl leniency is fine for
 * a chord like ⌘F, but a chord that stays live inside text fields AND calls
 * preventDefault will SWALLOW whatever the platform bound the Ctrl form to. On
 * macOS, Chromium implements the emacs-style editing bindings in inputs and
 * contenteditables, so ⌃K is delete-to-end-of-line — losing that in the composer
 * is a real regression, unlike losing a caret-movement binding.
 *
 * Falls back to the lenient check when the platform is unknown (the desktop
 * bridge is unavailable, e.g. in unit tests), so a chord never goes dead.
 */
export function isPlatformPrimaryAccel(event: KeyboardEvent): boolean {
  const platform = getDesktopApi()?.platform;
  if (platform === undefined) {
    return isPrimaryAccel(event);
  }
  return platform === "darwin"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
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
 * Classify a keydown as a history-navigation chord, or `null`:
 *   ⌘[ / ⌃[   → "back"     (the universal browser binding)
 *   ⌘] / ⌃]   → "forward"
 *   ⌥← / Alt+← → "back"     (the Windows/Linux browser convention)
 *   ⌥→ / Alt+→ → "forward"
 *
 * The bracket chords stay live inside editable fields — like a browser,
 * ⌘[ never types anything — so navigation works while the caret sits in
 * the composer. The Alt-arrow pair must NOT fire while editing: Option/
 * Alt+arrow is word-wise caret movement there.
 *
 * Brackets match `event.code` first (layout-independent physical key)
 * with an `event.key` fallback, mirroring {@link isAccelLetter}.
 */
export function matchHistoryNavChord(
  event: KeyboardEvent,
): "back" | "forward" | null {
  if (isPrimaryAccel(event) && !event.altKey && !event.shiftKey) {
    if (event.code === "BracketLeft" || event.key === "[") {
      return "back";
    }
    if (event.code === "BracketRight" || event.key === "]") {
      return "forward";
    }
    return null;
  }
  if (
    event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !isEditableTarget(event)
  ) {
    if (event.key === "ArrowLeft") {
      return "back";
    }
    if (event.key === "ArrowRight") {
      return "forward";
    }
  }
  return null;
}

/**
 * Classify a keydown as a find/search chord, or `null`:
 *   ⌘F / ⌃F   → "find"   (context find — in-thread find when a thread is open,
 *                          or the thread-list quick-search when the sidebar is
 *                          focused; the caller resolves which from focus)
 *   ⌘⇧F / ⌃⇧F → "search" (open the global thread search screen)
 *
 * ⌘F is deliberately focus-sensitive; {@link matchThreadJumpChord} (⌘K) is the
 * unambiguous way to reach the thread list from anywhere.
 *
 * Unlike {@link matchLayoutChord}, find stays live inside editable fields —
 * ⌘F is a universal "find" gesture that should fire even while the caret is in
 * the composer or another input. ⌥ is excluded so it never collides with an
 * Option chord.
 */
export function matchFindChord(event: KeyboardEvent): "find" | "search" | null {
  if (!isPrimaryAccel(event)) {
    return null;
  }
  if (event.altKey) {
    return null;
  }
  if (!isAccelLetter(event, "f")) {
    return null;
  }
  return event.shiftKey ? "search" : "find";
}

/**
 * Whether `event` is the thread-jump chord: ⌘K / ⌃K.
 *
 * ⌘K is the focus-independent way into the thread-list quick search — the
 * near-universal "jump to a thing in the list" binding (Slack's quick switcher,
 * Linear, GitHub, VS Code's ⌘P sibling). It exists because ⌘F follows focus:
 * the operator reaching for the thread list from inside a thread would land in
 * the in-thread find instead, since the composer and transcript belong to the
 * thread. ⌘K always means the list.
 *
 * Like {@link matchFindChord} it stays live in editable fields — the composer is
 * exactly where an operator is standing when they want to jump elsewhere. Shift
 * and Option are excluded so it can't collide with a future chord.
 *
 * Unlike every other chord here it uses {@link isPlatformPrimaryAccel}, NOT the
 * lenient Cmd-or-Ctrl check: staying live in text fields means the Ctrl form
 * would swallow macOS's ⌃K (delete-to-end-of-line) in the composer. So ⌘K on
 * macOS, Ctrl+K on Windows/Linux (where Ctrl+K binds nothing native), and the
 * composer keeps its editing keys on both.
 */
export function matchThreadJumpChord(event: KeyboardEvent): boolean {
  return (
    isPlatformPrimaryAccel(event) &&
    !event.altKey &&
    !event.shiftKey &&
    isAccelLetter(event, "k")
  );
}

/**
 * Render the display label for a primary-accelerator chord, adjusted for
 * the current platform: ⌘/⌥/⇧ glyphs on macOS, "Ctrl"/"Alt"/"Shift" words
 * joined with "+" on Windows/Linux. This is presentation only — {@link
 * isPrimaryAccel} accepts either Cmd or Ctrl at runtime, so the binding
 * works regardless of which label we show. Falls back to the Windows/Linux
 * form when the platform is unknown (the desktop bridge is unavailable).
 */
export function formatPrimaryAccel(
  key: string,
  options: { alt?: boolean; shift?: boolean } = {},
): string {
  const isMac = getDesktopApi()?.platform === "darwin";
  if (isMac) {
    return `⌘${options.alt ? "⌥" : ""}${options.shift ? "⇧" : ""}${key}`;
  }
  const parts = ["Ctrl"];
  if (options.alt) {
    parts.push("Alt");
  }
  if (options.shift) {
    parts.push("Shift");
  }
  parts.push(key);
  return parts.join("+");
}
