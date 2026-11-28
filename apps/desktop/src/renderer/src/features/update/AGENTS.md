# features/update

- Keep `AppUpdateBanner`'s status and check-result channels separate. Only a
  menu check raises the live card. Background downloads stay silent.
- `available` is in progress. The status channel carries the download to
  completion. Keep `settle()` reachable from both channels.
- Keep the progress card outside the notice stack, without a countdown.
  Only settled outcomes use `showNotice`.
- End the action row with Cancel, or with Restart followed by Dismiss.
- In `auto-updater.ts`, register `activeDownload` before `checkForUpdates()`.
  Use `activeDownload.canceled` to report cancellations as `canceled`.
- Render each version with `ReleaseNotesLink` using `releaseNotesUrl`.
- Draw the live card's progress with the shared `ProgressStrip` and the
  byte meter with `formatDownloadMeter`; no second progress layout.
- Enable the dev fake only with `PWRAGENT_DEV_FAKE_UPDATE=1`.

Read [the update banner guide](../../../../../docs/app-update-banner.md) before
changing the banner, updater status, release-notes links, or dev fake.
