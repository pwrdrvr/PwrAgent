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

## Authoritative remote audit

The package identities are `pwrdrvr/tap/pwragent` at
`pwrdrvr/homebrew-tap/Casks/pwragent.rb` and `PwrDrvr.PwrAgent` at
`microsoft/winget-pkgs/manifests/p/PwrDrvr/PwrAgent`.

The same helper powers the read-only
[distribution audit workflow](../.github/workflows/distribution-audit.yml), which
runs on relevant PRs, published/edited releases, daily and on demand. It needs
neither installed package clients nor submission credentials. It preserves JSON
and a job summary on success or an actionable blocker on failure. A complete
audit means source discovery completed; it does not mean both channels are live.

Record the checked time, GitHub Latest and highest promoted stable versions,
channel comparisons, authoritative source URLs, architecture-specific artifact
URLs/hashes, and open/closed submission URLs in the release handoff. The helper
checks public repository visibility/default branches, searches the tap, Winget,
official Homebrew casks and formulae by product name and homepage, and compares known source metadata with
available GitHub asset digests. If a source layout changes, investigate it rather
than guessing a URL, hash, architecture or identity. Byte verification uses build artifacts in the existing generation/platform jobs. Investigate channel versions
ahead of GitHub Latest, stale versions, failed validation, and unresolved PRs
before planning an update. API/authentication/rate-limit failures are errors,
not evidence that a package is missing. Compare versions numerically.

macOS uses arm64 on Apple Silicon and universal on Intel; derive the minimum OS
from the tagged configuration. Windows currently ships **x64 only**, with NSIS `/currentuser`
and `/allusers` installations. Do not declare Windows ARM64 until that signed
artifact exists. The exact artifact URL templates are:

```text
https://github.com/pwrdrvr/PwrAgent/releases/download/v<version>/PwrAgent-<version>-arm64.dmg
https://github.com/pwrdrvr/PwrAgent/releases/download/v<version>/PwrAgent-<version>-universal.dmg
https://github.com/pwrdrvr/PwrAgent/releases/download/v<version>/PwrAgent-<version>-windows-x64-setup.exe
https://github.com/pwrdrvr/PwrAgent/releases/download/v<version>/PwrAgent-macos-SHA256SUMS
https://github.com/pwrdrvr/PwrAgent/releases/download/v<version>/PwrAgent-windows-SHA256SUMS
```

Always pin tag-specific filenames. The read-only audit makes no installer requests;
generation verifies the matching publisher checksums and GitHub digests using
Actions build artifacts.

## Read credential verification and rotation

Verify read-token access using only organization secret metadata and its selected
repository list; never retrieve, print or copy its value. The prepare log reports
only whether the organization read token is available. A successful remote audit
in that run verifies authenticated reads. For a non-publishing runtime check:

```bash
gh api orgs/pwrdrvr/actions/secrets/DISTRIBUTION_READ_TOKEN \
  --jq '{name, visibility, updated_at, selected_repositories_url}'
gh api orgs/pwrdrvr/actions/secrets/DISTRIBUTION_READ_TOKEN/repositories \
  --jq '.repositories[].full_name'
gh workflow run distribution-audit.yml --repo pwrdrvr/PwrAgent --ref <audit-branch>
gh run list --repo pwrdrvr/PwrAgent --workflow distribution-audit.yml --limit 5
gh run view <run-id> --repo pwrdrvr/PwrAgent --log
```

Only inspect secret metadata; the log should name the organization credential
source/availability and report completed public reads, with its value withheld.
If metadata access is forbidden, Harold must verify the selected-repository list.
A fork PR using the fallback proves fallback reads, not organization-secret sharing.
Do not dispatch `release.yml` or the install/submission workflow just to check the
read credential. The submission job passes the read token
separately to GET requests; only its write operations use `DISTRIBUTION_TOKEN`.

