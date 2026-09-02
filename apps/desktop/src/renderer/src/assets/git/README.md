# Git brand assets

The three SVG files in this directory are the **official, unaltered** Git
icon variants published by the Git project:

- `icon-1788c.svg` — brand-default variant (Pantone 1788C, `#f03c2e`)
- `icon-black.svg` — black variant (`#100f0d`)
- `icon-white.svg` — white variant

## Source and licence

- Logo downloads: <https://git-scm.com/downloads/logos>
- Direct files: `https://git-scm.com/images/logos/downloads/Git-Icon-<variant>.svg`

The Git logo was designed by **Jason Long** and is licensed under the
**Creative Commons Attribution 3.0 Unported** licence
(<https://creativecommons.org/licenses/by/3.0/>). That licence requires
attribution, which this README provides and which
[`GitIcon.tsx`](../../icons/GitIcon.tsx) repeats in its doc comment so the
obligation stays next to the code that renders it.

CC BY 3.0 permits use and redistribution, including in a commercial
product, provided the attribution above travels with the files. It does
not make the mark a PwrAgent asset — see the usage rules below.

## Usage rules — do not alter these files

- **No recoloring.** The three variants here are the colorways the Git
  project publishes. We do not apply `currentColor` or CSS filters to
  them, which is why `GitIcon.tsx` renders the asset as an `<img>` rather
  than inlining it as `<svg stroke="currentColor">`.
- **No redrawing.** Do not hand-trace or approximate the mark. If a
  variant you need does not exist, start from the downloads page.
- **No warping.** The icon renders square at the source aspect ratio.

## Updating these files

Re-download rather than editing in place:

```bash
cd apps/desktop/src/renderer/src/assets/git
curl -sSL -o icon-1788c.svg "https://git-scm.com/images/logos/downloads/Git-Icon-1788C.svg"
curl -sSL -o icon-black.svg "https://git-scm.com/images/logos/downloads/Git-Icon-Black.svg"
curl -sSL -o icon-white.svg "https://git-scm.com/images/logos/downloads/Git-Icon-White.svg"
```

Verify at chip and row sizes (`<GitIcon size={14} />` and `size={18}`)
before shipping. The brand-red variant is the default because it stays
legible on both PwrAgent themes; the black and white variants are here
for surfaces that need a monochrome mark.
