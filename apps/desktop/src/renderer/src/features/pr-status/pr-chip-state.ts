import type { PrSummary } from "@pwragent/shared";

/**
 * Shared reading of a `PrSummary`'s display state.
 *
 * Lifted out of `PrChip.tsx` so the chip and its hover card resolve lifecycle,
 * check state, and the status sentence through the same functions. If those two
 * surfaces ever disagree about a PR, it should be because someone changed one of
 * these — not because a second copy drifted.
 */

export type PrChipDotState =
  | NonNullable<PrSummary["checkState"]>
  | "merged"
  | "closed";

export function resolveChipState(pr: PrSummary): PrChipDotState {
  const lifecycleState = resolveLifecycleState(pr);
  if (lifecycleState === "merged" || lifecycleState === "closed") {
    return lifecycleState;
  }
  return resolveCheckState(pr);
}

export function resolveLifecycleState(
  pr: PrSummary,
): NonNullable<PrSummary["lifecycleState"]> {
  if (pr.lifecycleState) {
    return pr.lifecycleState;
  }
  if (pr.state === "merged" || pr.state === "closed") {
    return pr.state;
  }
  return "open";
}

export function resolveCheckState(
  pr: PrSummary,
): NonNullable<PrSummary["checkState"]> {
  return pr.checkState ?? normalizeLegacyCheckState(pr.state);
}

function normalizeLegacyCheckState(
  state: PrSummary["state"],
): NonNullable<PrSummary["checkState"]> {
  if (
    state === "passing"
    || state === "failing"
    || state === "pending"
    || state === "unknown"
  ) {
    return state;
  }
  return "unknown";
}

/**
 * Everything the chip's classes say about a PR, resolved once.
 *
 * The composer renders its PR chips through Tiptap's DOM specs, which cannot
 * mount `PrChip` and never see a `PrSummary` again after the chip is minted.
 * Deriving both surfaces from this one function is what keeps a composer chip
 * the same color as the sidebar chip for the same PR.
 */
export type PrChipPresentation = {
  chipState: PrChipDotState;
  hasFailingChecksStillRunning: boolean;
  isConflicting: boolean;
  isDraft: boolean;
};

export function resolvePrChipPresentation(
  pr: PrSummary,
  options?: {
    /**
     * The chip sits next to explicit status pills (the Pull Requests card), so
     * draft + merge conflict belong to those pills and are dropped here.
     */
    withStatusPills?: boolean;
  },
): PrChipPresentation {
  // Draft and merge-conflict ride ALONGSIDE the check-state dot color rather
  // than replacing it: an OPEN draft keeps its real status color and gains a
  // separate affordance bar, and a conflict recolors the dot red (see the
  // `.pr-chip--draft` / `.pr-chip--conflicting` rules in app.css). Both only
  // apply while the PR is open — a merged/closed chip owns its own dot color.
  const isOpen = resolveLifecycleState(pr) === "open";
  const surfaceAffordances = isOpen && !options?.withStatusPills;
  return {
    chipState: resolveChipState(pr),
    hasFailingChecksStillRunning:
      isOpen
      && resolveCheckState(pr) === "failing"
      && pr.checksStillRunning === true,
    isConflicting: surfaceAffordances && pr.mergeState === "conflicting",
    isDraft: surfaceAffordances && pr.reviewState === "draft",
  };
}

/**
 * The `pr-chip--*` modifiers for a presentation, WITHOUT the base `pr-chip`
 * class. Kept separate so the composer can store the modifiers on its mention
 * node and still compose them with its own chip classes.
 */
export function prChipModifierClasses(
  presentation: PrChipPresentation,
): string[] {
  return [
    `pr-chip--${presentation.chipState}`,
    presentation.hasFailingChecksStillRunning ? "pr-chip--checks-running" : "",
    presentation.isDraft ? "pr-chip--draft" : "",
    presentation.isConflicting ? "pr-chip--conflicting" : "",
  ].filter(Boolean);
}

/** The modifiers a `pr-chip` element already carries, in stored order. */
export function readPrChipModifierClasses(className: string): string[] {
  return className
    .split(/\s+/)
    .filter((entry) => entry.startsWith("pr-chip--"));
}

/** Whether the PR carries no status signal at all — a fresh attachment. */
export function isPrStatusUnknown(pr: PrSummary): boolean {
  return (
    pr.state === "unknown"
    && !pr.checkState
    && !pr.lifecycleState
    && !pr.reviewState
    && !pr.mergeState
  );
}

/**
 * The full status sentence: review state, merge conflict, and check state,
 * separated by middots. Used verbatim as the chip's accessible name and as the
 * hover card's status line.
 */
export function prStatusLabel(pr: PrSummary): string {
  if (isPrStatusUnknown(pr)) {
    return "status unknown";
  }

  const lifecycleState = resolveLifecycleState(pr);
  const parts: string[] = [];
  if (lifecycleState === "merged") {
    return "merged";
  } else if (lifecycleState === "closed") {
    return "closed without merge";
  } else if (pr.reviewState === "draft") {
    parts.push("draft");
  } else {
    parts.push("ready for review");
  }

  if (pr.mergeState === "conflicting") {
    parts.push("merge conflict");
  }

  parts.push(checkStateTooltipLabel(resolveCheckState(pr), pr.checksStillRunning));
  return parts.join(" · ");
}

/**
 * The one-word lifecycle the dot color cannot say out loud. Draft outranks
 * "open" because it is the more specific fact about an open PR.
 */
export function prPhaseLabel(pr: PrSummary): string | undefined {
  if (isPrStatusUnknown(pr)) {
    return undefined;
  }
  const lifecycleState = resolveLifecycleState(pr);
  if (lifecycleState !== "open") {
    return lifecycleState;
  }
  return pr.reviewState === "draft" ? "draft" : "open";
}

export function checkStateTooltipLabel(
  state: NonNullable<PrSummary["checkState"]>,
  checksStillRunning: boolean | undefined,
): string {
  switch (state) {
    case "passing":
      return "checks passing";
    case "failing":
      return checksStillRunning
        ? "checks failing · checks still running"
        : "checks failing";
    case "pending":
      return "checks pending";
    case "unknown":
      return "status unknown";
  }
}
