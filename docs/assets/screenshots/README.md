# README screenshots

This directory holds the screenshots referenced from the top-level
[README.md](../../../README.md). Each entry below lists the target filename,
the surface to capture, and the framing notes.

Capture conventions:

- Desktop app running locally (`pnpm dev` or a release build).
- Window size: **1440 × 900** (standard macOS screenshot dimensions).
- Light theme by default. Capture a dark-theme variant only if a row reads
  noticeably better in dark mode; suffix with `-dark.png`.
- Real data, not lorem-ipsum. Use a populated replay fixture or a local
  profile with a handful of realistic-looking threads.
- Crop tight to the relevant chrome. Don't include the macOS menu bar or
  desktop wallpaper.
- File size budget per shot: aim for < 400 KB. Use PNG (lossless) — if a
  shot blows the budget, run it through `pngcrush` or `oxipng`.

If a surface listed below isn't yet visually convincing enough to ship
publicly, **drop the row from the README** rather than ship a confusing
screenshot. Better to show three good shots than six mixed.

## Required captures

### `screenshot-recents-hero.png`

The "hero" shot at the top of the README. Recents lens, populated with
several threads, at least one carrying a messenger badge (Telegram or
Discord). Convey the thread-first information hierarchy at a glance.

### `screenshot-bound-thread.png`

A thread detail view with linked-messenger context visible. The viewer
should be able to tell that this thread has a chat-platform conversation
attached without reading any explanatory copy.

### `screenshot-messenger-status.png`

Settings or status surface showing the connection state of one or more
messengers (Telegram / Discord / Mattermost). The "messenger status at a
glance" claim in the README points here.

### `screenshot-pairing.png`

The pairing / binding flow that links the desktop app to a chat bot. If
there is no dedicated wizard, a clean settings-card view that conveys
"bring your own bot, paste a token" is fine.

### `screenshot-closed-by-default.png`

Approval gate UI or a closed-thread surface that conveys "the agent isn't
acting on its own." The reader should walk away thinking the app is safe
by default.

## Optional captures

### `screenshot-multi-directory-thread.png`

Optional. A thread that's linked to more than one Git directory, showing
how directory associations work without forcing one-thread-per-folder
discipline. Include only if the surface is stable.

## Updating screenshots

When you change a surface shown in one of these screenshots, regenerate
the screenshot in the same PR. The README's first-impression value
depends on the screenshots staying honest about the current UI.
