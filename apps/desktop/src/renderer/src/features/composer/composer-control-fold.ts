/**
 * The composer's control row is one line at every width. When the controls do
 * not fit, they fold into the ⋮ menu in a fixed order instead of wrapping:
 *
 * 1. `details`: the controls moving to the thread's Details rail. They are
 *    the environment and command pickers, the editor and terminal apps, the
 *    workspace handoff menu, PR Auto-fix, and the skill profile.
 * 2. `run`: the environment ▶, which runs the selected command.
 * 3. `dictation`.
 * 4. `attach`. It still works by paste and drag-drop while folded.
 *
 * The access control, the model pill, ⋮, the context moon and the Send split
 * never fold. Once every tier has folded, the model name truncates. Nothing
 * else gives up width.
 *
 * A pane can be narrower than even those pinned controls. Then the row
 * `overflows`, and only then it wraps, so Send never leaves the box.
 */
export const COMPOSER_FOLD_TIERS = ["details", "run", "dictation", "attach"] as const;

export type ComposerFoldTier = (typeof COMPOSER_FOLD_TIERS)[number];

export type ComposerRowItem = {
  /** The tier the control folds with. Absent for a control that never folds. */
  tier?: ComposerFoldTier;
  /** The control's natural width, in px. */
  width: number;
  /**
   * Set only on a control that may shrink, the model pill: the narrowest it
   * can draw. It shrinks only after every tier has folded.
   */
  minWidth?: number;
};

export type ComposerRowPlan = {
  /** How many tiers fold, counted from the start of `COMPOSER_FOLD_TIERS`. */
  foldedTierCount: number;
  /** Width taken from shrinkable controls after every tier has folded. */
  shrink: number;
  /**
   * The pinned controls do not fit even at their floors, so the row has to
   * wrap to keep Send in the box.
   */
  overflows: boolean;
};

/** Sub-pixel measurements must not fold a control that fits. */
const FIT_TOLERANCE_PX = 0.5;

export function foldedComposerTiers(
  foldedTierCount: number,
): ReadonlySet<ComposerFoldTier> {
  return new Set(COMPOSER_FOLD_TIERS.slice(0, foldedTierCount));
}

export function isComposerTierFolded(
  tier: ComposerFoldTier,
  foldedTierCount: number,
): boolean {
  return COMPOSER_FOLD_TIERS.indexOf(tier) < foldedTierCount;
}

/** The items still drawn in the row once `foldedTierCount` tiers fold. */
export function visibleComposerRowItems<T extends ComposerRowItem>(
  items: readonly T[],
  foldedTierCount: number,
): T[] {
  return items.filter(
    (item) => item.tier === undefined || !isComposerTierFolded(item.tier, foldedTierCount),
  );
}

/** The width a single-line flex row of `items` takes with `gap` between them. */
export function composerRowWidth(
  items: readonly Pick<ComposerRowItem, "width">[],
  gap: number,
): number {
  if (items.length === 0) return 0;
  return items.reduce((sum, item) => sum + item.width, 0) + gap * (items.length - 1);
}

/**
 * Fold the fewest tiers that let the row fit `available` px on one line. If it
 * still overflows with every tier folded, take the rest from the shrinkable
 * controls, down to their floors.
 */
export function planComposerRowFold(input: {
  available: number;
  gap: number;
  items: readonly ComposerRowItem[];
}): ComposerRowPlan {
  const { available, gap, items } = input;
  let width = 0;
  for (let folded = 0; folded <= COMPOSER_FOLD_TIERS.length; folded += 1) {
    width = composerRowWidth(visibleComposerRowItems(items, folded), gap);
    if (width <= available + FIT_TOLERANCE_PX) {
      return { foldedTierCount: folded, shrink: 0, overflows: false };
    }
  }
  const shrinkable = items.reduce(
    (sum, item) =>
      item.minWidth === undefined ? sum : sum + Math.max(0, item.width - item.minWidth),
    0,
  );
  return {
    foldedTierCount: COMPOSER_FOLD_TIERS.length,
    shrink: Math.min(shrinkable, width - available),
    overflows: width - shrinkable > available + FIT_TOLERANCE_PX,
  };
}

/**
 * How long after a thread opens the row keeps the fold it last settled on
 * there. A thread's environment controls can arrive after it opens; without
 * the hold, the row would draw unfolded and then fold them away a moment
 * later.
 */
export const COMPOSER_FOLD_SETTLE_MS = 2000;

/** A fold a thread's row settled on, and the row width it settled at. */
export type ComposerFoldMemo = {
  foldedTierCount: number;
  /** The row's content width, in px. */
  available: number;
};

/** A remembered fold, kept while the row settles again. */
export type ComposerFoldHold = ComposerFoldMemo & {
  /** When the hold ends, on the `now` clock passed to `heldComposerRowFold`. */
  until: number;
};

/**
 * The fold the row draws: what it measured, but never less than a hold still
 * in force. A hold only ever keeps controls folded. It never folds one the
 * measurement would not, so a late control can still fold more. It applies
 * only at the width it was remembered at: in a wider or narrower pane the
 * remembered fold says nothing.
 */
export function heldComposerRowFold(
  measured: ComposerFoldMemo,
  hold: ComposerFoldHold | undefined,
  now: number,
): number {
  if (!hold || now >= hold.until) return measured.foldedTierCount;
  if (Math.abs(measured.available - hold.available) > FIT_TOLERANCE_PX) return measured.foldedTierCount;
  return Math.max(measured.foldedTierCount, hold.foldedTierCount);
}

/**
 * The fold each thread's row last settled on, by thread. It lives only in
 * this window and forgets the least recently used thread past `limit`.
 */
export function createComposerFoldMemory(limit = 200): {
  recall: (scope: string) => ComposerFoldMemo | undefined;
  remember: (scope: string, memo: ComposerFoldMemo) => void;
} {
  const folds = new Map<string, ComposerFoldMemo>();
  return {
    recall: (scope) => folds.get(scope),
    remember: (scope, memo) => {
      folds.delete(scope);
      folds.set(scope, memo);
      if (folds.size > limit) {
        const oldest = folds.keys().next();
        if (!oldest.done) folds.delete(oldest.value);
      }
    },
  };
}
