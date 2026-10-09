/**
 * Small keyboard-accelerator helpers shared by window-chrome controls
 * (the panel toggle chips today). Mirrors the convention used across the
 * renderer: the primary accelerator is ⌘ on macOS and Ctrl elsewhere,
 * and chords never fire while the user is typing in a field.
 */
import type { KeybindingActionId } from "../../../shared/keybindings";
import { getDesktopApi } from "./desktop-api";
import {
  chordLabelFor,
  getKeybindingsState,
  keydownMatchesAction,
} from "./keybindings-store";

export function isPrimaryAccel(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">,
): boolean {
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
export function isPlatformPrimaryAccel(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">,
): boolean {
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
 *   "sidebar" toggles the left sidebar (⌘B / Ctrl+B by default)
 *   "rail"    toggles the right context rail (⌥⌘B / Ctrl+Alt+B)
 * Both never fire while typing in a field. The chords are the operator's
 * current bindings from `keybindings.toml`.
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
  const inField = isEditableTarget(event);
  if (keydownMatchesAction(event, "layout.toggle_sidebar", inField)) {
    return "sidebar";
  }
  if (keydownMatchesAction(event, "layout.toggle_context_rail", inField)) {
    return "rail";
  }
  return null;
}

/**
 * Classify a keydown as a history-navigation chord, or `null`. The defaults
 * are ⌘[ / ⌘] (the universal browser binding) and Alt+← / Alt+→ (the
 * Windows/Linux browser convention).
 *
 * The bracket chords stay live inside editable fields — like a browser,
 * ⌘[ never types anything — so navigation works while the caret sits in
 * the composer. A chord that edits text, such as Alt+arrow (word-wise caret
 * movement), never fires while editing.
 */
export function matchHistoryNavChord(
  event: KeyboardEvent,
): "back" | "forward" | null {
  const inField = isEditableTarget(event);
  if (keydownMatchesAction(event, "navigation.back", inField)) {
    return "back";
  }
  if (keydownMatchesAction(event, "navigation.forward", inField)) {
    return "forward";
  }
  return null;
}

/**
 * Classify a keydown as a find/search chord, or `null`:
 *   "find"   context find, ⌘F by default — in-thread find when a thread is
 *            open, or the thread-list quick-search when the sidebar is
 *            focused; the caller resolves which from focus
 *   "search" open the global thread search screen, ⇧⌘F by default
 *
 * Find is deliberately focus-sensitive; {@link matchThreadJumpChord} is the
 * unambiguous way to reach the thread list from anywhere. Both stay live in
 * editable fields, unless the operator bound a chord that edits text there.
 */
export function matchFindChord(event: KeyboardEvent): "find" | "search" | null {
  const inField = isEditableTarget(event);
  if (keydownMatchesAction(event, "navigation.find", inField)) {
    return "find";
  }
  if (keydownMatchesAction(event, "navigation.search_threads", inField)) {
    return "search";
  }
  return null;
}

/**
 * Whether `event` is the thread-jump chord, ⌘K / Ctrl+K by default.
 *
 * It is the focus-independent way into the thread-list quick search — the
 * near-universal "jump to a thing in the list" binding (Slack's quick switcher,
 * Linear, GitHub, VS Code's ⌘P sibling). It exists because find follows focus:
 * the operator reaching for the thread list from inside a thread would land in
 * the in-thread find instead, since the composer and transcript belong to the
 * thread. The jump chord always means the list.
 *
 * It stays live in editable fields — the composer is exactly where an operator
 * is standing when they want to jump elsewhere. The platform's modifier is
 * matched strictly, so the default never swallows macOS's ⌃K
 * (delete-to-end-of-line) in the composer.
 */
export function matchThreadJumpChord(event: KeyboardEvent): boolean {
  return keydownMatchesAction(event, "navigation.jump_to_thread", isEditableTarget(event));
}

/**
 * The display label of an action's current first chord, in this platform's
 * notation, or `undefined` when the operator unbound it.
 */
export function formatActionChord(actionId: KeybindingActionId): string | undefined {
  return chordLabelFor(getKeybindingsState(), actionId);
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
