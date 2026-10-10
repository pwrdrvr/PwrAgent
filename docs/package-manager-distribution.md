# Package-manager distribution

Homebrew publication is owned by `pwrdrvr/homebrew-tap`. Winget validation and
submission remain in PwrAgent. Both follow the suffix-free, explicitly promoted
GitHub Stable Latest release; prereleases do not publish either channel.

## Automatic Homebrew publication

The tap's `bump-pwragent.yml` calls its shared `sync.yml`, checks Latest every
15 minutes, and commits the validated cask directly to tap `main`. Routine
releases need no Homebrew PR or merge. PwrAgent's `homebrew.yml` synchronizes on
stable release events, manual dispatch, and a reconciliation schedule.

An optional `HOMEBREW_TAP_DISPATCH_TOKEN` enables immediate dispatch: a
fine-grained PAT scoped to `pwrdrvr/homebrew-tap` with Actions write permission.
Without it, synchronization waits for the tap schedule for up to 35 minutes.
The tap uses its own `GITHUB_TOKEN` for publication. Homebrew does not need
`DISTRIBUTION_TOKEN`, a Winget fork, CLA acceptance, or Microsoft review.

The cask selects arm64 on Apple Silicon and universal on Intel, derives minimum
macOS from the tagged release configuration, and preserves `~/.pwragent` on
uninstall. Tap validation uses isolated Intel/Apple Silicon runners for fresh
installation, upgrade from the published version, app identity/version/minimum
OS, architectures, Developer ID, Gatekeeper, stapled notarization, and uninstall.

## CI artifacts and download statistics

CI acquires signed installers and checksum manifests from **Actions build
artifacts**, never published release-download URLs. The shared Python resolver
requires a successful `release.yml` run for the exact stable tag commit and
rejects PRs, forks, preview workflows, failed runs and expired artifacts. Every
member must match the release metadata's SHA-256 and size. ZIP member ambiguity,
unsafe paths, corrupt bytes and moved tags fail explicitly. An assembled release
artifact can supply older Windows bytes when its platform artifact has expired.

Signed platform/assembled artifacts retain for 90 days. Exact byte caches are
independent of validator code, architecture, or current/previous role; restores
are verified again. Missing/expired original artifacts stop validation. Restore
the original build artifact instead of fetching release assets or rebuilding
published installers. Artifact archive acquisition is reused within a job.

Homebrew's actual URL-keyed cache is seeded from verified DMGs. Its CI curl
guard blocks PwrDrvr release-asset URLs/API downloads. The online audit excludes
only `url_https_availability`, which would probe the binary URL; URL identity and
availability of the published asset are checked through release metadata.
Remaining audits, package checksum verification and native checks still run.
WinGet's install-only manifests use loopback URLs serving verified EXEs; submitted
manifests retain production GitHub URLs, hashes, scopes and installer switches.

Already published tap versions make no installer requests, even after cache
expiry or validator changes. Identical successful unpublished validations reuse
trusted success records; changed inputs require fresh coverage using artifact
bytes. Missing caches never authorize release-download fallback.

## Winget validation and submission

`package-manager-distribution.yml` is scoped to Winget. Preparation audits public
sources, resolves Stable Latest and the previous stable upgrade baseline,
generates manifests and selects native Windows checks. It does not open Homebrew
PRs. Windows coverage validates schema, SHA-256, Authenticode publisher,
unattended user/machine installs, installed executable/version/signature,
previous-stable upgrade and uninstall. Native success is keyed by immutable
assets, generated files, validator code, runner image, architecture and resolved
WinGet client. PR/other-branch success cannot authorize trusted submission.

Configure `WINGET_FORK_REPO` to the existing publisher-owned
`pwrdrvr/winget-pkgs` fork, and `DISTRIBUTION_TOKEN` to a dedicated identity that
can write that fork and open upstream Microsoft PRs. Missing submission
credentials report a named blocker after validation; they do not block Homebrew.
No automatic fork creation, CLA acceptance or upstream merge is performed.
Submission recognizes already published/pending versions and avoids duplicates.

`DISTRIBUTION_READ_TOKEN || github.token` supplies public reads only. Never
print, retrieve or copy secret values. Inspect secret metadata to check selected
repositories, and have the owner verify expiration/rotation. Authentication,
throttling and incomplete search results are blockers, not evidence of package
absence. Existing read-token retry budgets remain unchanged.

## Stable promotion and verification

1. Promote the authorized stable release; keep product publication separate from
   package-manager repair. Events emitted by `GITHUB_TOKEN` may not start another
   workflow, so explicitly dispatch `homebrew.yml` if immediate follow-up is
   needed. The tap schedule independently reconciles missed events.
2. Require the tap's successful native validation and publication run. It
   rechecks Stable Latest, release asset identity, tag commit and the previous
   cask blob before writing, then verifies tap main. Publication failures create
   one tracking issue per outage with the failed run.
3. Refresh a clean Homebrew client with `brew update`, then inspect
   `brew info --cask pwrdrvr/tap/pwragent`. Repository publication and refreshed
   client discovery are separate checks. Install/upgrade smoke tests belong on
   isolated clients; never replace an operator's running app or remove profiles.
4. For Winget, inspect the validation/submission run and existing upstream PR.
   Resolve account-owned CLA/draft readiness and Microsoft review/indexing
   blockers, then use `winget source update --name winget` and
   `winget show --id PwrDrvr.PwrAgent --exact --source winget`.

Manual generation with `pnpm release:channels --out .local/distribution/current
--previous-out .local/distribution/previous --tag v<version>` uses the same
artifact-only acquisition. Never report a channel live solely because a PR
opened or a read-only audit passed.

## Official references

- [Homebrew tap maintenance](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap),
  [Cask Cookbook](https://docs.brew.sh/Cask-Cookbook), and
  [tap trust](https://docs.brew.sh/Tap-Trust).
- [WinGet manifest authoring](https://learn.microsoft.com/en-us/windows/package-manager/package/manifest)
  and [submission requirements](https://learn.microsoft.com/en-us/windows/package-manager/package/repository).
- [GitHub artifact retention](https://docs.github.com/en/actions/tutorials/store-and-share-data)
  and [workflow triggering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
