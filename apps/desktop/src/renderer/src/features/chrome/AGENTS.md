# features/chrome — AGENTS.md

## The Pwr-family title strip

PwrGit, PwrAgent and PwrSnap draw the same top-of-window chrome on macOS.
These numbers are shared across the family. Change them here and in the
sibling apps together, never in one app alone. PwrGit wrote the spec down
first (pwrdrvr/PwrGit#361, its `features/chrome/AGENTS.md`).

| Part | Value | Where in PwrAgent |
| --- | --- | --- |
| Band | 40px fill, centreline y=20. A divider, if any, sits *below* the fill (41px border-box) | `--chrome-band-h`; `box-sizing: content-box` on `.activity-titlebar` and `.settings-titlebar` |
| Stoplights | `trafficLightPosition: { x: 16, y: 13 }`: a 14px button centred on y=20; the group ends at x=76 | `MACOS_TRAFFIC_LIGHT_POSITION` in `main/macos-window-chrome.ts` |
| Brand start | x=96: 16px rail + 80px gutter, 20px clear of the stoplights | `.sidebar__masthead`, `.settings-nav__masthead`, `.activity-titlebar`, `.thread-header__masthead`, `.star-map__chrome` |
| Mark | The app icon's glyph as inline SVG, 20px square, `currentColor` = `--accent`, 8px gap to the wordmark, `aria-hidden` | `PwrAgentMark` in `BrandLockup.tsx`; `.brand-lockup` |
| Wordmark | `700 17px/1`, `letter-spacing: -0.01em`; "Pwr" `--text-primary`, "Agent" `--accent` | `.sidebar__brand`, `.settings-nav__brand`, `.activity-titlebar__brand` |
| Centring | Text centres by cap height (`text-box: trim-both cap alphabetic`); chevrons by x-height (`trim-both ex alphabetic`) | The grouped `text-box` rules after `.brand-lockup` in `styles/app.css` |

Why each one is what it is:

- **The fill must be an even number of points.** Electron's
  `trafficLightPosition` takes whole points, so a 14px button can centre only
  on a whole point. A 1px border inside a 40px box leaves a 39px fill centred
  on 19.5, which no stoplight can reach. The Activity and Settings title bars
  sat there until the divider moved below the fill.
- **Trim, don't nudge.** Flex centres a text element's line box, so the
  capitals land wherever the font's ascent and descent put them. The Activity
  wordmark sat 1.25px high, and the thread title sat 1px high. `text-box`
  trimming centres the drawn ink at any size, in any font. A trimmed element
  that clips its overflow (an ellipsizing crumb) needs `padding-block` to give
  its descenders back.
- **The mark is the icon glyph, not a new drawing.** `PwrAgentMark` uses the
  four `<rect>`s of `docs/design/pwragent-v2/project/assets/logo-pwragnt.svg`,
  which `scripts/generate-macos-app-icon.swift` also draws. Its viewBox is the
  glyph's bounds squared about the tile centre. It is drawn in `--accent`, the
  UI orange, not the icon's `#e8743a`. `brand-lockup.test.tsx` compares the
  bars with the SVG.

## Where PwrAgent differs from its siblings

- **The wordmark draws in the system font, not Geist.** `--font-sans` names
  Geist first, but PwrAgent bundles no `@font-face`. CDP
  `CSS.getPlatformFontsForNode` reports `.SF NS` (`.SFNS-Bold`,
  `isCustomFont: false`) for every wordmark. PwrGit and PwrSnap bundle Geist
  Sans, so the same 17px spec draws a slightly different wordmark there. The
  widths below are measured in `.SF NS`.
- **The lockup is 106.5px wide, and two surfaces could not hold it.**
  - The sidebar masthead sheds the mark first, before any button, when the
    rail's content box is 307px or less. `@container sidebar` sits beside
    `.sidebar__masthead`. The default 408px rail keeps the mark.
  - On macOS the Settings and Automations nav column is 216px wide, not 188px.
    The strip platforms hide that masthead and keep 188px.
- **The thread breadcrumb aligns by baseline.** Its 12px project eyebrow and
  its 14px title are one line of text. The title trims to cap height and
  centres its capitals at y=20. The eyebrow rides the title's baseline.
- **The Windows/Linux painted strip (`.app-titlebar__brand`) is not on this
  spec.** It keeps a 14px wordmark with no mark. The spec is macOS-only, and
  that strip is shared with the OS caption buttons.

## Verifying

Measure; do not judge alignment by eye. Render each strip at 2× in headless
Chromium against the real `styles/app.css`, and draw the stoplights as 14px
circles at their Electron position. Find each element's ink by diffing the
frame with and without that element. Compare the ink centre with y=20.

- Measure a wordmark on "Pwr", which has capitals and no descenders.
- Measure a crumb on its first capital.
- Force the mark's bars to full opacity. The 0.25 bar otherwise reads as
  background.

These are the measured centres at the adoption, in `.SF NS`, on macOS 26:

| Element | Centre |
| --- | --- |
| Stoplights | 20.0 |
| Mark | 20.0 |
| Wordmark capitals | 19.75 |
| Thread title | 20.0 |
| Settings and Activity crumbs | 19.75–20.5 |
| Chevrons | 19.25–19.5 |

The wordmark's 0.25 is one device pixel. Its source is the SF capital, whose
ink stands a little above the font's cap-height metric. macOS 15 and earlier
have not been measured.
