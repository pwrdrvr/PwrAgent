import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  COMPOSER_FOLD_SETTLE_MS,
  COMPOSER_FOLD_TIERS,
  createComposerFoldMemory,
  heldComposerRowFold,
  planComposerRowFold,
  type ComposerFoldHold,
  type ComposerFoldTier,
  type ComposerRowItem,
} from "./composer-control-fold";

/** The fold each thread's row last settled on, for this window. */
const composerFoldMemory = createComposerFoldMemory();

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
 * control it is about to fold. `scope` names the thread or launchpad: a row
 * it has drawn before starts at the fold it settled on there, and keeps at
 * least that much folded while the thread's late controls arrive
 * (`heldComposerRowFold`).
 */
export function useComposerRowFold(scope?: string): {
  rowRef: (element: HTMLElement | null) => void;
  foldedTierCount: number;
  overflows: boolean;
} {
  const [fold, setFold] = useState<ComposerRowFoldState>(() => rememberedFold(scope) ?? NO_FOLD);
  const [foldScope, setFoldScope] = useState(scope);
  const [row, setRow] = useState<HTMLElement | null>(null);
  // A new thread's first commit already draws the fold remembered for it,
  // instead of the last thread's.
  if (foldScope !== scope) {
    setFoldScope(scope);
    const remembered = rememberedFold(scope);
    if (remembered) setFold(remembered);
  }
  const scopeRef = useRef(scope);
  const holdRef = useRef<ComposerFoldHold | undefined>(undefined);
  // How a change is applied depends on where it was seen; see `measure`.
  const measureRef = useRef<((from: "render" | "observer") => void) | undefined>(undefined);

  // A new thread starts from the fold its row last settled on, if it has one.
  useLayoutEffect(() => {
    scopeRef.current = scope;
    const remembered = scope === undefined ? undefined : composerFoldMemory.recall(scope);
    holdRef.current = remembered === undefined
      ? undefined
      : { ...remembered, until: performance.now() + COMPOSER_FOLD_SETTLE_MS };
    measureRef.current?.("render");
    if (!holdRef.current) return undefined;
    const release = window.setTimeout(() => measureRef.current?.("render"), COMPOSER_FOLD_SETTLE_MS);
    return () => window.clearTimeout(release);
  }, [scope]);

  useLayoutEffect(() => {
    if (!row || typeof ResizeObserver === "undefined") return undefined;
    const measure = (from: "render" | "observer") => {
      const measured = measureComposerRowFold(row);
      const now = performance.now();
      const hold = holdRef.current;
      const settling = hold !== undefined && now < hold.until;
      if (!settling && scopeRef.current !== undefined && measured.available > 0) {
        composerFoldMemory.remember(scopeRef.current, {
          foldedTierCount: measured.foldedTierCount,
          available: measured.available,
        });
      }
      const next: ComposerRowFoldState = {
        foldedTierCount: heldComposerRowFold(measured, hold, now),
        overflows: measured.overflows,
      };
      const update = () => setFold((current) =>
        current.foldedTierCount === next.foldedTierCount && current.overflows === next.overflows
          ? current
          : next);
      // An observer sees a change React has already committed and the
      // browser is about to paint, so its fold must commit now, not in a
      // later task, or that paint shows the unfolded row for a frame. A
      // layout effect or a timer is not in that position.
      if (from === "observer") flushSync(update);
      else update();
    };
    measureRef.current = measure;
    const onChange = () => measure("observer");
    const resizeObserver = new ResizeObserver(onChange);
    const observeItems = () => {
      resizeObserver.disconnect();
      resizeObserver.observe(row);
      for (const item of composerRowFlexItems(row)) resizeObserver.observe(item);
    };
    // Controls come and go with the thread (an environment, a PR, a running
    // dictation), so the set of items to watch is re-read on each change.
    const mutationObserver = new MutationObserver(() => {
      observeItems();
      onChange();
    });
    mutationObserver.observe(row, { childList: true, subtree: true, characterData: true });
    observeItems();
    measure("render");
    return () => {
      measureRef.current = undefined;
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [row]);

  const rowRef = useCallback((element: HTMLElement | null) => setRow(element), []);
  return { rowRef, foldedTierCount: fold.foldedTierCount, overflows: fold.overflows };
}

type ComposerRowFoldState = { foldedTierCount: number; overflows: boolean };

function rememberedFold(scope: string | undefined): ComposerRowFoldState | undefined {
  const memo = scope === undefined ? undefined : composerFoldMemory.recall(scope);
  return memo === undefined ? undefined : { foldedTierCount: memo.foldedTierCount, overflows: false };
}

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

export function measureComposerRowFold(row: HTMLElement): ComposerRowFoldState & { available: number } {
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
    // (`--composer-row-floor`). Setting a style attribute is not a change the
    // observer above watches, so this does not schedule another measure.
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
  if (available <= 0) return { ...NO_FOLD, available: 0 };
  const plan = planComposerRowFold({ available, gap, items });
  return { foldedTierCount: plan.foldedTierCount, overflows: plan.overflows, available };
}
