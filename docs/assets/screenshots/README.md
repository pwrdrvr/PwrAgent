# README screenshots

The artifacts in this directory are referenced from the top-level
[README.md](../../../README.md). They are produced by an inspect-style
Playwright spec that drives known UI surfaces and shells out to Swift
for native macOS window capture (with stoplights, drop shadow, and
retina resolution).

## Files

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
