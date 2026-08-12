import { useCallback, useRef, useState } from "react";

/**
 * Owns the thread-jump palette — the modal opened by ⌘K from anywhere, or by
 * ⌘F while the sidebar holds focus.
 *
 * The palette portals onto `document.body`, so opening it no longer requires a
 * sidebar. Picking a thread still scrolls its sidebar row into view, and
 * `scrollIntoView` is a no-op inside the `display: none` subtree that ⌘B leaves
 * behind. A hidden sidebar is therefore revealed at PICK time, not open time:
 * a temporary peek that writes nothing to config.toml and ends as soon as the
 * selected row's landing scroll completes.
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
   * Reveal a hidden sidebar so a jump's scroll-into-view has layout to land in.
   * Returns whether a peek started, which selects an instant landing scroll.
   */
  beginRevealPeek: () => boolean;
  /** Restore a peek after the selected row's landing scroll completes. */
  completePeekRestore: () => void;
  /** ⌘K again backs out of a jump you did not mean to start. */
  toggleJump: () => void;
  /** End any pending peek when the operator explicitly changes the preference. */
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
