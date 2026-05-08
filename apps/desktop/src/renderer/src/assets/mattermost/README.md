# Mattermost brand assets

The three SVG files in this directory are the **official, unaltered**
Mattermost icon variants from Mattermost's downloadable brand kit:

- `icon-black.svg` — pure black variant (`#1b1d22`)
- `icon-denim.svg` — brand-default variant (`#1e325c`)
- `icon-white.svg` — pure white variant

## Source

- Brand guidelines: <https://mattermost.com/brand-guidelines/>
- Brand kit (zip): <https://mattermost.com/wp-content/uploads/2026/02/Logo_Mattermost.zip>

The files here come from `Logo_Mattermost/Logo_without_clearspace/Icon/`
inside the zip. We use the "without clearspace" Icon variants so the
mark fills the chip area at small sizes — the "with clearspace" variants
include extra padding intended for documents and marketing surfaces.

## Usage rules — DO NOT alter these files

Mattermost's brand guidelines explicitly forbid altering the mark.
Quoting their guidelines page: *"The Mattermost logo must not be altered
in any way."* Restrictions called out specifically include:

- **No recoloring** — the three variants here are the only colorways
  permitted. We do not apply `currentColor` or CSS filters to these
  images. That's why [`MattermostIcon.tsx`](../../icons/MattermostIcon.tsx)
  renders the asset as an `<img>` instead of inlining it as `<svg>` with
  `stroke="currentColor"`.
- **No effects** — no drop shadows, gradients, glows, or composites.
- **No warping or cropping** — the icon is rendered as a square at the
  same aspect ratio as the source.
- **No redrawing** — do not hand-redraw, trace, or "approximate" the
  mark. If you need a variant that doesn't exist in the kit, contact
  Mattermost's media team rather than producing one yourself.

## Updating these files

If Mattermost publishes a new logo, update by **re-downloading from the
source above** rather than editing the existing files in place:

```bash
curl -sSL -o /tmp/Logo_Mattermost.zip "https://mattermost.com/wp-content/uploads/2026/02/Logo_Mattermost.zip"
unzip -q /tmp/Logo_Mattermost.zip -d /tmp/mattermost-brand
cp /tmp/mattermost-brand/Logo_Mattermost/Logo_without_clearspace/Icon/Mattermost_icon_black.svg ./icon-black.svg
cp /tmp/mattermost-brand/Logo_Mattermost/Logo_without_clearspace/Icon/Mattermost_icon_denim.svg ./icon-denim.svg
cp /tmp/mattermost-brand/Logo_Mattermost/Logo_without_clearspace/Icon/Mattermost_icon_white.svg ./icon-white.svg
```

(Watch the brand kit URL — Mattermost may republish at a different path.
If the URL above 404s, start from the brand guidelines page.)

Verify the new files render correctly at chip and status-indicator sizes
(`<MattermostIcon size={14} />` and `<MattermostIcon size={16} />`) before
shipping.

## Why this matters

The same pattern is now used for Telegram and Discord: official files
live under `assets/<platform>/`, render via `<img>`, and stay insulated
from surrounding CSS color state. The status dot communicates health;
the vendor icon communicates identity.
