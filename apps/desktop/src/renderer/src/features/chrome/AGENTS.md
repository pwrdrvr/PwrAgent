# features/chrome

- PwrGit, PwrAgent and PwrSnap share the macOS title-strip numbers: a 40px band
  centred on y=20, stoplights at `{ x: 16, y: 13 }`, the brand at x=96, a 20px
  mark, and a `700 17px/1` wordmark. Change them here and in the sibling apps
  together, never in one app alone.
- Keep the fill an even number of points, centre text with `text-box` trimming
  instead of nudges, and draw the mark from the app icon's glyph.
- Measure alignment in headless Chromium; do not judge it by eye.

Before changing a title strip, the brand lockup, masthead breakpoints, or
breadcrumb alignment, read
[chrome-title-strip.md](../../../../../docs/chrome-title-strip.md) and
[desktop-chrome-tokens.md](../../../../../../../docs/desktop-chrome-tokens.md).
