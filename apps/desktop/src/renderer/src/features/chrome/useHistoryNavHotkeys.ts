import { useEffect, useRef } from "react";
import { matchHistoryNavChord } from "../../lib/keyboard-accel";

/**
 * Binds the single window-level listener pair for history navigation:
 * the keyboard chords (⌘[/⌘], Alt+←/→ — see `matchHistoryNavChord`) and
 * the back/forward thumb buttons on a mouse (Chromium reports them as
 * `button` 3 and 4). Call this exactly ONCE, from the always-mounted
 * shell owner — never per HistoryNavButtons instance — mirroring
 * `useLayoutChordHotkeys`, so the affordance works app-wide regardless
 * of which header (thread, placeholder, search) is on screen.
 *
 * A ref holds the latest handlers so the listeners bind once and never
 * go stale, even though the callbacks close over fresh state each render.
 */
export function useHistoryNavHotkeys(handlers: {
  onBack: () => void;
  onForward: () => void;
}): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const chord = matchHistoryNavChord(event);
      if (chord === null) {
        return;
      }
      event.preventDefault();
      if (chord === "back") {
        handlersRef.current.onBack();
      } else {
        handlersRef.current.onForward();
      }
    };
    const onMouseUp = (event: MouseEvent): void => {
      if (event.button !== 3 && event.button !== 4) {
        return;
      }
      // The renderer has no webContents history, so without this the
      // thumb buttons would be dead clicks; claim them for thread history.
      event.preventDefault();
      if (event.button === 3) {
        handlersRef.current.onBack();
      } else {
        handlersRef.current.onForward();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);
}
