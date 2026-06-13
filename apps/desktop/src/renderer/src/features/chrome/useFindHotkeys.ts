import { useEffect, useRef } from "react";
import { matchFindChord } from "../../lib/keyboard-accel";

/**
 * Single window-level owner for the find/search chords, mirroring
 * {@link useLayoutChordHotkeys}:
 *   ⌘F / ⌃F   → onFind        (context find; optional)
 *   ⌘⇧F / ⌃⇧F → onOpenSearch  (open the global thread search screen)
 *
 * Call this exactly ONCE from the always-mounted shell owner. A ref keeps the
 * handlers fresh so the listener binds once and never goes stale even though
 * the callbacks close over fresh state each render.
 *
 * `onFind` is optional: when omitted, ⌘F is left untouched (no preventDefault)
 * so the key isn't swallowed on surfaces that don't handle in-context find.
 */
export function useFindHotkeys(handlers: {
  onOpenSearch: () => void;
  onFind?: () => void;
}): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const chord = matchFindChord(event);
      if (chord === null) {
        return;
      }
      if (chord === "search") {
        event.preventDefault();
        handlersRef.current.onOpenSearch();
        return;
      }
      const onFind = handlersRef.current.onFind;
      if (!onFind) {
        return;
      }
      event.preventDefault();
      onFind();
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, []);
}
