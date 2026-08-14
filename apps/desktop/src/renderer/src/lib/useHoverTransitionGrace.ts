import { useCallback, useEffect, useRef } from "react";

/**
 * Time allowed for a pointer to cross a native title-bar/content boundary.
 *
 * Electron on Windows can deliver leave from a title-bar trigger before it
 * delivers entry to an absolutely positioned descendant below the title bar.
 * A short grace period keeps the descendant mounted long enough for its entry
 * event to cancel dismissal. Ordinary exits still close promptly, while
 * explicit actions use `dismissImmediately` and remain synchronous.
 */
export const HOVER_TRANSITION_GRACE_MS = 300;

export function useHoverTransitionGrace(onDismiss: () => void): {
  cancelHoverDismiss: () => void;
  dismissAfterGrace: () => void;
  dismissImmediately: () => void;
} {
  const dismissRef = useRef(onDismiss);
  const timerRef = useRef<number | null>(null);
  dismissRef.current = onDismiss;

  const cancelHoverDismiss = useCallback((): void => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const dismissImmediately = useCallback((): void => {
    cancelHoverDismiss();
    dismissRef.current();
  }, [cancelHoverDismiss]);

  const dismissAfterGrace = useCallback((): void => {
    cancelHoverDismiss();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      dismissRef.current();
    }, HOVER_TRANSITION_GRACE_MS);
  }, [cancelHoverDismiss]);

  useEffect(
    () => cancelHoverDismiss,
    [cancelHoverDismiss],
  );

  return {
    cancelHoverDismiss,
    dismissAfterGrace,
    dismissImmediately,
  };
}
