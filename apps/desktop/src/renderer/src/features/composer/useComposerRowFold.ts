import { useCallback, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
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
 *
 * Every fold lands before the browser paints, so the row never draws a
 * control it is about to fold.
 */
export function useComposerRowFold(): {
  rowRef: (element: HTMLElement | null) => void;
  foldedTierCount: number;
  overflows: boolean;
} {
  const [fold, setFold] = useState<ComposerRowFoldState>(NO_FOLD);
  const [row, setRow] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!row || typeof ResizeObserver === "undefined") return undefined;
    let frame: number | undefined;
    const measure = (from: "render" | "mutation" | "resize") => {
      const next = measureComposerRowFold(row);
      const update = () => setFold((current) =>
        current.foldedTierCount === next.foldedTierCount && current.overflows === next.overflows
          ? current
          : next);
      // A mutation is a control React has just committed, which the browser
      // is about to paint, so its fold must commit now, not in a later task,
      // or that paint shows the unfolded row for a frame. A measure from this
      // layout effect already runs before paint, and a resize waits a frame
      // (below), so both apply normally.
      if (from === "mutation") flushSync(update);
      else update();
    };
    // A resize is measured on the next frame. Folding inside the observer's
    // own callback would resize the row's other items in the same pass,
    // which the browser reports as an undelivered-notification loop error.
    const resizeObserver = new ResizeObserver(() => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        measure("resize");
      });
    });
    const observeItems = () => {
      resizeObserver.disconnect();
      resizeObserver.observe(row);
      for (const item of composerRowFlexItems(row)) resizeObserver.observe(item);
    };
    // Controls come and go with the thread (an environment, a PR, a running
    // dictation), so the set of items to watch is re-read on each change.
    const mutationObserver = new MutationObserver(() => {
      observeItems();
      measure("mutation");
    });
    mutationObserver.observe(row, { childList: true, subtree: true, characterData: true });
    observeItems();
    measure("render");
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [row]);

  const rowRef = useCallback((element: HTMLElement | null) => setRow(element), []);
  const current = row ? fold : NO_FOLD;
  return { rowRef, foldedTierCount: current.foldedTierCount, overflows: current.overflows };
}

type ComposerRowFoldState = { foldedTierCount: number; overflows: boolean };

const NO_FOLD: ComposerRowFoldState = { foldedTierCount: 0, overflows: false };

const FOLD_TIERS: ReadonlySet<string> = new Set(COMPOSER_FOLD_TIERS);

/**
 * The labels that ellipsize once every tier has folded: the model name, the
 * new-thread provider, and the Where label.
 */
const TRUNCATING_LABELS = ".model-settings__pill-model, .model-settings__pill-provider, .composer-where__label";

/** The pills around those labels, which clip whatever does not fit. */
const CLIPPING_PILLS = ".model-settings__pill, .composer-where__pill";

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

export function measureComposerRowFold(row: HTMLElement): ComposerRowFoldState {
  const style = getComputedStyle(row);
  const available = row.clientWidth
    - (Number.parseFloat(style.paddingLeft) || 0)
    - (Number.parseFloat(style.paddingRight) || 0);
  const gap = Number.parseFloat(style.columnGap) || 0;
  const items: ComposerRowItem[] = composerRowFlexItems(row).map((element) => {
    const fold = element.dataset.composerFold;
    const tier = fold !== undefined && FOLD_TIERS.has(fold) ? (fold as ComposerFoldTier) : undefined;
    const width = element.dataset.composerRowGroup !== undefined ? 0 : element.getBoundingClientRect().width;
    // A truncated name reports its shrunk box, and a pill squeezed past its
    // floor clips the rest; add back what both hide so the row unfolds as
    // soon as the whole control would fit again.
    const labels = [...element.querySelectorAll<HTMLElement>(TRUNCATING_LABELS)];
    const hidden = labels.reduce(
      (sum, label) => sum + Math.max(0, label.scrollWidth - label.clientWidth),
      0,
    );
    const pill = element.querySelector<HTMLElement>(CLIPPING_PILLS);
    const clipped = pill ? Math.max(0, pill.scrollWidth - pill.clientWidth) : 0;
    const natural = width + hidden + clipped;
    // A control the stylesheet lets shrink (the model and Where pills) gives
    // up its truncating labels once every tier has folded, and no more: the
    // rest of the pill (effort, icons, chevron) is its floor.
    const shrinks = (Number.parseFloat(getComputedStyle(element).flexShrink) || 0) > 0;
    const minWidth = shrinks && labels.length > 0
      ? Math.max(0, natural - labels.reduce((sum, label) => sum + label.scrollWidth, 0))
      : undefined;
    // The stylesheet cannot know that floor, so it reads it from here
    // (`--composer-row-floor`). The mutation observer ignores style
    // attributes; if the new floor resizes the pill, the resize observer
    // measures once more on the next frame and finds the same plan.
    if (minWidth !== undefined) {
      const floor = `${Math.ceil(minWidth)}px`;
      if (element.style.getPropertyValue("--composer-row-floor") !== floor) {
        element.style.setProperty("--composer-row-floor", floor);
      }
    }
    return {
      ...(tier ? { tier } : {}),
      width: natural,
      ...(minWidth !== undefined ? { minWidth } : {}),
    };
  });
  if (available <= 0) return NO_FOLD;
  const plan = planComposerRowFold({ available, gap, items });
  return { foldedTierCount: plan.foldedTierCount, overflows: plan.overflows };
}
