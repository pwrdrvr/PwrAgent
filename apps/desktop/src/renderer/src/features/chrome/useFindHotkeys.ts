import { useEffect, useRef } from "react";
import { matchFindChord, matchThreadJumpChord } from "../../lib/keyboard-accel";

/**
 * Single window-level owner for the find/search chords, mirroring
 * {@link useLayoutChordHotkeys}:
 *   ⌘F / ⌃F   → onFind        (context find; optional)
 *   ⌘⇧F / ⌃⇧F → onOpenSearch  (open the global thread search screen)
 *   ⌘K / ⌃K   → onThreadJump  (thread-list quick search, from anywhere; optional)
 *
 * Call this exactly ONCE from the always-mounted shell owner. A ref keeps the
 * handlers fresh so the listener binds once and never goes stale even though
 * the callbacks close over fresh state each render.
 *
 * `onFind` and `onThreadJump` are optional: when omitted, their chord is left
 * untouched (no preventDefault) so the key isn't swallowed on surfaces that
 * don't handle it.
 */
export function useFindHotkeys(handlers: {
  onOpenSearch: () => void;
  onFind?: () => void;
  onThreadJump?: () => void;
}): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (matchThreadJumpChord(event)) {
        const onThreadJump = handlersRef.current.onThreadJump;
        if (!onThreadJump) {
          return;
        }
        event.preventDefault();
        onThreadJump();
        return;
      }
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
