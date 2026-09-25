# Grok brand assets

The two SVG files in this directory are the **official, unaltered** Grok
logomark variants from SpaceXAI's logo download. xAI renamed itself SpaceXAI
in July 2026; Grok kept its name.

- `Grok_Logomark_Dark.svg` — near-black mark (`#0A0A0A`) for light surfaces
- `Grok_Logomark_Light.svg` — white mark for dark surfaces

xAI names each file for the color of the mark, not the surface.
[`GrokIcon.tsx`](../../icons/GrokIcon.tsx) picks between the two from the
live theme.

## Source

- Brand guidelines: <https://x.ai/legal/brand-guidelines>, linked there as
  "Download Logos"
- Logo zip: <https://data.x.ai/logos/SpaceXAI_Grok_Assets.zip>

The files come from `SpaceXAI_Grok_Assets/` inside the zip. Fetched on
2026-09-25:

| File | Bytes | SHA-256 |
|---|---|---|
| `SpaceXAI_Grok_Assets.zip` | 351,396 | `db9129acd4efc4c2202d25afe31b70281a79f8507f75520ab5e6b3356895a7e9` |
| `Grok_Logomark_Dark.svg` | 965 | `a127a7cd42b0450f7d3827a331b0730aab49fd99c3fe920d172475b9ffc83992` |
| `Grok_Logomark_Light.svg` | 961 | `b20648e2f111d7fbc91f58b22d1e76e9885b68a163cb5a1010f7f11bf5840491` |

Use the logomark, not `Grok_Full_Logomark_*` (mark plus wordmark, too wide
for an icon slot) or the `spacexai - *` files, which are the company's own
symbol and not Grok's. Do not substitute `grok.com`'s favicon. It is a site
icon, not the published download.

## Usage rules — DO NOT alter these files

The brand guidelines allow the marks only to accurately refer to xAI and its
services, and ask that logos be used exactly as provided at the download
link, without alteration. They forbid:

- any use that implies xAI's endorsement, approval, or sponsorship;
- the marks in an app title, domain name, or product name;
- placing anything near the marks that could read as a new, combined mark.

xAI may require changes after review or withdraw permission at any time.
Questions go to legal@x.ai.

How PwrAgent follows those rules:

- **Rendered verbatim via `<img>`**, never inlined with `currentColor`,
  recolored, or faded.
- **On its own tile, beside the words "Grok Build".** It is not joined to
  PwrAgent's mark. The file has no built-in clear space (the mark runs to
  the canvas edges), so the wizard insets it within a neutral tile.
- **Every surface carries the non-affiliation note.** The Grok Build
  provider card shows it.

## Updating these files

`data.x.ai` sits behind Cloudflare, which answers `curl` with a 403 even
with a browser user agent. Download the zip with a browser from the brand
guidelines page, then:

```bash
unzip -q -o ~/Downloads/SpaceXAI_Grok_Assets.zip -d /tmp/grok-brand
cp /tmp/grok-brand/SpaceXAI_Grok_Assets/Grok_Logomark_Dark.svg .
cp /tmp/grok-brand/SpaceXAI_Grok_Assets/Grok_Logomark_Light.svg .
shasum -a 256 Grok_Logomark_*.svg
```

If the link on the brand page has moved, follow it rather than the URL
above. Check the result on the onboarding wizard's Grok Build provider card
on both themes before shipping.
