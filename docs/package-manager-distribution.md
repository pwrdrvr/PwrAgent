# Package manager distribution

This is the contributor procedure for distributing the desktop app. Operator
installation documentation belongs in `pwrdrvr/docs.pwragent.ai`. GitHub Releases
in [pwrdrvr/PwrAgent](https://github.com/pwrdrvr/PwrAgent/releases) remain the
binary source; package repositories contain metadata, not rebuilt binaries.

## Sources and ownership

| Channel | Identifier | Authoritative package source | Ownership |
| --- | --- | --- | --- |
| Homebrew cask | `pwrdrvr/tap/pwragent` | [pwrdrvr/homebrew-tap, Casks/pwragent.rb](https://github.com/pwrdrvr/homebrew-tap/blob/main/Casks/pwragent.rb) | PwrDrvr owns the tap; changes land through tap PRs |
| Winget | `PwrDrvr.PwrAgent` | [microsoft/winget-pkgs, manifests/p/PwrDrvr/PwrAgent](https://github.com/microsoft/winget-pkgs/tree/master/manifests/p/PwrDrvr/PwrAgent) | Microsoft reviews/indexes community submissions; PwrDrvr maintains its manifest submissions |

The identifiers above are the registration targets until their initial PRs
merge. A fork or an open PR is not publication. On the initial audit (2026-10-02),
neither channel contained PwrAgent and the existing PwrDrvr tap contained only
PwrSnap. Initial submissions were opened afterward. No PwrAgent formula or official
Homebrew cask was found. Recheck live sources on every release; this snapshot
does not prove their current state.

Initial registration submissions:

- [Homebrew tap PR #9](https://github.com/pwrdrvr/homebrew-tap/pull/9): cask,
  documentation and CI for PwrAgent. Pending merge and refreshed-client
  verification. The tap's existing PwrSnap online-audit lane fails because its
  main-branch cask is 1.1.2 while PwrSnap Latest is 1.1.12; that channel's pending
  bump is separate work and must not be overwritten by this registration.
- [Winget PR #445659](https://github.com/microsoft/winget-pkgs/pull/445659):
  `PwrDrvr.PwrAgent` 1.1.4. The Microsoft policy bot requires `huntharo` to accept
  the CLA. The account owner must review and respond to that bot; automation
  does not sign the agreement. The submission is draft while Windows validation
  is completed, then requires upstream validation/review and client indexing.
- [PwrAgent implementation PR #2473](https://github.com/pwrdrvr/PwrAgent/pull/2473):
  product-side generation, validation, submissions and required release checks.

The publisher fork `pwrdrvr/winget-pkgs` and repository variable
`WINGET_FORK_REPO=pwrdrvr/winget-pkgs` were created for this setup.
`DISTRIBUTION_TOKEN` is still absent. An authorized operator must provision
the dedicated credential below before automatic submissions can run. Neither
channel was live at the initial submission; retain these pending links in the
release handoff until publication is verified.

The audited promoted stable release was `v1.1.4` (2026-09-30). Its downloaded
bytes matched both GitHub asset digests and the publisher's platform SHA256SUMS:

| Released artifact | SHA-256 |
| --- | --- |
| `PwrAgent-1.1.4-arm64.dmg` | `f128bd02c2896864543593c3893b383e806cc1c74bcdfe05a9e3102a03bfdc92` |
| `PwrAgent-1.1.4-universal.dmg` | `22c461520afe4775683deedabe45146ac8691767b202196a5cb931e427e273ab` |
| `PwrAgent-1.1.4-windows-x64-setup.exe` | `3ef2d8aaa5dd68cedbe02a80687994d63774b5cf0852024846aa1a5908837598` |

macOS uses arm64 on Apple Silicon and universal on Intel, with macOS 12 as the
bundle's minimum. Windows currently ships **x64 only**, with NSIS `/currentuser`
and `/allusers` installations. Do not declare Windows ARM64 until that signed
artifact exists. The exact artifact URL templates are:

```text
https://github.com/pwrdrvr/PwrAgent/releases/download/v<version>/PwrAgent-<version>-arm64.dmg
https://github.com/pwrdrvr/PwrAgent/releases/download/v<version>/PwrAgent-<version>-universal.dmg
https://github.com/pwrdrvr/PwrAgent/releases/download/v<version>/PwrAgent-<version>-windows-x64-setup.exe
https://github.com/pwrdrvr/PwrAgent/releases/download/v<version>/PwrAgent-macos-SHA256SUMS
https://github.com/pwrdrvr/PwrAgent/releases/download/v<version>/PwrAgent-windows-SHA256SUMS
```

Use `pnpm release:channels --out ...` below to download bytes and compare SHA-256
against the matching publisher checksum file and available GitHub asset digest.
The audit alone checks source metadata; it does not download installers.
Always pin tag-specific, versioned filenames; never use
`releases/latest/download` aliases or placeholder hashes in package metadata.
Homebrew uninstall preserves `~/.pwragent`, which contains profiles and state.

## Before every release, including prereleases

Run from this checkout with authenticated GitHub CLI and Node 22:

```bash
pnpm release:channels --audit
```

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
than guessing a URL, hash, architecture or identity. Downloaded-byte verification
remains in the existing generation/platform jobs. Investigate channel versions
ahead of GitHub Latest, stale versions, failed validation, and unresolved PRs
before planning an update. API/authentication/rate-limit failures are errors,
not evidence that a package is missing. Compare versions numerically.

Before initial registration or a source migration, also search code and open
and closed PRs for **PwrAgent**, its homepage and publisher in Winget, official
Homebrew casks/formulae, and the PwrDrvr tap. Inspect any discovered identifiers,
owners and installer URLs. Reuse an existing entry rather than registering a
second spelling. The audit rejects an official Homebrew entry so an operator
can reconcile a move out of the tap. Do not automatically migrate ownership.

Alpha, beta and unpromoted stable candidates leave both stable channels alone.
Still report the comparison and carry pending submissions into their handoff.

## Automation setup

[package-manager-distribution.yml](../.github/workflows/package-manager-distribution.yml)
runs on stable release publication/edit (including promotion), daily, and on
demand. PRs affecting the scripts or workflow run validation without submission.
The workflow reads current release automation for promotion of older tags,
pins that checkout for submission, and serializes channel updates.
Idle daily audits and channels with pending submissions read metadata only.
A Linux planner resolves immutable current/previous asset identities and generated
package inputs, then checks exact successful-validation keys before starting any
native runner or downloading installers. Repeated PR, manual and scheduled
candidates reuse validation; `force_validation=true` deliberately repeats it.
Publication retries remain separate from native validation: a stale channel with
no pending PR can retry submission using already validated inputs.

Validation keys include current/previous versions and asset digests, generated
casks/manifests, validator code, architecture, published hosted-image version,
the pinned stable Homebrew commit and the resolved stable WinGet client assets.
Image families follow the [published runner label mapping](https://github.com/actions/runner-images#available-images).
A runner validates normally during an image rollout, but records no reusable
success unless its actual `ImageVersion` matches the planned image. Changes to
these inputs require new coverage. A PR can reuse its own or trusted success;
validation-only manual branch dispatches can reuse their own success too. Trusted
submission accepts only main or the promoted stable tag's success, never PR or
other branch results. Failed checks
never create a success marker.

Installer caches use exact version/name/SHA256 keys independently of validator
code and current/previous role. Restores check API sizes and digests, then
published SHA256SUMS before sharing bytes. A corrupt restore fails closed:
remove that exact cache and retry; never bypass the checksum. Automation stops
with a named blocker if required API digests or platform metadata are missing.
Homebrew's actual URL-keyed cache is seeded from these verified DMGs. WinGet
validates untouched production manifests and uses installation-only copies with
loopback HTTP URLs for verified EXEs. Hashes, scopes and switches stay intact;
production GitHub URLs are never changed or submitted as loopback URLs.
Architecture, minimum OS, publisher signature, notarization, installed-version,
user/machine scope and upgrade assertions remain in place.

A cold full validation now fetches four DMGs and two EXEs once each, rather than
preparation plus native re-downloads (eight direct DMG and four direct EXE
requests previously), plus up to four Homebrew and four WinGet fetches before
client retries. This halves direct installer requests on a cold full validation. Warm byte caches need
zero PwrAgent installer downloads even after validator changes or forced checks.
An identical successful candidate needs zero native jobs, instead of two macOS
jobs and one Windows job. Idle daily audits already made zero installer requests;
the October 3/4 runs are examples, not evidence of daily installer inflation.
Cache eviction and new release bytes still require downloads. WinGet's own
client packages and public metadata audits are separate traffic. The loopback
install tests preserve package-manager behavior but do not test GitHub's CDN
transport on every run; cold byte acquisition verifies that transport separately.

Configure these in **pwrdrvr/PwrAgent**, without copying signing secrets:

- Organization Actions secret `DISTRIBUTION_READ_TOKEN`: Harold provisioned a
  dedicated fine-grained PAT restricted to public repositories with no additional
  permissions, shared with PwrAgent, PwrGit and PwrSnap. Public package-source
  audits, existing-identity/submission searches and release-metadata generation
  use `GH_TOKEN: ${{ secrets.DISTRIBUTION_READ_TOKEN || github.token }}`. Homebrew's
  online audit uses the same fallback as `HOMEBREW_GITHUB_API_TOKEN`. This selects
  user authentication for public reads; it does not grant repository write access
  or authorize submissions. Unrelated operations retain the default workflow token.
  Fork PR checks can use that fallback when organization secrets are unavailable.
- Repository variable `WINGET_FORK_REPO`: `pwrdrvr/winget-pkgs`, an existing
  publisher-owned fork of `microsoft/winget-pkgs`.
- Repository secret `DISTRIBUTION_TOKEN`: a credential authorized to read the
  package/source repositories, create branches/commits in `pwrdrvr/homebrew-tap`
  and the Winget fork, and open upstream Winget PRs. GitHub's repository
  `GITHUB_TOKEN` alone cannot write these other repositories. Confirm token type
  and organization policy support the public upstream PR operation; a
  repository-scoped fine-grained token may not cover that operation. Use a
  dedicated automation identity/credential, not an operator's token copied from
  their CLI login. The Microsoft CLA bot may require an account owner's action.

The automation does not provision credentials, sign a CLA, merge submissions,
promote product releases, or change existing pending PRs. Missing credentials
fail the submission job with validated inputs still downloadable. Review the
workflow's permissions and the credential's expiry during release preflight.

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

## After stable promotion

1. Find the package-manager workflow for the promoted tag. If promotion used
   `GITHUB_TOKEN`, its edit may not start another workflow; explicitly dispatch
   this workflow with `submit=true`. A daily run also reconciles missed events.
2. Review `package-manager-inputs` and the preflight summary. Generation requires
   the current suffix-free, non-draft, non-prerelease GitHub Latest release.
   It downloads the versioned artifacts, checks sizes, SHA256SUMS and available
   GitHub digests, and refuses automatic downgrades. A bad cache fails validation;
   remove that cached file and retry rather than accepting its bytes.
3. Require successful macOS arm64 and Intel jobs: cask style and online audit,
   both DMGs' architectures and minimum OS, Developer ID team `T44CNHC4UH`,
   signatures, Gatekeeper, stapled notarization, fresh installation and upgrade
   from the preceding stable release. The cask is `auto_updates true`, so use
   `brew upgrade --cask --greedy` when testing or reconciling managed upgrades.
4. Require the Windows job: `winget validate`, SHA-256 and valid PwrDrvr LLC
   Authenticode signatures, unattended user/machine installs, installed x64
   executable/version/signature, previous-stable upgrade, and uninstall.
   A first stable release without an upgrade baseline needs an explicitly
   recorded manual baseline; the workflow refuses to invent one. Exhausted release-history pagination also requires manual selection.
5. Review the submission job's PR URLs. Existing pending PRs are reported and
   reused as the next action; no duplicate is opened. A matching version on the
   authoritative branch is reported as `published-in-repository`, which still
   needs client/index verification. Do not equate this with an installed test.
6. Monitor each submission through validation and merge. Resolve upstream
   findings on that PR and rerun checks. Report CLA, security-scan, human-review,
   Homebrew cache and Winget indexing delays by name with the submission URL,
   observed state, check time and concrete next action. Do not give an invented
   completion estimate or silently stop at PR creation.

Manual generation uses the same validation inputs without submission:

```bash
pnpm release:channels --out .local/distribution/current \
  --previous-out .local/distribution/previous --tag v<version>
```

For an initial upstream PR, read that repository's current agent guidance,
contribution guide and PR template. Winget uses the multi-file 1.12 schema and
one package/version per PR. Run `winget validate --manifest <version-folder>`
and `winget install --manifest <version-folder>` in isolated Windows before
marking those checks complete. If the host cannot execute Winget, leave those
boxes unchecked and link the actual upstream or workflow validation.

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

| Current handoff item (recheck live) | Owner | Action / evidence required |
| --- | --- | --- |
| [Homebrew #9](https://github.com/pwrdrvr/homebrew-tap/pull/9) | Harold / PwrDrvr tap maintainers | Review PwrAgent checks and merge when approved; investigate the separate PwrSnap check failure in that tap without overwriting its work. Fetch main's cask, then refresh an isolated client. |
| [Winget #445659](https://github.com/microsoft/winget-pkgs/pull/445659) | `huntharo` for CLA and draft readiness; Microsoft reviewers for acceptance/indexing | Account owner handles the CLA bot; retain draft status until Windows evidence is complete. Follow upstream checks/review, accepted master manifest, then refreshed Winget source. |
| Missing `DISTRIBUTION_TOKEN` | Harold / organization maintainers | Provision a separate authorized submission identity if automatic writes are wanted. `DISTRIBUTION_READ_TOKEN` cannot fill this role. |
| Read PAT expiry/rotation | Harold / organization maintainers | Maintain the expiry inventory, rotate under the same name/scope/repository selection, rerun the read-only workflow and retain its successful URL. |

The 2026-10-03 remote audit found GitHub Latest/highest promoted stable `v1.1.4`,
no published PwrAgent entry at either authoritative package path, no alternate
identity in complete searches, and both initial submissions still open (Winget
draft). This is a checked snapshot, not a publication claim. Carry each item with
its last check time, submission/run URL, owner and next action into every handoff.
Once merged, review/index/cache delays remain open until source and client agree.

## Verify publication after merge

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
both resolve the submitted version. A merge with an old/absent client result
is **pending cache/index propagation**: retain the PR link, check time and next
refresh command. Every release handoff includes both channel outcomes; a
blocked channel is carried forward explicitly even if the product release
itself is published. Never cut an unrelated product release to repair setup.

## Official requirements

- [Microsoft manifest authoring](https://learn.microsoft.com/en-us/windows/package-manager/package/manifest)
  and [submission/validation](https://learn.microsoft.com/en-us/windows/package-manager/package/repository).
- [Winget repository contributor guide](https://github.com/microsoft/winget-pkgs/blob/master/CONTRIBUTING.md)
  and [current manifest schemas](https://github.com/microsoft/winget-cli/tree/master/schemas/JSON/manifests).
- [Homebrew tap maintenance](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap),
  [Cask Cookbook](https://docs.brew.sh/Cask-Cookbook),
  [acceptable casks](https://docs.brew.sh/Acceptable-Casks) and
  [tap trust](https://docs.brew.sh/Tap-Trust).

Recheck these when installer formats, Homebrew APIs, schemas or channel policy
change. Use the existing vendor tap for initial Homebrew registration; an
official-cask submission is a separate migration after checking acceptance
requirements and coordinating the existing token.
