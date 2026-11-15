# Desktop Chrome Token Contract

Read this before building or changing window chrome, title strips, brand marks, breadcrumbs, eyebrows, or path/application rows. Also read the [desktop style guide](design/desktop-style-guide.md) and [UI theme guide](UI-THEME.md).

## Reuse existing chrome tokens

Before you build new window chrome, open `apps/desktop/src/renderer/src/styles/app.css`.

- Find the existing primitive that has the same function.
- Copy its token references.
- Do not select a different token because it looks similar.
- Keep brand presentation identical in all windows.

This rule applies to these elements:

- Title-bar strips.
- Brand marks.
- Breadcrumbs.
- Eyebrows.
- Path or application rows.

Canonical primitives and the tokens they read:

| Primitive | Mark | Brand | Brand accent | Eyebrow | Breadcrumb separator | Breadcrumb current |
|---|---|---|---|---|---|---|
| `.sidebar__brand` (main sidebar) | `--accent` | `--text-primary` | `--accent` | n/a | n/a | n/a |
| `.settings-nav__brand` (Settings nav) | `--accent` | `--text-primary` | `--accent` | n/a | n/a | n/a |
| `.settings-titlebar__*` (Settings right-pane) | n/a | n/a | n/a | `--accent` | `--text-muted` | `--text-primary` |
| `.activity-titlebar__*` (Activity window) | `--accent` | `--text-primary` | `--accent` | `--accent` | `--text-muted` | `--text-primary` |

Render a brand through `BrandLockup`
(`apps/desktop/src/renderer/src/features/chrome/BrandLockup.tsx`).

- It draws the app-icon mark and the wordmark together.
- Do not hand-write a `__brand` paragraph. The lockup's test fails when one appears.
- The macOS title-strip geometry is the Pwr-family spec in
  [features/chrome/AGENTS.md](../apps/desktop/src/renderer/src/features/chrome/AGENTS.md).

`apps/desktop/src/renderer/src/styles/__tests__/theme-contract.test.tsx` enforces this token contract.

- The test compares brand accent tokens across the listed primitives.
- The test holds the lockup's mark color, gap, and wordmark type to the family spec.
- The test also compares Activity and Settings breadcrumb tokens.
- If you intentionally change a chrome token, change the test in the same commit.
- This paired change makes the design decision visible during review.
