/**
 * How tall the operator dragged Usage Activity's thread list. A viewing
 * preference for this machine's window, so localStorage, never SQLite, never
 * federated — the rule the Savings lens split follows.
 */
const STORAGE_KEY = "pwragent.usageActivity.layout";

/** About four rows under the toolbar. Below this the list reads as broken. */
export const USAGE_RESULTS_MIN_HEIGHT = 220;
export const USAGE_RESULTS_MAX_HEIGHT = 2400;

export const clampUsageResultsHeight = (height: number) =>
  Math.round(Math.min(USAGE_RESULTS_MAX_HEIGHT, Math.max(USAGE_RESULTS_MIN_HEIGHT, height)));

/** Absent until the grip is used, so an untouched window keeps filling the space below the chart. */
export function readStoredUsageResultsHeight(): number | undefined {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as { resultsHeight?: unknown } | null;
    const height = parsed?.resultsHeight;
    return typeof height === "number" && Number.isFinite(height) ? clampUsageResultsHeight(height) : undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredUsageResultsHeight(height: number | undefined): void {
  try {
    if (height === undefined) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ resultsHeight: height }));
  } catch {
    // A full or blocked store costs the operator their height, nothing more.
  }
}
