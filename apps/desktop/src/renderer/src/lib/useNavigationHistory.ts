import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * One entry in the renderer's browser-style navigation history. Only the
 * two "content" surfaces are recorded: an open thread (by identity key)
 * and the thread-search view. Overlay-ish surfaces — Settings,
 * Automations, launchpads, the empty no-selection state — are deliberately
 * untracked: they behave like modal chrome, not places you navigate back
 * to. The caller signals those by passing `current: undefined`.
 */
export type NavigationHistoryLocation =
  | { view: "search" }
  | { view: "thread"; threadKey: string };

/** Per-stack depth cap, matching what a browser-ish history needs. */
const MAX_HISTORY_DEPTH = 50;

function sameLocation(
  a: NavigationHistoryLocation,
  b: NavigationHistoryLocation,
): boolean {
  if (a.view === "search") {
    return b.view === "search";
  }
  return b.view === "thread" && a.threadKey === b.threadKey;
}

/** Append with consecutive-duplicate dedup + depth cap. */
function appendLocation(
  stack: NavigationHistoryLocation[],
  location: NavigationHistoryLocation,
): NavigationHistoryLocation[] {
  const top = stack[stack.length - 1];
  if (top !== undefined && sameLocation(top, location)) {
    return stack;
  }
  return [...stack, location].slice(-MAX_HISTORY_DEPTH);
}

type HistoryStacks = {
  back: NavigationHistoryLocation[];
  /**
   * The history cursor: the last tracked location the user was on. Stays
   * put while an untracked surface (Settings, a launchpad) is in front,
   * so returning to the same thread afterwards never records a hop.
   */
  cursor: NavigationHistoryLocation | undefined;
  forward: NavigationHistoryLocation[];
};

const EMPTY_STACKS: HistoryStacks = { back: [], cursor: undefined, forward: [] };

/**
 * Browser-style back/forward history over the app shell's navigation
 * state. The hook OBSERVES `current` rather than requiring every
 * navigation call-site to push explicitly — any change of the tracked
 * location (sidebar click, search result, menu deep-link, thread
 * creation) lands in the back stack automatically, and a new navigation
 * clears the forward stack, exactly like a browser.
 *
 * `restore` is invoked from goBack/goForward and must synchronously set
 * the shell state that derives `current`; the hook moves its cursor
 * first, so the resulting `current` change is recognized as its own
 * restore and not re-pushed.
 */
export function useNavigationHistory(args: {
  /** The tracked location now showing, or undefined on untracked surfaces. */
  current: NavigationHistoryLocation | undefined;
  /** Apply a previously recorded location. */
  restore: (location: NavigationHistoryLocation) => void;
}): {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
} {
  const [stacks, setStacks] = useState<HistoryStacks>(EMPTY_STACKS);
  // Mirror for synchronous reads from goBack/goForward — the setState
  // value alone would go stale inside the stable callbacks below.
  const stacksRef = useRef(stacks);
  const currentRef = useRef<NavigationHistoryLocation | undefined>(undefined);
  const restoreRef = useRef(args.restore);
  useEffect(() => {
    restoreRef.current = args.restore;
  });

  const current = args.current;
  useEffect(() => {
    currentRef.current = current;
    if (current === undefined) {
      // Untracked surface in front; the cursor holds its place.
      return;
    }
    const prev = stacksRef.current;
    if (prev.cursor !== undefined && sameLocation(prev.cursor, current)) {
      // Same place (or our own goBack/goForward restore) — nothing to record.
      return;
    }
    const next: HistoryStacks = {
      back:
        prev.cursor !== undefined
          ? appendLocation(prev.back, prev.cursor)
          : prev.back,
      cursor: current,
      forward: [],
    };
    stacksRef.current = next;
    setStacks(next);
  }, [current]);

  const goBack = useCallback((): void => {
    const prev = stacksRef.current;
    if (currentRef.current === undefined) {
      // From an untracked surface, "back" returns to the last tracked
      // location without consuming a history entry — like dismissing the
      // overlay rather than walking the stack.
      if (prev.cursor !== undefined) {
        restoreRef.current(prev.cursor);
      }
      return;
    }
    const target = prev.back[prev.back.length - 1];
    if (target === undefined) {
      return;
    }
    const next: HistoryStacks = {
      back: prev.back.slice(0, -1),
      cursor: target,
      forward:
        prev.cursor !== undefined
          ? [prev.cursor, ...prev.forward].slice(0, MAX_HISTORY_DEPTH)
          : prev.forward,
    };
    stacksRef.current = next;
    setStacks(next);
    restoreRef.current(target);
  }, []);

  const goForward = useCallback((): void => {
    const prev = stacksRef.current;
    const target = prev.forward[0];
    if (target === undefined) {
      return;
    }
    const next: HistoryStacks = {
      back:
        prev.cursor !== undefined
          ? appendLocation(prev.back, prev.cursor)
          : prev.back,
      cursor: target,
      forward: prev.forward.slice(1),
    };
    stacksRef.current = next;
    setStacks(next);
    restoreRef.current(target);
  }, []);

  const canGoBack =
    stacks.back.length > 0 ||
    (current === undefined && stacks.cursor !== undefined);
  const canGoForward = stacks.forward.length > 0;

  return useMemo(
    () => ({ canGoBack, canGoForward, goBack, goForward }),
    [canGoBack, canGoForward, goBack, goForward],
  );
}
