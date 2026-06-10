import { useEffect, useRef } from "react";
import { matchLayoutChord } from "../../lib/keyboard-accel";

/**
 * Binds the single window-level listener for the layout chords
 * (⌘B / ⌃B → sidebar, ⌘⌥B / ⌃⌥B → rail). Call this exactly ONCE, from the
 * always-mounted shell owner — NOT from each `PanelToggleButtons` chip.
 *
 * Multiple chips can be mounted at the same time (on Windows the custom title
 * bar AND the thread header both render them), and binding one listener per
 * chip double-toggled the state to a visible no-op. Hoisting the chord to a
 * single owner also makes it work app-wide, regardless of how many chips —
 * or none — are currently on screen.
 *
 * A ref holds the latest handlers so the listener binds once and never goes
 * stale, even though the toggle callbacks close over fresh state each render.
 */
export function useLayoutChordHotkeys(handlers: {
  onToggleSidebar: () => void;
  onToggleRail: () => void;
}): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const chord = matchLayoutChord(event);
      if (chord === null) {
        return;
      }
      event.preventDefault();
      if (chord === "rail") {
        handlersRef.current.onToggleRail();
      } else {
        handlersRef.current.onToggleSidebar();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, []);
}
