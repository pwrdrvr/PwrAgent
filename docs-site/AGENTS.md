# docs-site Guidance

The operator-facing Jekyll site served at <https://docs.pwragent.ai>.
Built and deployed by `.github/workflows/pages.yml` on every merge to
`main` that touches `docs-site/**`.

## Accessibility

**Goal: the docs site should be fully usable with a screen reader,
keyboard-only navigation, and the platform's reduced-motion /
high-contrast preferences honored.** Operators land on
docs.pwragent.ai when something is unclear or broken — that has to
work the same for everyone.

Baseline (verified): zero violations against WCAG 2.0 / 2.1 / 2.2
Level AA + axe best-practice rules across the home, `/desktop/`,
`/providers/telegram/`, and `/messaging/pairing/` pages at both
1440×900 and 393×852 viewports.

Things to keep working when extending the site:

- Each page has exactly one `<h1>`, with `<h2>` / `<h3>` nesting
  that doesn't skip levels.
- Every `<img>` carries a descriptive `alt` (or `alt=""` for
  purely decorative images). The hero `desktop-hero.png` alt
  text describes what's visible to a non-sighted reader.
- The dropdown nav reveals on `:hover` and `:focus-within` so
  keyboard users can reach every sub-link.
- The skip-to-content link at the very top of `<body>` lets a
  keyboard user jump past the nav and land focus directly in
  `<main>` (which carries `tabindex="-1"` so the focus move
  actually takes).
- Anchor jumps respect the sticky header on desktop via
  `scroll-margin-top` on every heading inside `.page`.
- The `prefers-reduced-motion: reduce` media query disables
  every transition/animation in the site stylesheet.
- Color contrast: the Tangerine Terminal palette pairs
  `--text-primary` (#f7f3eb) on `--bg-app` (#000000) for body
  text (≈19.5:1 — WCAG AAA), and `--accent` (#ff8a1f) on black
  for interactive accents (≈11:1 — WCAG AAA). When introducing
  a new token, check the contrast pair before shipping.

### Re-auditing locally

Run the docs site container (or `bundle exec jekyll serve` from
`docs-site/`), then via [agent-browser](../apps/desktop/AGENTS.md):

```bash
# Build + serve.
docker build -t pwragent-docs-site:local docs-site/
docker run -d --name pwragent-docs-site -p 4000:4000 \
  pwragent-docs-site:local

# Inject axe-core and run against any page.
agent-browser set viewport 1440 900 1
agent-browser open http://localhost:4000/desktop/
agent-browser wait --load networkidle
agent-browser eval --stdin <<'EOF'
(async () => {
  if (!window.axe) {
    await new Promise((r, j) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js';
      s.onload = r; s.onerror = j;
      document.head.appendChild(s);
    });
  }
  const results = await window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
  });
  return {
    violations: results.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length })),
    incomplete: results.incomplete.map((v) => ({ id: v.id, count: v.nodes.length })),
    passes: results.passes.length,
  };
})()
EOF
```

Aim for `violations: []` on every page. `incomplete` results
warrant a manual check but aren't violations — axe couldn't
determine the answer automatically.

## Style + tone

- Operator-facing prose. Lead with the value or behavior;
  implementation details (framework names, table schemas,
  library APIs) don't belong in user docs.
- Defaults are *the* recommendation. "Why you might change it"
  is the rarer case, not the headline.
- Keep dropdown labels under one line in the desktop dropdown
  (~50 chars). On mobile they wrap to two lines but should still
  be scannable.

## Screenshots

Captured by the desktop app's E2E pipeline; see
[apps/desktop/AGENTS.md](../apps/desktop/AGENTS.md) "Capturing
README Screenshots" for the full pipeline. The
`scripts/filter-noise-screenshots.mjs` post-capture cleanup
reverts PNGs whose pixels are identical to the committed version,
so re-running the screenshot script only commits actually-changed
images.

## Local preview

```bash
docker build -t pwragent-docs-site:local docs-site/
docker run -d --name pwragent-docs-site -p 4000:4000 \
  pwragent-docs-site:local
# Open http://localhost:4000/
```

Cloudflare proxies the live site at `docs.pwragent.ai`; after a
deploy, manually purge the CSS / HTML at the CF dashboard
(Caching → Purge Cache → Custom Purge) or wait the ~4h
`max-age=14400` TTL.

## Pages workflow

`.github/workflows/pages.yml` fires on `main` pushes that touch
`docs-site/**` or the workflow file itself. CI (the heavy
Vitest / typecheck / lint matrix) skips on docs-site-only PRs
per the paths-ignore in `.github/workflows/ci.yml`.
