/**
 * The PwrAgent mark: the app icon's glyph, drawn from the `<rect>`s of
 * docs/design/pwragent-v2/project/assets/logo-pwragnt.svg — the same four
 * bars, at the same four opacities, that `scripts/generate-macos-app-icon.swift`
 * bakes into `build/icon.icon`. Not a new drawing.
 *
 * The viewBox is the glyph's own bounds (x 28–100, y 32–96) squared about
 * their centre, which is also the icon tile's centre (64, 64), so the bars fill
 * the 20px box the way PwrGit's and PwrSnap's marks fill theirs.
 *
 * It fills `currentColor`, which `.brand-lockup` sets to `--accent` — the UI
 * orange, not the icon's #e8743a. The wordmark beside it names the app, so the
 * mark is decorative to assistive tech.
 */
export function PwrAgentMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="brand-lockup__mark"
      focusable="false"
      height={size}
      viewBox="28 28 72 72"
      width={size}
    >
      <g fill="currentColor">
        <rect height="10" rx="2" width="60" x="28" y="32" />
        <rect height="10" opacity="0.65" rx="2" width="72" x="28" y="50" />
        <rect height="10" opacity="0.4" rx="2" width="44" x="28" y="68" />
        <rect height="10" opacity="0.25" rx="2" width="56" x="28" y="86" />
      </g>
    </svg>
  );
}

/**
 * Which chrome primitive draws the wordmark. Each keeps its own class pair so
 * the token contract in theme-contract.test.tsx can hold them to one look.
 */
export type BrandLockupVariant = "sidebar" | "settings-nav" | "activity-titlebar";

const WORDMARK_CLASSES: Record<BrandLockupVariant, { wordmark: string; accent: string }> = {
  sidebar: { wordmark: "sidebar__brand", accent: "sidebar__brand-accent" },
  "settings-nav": { wordmark: "settings-nav__brand", accent: "settings-nav__brand-accent" },
  "activity-titlebar": {
    wordmark: "activity-titlebar__brand",
    accent: "activity-titlebar__brand-accent",
  },
};

/**
 * Mark + "Pwr" / "Agent" wordmark: the Pwr-family title-strip brand. Every
 * top-of-window brand on macOS renders through this, so the lockup cannot
 * differ between the main window, Settings, and the auxiliary windows.
 */
export function BrandLockup({ variant }: { variant: BrandLockupVariant }) {
  const classes = WORDMARK_CLASSES[variant];
  return (
    <div className="brand-lockup">
      <PwrAgentMark />
      <p className={classes.wordmark}>
        Pwr<span className={classes.accent}>Agent</span>
      </p>
    </div>
  );
}
