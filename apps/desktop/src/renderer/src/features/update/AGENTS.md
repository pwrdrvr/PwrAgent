# features/update — AGENTS.md

## Two channels, and they are not redundant

`AppUpdateBanner` subscribes to both `onAppUpdateStatus` and
`onAppUpdateCheckResult`, and collapsing them into one breaks the feature:

- **`app:update-status-event`** carries *what the updater is doing* —
  checking, available, downloading (with percent and bytes), downloaded,
  canceled, error. Every check moves it, including the hourly background ones.
- **`app:update-check-result-event`** is emitted from exactly one trigger —
  `checkForAppUpdatesNow("menu")`, i.e. Help → Check for Updates. It is the
  only thing that distinguishes "the operator is waiting for this answer" from
  "the hour hand looked again". Settings → General → Updates deliberately does
  not emit it: that surface reports its `manual` result inline beside the
  button, and a card repeating the answer next to it would say the same thing
  twice. Neither does the app-management agent tool, which answers the agent
  that called it.

So the live progress card is gated on having seen a `checking` tick on the
*result* channel, and is then driven by the *status* channel. A background
download must raise nothing: the operator did not ask, and the only thing
worth interrupting them for is the finished, actionable offer.

## `available` is the middle of the work here, not the end of it

This is where PwrAgent differs from PwrGit, which this feature was ported
from. PwrGit's menu check `await`s the whole `downloadPromise` and returns
`downloaded`. PwrAgent's `runAppUpdateCheck` returns as soon as
`autoUpdater.checkForUpdates()` resolves — at `available` — and lets the
updater's own `download-progress` / `update-downloaded` / `update-cancelled`
events carry the rest.

So `available` arriving on the *result* channel is not an outcome. The card
stays up and the status channel carries the download to its end;
`isUpdateCheckInProgress` is what both sides agree on. Treating it as an
outcome would take the card down for the entire download it just started,
which is the bug this feature exists to fix.

It also means the *status* channel is where a watched download finishes,
fails, or stops — `settle()` is reachable from both subscriptions for that
reason. Do not move the hand-off to the result channel alone.

## In-flight gets a progress track; finished gets the countdown

`AppNoticeToast` auto-dismisses a transient notice after 9s and paints
`.app-notice-toast__timer` draining toward it. That is right for a notice that
has finished talking and wrong for work still running — a real download is
minutes.

So: while a check the operator asked for is working, this component renders
its own card (progress track, byte meter, Cancel) outside the notice stack,
with no countdown. Only when the check settles does the outcome go to the
stack, through `showNotice`, where the countdown is correct. Don't move the
in-flight card into a notice.

## Cancel is offered from `available`, so main must be ready by then

`updateProgressCopy` turns Cancel on as soon as the status reaches
`available` — before any bytes have moved. `auto-updater.ts` therefore
registers its `activeDownload` before it calls `autoUpdater.checkForUpdates()`
(which emits `update-available` from inside itself), with an empty `cancel`
slot that electron-updater's token fills in once it exists, and honors a flag
that was already set (`applyPendingUpdateCancel`). Register it any later and
there is a window where the button is on screen and does nothing: the click
marks the renderer `canceling`, main finds no download, and the update
installs anyway.

## A cancel is not an error

`{ status: "canceled" }` is its own status on purpose. `available` would
promise a download that is no longer running, and `error` would put a failure
in front of someone who got exactly what they asked for. electron-updater
agrees: it deliberately does **not** dispatch its `error` event for a
cancellation, and emits `update-cancelled` instead.

The download promise's rejection is byte-identical to a network failure's, so
`auto-updater.ts` remembers that *it* asked (`activeDownload.canceled`) rather
than sniffing the error. Keep that flag the discriminator. That handler is
also the only thing observing `downloadPromise` at all — without it a cancel
would be an unhandled rejection in main.

## The dev fake is the only way to see any of this

Real auto-update runs in packaged production builds only, so
`simulateDevUpdateCheck` walks the whole machine — checking → available → a
ramp of download percents → downloaded — for a check the operator initiated.
It ramps rather than emitting one sample because a meter cannot be judged
against a single frozen percent, and it honors Cancel for the same reason.

Unlike PwrGit's, it is opt-in behind `PWRAGENT_DEV_FAKE_UPDATE=1` rather than
running in any unpackaged build. Settings → Updates is a real diagnostic
surface in `pnpm dev` (release matrix, channel/train selection) that a fake
v420.0.0 would sit on top of, and `checkForAppUpdatesNow("manual")` is
reachable from the app-management agent tool, which would otherwise report a
fabricated update to the user as fact. `PWRAGENT_DEV_FAKE_UPDATE_STEP_MS`
paces it so `e2e/update-check.spec.ts` can click a button that only exists
mid-download.

