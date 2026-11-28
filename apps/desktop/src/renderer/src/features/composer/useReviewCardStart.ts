import { useCallback, useEffect, useRef, useState } from "react";
import { useEventCallback } from "../../lib/useEventCallback";

/** The review panel a to-do card opened, as that card sees it. */
export type ComposerReviewSetup = {
  todoId: string;
  /** The panel's Start review, by its label, while the card may offer it. */
  start?: { label: string; run: () => void };
};

/**
 * Reports the review panel a to-do card opened back to that card. The card
 * offers the panel's Start review in the spot of its own while the panel's
 * button is enabled, starts now rather than at a scheduled time, and is all
 * on screen, inside the composer's scroll area and the window, so a card
 * never starts a review the operator cannot see.
 *
 * Returns the ref for the panel's Start review button.
 */
export function useReviewCardStart(options: {
  todoId: string | undefined;
  label: string;
  /** The panel's Start review is disabled or would schedule the review. */
  unavailable: boolean;
  start: () => void;
  onReviewSetupChange: ((setup: ComposerReviewSetup | undefined) => void) | undefined;
}): (button: HTMLButtonElement | null) => void {
  const [inView, setInView] = useState(false);
  const observerRef = useRef<IntersectionObserver | undefined>(undefined);
  const buttonRef = useCallback((button: HTMLButtonElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = undefined;
    if (!button) {
      setInView(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setInView(entry.intersectionRatio >= 0.99);
    }, { threshold: [0, 0.99] });
    observer.observe(button);
    observerRef.current = observer;
  }, []);
  const { todoId, onReviewSetupChange } = options;
  const startLabel = todoId && inView && !options.unavailable ? options.label : undefined;
  const run = useEventCallback(options.start);
  useEffect(() => {
    onReviewSetupChange?.(todoId
      ? { todoId, ...(startLabel ? { start: { label: startLabel, run } } : {}) }
      : undefined);
  }, [onReviewSetupChange, todoId, startLabel, run]);
  useEffect(() => () => onReviewSetupChange?.(undefined), [onReviewSetupChange]);
  return buttonRef;
}
