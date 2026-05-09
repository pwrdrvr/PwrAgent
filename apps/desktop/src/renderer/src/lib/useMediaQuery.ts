import { useEffect, useState } from "react";

/**
 * React hook wrapping `window.matchMedia` with a tracked match
 * result. Returns the current `matches` value of the supplied
 * media query string and re-renders the consumer whenever the
 * match flips.
 *
 * Used by ThreadView to drive the wide-display auto-pin of the
 * context rail (issue #240). Lives in `lib/` so future surfaces
 * (responsive pickers, layout switches, etc.) don't need to
 * re-derive the matchMedia plumbing — the SSR guard, the listener
 * registration, the lazy initial-state read, and the cleanup are
 * all self-contained here.
 *
 * Implementation notes:
 *   - The lazy initial state reads `matchMedia(...).matches`
 *     synchronously so the FIRST render already has the right
 *     value; the post-mount effect just registers the listener
 *     for future flips.
 *   - The effect re-reads `matches` once after registering its
 *     listener too, in case the media query state flipped between
 *     the initial-state read and the effect firing (very narrow
 *     race, but cheap to guard against).
 *   - Both branches gate on `typeof window === "undefined" ||
 *     !window.matchMedia` so server-side renders / non-browser
 *     environments don't crash. Electron's renderer always has
 *     `window`, but the guard keeps the hook portable.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return false;
    }
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const mql = window.matchMedia(query);
    const handler = (event: MediaQueryListEvent): void => {
      setMatches(event.matches);
    };
    setMatches(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}
