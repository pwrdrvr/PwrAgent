# Sandboxer mark

`sandboxer-mark.svg` is Sandboxer's own site icon, **unaltered**. The New
thread launchpad's Sandboxer tile draws it.

## Source

- File: <https://sandboxer.com/favicon.svg>, the icon `https://sandboxer.com/`
  declares with `<link rel="icon">`.
- Fetched 2026-10-25. SHA-256:
  `6085d6a883aaebb1662d6cfd46f73c9c8030912c905cb519a6efac9612492e70`.

Sandboxer publishes no brand kit or brand guidelines. This file is the only
mark it ships, so it is used as published, to name Sandboxer's own service on
a control that sets up Sandboxer. Replace it with a brand-kit file, and record
the kit's usage rules here, if Sandboxer publishes one.

## Usage rules

With no published guidelines, follow the common rules for third-party marks:

- **No recoloring.** Render it through `<img>`, never as inline `<svg>` with
  `currentColor` or CSS filters, so surrounding color rules cannot reach it.
- **No effects, warping, or cropping.** Draw it square at its own aspect ratio.
- **No redrawing.** Do not trace or approximate the mark.

## Updating this file

Re-fetch it rather than editing it in place:

```bash
curl -fsSL https://sandboxer.com/favicon.svg -o sandboxer-mark.svg
shasum -a 256 sandboxer-mark.svg
```

Update the date and checksum above, then check the launchpad tile in the dark
and light themes before shipping.
