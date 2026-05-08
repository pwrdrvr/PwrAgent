# Telegram brand assets

The SVG file in this directory is the **official, unaltered** Telegram
logo from Telegram's downloadable press-logo zip:

- `icon-color.svg` - current Telegram logo: blue gradient circle with
  white paper-plane mark

## Source

- Press info and usage note: <https://telegram.org/press#telegram-logos>
- Logo zip: <https://telegram.org/file/464001088/1/bI7AJLo7oX4.287931.zip/374fe3b0a59dc60005>

The source zip contains `Logo.svg`, `Logo.png`, and older logo files.
We use `Logo.svg` because it is the current scalable asset and renders
cleanly at the 12-16px sizes used in PwrAgent's messaging surfaces.

## Usage rules

Telegram's press page says to use the published logo files for article
illustrations, graphs, "forward to Telegram" buttons, and similar uses,
provided people understand the app is not representing Telegram
officially.

Telegram's press page does not publish separate black or white variants,
and it does not grant permission to recolor or redraw the mark. PwrAgent
therefore renders the official color SVG verbatim via `<img>` and does
not apply `currentColor`, CSS filters, effects, path edits, or custom
monochrome silhouettes.

## Updating this file

If Telegram publishes a new logo, update by re-downloading from the
source above rather than editing the existing file:

```bash
curl -sSL -o /tmp/telegram-logos.zip "https://telegram.org/file/464001088/1/bI7AJLo7oX4.287931.zip/374fe3b0a59dc60005"
rm -rf /tmp/telegram-brand
unzip -q /tmp/telegram-logos.zip -d /tmp/telegram-brand
cp /tmp/telegram-brand/Logo.svg ./icon-color.svg
```

If the zip URL changes, start from the Telegram press page and follow
the "Telegram logos" link.
