import { useCallback, useEffect, useRef, useState } from "react";
import {
  COMPOSER_FOLD_TIERS,
  planComposerRowFold,
  type ComposerFoldTier,
  type ComposerRowItem,
} from "./composer-control-fold";

/**
 * Measures the composer's control row and decides how many tiers fold into ⋮
 * (`planComposerRowFold`).
 *
 * A folded control stays mounted in its `[data-composer-fold]` slot, taken
 * out of the flow and hidden (`.composer__fold-slot.is-folded`). So the row
 * can always read every control's natural width, folded or not, and an
 * unfold never guesses.
 */
export function useComposerRowFold(): {
  rowRef: (element: HTMLElement | null) => void;
  foldedTierCount: number;
} {
  const [foldedTierCount, setFoldedTierCount] = useState(0);
  const [row, setRow] = useState<HTMLElement | null>(null);
  const frameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!row || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      frameRef.current = undefined;
      setFoldedTierCount(measureComposerRowFold(row));
    };
    const schedule = () => {
      if (frameRef.current !== undefined) return;
      frameRef.current = window.requestAnimationFrame(measure);
    };
    const resizeObserver = new ResizeObserver(schedule);
    const observeItems = () => {
      resizeObserver.disconnect();
      resizeObserver.observe(row);
      for (const item of composerRowFlexItems(row)) resizeObserver.observe(item);
    };
    // Controls come and go with the thread (an environment, a PR, a running
    // dictation), so the set of items to watch is re-read on each change.
    const mutationObserver = new MutationObserver(() => {
      observeItems();
      schedule();
    });
    mutationObserver.observe(row, { childList: true, subtree: true, characterData: true });
    observeItems();
    measure();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
    };
  }, [row]);

  const rowRef = useCallback((element: HTMLElement | null) => setRow(element), []);
  return { rowRef, foldedTierCount: row ? foldedTierCount : 0 };
}

const FOLD_TIERS: ReadonlySet<string> = new Set(COMPOSER_FOLD_TIERS);

/** The labels that ellipsize once every tier has folded: the model name and the Where pill. */
const TRUNCATING_LABELS = ".model-settings__pill-model, .composer-where__label";

/**
 * The boxes that sit in the row's flex line, in order. `display: contents`
 * groups (the pending-send fieldsets) are walked through, and so is a
 * `[data-composer-row-group]`, a flex group that uses the row's own gap and
 * so adds nothing but its children. A folded slot is kept: it is out of the
 * flow but still sized to its control.
 */
function composerRowFlexItems(row: HTMLElement): HTMLElement[] {
  const items: HTMLElement[] = [];
  const walk = (parent: Element) => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement)) continue;
      const style = getComputedStyle(child);
      if (style.display === "contents") {
        walk(child);
        continue;
      }
      if (child.dataset.composerRowGroup !== undefined) {
        const before = items.length;
        walk(child);
        // Every control in it has folded, but the empty group still sits in
        // the line and takes a gap, so it counts as a control with no width.
        if (items.slice(before).every((item) => item.classList.contains("is-folded"))) {
          items.push(child);
        }
        continue;
      }
      if (style.display === "none") continue;
      const fold = child.dataset.composerFold;
      if (fold === undefined && (style.position === "absolute" || style.position === "fixed")) continue;
      items.push(child);
    }
  };
  walk(row);
  return items;
}

export function measureComposerRowFold(row: HTMLElement): number {
  const style = getComputedStyle(row);
  const available = row.clientWidth
    - (Number.parseFloat(style.paddingLeft) || 0)
    - (Number.parseFloat(style.paddingRight) || 0);
  const gap = Number.parseFloat(style.columnGap) || 0;
  const items: ComposerRowItem[] = composerRowFlexItems(row).map((element) => {
    const fold = element.dataset.composerFold;
    const tier = fold !== undefined && FOLD_TIERS.has(fold) ? (fold as ComposerFoldTier) : undefined;
    const width = element.dataset.composerRowGroup !== undefined ? 0 : element.getBoundingClientRect().width;
    // A truncated name reports its shrunk box; add back what it hides so the
    // row unfolds as soon as the full name would fit again.
    const truncatable = element.querySelector<HTMLElement>(TRUNCATING_LABELS);
    const hidden = truncatable ? Math.max(0, truncatable.scrollWidth - truncatable.clientWidth) : 0;
    return { ...(tier ? { tier } : {}), width: width + hidden };
  });
  if (available <= 0) return 0;
  return planComposerRowFold({ available, gap, items }).foldedTierCount;
}
