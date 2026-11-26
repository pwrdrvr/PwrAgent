# README screenshots

The artifacts in this directory are referenced from the top-level
[README.md](../../../README.md). They are produced by an inspect-style
Playwright spec that drives known UI surfaces and shells out to Swift
for native macOS window capture (with stoplights, drop shadow, and
retina resolution).

## README captures (WebP)

The top-level README shows these. Each was taken from a built PwrAgent at a
1440×900 window on a Retina display (2880×1800), with invented projects,
threads, and people, then encoded with `cwebp -q 82 -m 6 -resize 1600 0`.
They are ordinary Git blobs, not LFS, because GitHub's README renderer cannot
resolve LFS pointers. No e-mail address, account identifier, token, or local
path may appear in one; check each frame with OCR before committing it.

| File | Surface |
|---|---|
| `hero.webp` | Main window — Directories lens, a thread with its plan, Edits rail with a diff |
| `star-map.webp` | Star Map, Lanes layout, this machine and one federated machine |
| `backends.webp` | New thread with the provider menu open, AI providers rail |
| `review.webp` | A code review in a thread with P1–P3 findings |
| `terminal.webp` | Integrated terminal in a thread's worktree |

## Legacy capture spec

`pnpm --filter @pwragent/desktop screenshot:readme` still exists for the older
PNG/GIF capture workflow, though those unreferenced `screenshot-*.png` and
`screenshot-pairing.gif` files are no longer checked into this directory.

The full walkthrough — the spec, fixtures, state-seeding helpers, native
capture and GIF stitching utilities, and the macOS Screen Recording
permission prompt — lives in
[`apps/desktop/docs/screenshots.md`](../../../apps/desktop/docs/screenshots.md#capturing-readme-screenshots).

## When to regenerate

When you change a surface shown in one of these artifacts, regenerate
the affected capture in the same PR. The README's first-impression
value depends on the screenshots staying honest about the current UI.
