# GitHub brand assets

The two SVG files in this directory are the **official, unaltered**
GitHub Invertocat mark from GitHub's downloadable logo kit:

- `invertocat-black.svg` — black variant, used on light theme
- `invertocat-white.svg` — white variant, used on dark theme

## Source

- Logos page: <https://github.com/logos>
- Logo kit (zip): <https://brand.github.com/GitHub_Logos.zip>

The files come from `GitHub Logos/SVG/` inside that zip. We use the
`GitHub_Invertocat_<variant>.svg` files rather than the
`..._Clearspace.svg` ones so the mark fills the icon chip — the
clearspace variants pad the artboard for documents and marketing
surfaces. The same reasoning is documented for Mattermost in
[`../mattermost/README.md`](../mattermost/README.md).

## Why the Invertocat and not the GitHub Desktop icon

PwrAgent renders this mark for the **`gh` command line tool**. `gh` is
GitHub's own CLI and is not a part of GitHub Desktop, so the GitHub mark
is the accurate identity for it. GitHub's logo guidance covers using the
mark to refer to GitHub; it does not cover borrowing a different
product's application icon.

## Usage rules — do not alter these files

GitHub's logo guidance forbids modifying the mark. In particular:

- **No recoloring.** Black and white are the two variants GitHub
  publishes for this mark, and picking between them by theme is a
  variant choice, not a recolor. `GitHubIcon.tsx` therefore renders the
  asset as an `<img>` and swaps files on `[data-theme]`; it never applies
  `currentColor` or a CSS filter.
- **No redrawing, warping, cropping, or effects.**
- **Not for endorsement.** The mark identifies the `gh` tool PwrAgent
  runs. It must not appear anywhere that implies GitHub sponsors,
  endorses, or is affiliated with PwrAgent.

## Updating these files

```bash
curl -sSL -o /tmp/GitHub_Logos.zip "https://brand.github.com/GitHub_Logos.zip"
unzip -o -j /tmp/GitHub_Logos.zip \
  "GitHub Logos/SVG/GitHub_Invertocat_Black.svg" \
  "GitHub Logos/SVG/GitHub_Invertocat_White.svg" \
  -d apps/desktop/src/renderer/src/assets/github
cd apps/desktop/src/renderer/src/assets/github
mv GitHub_Invertocat_Black.svg invertocat-black.svg
mv GitHub_Invertocat_White.svg invertocat-white.svg
```

(The zip URL comes from the "Download our logos" link on
<https://github.com/logos>. If it 404s, start from that page.)
