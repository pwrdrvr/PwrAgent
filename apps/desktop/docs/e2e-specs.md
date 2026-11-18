# Writing and Inspecting Desktop E2E Specs

Moved from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps a summary and
says when to read this document. Relative links were updated for this location.

## E2E Failure Timing

Import `test` from `e2e/fixtures/electron-test` in desktop specs. Its automatic
fixture attaches the main process's existing listing and Git timing snapshots
only for failed attempts, including timeouts. `launchElectronApp` captures them
before explicit close calls, while the app is still reachable. Passing attempts
discard those in-memory copies. The bridge requires `PWRAGENT_E2E=1`, a replay
fixture, and an unpackaged app.

## E2E Locator Hygiene Around Global Chrome

The thread/search title bars always render the history Back/Forward
buttons (accessible names `Back` and `Forward`), and they stay mounted
behind overlays like the onboarding wizard. A page-wide
`getByRole("button", { name: /Back/i })` will resolve to multiple
elements and fail Playwright strict mode. When writing specs:

- Scope to a container (`dialog.getByRole(...)`) or anchor the regex to
  the full label (e.g. the wizard's `/^← Back/i`).
- Target the history buttons themselves via their test ids:
  `history-nav-back` / `history-nav-forward`.

The composer's stop-the-turn button is the same story and has the test id
`composer-stop-turn`. Use it rather than `getByRole("button", { name:
"Stop" })`, which 21 call sites across 10 specs once relied on. Adding the
active sub-agents strip broke every one of them, because a row control named
"Stop sub-agent: <task>" still matches: **Playwright matches an accessible
`name` as a normalized substring by default**, so qualifying the new button's
label was not enough — only `exact: true` or a test id disambiguates. The
`toHaveCount(0)` assertions were the sharpest edge, since they assert no Stop
button exists anywhere in the window.

Note the vitest/Playwright asymmetry when you write a unit test to guard one
of these: Testing Library matches a string `name` **exactly**, so a unit
assertion that "Stop" no longer resolves will pass while the Playwright
locator it was meant to protect still breaks.

The same trap runs in the other direction, and it bites the *renderer*
rather than the spec: **`getByLabel` matches on substring**, and 31 call
sites across 23 specs drive the composer with `getByLabel("Reply")`. A new
`aria-label` anywhere in the app that merely *contains* "reply" turns every
one of them into a strict-mode violation as soon as the labelled element
renders. The unsent-draft chip was originally labelled "Unsent draft reply"
and did exactly that — the unit suite was green and only Desktop E2E caught
it. When you add an `aria-label`, grep the specs for the words in it before
you settle on the wording.

## Inspecting Branch Drift Dialog E2E

To open the replay-backed "Thread branch changed" dialog and keep Electron
open for manual screenshots, run from the repo root:

```bash
pnpm --filter @pwragent/desktop inspect:e2e:branch-drift
```

The script builds the desktop app, launches a deterministic branch-drift
fixture in headed Electron, waits with the dialog visible, and exits only
after you close the Electron window or quit the app. Use this for visual
inspection of the dialog instead of the normal `thread-branch-drift.spec.ts`,
which closes Electron automatically after assertions pass.
