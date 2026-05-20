# Onboarding wizard — design pass v1

Self-contained design artifact for the first-run wizard requested in
[issue #467](https://github.com/pwrdrvr/PwrAgent/issues/467). Reference, not
implementation; treat it the same way `docs/design/pwragent-v2/` is treated
per [pwragent-v2/SOURCE.md](../pwragent-v2/SOURCE.md) — copy the *intent*,
not the prototype's structure verbatim.

## What's in here

- [`index.html`](index.html) — single-page HTML prototype. Eight wizard
  surfaces stacked vertically:
  1. Welcome (auto-fires on first launch of a fresh profile)
  2. Step 1 — Thread Presentation (Compact vs Mission Control)
  3. Step 2 — Codex Profile (Shared · Isolated · Multiple)
  4. Step 3a — Messaging safety preamble
  5. Step 3b — Provider table
  6. Step 3c — Telegram per-provider setup (exemplar)
  7. Done / review
  8. Post-wizard Settings → General reflection + Help menu re-entry

  Append `?slide=<id>` (e.g. `?slide=step3c`) to isolate one panel —
  used for screenshot capture.

- [`screenshots/`](screenshots/) — one PNG per slide, 1440×900, captured
  via Playwright's bundled chrome-headless-shell. Reproduce with:

  ```bash
  python3 -m http.server 8766 --directory docs/design/onboarding-wizard-v1 &
  CHROMIUM=~/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell
  for slide in welcome step1 step2 step3a step3b step3c done settings; do
    "$CHROMIUM" --headless --disable-gpu --hide-scrollbars \
      --window-size=1440,900 \
      --screenshot="docs/design/onboarding-wizard-v1/screenshots/$slide.png" \
      "http://localhost:8766/?slide=$slide"
  done
  ```

## Design language

- Tokens mirror `apps/desktop/src/renderer/src/styles/app.css` (Tangerine
  Terminal). If those tokens drift, this prototype drifts too — intentional.
- Wizard chrome reuses the Settings titlebar's eyebrow + breadcrumb pattern
  (`apps/desktop/src/renderer/src/styles/app.css` `.settings-titlebar__*` and
  `.activity-titlebar__*`). The step rail under it borrows the segmented-
  control visual treatment but adds an underline for progress state.
- Mini app-shell behind the scrim is faded with blur + opacity so the modal
  reads as anchored in the product, not floating in a void.
- The Step 1 choice cards embed actual thread-row primitives at 50% scale —
  the operator literally sees the future state of their sidebar.
- Step 2's three diagrams are deliberately schematic (PA ↔ CX), not
  photo-real Codex Desktop screenshots, because the desktop UI of Codex
  Desktop is owned by another team and may drift.

## Out of scope for this design pass

- The Multiple-profile Step 2 → repeated Step 3 path. Single-profile flow
  is illustrated; multi-profile expands the same primitives.
- Per-provider setup for Discord / Mattermost / Slack / Feishu / LINE.
  Telegram is the exemplar; each platform reuses the same horizontal
  substep rail (token → identify → pair → done) with platform-specific
  field shapes.
- Light-theme variants. Production tokens already flip via `data-theme`;
  the prototype only renders dark for now.
- Motion and transitions. Modal scrim fade, step-rail underline slide,
  card hover lift — defer to implementation.

## Provenance

- Created on branch `priceless-chebyshev-e240ad`.
- Created on: 2026-05-17.
- Created via: Claude (design pass requested by issue author).
- Builds on (no code copied): `docs/design/pwragent-v2/project/styles.css`
  for layout primitive ideas; `apps/desktop/src/renderer/src/styles/app.css`
  for tokens.

## Implementation notes for the build agent

These are observations from the design pass that should inform — but not
constrain — the implementation:

- **`density` already exists.** Step 1 maps onto the existing
  `DesktopSettingsSnapshot.general.appearance.density` setting (see
  `apps/desktop/src/renderer/src/features/settings/GeneralSettings.tsx`).
  The wizard's pick should drive the same setting; no new persistence
  surface is needed for Thread Presentation.
- **Codex profile model is the only new persistence surface.** The
  `Shared` / `Isolated` / `Multiple` choice is a new per-profile field;
  consider `general.codexProfileModel` alongside `appearance`.
- **Messaging acknowledgement persists as a timestamp + provider list.**
  Audit-trail oriented; don't re-prompt unless user explicitly replays
  onboarding from the Help menu.
- **First-launch detection is per-profile.** Use a `onboarding.completed`
  boolean in per-profile config.toml; new profiles get false; wizard sets
  to true on completion or explicit Skip.
- **Help → Replay onboarding** must NOT flip `onboarding.completed` back
  to false. It's a transient re-entry path; the per-profile flag stays
  true once it's been set.
- **In-session "profile-just-created" marker** is in-memory only and
  suppresses any "create another profile" prompt in the wizard for that
  session. Don't persist.