Because the opt-in is checked inside the `!productionUpdatesEnabled()` branch,
which comes *before* the Linux branch, the fake reaches every platform. That
is what lets one e2e spec cover this flow on the Linux lane, where a packaged
build answers `skipped` and offers no in-app download at all.

## A version this app names, it must also be able to describe

Every update surface prints a version number the operator has never seen and
could not look up from inside the app. Settings → About's **Open changelog**
reads the `CHANGELOG.md` that shipped *inside the running build*, so by
construction it says nothing about the build being offered — a v1.0.6 install
cannot carry v1.1.0's notes. Before this, the four-slot matrix, the
`Update ready: v1.1.0. Restart to install.` line, the banner's cards and the
settled-check notice all named a version with no way out to what is in it.

So: **any surface that renders a version renders a
[`ReleaseNotesLink`](./ReleaseNotesLink.tsx) beside it**, and the URL comes
from `releaseNotesUrl` in
[packages/shared/src/release-notes.ts](../../../../../../packages/shared/src/release-notes.ts)
— never composed at the call site.

| Surface | Control |
|---|---|
| Settings → General → Updates, all four slot tiles | `Release notes` under each tile |
| Settings → General → Updates, the status line and `Downloaded version:` | `Release notes` inline, scoped to the version that line names |
| Banner live card (`available` / `downloading`) | `Release notes` beside Cancel |
| Banner offer card (`downloaded`) | `Release notes` between Restart and Dismiss |
| Settled-check notice (`no-update` / `canceled`) | `Release notes` as a notice action |
| Settings → About, Build → Version | `Release notes` beside the version |
| Settings → About, Changelog | `Open release notes` beside `Open changelog` |

Five things about that are load-bearing:

- **The URL is DERIVED from the version, not read from the feed.**
  `AppUpdateReleaseInfo.url` carries GitHub's `html_url` for the four
  published slots, but the STATUS surfaces have no feed record at all —
  `AppUpdateStatus` carries a bare version through every transition,
  including the ones electron-updater raises, which never saw
  `readAppUpdateReleaseVersions`' GitHub read. One composer that takes a
  version is the only thing all seven surfaces can share. Deriving is exact
  because the release tag is `v` + the version, which `auto-updater.ts`
  already assumes when it strips that `v` off `tag_name`.
- **No URL means no control.** `releaseNotesUrl` answers `undefined` for
  anything that is not semver-shaped — the `"unknown"` an updater answer
  without `updateInfo` produces, the slot matrix's `Loading…` and
  `Unavailable` headlines — and `ReleaseNotesLink` renders `null` for it.
  A link onto a 404 is worse than none. What it deliberately does NOT catch
  is a semver-shaped version that was never tagged; catching that would mean
  asking GitHub per surface, which is the feed read the first point rejects.
- **It is a `<button>`, never an `<a href>`.** PwrAgent is not PwrSnap here:
  `applyWindowSecurityHardening` installs both a `will-navigate` block and a
  `setWindowOpenHandler`, so an anchor would be safe. The button is chosen
  for what it is — an action that hands a URL to the OS, which is what every
  other renderer-side external open in this app already does — and for not
  depending on that guard to be correct. Settings → About's two
  `<a target="_blank">` rows do; don't add more. Pinned by
  `ReleaseNotesLink.test.tsx`.
- **Settings → Updates hangs it OUTSIDE the tile.** The slot tile is a
  `role="radio"`, and an interactive element nested in one is neither valid
  HTML nor reachable by this matrix's roving tabindex — hence
  `.settings-release-slots__cell` wrapping the two. All four slots get a
  link, not just the selected one: picking a slot rewrites which build
  PwrAgent installs, so reading the notes has to be possible without picking.
- **The notice is the one surface that does not render the component.**
  `AppNoticeToastNotice.actions` owns its own button markup, so the outcome
  notice carries the link as an action and shares `openReleaseNotes` instead.
  Adding a second way to open a release page is what that export exists to
  prevent.

Two surfaces deliberately carry NO link: the `checking` card, which has no
version yet, and the `skipped` / `error` outcomes, which name none.

The renderer half and the main half are pinned separately, because they live
in different packages and could drift:
`apps/desktop/src/main/__tests__/window-external-open-release-notes.test.ts`
runs the **real** `applyWindowSecurityHardening` over composed URLs — with a
positive control, so the passing cases cannot pass against a guard that opens
anything — rather than re-stating its rule.
