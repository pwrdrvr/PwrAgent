/**
 * Small keyboard-accelerator helpers shared by window-chrome controls
 * (the panel toggle chips today). Mirrors the convention used across the
 * renderer: the primary accelerator is ⌘ on macOS and Ctrl elsewhere,
 * and chords never fire while the user is typing in a field.
 */

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
