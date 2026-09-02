/**
 * Per-machine view state for the Explorer's Savings lens.
 *
 * Which reference sections are unfolded, and how tall the operator dragged the
 * detail stack, are viewing preferences rather than thread facts. Two windows
 * on the same thread may legitimately want different splits, and a peer
 * instance has no business learning how this machine's operator reads the
 * screen. localStorage, never SQLite, never federated — the rule drafts follow.
 */
export type SavingsSectionKey = "decisions" | "boundaries" | "code-mode";

export type SavingsLayoutPreferences = {
  /**
   * Operator-chosen height of the detail stack, in CSS pixels. Absent until
   * the grip is dragged, so an untouched lens keeps sizing itself to content.
   */
  detailsHeight?: number;
  openSections: SavingsSectionKey[];
};

/**
 * Everything folded.
 *
 * The lens answers one question — what did gating buy, and where. The
 * reference sections matter on the day you are checking a compaction or
 * debugging a dispatch cluster, and charging every visit for them is what
 * squeezed the results list down to a single row.
 */
export const DEFAULT_SAVINGS_LAYOUT: SavingsLayoutPreferences = {
  openSections: [],
};

/** Three result rows. Below this the list reads as broken, not as short. */
export const SAVINGS_RESULTS_MIN_HEIGHT = 160;

/** One folded row. The detail stack never drags away to nothing. */
export const SAVINGS_DETAILS_MIN_HEIGHT = 34;

const SECTION_KEYS: readonly SavingsSectionKey[] = [
  "decisions",
  "boundaries",
  "code-mode",
];

const STORAGE_KEY = "pwragent.toolOutput.savingsLayout";

export function readStoredSavingsLayout(): SavingsLayoutPreferences {
  if (typeof window === "undefined") return DEFAULT_SAVINGS_LAYOUT;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SAVINGS_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<SavingsLayoutPreferences>;
    const height = parsed.detailsHeight;
    return {
      detailsHeight:
        typeof height === "number" && Number.isFinite(height)
          ? Math.max(SAVINGS_DETAILS_MIN_HEIGHT, Math.round(height))
          : undefined,
      // An unknown key is dropped rather than carried: a renamed section would
      // otherwise keep unfolding a row that no longer exists.
      openSections: Array.isArray(parsed.openSections)
        ? SECTION_KEYS.filter((key) => parsed.openSections?.includes(key))
        : [],
    };
  } catch {
    return DEFAULT_SAVINGS_LAYOUT;
  }
}

export function writeStoredSavingsLayout(value: SavingsLayoutPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // A full or blocked store costs the operator their split, nothing more.
  }
}

/**
 * Keep the results list above its floor.
 *
 * The grip sets the detail stack's preferred height; the stack still shrinks
 * below it when the window is short, because the list's floor wins. Clamping
 * on drag stops the stored value from drifting far past anything the current
 * window could honour.
 */
export function clampDetailsHeight(
  height: number,
  availableHeight: number,
): number {
  const ceiling = Math.max(
    SAVINGS_DETAILS_MIN_HEIGHT,
    availableHeight - SAVINGS_RESULTS_MIN_HEIGHT,
  );
  return Math.round(
    Math.min(Math.max(height, SAVINGS_DETAILS_MIN_HEIGHT), ceiling),
  );
}
