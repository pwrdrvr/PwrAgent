import { useCallback, useRef, useState } from "react";

/**
 * Owns the thread-list quick search — the popup opened by ⌘K from anywhere, or
 * by ⌘F while the sidebar holds focus.
 *
 * The popup renders inside the sidebar, and a hidden sidebar (⌘B) is
 * `display: none`, so opening the search over a hidden sidebar has to reveal it
 * first. That reveal is a PEEK, not a preference change: it never writes
 * config.toml, and closing the search puts the sidebar back. Someone who
 * deliberately hides their sidebar shouldn't have it silently — and permanently
 * — reopened just because they reached for a thread.
 */
export function useThreadJump(options: {
  sidebarHidden: boolean;
  /** Show/hide the sidebar for the peek WITHOUT persisting the preference. */
  setSidebarHidden: (hidden: boolean) => void;
}): {
  open: boolean;
  openJump: () => void;
  closeJump: () => void;
  /** ⌘K again backs out of a jump you didn't mean to start. */
  toggleJump: () => void;
  /**
   * Call from whatever persists the sidebar preference (⌘B, the toggle chips).
   * An explicit preference outranks a peek: ending it here means the closing
   * search can't revert what the operator just chose. Nothing in today's UI can
   * actually toggle the sidebar while the popup is up — a click dismisses the
   * popup first, and ⌘B is inert while the caret sits in its field — so this is
   * a rail, not a live path.
   */
  endPeek: () => void;
} {
  const { sidebarHidden, setSidebarHidden } = options;
  const [open, setOpen] = useState(false);
  const peekedRef = useRef(false);

  const openJump = useCallback(() => {
    if (sidebarHidden) {
      peekedRef.current = true;
      setSidebarHidden(false);
    }
    setOpen(true);
  }, [sidebarHidden, setSidebarHidden]);

  const closeJump = useCallback(() => {
    setOpen(false);
    if (peekedRef.current) {
      peekedRef.current = false;
      setSidebarHidden(true);
    }
  }, [setSidebarHidden]);

  const toggleJump = useCallback(() => {
    if (open) {
      closeJump();
      return;
    }
    openJump();
  }, [open, closeJump, openJump]);

  const endPeek = useCallback(() => {
    peekedRef.current = false;
  }, []);

  return { open, openJump, closeJump, toggleJump, endPeek };
}
