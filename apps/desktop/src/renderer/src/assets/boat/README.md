# Boat mark

`boat-mark.svg` is Boat's own site icon, **unaltered**. The New thread
launchpad's Boat tile and Boat's row in Settings → Plugins draw it.

## Source

- File: <https://boat.dev/icon.svg>, the icon `https://boat.dev/` declares
  with `<link rel="icon" type="image/svg+xml">`.
- Fetched 2026-11-20. SHA-256:
  `3176deb726c81cee9ef6468851c9a8551568e7fcd9a0edb1e173c531748df6a7`.

No Boat brand kit or brand guidelines were found. This file is the mark its
site ships, so it is used as published, to name Boat's own service on a
control that sets up Boat. Replace it with a brand-kit file, and record the
kit's usage rules here, if Boat publishes one.

## Usage rules

With no published guidelines, follow the common rules for third-party marks:

- **No recoloring.** Render it through `<img>`, never as inline `<svg>` with
  `currentColor` or CSS filters, so surrounding color rules cannot reach it.
- **No effects, warping, or cropping.** The mark is wider than it is tall and
  has a transparent background, so it is drawn with `object-fit: contain` on
  the `--brand-mark-plate` plate (`mcp-connection__icon--plate`). The plate
  keeps the dark blue mark legible in dark themes without touching the file.
- **No redrawing.** Do not trace or approximate the mark.

## Updating this file

Re-fetch it rather than editing it in place:

```bash
curl -fsSL https://boat.dev/icon.svg -o boat-mark.svg
shasum -a 256 boat-mark.svg
```

Update the date and checksum above, then check the launchpad tile in the dark
and light themes before shipping.
