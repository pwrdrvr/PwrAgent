# OpenAI brand assets

The two SVG files in this directory are the **official, unaltered** OpenAI
Blossom variants from OpenAI's downloadable logo pack:

- `OAI_OpenAI-Blossom_Black.svg` — black Blossom for light surfaces
- `OAI_OpenAI-Blossom_White.svg` — white Blossom for dark surfaces

[`OpenAIIcon.tsx`](../../icons/OpenAIIcon.tsx) picks between them from the
live theme.

## Source

- Brand guidelines: <https://openai.com/brand/>
- Logo pack (zip): <https://cdn.openai.com/brand/openai-logos.zip>

The files come from `OpenAI-logos/SVGs/` inside the zip. Fetched on
2026-09-25:

| File | Bytes | SHA-256 |
|---|---|---|
| `openai-logos.zip` | 70,258 | `c54e85ab5884228f89f0230dd8effa8d588cad78166fe954135f4afa553222db` |
| `OAI_OpenAI-Blossom_Black.svg` | 2,415 | `75c1e9fffa5e8c437bec1d67197a73992bca45d166c6ff23215185dea8fae92a` |
| `OAI_OpenAI-Blossom_White.svg` | 2,415 | `01d158767c4eec0e47bd617e67759c33da0accd1438be1a8d29dfdb99ce87285` |

## Why the Blossom stands in for Codex

OpenAI publishes no separate Codex mark. The brand page offers only the
OpenAI logo pack and partnership templates, and the openai/codex repository
(Apache-2.0, which grants no trademark rights) contains no logo. The Codex
app icon ships only inside ChatGPT.app and is in no public brand kit.
Versions of it on icon sites are unofficial redraws, which this repository
does not accept. The Blossom is therefore the official file that identifies
the Codex CLI. OpenAI's own Codex page uses a Blossom tile the same way.

The brand page also hosts `Blossom_Dark.svg` / `Blossom_Light.svg`. Those are
construction diagrams with guide lines, not logo files. Do not use them.

## Usage rules — DO NOT alter these files

OpenAI's brand page lets a developer use the logo to truthfully identify the
OpenAI technology a product uses, provided the logo is used exactly as
supplied and OpenAI is acknowledged as its owner. The same page forbids:

- implying a partnership, sponsorship, or endorsement, or misrepresenting
  the relationship with OpenAI;
- showing the logo more prominently than the product's own branding, or
  making it part of that branding (name, app icon, primary mark);
- placing the Blossom in a partnership lockup;
- stretching, cropping, recoloring, adding effects, or setting the mark on
  a busy image.

A product that resembles an OpenAI product should say it is independently
developed and not affiliated with, endorsed by, or sponsored by OpenAI.

How PwrAgent follows those rules:

- **Rendered verbatim via `<img>`**, never inlined with `currentColor`, and
  never faded. The muted "untouched" diagram node fades its words, not the
  node.
- **Clear space is part of the file.** The mark covers about half of its
  716-unit canvas. Size the `<img>` to the box the mark and its clear space
  should fill, and never crop to the mark.
- **Never larger than PwrAgent's own mark.** The onboarding wizard draws the
  Blossom on a neutral tile at the same size as PwrAgent's app icon, with
  the word "Codex" beside it. This reads as a diagram of two apps, not a
  combined lockup.
- **Every surface carries the non-affiliation note.** Both the Codex profile
  step and the Codex CLI provider card show it.

Logo permission questions go to partnercomms@openai.com, and legal questions
to legal@openai.com.

## Updating these files

Re-download from the source above. Do not edit these files in place:

```bash
curl -sSL -o /tmp/openai-logos.zip "https://cdn.openai.com/brand/openai-logos.zip"
unzip -q -o /tmp/openai-logos.zip -x '__MACOSX/*' -d /tmp/openai-brand
cp /tmp/openai-brand/OpenAI-logos/SVGs/OAI_OpenAI-Blossom_Black.svg .
cp /tmp/openai-brand/OpenAI-logos/SVGs/OAI_OpenAI-Blossom_White.svg .
shasum -a 256 OAI_OpenAI-Blossom_*.svg
```

If the pack now contains a Codex mark, prefer it and update
`OpenAIIcon.tsx`, the usage notes above, and this README together. If the
URL 404s, start from the brand page. Check the result in the onboarding
wizard's Codex profile step on both themes before shipping.
