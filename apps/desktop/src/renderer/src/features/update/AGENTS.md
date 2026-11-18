# features/update

- `AppUpdateBanner` subscribes to both the status channel and the check-result
  channel; do not collapse them. Only a menu check raises the live card, and a
  background download raises nothing.
- `available` on the result channel is not an outcome: the status channel
  carries the download to its end, and `settle()` stays reachable from both.
- The in-flight card (track, meter, Cancel) stays outside the notice stack with
  no countdown; only the settled outcome goes through `showNotice`.
- The dismissing button is last in the action row (Cancel, or Restart then
  Dismiss). That slot is a safety rule.
- `auto-updater.ts` registers `activeDownload` before `checkForUpdates()`. A
  cancel is `canceled`, never `error`, discriminated by `activeDownload.canceled`.
- Any surface that renders a version renders a `ReleaseNotesLink` button whose
  URL comes from `releaseNotesUrl`, never composed at the call site.
- The dev fake is opt-in behind `PWRAGENT_DEV_FAKE_UPDATE=1`.

Before changing the update banner, updater status flow, release-notes links, or
the dev fake, read
[app-update-banner.md](../../../../../docs/app-update-banner.md).
