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