During every release preflight, confirm the read PAT's expiration date with its
organization maintainer Harold (`huntharo`); Actions secret metadata does not
expose that date. Harold owns an access-controlled expiry inventory containing
the credential name, expiry date, renewal owner, selected repositories, last
rotation date and last successful audit URL, with no credential values. Arrange
renewal/rotation before expiry: the owner replaces the organization secret through GitHub's
secret settings and preserves the selected PwrAgent/PwrGit/PwrSnap access and
public-read-only scope. Rerun the audit after rotation. If it expires or is revoked,
report the failed run and ask the owner to rotate it; do not broaden permissions,
copy a signing/submission credential, or infer package absence from an auth failure.

User authentication still has GitHub code-search and secondary rate limits.
The GET helper permits at most three attempts with a total wait budget of three
minutes, respects `Retry-After` and primary reset headers, and stops if a requested
delay exceeds the budget. Only optional HTTP 404 means absence. Throttling,
`incomplete_results`, malformed search responses and results beyond GitHub's 1,000-result search ceiling fail the audit. Search
pagination reads all pages (100 items each), requires `incomplete_results=false`
on every page, and rejects duplicate items or totals that change mid-query.
Release-history pagination reads up to 2,000 releases; exceeding that bounded
window is a blocker rather than an invented upgrade baseline. Retry later or narrow the search and record the
failure as a blocker; do not register a duplicate based on a partial result.
See GitHub's [rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
and [search response guidance](https://docs.github.com/en/rest/search/search).

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

## Required follow-up after every GitHub publication

Run the read-only audit again after assets and release notes are published,
including alpha/beta and unpromoted suffix-free releases. `release.yml` calls the
same audit after its notes job; an edited/published event also catches manual
promotion. Stable package comparisons still target GitHub Latest, never a beta
or an unpromoted candidate. Compare the reported highest promoted stable with
Latest and explain any difference; do not silently repoint Latest.

A failed post-publication audit leaves the GitHub release published. Harold owns
the retry and must link the failed run and action needed. A successful read-only
audit cannot close install/upgrade or source/client follow-up work.

Harold (`huntharo`) owns read-token rotation, failed-audit follow-up and Winget
submission credentials/CLA readiness. Tap maintainers own Homebrew publication;
Microsoft reviewers own upstream acceptance and indexing. Carry each blocker
with its checked time, source/submission/run link and concrete next action.

## Verify source and client publication

Fetch the authoritative remote files and compare their version, installer URLs,
architecture, scope and SHA-256 with the signed release. Then use clean clients:

```bash
brew update
brew info --cask --json=v2 pwrdrvr/tap/pwragent
brew install --cask pwrdrvr/tap/pwragent
brew upgrade --cask --greedy pwrdrvr/tap/pwragent
```

```powershell
winget source update --name winget
winget show --id PwrDrvr.PwrAgent --exact --source winget
winget install --id PwrDrvr.PwrAgent --exact --source winget --scope user
winget upgrade --id PwrDrvr.PwrAgent --exact --source winget
```

Verify the installed app version and publisher signature, plus an upgrade from
the former channel version. Test Windows machine scope as well. If Homebrew
requires tap trust, trust only `pwrdrvr/tap/pwragent`. Use isolated clients/app
directories; never replace an operator's running app or delete profiles for a
smoke test. Record runner/OS/architecture, old/new versions and results.

Only call a channel live when its authoritative branch and refreshed client
both resolve the promoted version. A merge with an old/absent client result
is **pending cache/index propagation**: retain the PR link, check time and next
refresh command. Every release handoff includes both channel outcomes; a
blocked channel is carried forward explicitly even if the product release
itself is published. Never cut an unrelated product release to repair setup.

## Official references

- [Homebrew tap maintenance](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap),
  [Cask Cookbook](https://docs.brew.sh/Cask-Cookbook), and
  [tap trust](https://docs.brew.sh/Tap-Trust).
- [WinGet manifest authoring](https://learn.microsoft.com/en-us/windows/package-manager/package/manifest)
  and [submission requirements](https://learn.microsoft.com/en-us/windows/package-manager/package/repository).
- [GitHub artifact retention](https://docs.github.com/en/actions/tutorials/store-and-share-data)
  and [workflow triggering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
