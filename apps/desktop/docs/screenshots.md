# Capturing Screenshots

Moved from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps a summary and
says when to read this document. Relative links were updated for this location.

## Capturing README Screenshots

> The top-level README now uses WebP captures,
> `docs/assets/screenshots/*.webp` (hero, Star Map, backends, review,
> terminal), taken from the built app at 1440×900 on a Retina display with
> invented showcase data. They are ordinary Git blobs, not LFS: GitHub's
> README renderer cannot resolve LFS pointers. The older PNG and GIF captures
> were removed from `docs/assets/screenshots/`; the spec below still exists
> for reference and ad-hoc capture.

The PNGs and animated GIF under `docs/assets/screenshots/` are produced by an inspect-style Playwright
spec that drives five known UI surfaces and shells out to Swift for
native macOS window capture (with stoplights, drop shadow, and retina
resolution — Playwright's `Page.screenshot()` only grabs the renderer
DOM, which loses the OS chrome).

Re-capture all five with:

```bash
pnpm --filter @pwragent/desktop screenshot:readme
```

For the **docs-site** screenshots (the `docs.pwragent.ai` site —
Settings → Applications / Worktrees / Models panels, Settings →
Messaging panels for each of the six platforms, and a Recents lens
hero), the docs themselves live in a separate repo at
[pwrdrvr/docs.pwragent.ai](https://github.com/pwrdrvr/docs.pwragent.ai)
but the capture pipeline still lives here. The command is:

```bash
pnpm --filter @pwragent/desktop screenshot:docs-site
```

It runs the same `capture-window.swift` pipeline as the README
screenshots and uses `PWRAGENT_DOCS_SITE_SCREENSHOT_CAPTURE=1` as
its gate. PNGs are written into the **sibling docs.pwragent.ai
checkout**'s `assets/screenshots/` directory — by default
`~/github/docs.pwragent.ai/assets/screenshots/`, overridable via
the `PWRAGENT_DOCS_SITE_REPO` environment variable when your
checkout lives somewhere else. After the run, `cd` into that
checkout to review + commit the captured PNGs. See the docs repo
for its own SHOT_LIST tracking.

### Capturing under a non-default theme or density

Both screenshot pipelines honor two optional env vars that seed the
launched profile's `[general.appearance]` block before Electron boots:

- `PWRAGENT_SCREENSHOT_THEME` — `dark` (default), `light`, or `system`.
- `PWRAGENT_SCREENSHOT_DENSITY` — `mission-control` (default), `compact`, or `minimal`.

Defaults match the committed PNGs (dark + mission-control), so omitting
the variables leaves the existing pipeline pixel-stable. The pre-React
bootstrap (main → preload → inline script in `index.html`) applies the
matching `<html data-*>` attributes on the first paint, so no UI driving
is required to flip the theme — just set the env var:

```bash
PWRAGENT_SCREENSHOT_THEME=light \
  pnpm --filter @pwragent/desktop screenshot:readme
```

The wiring lives in
[`e2e/fixtures/screenshot-appearance.ts`](../e2e/fixtures/screenshot-appearance.ts)
and is consumed by both inspect specs. The capability is intentionally
scoped to the screenshot pipelines — production E2E keeps its dark
default unconditionally so color-assertion tests stay deterministic on
every CI runner.

We do not currently regenerate the committed PNGs under light theme or
ship them in the docs site. That's tracked separately under issue #508
(theming v1 polish follow-up to #472).

The script builds the desktop app, launches it headed against curated
replay fixtures + state-seeded sqlite rows, takes the screenshots,
then runs the **noise filter** (`filter-noise-screenshots.mjs`) to
revert any PNG whose pixels are identical to the committed version
— the `screencapture` encoder produces nondeterministic byte streams
for deterministic input pixels, and PNGs don't delta-compress in
git's pack format, so committing re-encode noise adds ~900 KB per
file per regen for zero visual benefit. macOS Screen Recording
permission is required for whichever terminal/IDE runs the spec —
the first invocation triggers the system prompt; subsequent runs
are silent.

**Captures must come off a Retina (2x) display**, and the specs place
the window on one for you. `screencapture -l` renders at the backing
scale of whichever display the window occupies and offers no flag to
request 2x, so a run with the window on a 1x external monitor silently
produces half-resolution PNGs. The noise filter does not catch this —
half-res pixels *are* different pixels, so it keeps them. On
2026-09-01 a run in exactly that state overwrote all 21 committed
docs-site PNGs at half resolution, and 8 also caught a stray toast.

Two layers now prevent it:

* `e2e/fixtures/capture-window-placement.ts` centers the window on a
  Retina display before every capture. It probes the displays once, on
  the first `bringToFront` of the run, and trusts that probe for the rest
  of the run. Only 2x displays are eligible —
  a 1x panel cannot produce the asset at all — and among those it
  prefers one the window actually fits on, then the built-in panel (the
  usual laptop-docked-to-a-1x-monitor case), then the sharpest. It never
  resizes (the committed PNGs depend on the window size the spec sets),
  warns if no 2x display is attached, and throws if the window a capture
  targets cannot be found rather than silently capturing an unplaced
  one. Its selection rule is pure and unit-tested in
  `src/main/__tests__/capture-window-placement.test.ts`; the `evaluate`
  callbacks only read and write Electron state, because anything inside
  one is unreachable from Vitest. That test lives under `src/main/`
  rather than beside the fixture because `e2e/` is Playwright's
  `testDir` and its default `testMatch` claims `*.test.ts` — the same
  reason `sub-agent-state-seeding.test.ts` sits there.
* `scripts/capture-window.swift` stages each capture in a temp file,
  checks the observed scale, and exits 6 **without touching the
  destination** when it lands below ~1.5x — or when the staged file
  cannot be decoded to check at all. The check fails closed on purpose.
  The replace itself goes through `replaceItemAt`, so a failure cannot
  leave the destination missing. Pass `--allow-low-dpi` only if you
  genuinely want a 1x asset; both specs forward it when
  `PWRAGENT_SCREENSHOT_ALLOW_LOW_DPI=1`. If the probe found a Retina
  display, `captureWhileFocused` treats a 1x refusal like an inactive-window
  refusal. It raises the window, which places it back on the Retina
  display, and captures again. If the probe found none, the refusal fails
  the capture immediately, because every retry would land on the same 1x
  display.

Both specs pass `--pid=<Electron main pid>` to `capture-window.swift`
through `captureOwnerPidArg`. The script's owner match is the name
"Electron", and every unpackaged Electron app has that name. One run
captured a different Electron dev app that was frontmost at the time,
and wrote its window out as `settings-messaging-line.png`. The
inactive-window check passed as well, because it checked the app that
had been captured, and that app was active. Pass the PID on any new
capture.

Capturing off-screen is fine: `screencapture -l` pulls the window's
full composited image from the window server, so the shadow is never
clipped by a screen edge — verified against a probe window positioned
past the display edge, whose off-screen rows came back at full opacity.
What an oversized window loses is the centering, not the pixels.

Notices are suppressed during capture: unpackaged E2E launches do not
arm the vendor Grok CLI update check (`grokUpdateChecksDisabled` in
`main/acp/grok-cli-update.ts`), because its notice is durable and
would otherwise paint "Grok update available" over whatever the
capture happens to catch. `auto-updater.ts` gates PwrAgent's own
update check on the same predicate.

Hover is suppressed too, for the same reason. Placement slides the
window out from under the OS cursor, which does not move with it, so
whatever lands at the cursor's screen position picks up `:hover` — and
which element that is depends on how far the window moved. A Settings
→ Profiles capture came back with two nav items highlighted this way:
the spec clicked "Profiles" at x=2056, placement moved the window to
x=28, and the stationary cursor came to rest on "General", whose
`:hover` rule paints the same box as `.is-active`. `bringToFront`
therefore parks the pointer at (-10, -10) via `sendInputEvent` after
placing the window. No capture drives hover deliberately; if one ever
needs to, it has to set the hover after `bringToFront`, not before.

Scroll position is the third trap. Chromium snaps a scroll offset to the
device pixels of the display the window is on when the scroll lands, and
moving the window afterwards does not re-snap it. Settings → Messaging →
Slack opens with a smooth scroll to its Connect section, which came to
rest at `scrollTop` 171 when macOS opened the window on a 1x monitor and
at 170.5 when it opened on the Retina panel. The two captures differed
by one device pixel across the whole content pane, so the noise filter
kept both. The docs-site spec therefore calls `bringToFront` once right
after launch, before any navigation, as well as before each capture.
`waitForSettingsScrollToSettle` then holds a Settings capture until the
scroll pane has kept one `scrollTop` for 10 rendered frames, instead of
trusting a fixed delay to outlast the ~250ms smooth scroll.

Content that changes on its own is the fourth trap. None of it is a
rendering difference, so the noise filter keeps every variant. The
docs-site spec pins each source it has met:

* **Motion.** `launchDocsSiteApp` emulates `prefers-reduced-motion`,
  which parks the thinking scanner on its reduced-motion pose instead of
  mid-sweep. It also hides the text caret, which blinks on Chromium's own
  timer.
* **Wall-clock time.** Captures that print a time launch with `TZ=UTC`.
  `pinWallClock` pins `Date.now` in main and the renderer before a turn
  stamps its rows, the way `visual-regression.spec.ts` does. Main stamps
  a profile's `last_used` before the spec can reach it, so
  `pinProfileLastUsed` rewrites `profiles.toml` after launch instead.
* **Measured durations.** The thread context panel's "Initial load" row
  reports how long the first read took, 0 or 1 ms against a replay.
  `pinInitialLoad` sets it to a fixed value before the capture.
* **Temp paths.** Settings → Worktrees prints a path under the home
  root, so that capture launches on a fixed home root instead of an
  `mkdtemp` one.
* **Random tokens.** A pairing token exists only in the Generate
  response; sqlite keeps its HMAC. `pinPairingToken` swaps the displayed
  token for a fixed one of the same length.
* **Host discovery.** Settings → AI Providers reads main's cached
  provider catalog once, as the pane mounts. The spec waits for the
  startup provider refresh to settle before opening it. The rows still
  show whichever CLIs the capturing Mac has installed.

What's left is GPU raster noise, which the spec doesn't pin. Any
capture can come out with a few anti-aliased pixels, on rounded corners,
icon strokes or glyph edges, a few levels off from the last run. Pairing
frame 1's segment corners do it about one run in four. Rarely, one glyph
comes out corrupt. `--disable-gpu-rasterization` isn't a fix. It moved
the variance into other pixels and across batches of runs. Look at a
diff that small before chasing it, and re-capture a corrupt glyph.

Before adding a capture, check it for anything else in that list: dates,
durations, generated IDs, temp paths, spinners, or discovery results.
Then run the spec twice and compare decoded pixels, not PNG bytes.

Pieces, all under `apps/desktop/`:

| File | What it does |
|---|---|
| `e2e/readme-screenshots.inspect.spec.ts` | Five tests, one per surface. Gated behind `PWRAGENT_SCREENSHOT_CAPTURE=1`. |
| `e2e/docs-site-screenshots.inspect.spec.ts` | Tests producing PNGs for `docs.pwragent.ai` (Settings panels + per-provider Messaging panels + Recents hero + composer features + first-run onboarding wizard + live work rail). Gated behind `PWRAGENT_DOCS_SITE_SCREENSHOT_CAPTURE=1`. Output lands in the **sibling docs repo's** `assets/screenshots/` (default `~/github/docs.pwragent.ai/`, override with `PWRAGENT_DOCS_SITE_REPO`). |
| `e2e/fixtures/readme-recents-hero/replay.fixture.json` | Hand-crafted populated thread list for the hero shot. Edit by hand to retune. |
| `e2e/fixtures/readme-state-seeding.ts` | Direct sqlite/config seeders for messaging bindings, activity log entries, pairing tokens, and Telegram-enabled config. |
| `e2e/fixtures/capture-window-placement.ts` | Shared `bringToFront` for both capture specs. Resolves the target window once (optionally by title substring, case-insensitively, matching `capture-window.swift --title=`), centers it on a Retina display so `screencapture` renders at 2x, then raises it and makes it the active app (`app.focus({ steal: true })`), waiting until focus holds for 2s so an app that takes focus back does so before the capture, not during it. `captureWhileFocused` wraps each capture: when `capture-window.swift` refuses an inactive window (exit 7), or a 1x capture (exit 6) while the run has a Retina display, it raises the window and captures again, up to 3 tries. Displays are probed on the first `bringToFront` of a run only. Exports the pure selection rule (`pickCaptureDisplay`, `centeredIn`, `overflowsWorkArea`) and the focus waits (`waitForSteadyFocus`, `captureWhileFocused`) so they can be tested. |
| `e2e/fixtures/docs-site-state-seeding.ts` | All-providers-enabled `config.toml` seeder so the per-platform Settings → Messaging captures can scroll directly to each platform's section without driving the Enabled toggle in the UI. It also saves a Slack agent name (`PwrAgent - riley`), so the Slack capture shows Connect past its Name step instead of the suggestion built from the OS username of whoever runs it. |
| `scripts/capture-window.swift` | Resolves the Electron window's CGWindowID and runs `screencapture -l <wid>`. Stages to a temp file and refuses (exit 6) to overwrite the destination with a sub-Retina capture, or with one it cannot decode to verify. Replaces atomically via `replaceItemAt`. Also refuses (exit 7) when the window's app is not the active app before or after the capture, since an inactive window comes out with grey traffic lights and a smaller shadow. Optional `--title=<substring>` for multi-window apps, `--pid=<owner-pid>` to match only that process's windows, `--allow-low-dpi` to bypass the scale check; an unrecognized argument is an error (exit 2), not a silent no-op. |
| `scripts/filter-noise-screenshots.mjs` | Post-capture cleanup. Iterates modified PNGs in the current repo (default: under `docs/assets/screenshots/` only) or another repo (via `--root <path>`, used by `screenshot:docs-site` against the sibling docs repo). Decodes HEAD and working-tree to TIFF via `sips`, SHA-256 compares. Identical → `git restore --source=HEAD --worktree`. Visually different → kept for review. Net-new PNGs (untracked) are left alone. |
| `scripts/render-indicator-overlay.swift` | Paints a numbered step-indicator pill onto a single PNG via Core Graphics + Core Text. |
| `scripts/stitch-demo-gif.ts` | Reusable GIF stitcher. Annotates each frame via the indicator-overlay Swift helper, then encodes via two-pass ffmpeg `palettegen`/`paletteuse`. CLI: `--output`, `--frame-duration-ms`, `--no-indicator`, `--indicator-position top|bottom`. |

To produce a new multi-frame demo GIF outside the README spec:

```bash
pnpm --filter @pwragent/desktop exec tsx \
  apps/desktop/scripts/stitch-demo-gif.ts \
  --output docs/assets/screenshots/screenshot-some-demo.gif \
  --frame-duration-ms 1500 \
  docs/assets/screenshots/some-demo-frame-1.png \
  docs/assets/screenshots/some-demo-frame-2.png \
  docs/assets/screenshots/some-demo-frame-3.png
```

Works for 2+ frames; the indicator scales horizontally with frame
count.
