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
neither channel contained PwrAgent, no PwrAgent submissions were found, and the
existing PwrDrvr tap contained only PwrSnap. No PwrAgent formula or official
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
artifact exists. Always pin tag-specific, versioned filenames; never use
`releases/latest/download` aliases or placeholder hashes in package metadata.
Homebrew uninstall preserves `~/.pwragent`, which contains profiles and state.

## Before every release, including prereleases

Run from this checkout with authenticated GitHub CLI and Node 22:

```bash
pnpm release:channels --audit
```

Record the checked time, GitHub Latest version, channel versions, source URLs,
and open submission URLs in the release handoff. Investigate channel versions
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
Needed candidates cache current and previous release assets by API asset identity
and digest, and recheck sizes, published checksums and API digests on every use.
Platform jobs reuse successful validation only for the same candidate, upgrade
baseline, runner architecture and validation code. PRs and manual dispatches always run platform checks. PRs cannot save shared
validation results. Missing API digests disable reuse.
Failed validation never saves a success marker; submission retries remain enabled.
Signature, notarization and install/upgrade checks still run for new candidates.
Homebrew installs use the verified DMGs in its URL-keyed cache. WinGet may still
download installers during its local-manifest install/upgrade tests; those checks
are retained, but repeated successful candidates skip them. Cache eviction can
also cause a necessary download or validation to run again.

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
in that run verifies authenticated reads. The submission job passes the read token
separately to GET requests; only its write operations use `DISTRIBUTION_TOKEN`.

During every release preflight, confirm the read PAT's expiration date with its
organization owner (Actions secret metadata does not expose that date). Arrange
rotation before expiry: the owner replaces the organization secret through GitHub's
secret settings and preserves the selected PwrAgent/PwrGit/PwrSnap access and
public-read-only scope. Rerun the audit after rotation. If it expires or is revoked,
report the failed run and ask the owner to rotate it; do not broaden permissions,
copy a signing/submission credential, or infer package absence from an auth failure.

User authentication still has GitHub code-search and secondary rate limits.
The GET helper permits at most three attempts with a total wait budget of three
minutes, respects `Retry-After` and primary reset headers, and stops if a requested
delay exceeds the budget. Only optional HTTP 404 means absence. Throttling,
`incomplete_results`, malformed search responses and results beyond the requested
100-item page fail the audit. Retry later or narrow the search and record the
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
   recorded manual baseline; the workflow refuses to invent one. A preceding
   release outside its 100-release window also requires manual selection.
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
