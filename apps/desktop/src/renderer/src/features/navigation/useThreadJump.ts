import { useCallback, useRef, useState } from "react";

/**
 * Owns the thread-jump palette — the modal opened by ⌘K from anywhere, or by
 * ⌘F while the sidebar holds focus.
 *
 * The palette itself portals onto `document.body`, so opening it no longer
 * requires a sidebar at all. What still does is the *landing*: picking a thread
 * scrolls its row into view, and `scrollIntoView` is a no-op inside the
 * `display: none` subtree that ⌘B leaves behind. So a hidden sidebar is
 * revealed at PICK time, not at open time — a PEEK, never a preference change.
 * It writes nothing to config.toml, and it goes back the moment the row reports
 * that it mounted and scrolled. Someone who deliberately hides their sidebar
 * shouldn't have it silently — and permanently — reopened just because they
 * reached for a thread, nor watch it flash open behind a palette they were only
 * passing through.
 */
export function useThreadJump(options: {
  sidebarHidden: boolean;
  /** Show/hide the sidebar for the peek WITHOUT persisting the preference. */
  setSidebarHidden: (hidden: boolean) => void;
}): {
  open: boolean;
  openJump: () => void;
  closeJump: () => void;
  /**
   * Reveal a hidden sidebar so a jump's scroll-into-view has layout to land in,
   * and hold it revealed until {@link completePeekRestore}. Returns whether a
   * peek actually started — callers use it to pick an INSTANT scroll, since a
   * smooth one animates over several frames and re-hiding the sidebar
   * mid-animation abandons it wherever it got to.
   */
  beginRevealPeek: () => boolean;
  /** Restore the peek after the selected row has mounted and scrolled. */
  completePeekRestore: () => void;
  /** ⌘K again backs out of a jump you didn't mean to start. */
  toggleJump: () => void;
  /**
   * Call from whatever persists the sidebar preference (⌘B, the toggle chips).
   * An explicit preference outranks a peek: ending it here means a pending
   * reveal can't revert what the operator just chose.
   */
  endPeek: () => void;
} {
  const { sidebarHidden, setSidebarHidden } = options;
  const [open, setOpen] = useState(false);
  const peekedRef = useRef(false);

  const openJump = useCallback(() => {
    setOpen(true);
  }, []);

  const closeJump = useCallback(() => {
    setOpen(false);
  }, []);

  const beginRevealPeek = useCallback(() => {
    if (!sidebarHidden) {
      return false;
    }
    peekedRef.current = true;
    setSidebarHidden(false);
    return true;
  }, [sidebarHidden, setSidebarHidden]);

  const completePeekRestore = useCallback(() => {
    if (!peekedRef.current) {
      return;
    }
    peekedRef.current = false;
    setSidebarHidden(true);
  }, [setSidebarHidden]);

  const toggleJump = useCallback(() => {
    setOpen((current) => !current);
  }, []);

  const endPeek = useCallback(() => {
    peekedRef.current = false;
  }, []);

  return {
    open,
    openJump,
    closeJump,
    beginRevealPeek,
    completePeekRestore,
    toggleJump,
    endPeek,
  };
}
