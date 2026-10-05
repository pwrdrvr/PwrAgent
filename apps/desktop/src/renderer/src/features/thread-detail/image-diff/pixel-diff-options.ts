/* Kept apart from image-diff-model.ts so the worker bundles these and
   pixelmatch, not @pwragent/shared. */

/**
 * Diff colors, deliberately not pixelmatch's red: these are game art and UI
 * screenshots that already carry red, where a red delta reads as part of the
 * picture. `--image-diff-changed` / `--image-diff-aa` in app.css are the same
 * values for the legend, and do not flip with the theme because the worker
 * bakes these into the PNG.
 */
export const DIFF_COLOR: [number, number, number] = [255, 45, 155];
export const DIFF_AA_COLOR: [number, number, number] = [255, 225, 77];

/** What the worker hands pixelmatch. Exported so a test drives the real
 *  library with the same settings: it silently ignores keys it does not know,
 *  so a renamed option would fall back to its own defaults. */
export const DIFF_OPTIONS = {
  threshold: 0.1,
  diffColor: DIFF_COLOR,
  aaColor: DIFF_AA_COLOR,
  /** Enough of the original under the deltas to place a change on the
   *  picture, dim enough that magenta wins the eye. */
  alpha: 0.12,
} as const;
