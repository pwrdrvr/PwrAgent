# Automation messaging surfaces — design pass v1

Self-contained design artifact for the UX review of
[PR #2196](https://github.com/pwrdrvr/PwrAgent/pull/2196), which made every
messaging provider and every non-channel surface (DMs, group DMs, LINE rooms)
usable as an automation trigger and as a result destination.

Reference, not implementation; treat it the same way `docs/design/pwragent-v2/`
is treated per [pwragent-v2/SOURCE.md](../pwragent-v2/SOURCE.md) — copy the
*intent*, not the prototype's structure verbatim.

The findings these sheets illustrate are written up in
[automation-messaging-surfaces-ux-review.md](../automation-messaging-surfaces-ux-review.md).

## What's in here

- [`index.html`](index.html) — single-page HTML prototype. Six sheets stacked
  vertically, each a before/after pair: the surface as it behaves on
  `fix/automation-provider-surfaces`, and as this pass proposes it should read.

  1. `picker` — the `dm:` sentinel reaching the picker's durable-ID column
  2. `manual` — manual ID entry cannot express a DM, and saves an inert trigger
  3. `discord` — a picker whose nouns promise channels it can never list
  4. `preview` — history availability, stated before the operator commits
  5. `destination` — a Telegram DM destination with a live, discarded topic field
  6. `replay` — an empty state that blames the provider for a scope limit

  Append `?slide=<id>` (e.g. `?slide=manual`) to isolate one sheet — used for
  screenshot capture.

- [`screenshots/`](screenshots/) — one PNG per sheet, 1400px wide, captured via
  Playwright's bundled chrome-headless-shell. Reproduce with:

  ```bash
  python3 -m http.server 8771 --directory docs/design/automation-surfaces-v1 &
  CH=~/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell
  declare -A H=( [picker]=600 [manual]=570 [discord]=600 [preview]=620 [destination]=530 [replay]=640 )
  for slide in picker manual discord preview destination replay; do
    "$CH" --headless --disable-gpu --hide-scrollbars \
      --window-size=1400,${H[$slide]} \
      --screenshot="docs/design/automation-surfaces-v1/screenshots/$slide.png" \
      "http://localhost:8771/?slide=$slide"
  done
  ```

  Heights are per-sheet because each sheet is a different length and
  chrome-headless-shell has no full-page capture; they only trim dead space.

## Design language

- Tokens mirror `apps/desktop/src/renderer/src/styles/app.css` (Tangerine
  Terminal). If those tokens drift, this prototype drifts too — intentional.
- Every control is transcribed from a shipped primitive rather than restyled:
  `.messaging-surface-picker__panel` and its search row, section eyebrow, row
  anatomy (check column → kind glyph → name → mono ID) and action row;
  `.automation-field` / `.automation-field__hint`; `.automation-field--picker
  .messaging-surface-picker__trigger`; `.automation-segmented`; `.button--ghost`.
  Geometry — 38px row min-height, 12px check column, 13px glyph column, 60% name
  cap, 11px mono ID, 32px field height, 560px field measure — is copied from the
  same rules, so a sheet can be held against a running build.
- The only prototype-only chrome is the sheet header, the before/after column
  rules and the annotation callouts. Those are labelled as such and use no
  product class names.
- Dark only. Production tokens flip via `data-theme`; this pass does not.

## Out of scope for this design pass

- The Automations funnel rail and stage numbering. Sheets show a stage's
  contents, not its surrounding `AutomationFunnel` chrome.
- Messaging Routes settings, which shares `MessagingSurfacePicker` but feeds it
  observed surfaces rather than authorized conversations. Sheet 1's fix is in
  the Automations caller (`readProviderGroups` / `conversationOptions`), so it
  does not touch the Routes list.
- Group DMs and LINE rooms as a distinct visual kind. The generic contract
  represents them as `channel` and the picker marks them `#`; whether they earn
  their own glyph is a separate question from the ones raised here.
- Motion and transitions.

## Provenance

- Created on branch `fix/automation-provider-surfaces`.
- Created on: 2026-09-17.
- Created via: Claude (UX design review requested by the PR author).
- Builds on (no code copied): `apps/desktop/src/renderer/src/styles/app.css`
  for tokens and control geometry; `docs/design/onboarding-wizard-v1/` for the
  prototype's own sheet-and-`?slide=` structure.

## Note on the proposed copy

Every "proposed" string in the prototype is a draft, not a decision. The
constraint each one encodes — name the scope rather than the provider, say
*from* for a contact DM, do not print an internal sentinel — is the part worth
keeping if the wording changes.
