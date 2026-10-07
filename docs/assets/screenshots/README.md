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

## Older captures (PNG and GIF)

`pnpm --filter @pwragent/desktop screenshot:readme` still produces these. The
README no longer shows them.

| File | Surface |
|---|---|
| `screenshot-recents-hero.png` | Hero — Recents lens populated with realistic threads |
| `screenshot-install.png` | macOS DMG install window — drag PwrAgent into Applications |
| `screenshot-bound-thread.png` | Thread detail with linked-messenger context |
| `screenshot-messenger-status.png` | Settings → Messaging status card |
| `screenshot-pairing.gif` | Multi-frame animated demo of the paste-token pairing flow |
| `screenshot-pairing-frame-1.png` … `-frame-3.png` | Source frames for the pairing GIF |
| `screenshot-closed-by-default.png` | Messaging activity log with denied unauthorized users |

## Regenerating

```bash
pnpm --filter @pwragent/desktop screenshot:readme
```

The full walkthrough — the spec, fixtures, state-seeding helpers, native
capture and GIF stitching utilities, and the macOS Screen Recording
permission prompt — lives in
[`apps/desktop/AGENTS.md`](../../../apps/desktop/AGENTS.md#capturing-readme-screenshots).

## When to regenerate

When you change a surface shown in one of these artifacts, regenerate
the affected capture in the same PR. The README's first-impression
value depends on the screenshots staying honest about the current UI.
