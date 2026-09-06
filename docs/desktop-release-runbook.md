# Desktop Release Runbook

> MIT-licensed desktop release pipeline.

This runbook covers cutting v1.x desktop releases. macOS releases ship as
universal Apple Silicon + Intel binaries; distribution is outside the Mac App
Store via signed/notarized DMG with auto-update through `electron-updater`
against GitHub Releases on `pwrdrvr/PwrAgent`. Linux releases ship as manual
Debian packages for x64/amd64 and arm64.

---

## One-time setup

These steps need to happen exactly once. They are tracked in the v1.0 release
packaging plan as Phase A.

1. **Apple Developer Program enrollment** for PwrDrvr LLC.
   - Already done. Team ID: **`T44CNHC4UH`**. Team Name: `PwrDrvr LLC`.
2. **Developer ID Application certificate**.
   - Generated in Apple Developer portal → Certificates.
   - Imported into the dev Mac's Keychain.
   - Verify with:
     ```bash
     security find-identity -v -p codesigning
     # expect exactly: "Developer ID Application: PwrDrvr LLC (T44CNHC4UH)"
     ```
   - Exported as a password-protected `.p12` and stored in 1Password.
3. **App Store Connect API key** for notarization.
   - Created in App Store Connect → Users and Access → Integrations → Keys
     with the **Developer** role (least privilege that can notarize).
   - Downloaded the `.p8` file (one-time).
   - Stored in 1Password alongside the Key ID and Issuer ID.
4. **GitHub `apple-signing` Environment**.
   - Create the `apple-signing` environment in `pwrdrvr/PwrAgent`.
   - Add required reviewers and limit approval to **`huntharo`**.
   - Limit the environment to protected release refs/tags when GitHub's
     environment controls allow it.
   - Store the Apple signing/notarization secrets on this environment, not as
     repository secrets:
     - `CSC_LINK` — `.p12` base64-encoded
     - `CSC_KEY_PASSWORD` — the `.p12` password
     - `APPLE_API_KEY_BASE64` — `.p8` base64-encoded
     - `APPLE_API_KEY_ID` — the Key ID
     - `APPLE_API_ISSUER` — the Issuer ID
   - Optional publish secret, also environment-scoped if used:
     `RELEASES_PAT` — fine-grained PAT scoped to `Contents: Read & Write` on
     `pwrdrvr/PwrAgent`. The workflow falls back to `GITHUB_TOKEN` if absent.
5. **GitHub repository secrets**.
   - Do **not** keep Apple signing/notarization material as repository secrets
     after the `apple-signing` environment secrets are configured.
   - Non-release CI secrets, such as live smoke-test service keys, may remain as
     repository secrets if their workflows require them.

`APPLE_TEAM_ID` is hardcoded in `.github/workflows/release.yml` to `T44CNHC4UH`
since it is not a secret.

---

## Release trains and maintenance branches

`main` carries the active next-version train. Long-lived maintenance branches
carry patch releases for prior major/minor trains and are named
`releases/<major>.<minor>`, for example `releases/1.0` or `releases/1.1`.
Do not include the patch component in the branch name.

Before `main` moves to a new major/minor train, leave behind, or ask whether to
leave behind, a maintenance branch for the previous train. For example, when
cutting the first `1.1.0-beta.1` or `1.1.0` release from a current `1.0.*`
`main`, verify that `origin/releases/1.0` exists. If it does not, create it from
the current `1.0` release tag before committing the `1.1` version bump.

Patch releases land only on their train branch:

```bash
# v1.0.1 and v1.0.2 land on releases/1.0.
git switch releases/1.0
```

New major/minor releases land on `main`:

```bash
# v1.1.0-beta.1, v1.1.0, and v1.2.0-beta.1 land on main.
git switch main
```

CI runs for pushes to `main` and `releases/**`, and pull requests targeting
maintenance branches use the same PR workflow as `main`. Release workflow fixes
are always valid backport candidates for supported maintenance branches so old
trains do not lose the ability to ship security patches.

Desktop Settings let operators pick a **channel** (Stable or Beta) and a
**track** (Latest or Prerelease). Tag suffixes map onto those four slots:

| Settings slot | Tag | GitHub flag |
|---|---|---|
| Stable · Latest | `v1.0.5` | Latest (after promotion) |
| Stable · Prerelease | `v1.0.6-prerelease.1` | Pre-release |
| Beta · Latest | `v1.1.0-beta.3` | Pre-release |
| Beta · Prerelease | `v1.1.0-alpha.7` | Pre-release |

CI publishes **every** release as a GitHub `Pre-release`, including a
suffix-free stable tag. A suffix-free tag left at `prerelease: true` lands in
Stable · Prerelease, so Stable · Latest keeps serving the previous stable
release until an operator promotes the new one. See
[Promoting a release to Latest](#promoting-a-release-to-latest).

Use `-prerelease.N` for Stable RCs. Use `-alpha.N` / `-beta.N` on `main`.
Every `main` tag with a prerelease suffix must stay a GitHub Pre-release so
it cannot steal `/releases/latest` from the Stable train. Promote a smoked
alpha by bumping `apps/desktop/package.json` and the CHANGELOG heading to
the beta version, then tagging that commit. Do not retag the alpha SHA.

**The suffix is load-bearing, not just the GitHub flag.** Stable · Latest
resolves to the highest *suffix-free* non-prerelease tag, so a tag carrying
`-alpha.N` / `-beta.N` / `-prerelease.N` can never become the feed every
Stable operator is pushed onto — even if someone forgets the Pre-release
checkbox at tag time. A mistagged `main` tag fails **closed**: it lands in no
slot at all, and the Beta rows in Settings read "Unavailable" until the flag
is corrected on the GitHub release. That is the symptom to look for after a
`main` tag if Beta operators report seeing nothing new. The fallback to a
suffixed tag applies only to a release set with no suffix-free stable at all
(the pre-`v1.0.0` world, where every stable was a `v1.0.0-beta.N` published as
GitHub Latest).

## Cutting a release (CI path — preferred)

```bash
# 1. Bump the desktop version and add a matching top CHANGELOG.md entry.
# Treat apps/desktop/package.json as the release version source.
RELEASE_BRANCH=main
RELEASE_TAG=v1.0.0-alpha.7 pnpm release:check
pnpm licenses:generate
pnpm licenses:check

# 2. Commit the release metadata and land it on the release branch.
# Preferred: direct signed push by a maintainer with branch-protection bypass.
git add apps/desktop/package.json CHANGELOG.md THIRD_PARTY_LICENSES
git commit -S -m "chore(release): prepare v1.0.0-alpha.7"
git push origin HEAD:$RELEASE_BRANCH

# 3. Tag the exact release-branch commit after the metadata lands.
git fetch origin $RELEASE_BRANCH --tags
git pull --ff-only
RELEASE_TAG=v1.0.0-alpha.7 pnpm release:check
git tag -s v1.0.0-alpha.7 -m "v1.0.0-alpha.7"
git push origin v1.0.0-alpha.7
```

The `Release Desktop (macOS universal + Windows + Linux DEB)` workflow contains
seven job definitions (the Linux package job fans out across two architectures):

1. `Test and prepare signing input`, with `contents: read`, explicit
   `id-token: none`, no Apple secrets, and checkout credentials disabled. It
   installs dependencies, runs release metadata checks, typecheck, tests, and
   `apps/desktop/scripts/release.mjs --prepare-only`.
2. `Sign, notarize, package macOS`, gated by the protected `apple-signing`
   environment, with `contents: read` and explicit `id-token: none`. It does
   not check out the repository or run dependency installation/postinstall
   scripts. It downloads the prepared artifact, verifies its SHA-256 digest,
   expands it, and runs `apps/desktop/scripts/release.mjs --sign-stage-only
   --no-publish`
   with the environment-scoped Apple secrets.
3. `Package Linux DEB`, running on native Ubuntu x64 and arm64 GitHub-hosted
   runners. Each job runs `apps/desktop/scripts/release.mjs --linux
   --no-publish`, verifies the packaged ASAR, writes a stable download alias,
   and uploads the `.deb` files as short-retention workflow artifacts.
4. `Prepare Windows signing input`, running on Windows without an environment
   or signing credentials. It builds a self-contained, hoisted Windows release
   stage that includes the electron-builder toolchain, archives that stage and
   the small signing scripts without workspace `node_modules` links, records
   the archive SHA-256 as a job output, and uploads the archive. This avoids
   Windows tar recursively following pnpm workspace junctions.
5. `Sign and package Windows installer`, gated by the protected
   `windows-signing` environment. It does not check out source or install
   project dependencies/lifecycle scripts. It verifies and expands the exact
   prepared archive, installs `TrustedSigning`, and runs `release.mjs --win
   --sign-stage-only --no-publish --require-signing`. The post-package ASAR
   verifier resolves from the staged toolchain, not the workspace. The Azure
   service-principal secrets are injected only into this signing-aware packaging
   step. After packaging it copies the signed installer to the stable name
   `PwrAgent-windows-x64-setup.exe` and appends that copy to the Windows
   `SHA256SUMS` manifest.
6. `Publish release assets`, which waits for successful macOS signing, both
   Linux packages, and the signed Windows installer. Only then does it create
   the GitHub Release — always as a `Pre-release`, whatever the tag suffix —
   upload every platform's assets, and generate Linux `SHA256SUMS`. The step
   then reads the release back and fails the job if GitHub did not record
   `isPrerelease: true`. The Windows package checksum manifest is uploaded as
   `PwrAgent-windows-SHA256SUMS` so GitHub Release assets have unique names.
7. `Publish release notes`, which waits for successful all-platform asset
   publishing, extracts the matching `CHANGELOG.md` section, updates the
   GitHub Release body, and fails the workflow if the body still reads back as
   empty.

The macOS no-secret prepare job:

1. Verifies `THIRD_PARTY_LICENSES` matches a fresh deterministic generation.
2. Builds main/preload/renderer with electron-vite.
3. Runs `pnpm deploy --prod` to materialize a flat `node_modules` tree under
   `apps/desktop/release-stage/`.
4. Seeds the stage with `out/`, `build/`, `electron-builder.yml`, `LICENSE`,
   and `THIRD_PARTY_LICENSES`.
5. Archives the prepared stage plus the already-resolved `electron-builder`
   toolchain into the `desktop-release-signing-input` workflow artifact.

The macOS environment-gated signing job:

1. Verifies the prepared artifact SHA-256 from the build job output.
2. Decodes `APPLE_API_KEY_BASE64` from the env to a temp `.p8` file.
3. Patches the staged electron-builder GitHub `releaseType` from the desktop
   package version. This rewrites the staged config only; the job packages with
   `--publish never` and never creates a GitHub Release. The `Pre-release` flag
   on the published release comes from `Publish release assets`, which always
   passes `--prerelease`.
4. Runs `electron-builder --mac --universal --publish never` from the
   downloaded artifact, without invoking `pnpm install`, `npx`, or dependency
   lifecycle scripts. `electron-builder` signs every
   helper bundle individually, signs the main `.app`, submits to Apple's
   notarization service via `notarytool`, staples the ticket, builds the DMG
   and universal updater ZIP, and generates `latest-mac.yml` without creating
   a GitHub Release.
5. Prepares the stable-name `PwrAgent.dmg` alias and transfers the signed
   macOS assets to the all-platform publishing job.

The all-platform publishing job creates the GitHub Release only after the
signed macOS, Windows, and Linux payloads are all available. It uploads the
signed Windows installer alongside the macOS and Linux assets; a failed or
unapproved Windows signing job therefore cannot leave a partial public release.

The Windows jobs use the same trust boundary with a platform-specific final
step. The no-secret job prepares the stage on Windows, because its native
dependencies cannot be prepared on macOS. The protected job verifies the
archive before expanding it and does no source checkout, package-manager
install, or dependency lifecycle execution. It installs only the
`TrustedSigning` PowerShell module required by electron-builder. Windows NSIS
packaging remains inside this job because electron-builder signs the staged app
executables, generated uninstaller, and final installer during packaging; a
post-build signature on only the outer installer would not provide the same
coverage.

Cycle time target: ≤ 12 minutes.

Do not approve the `apple-signing` or `windows-signing` environment unless the
tag, commit, and metadata are the intended release. Do not create the GitHub
Release manually before the build succeeds. A manually created release appears
before all required platform builds have completed. The workflow creates the
release only after it has received the signed macOS and Windows payloads plus
both Linux packages, then the release-notes job verifies and writes the
matching `CHANGELOG.md` content. The release is not complete at either signing
approval gate: after approval, continue watching the run through `Publish
release notes`, then verify the final GitHub Release body is non-empty. If a
monitor or handoff stops at an approval gate, resume after approval rather than
treating the release as done.
Every CI-published release is born as a GitHub `Pre-release`, including a
suffix-free stable tag such as `v1.0.0`. Promotion to Latest is a separate
operator action taken after the assets, updater metadata, and smoke checks are
validated. GitHub excludes pre-release entries from `/releases/latest`,
`PwrAgent.dmg`, and the default Electron updater feed, so a freshly published
release reaches no Stable operator until that promotion.

If the automated release-notes job fails or GitHub temporarily rejects the
release edit, use this manual fallback after confirming the notes file contains
the approved `CHANGELOG.md` entry:

```bash
RELEASE_TAG=v1.0.0-beta.21
mkdir -p .local/release/"$RELEASE_TAG"
node scripts/extract-release-notes.mjs \
  --tag "$RELEASE_TAG" \
  --out .local/release/"$RELEASE_TAG"/RELEASE_NOTES.md
gh release edit "$RELEASE_TAG" \
  --repo pwrdrvr/PwrAgent \
  --notes-file .local/release/"$RELEASE_TAG"/RELEASE_NOTES.md
gh release view "$RELEASE_TAG" --repo pwrdrvr/PwrAgent --json body \
  --jq '.body | length'
```

If direct push to the release branch is rejected, use the repo-local release
skill fallback: open a short-lived release PR against the release branch, wait
for checks, squash merge it, then tag the merged release-branch commit.

Stable landing-page URL:

```text
https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent.dmg
```

Stable Windows download URLs:

```text
https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent-windows-x64-setup.exe
https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent-windows-SHA256SUMS
```

Stable Linux download URLs:

```text
https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent-linux-x64.deb
https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent-linux-arm64.deb
https://github.com/pwrdrvr/PwrAgent/releases/latest/download/SHA256SUMS
```

Each stable name is a byte-identical copy of the versioned asset from the same
release, so `pwragent.ai` can link these URLs directly instead of resolving the
versioned asset name through the GitHub Releases API. GitHub serves
`/releases/latest/download/` only from a release promoted to Latest, so these
URLs keep serving the previous release until the promotion step below runs.

For the current arm64-only beta, backfill the stable alias:

```bash
tmpdir=$(mktemp -d)
cd "$tmpdir"
gh release download v1.0.0-beta.4 --repo pwrdrvr/PwrAgent --pattern "*arm64.dmg"
mv PwrAgent-*-arm64.dmg PwrAgent.dmg
gh release upload v1.0.0-beta.4 PwrAgent.dmg --repo pwrdrvr/PwrAgent --clobber
```

---

## Updater channel files

`configureAutoUpdaterFeedForRelease` points electron-updater at a `generic`
feed rooted at one release's download directory
(`.../releases/download/<tag>/`). electron-updater then fetches exactly one
file name from that directory, chosen by platform:

| Platform | Channel file |
|---|---|
| macOS | `latest-mac.yml` |
| Windows | `latest.yml` |
| Linux x64 | `latest-linux.yml` |
| Linux arm64 | `latest-linux-arm64.yml` |

If the release does not carry the file for a platform, that platform's update
check fetches a 404 and fails. Every release up to and including
`v1.1.0-alpha.2` published only `latest-mac.yml`, so Windows update checks
failed on every release.

electron-builder writes these files as a side effect of **packaging**, not of
publishing, so the `--publish=never` packaging jobs produce them. The bug was
that the Windows and Linux workflow artifacts never collected them.

The name is `latest*` even for a prerelease version such as `1.1.0-alpha.2`.
electron-builder derives a channel from the version's prerelease tag (writing
`alpha.yml` instead) only for the `generic` publish provider;
`electron-builder.yml` publishes through `github`, which expresses prerelease
status with the release's `Pre-release` flag instead. Do not set
`publish.channel` — that would rename the published files away from the names
the installed builds ask for.

[`apps/desktop/scripts/update-channel-files.mjs`](../apps/desktop/scripts/update-channel-files.mjs)
holds the names. `release.mjs` imports them for its packaging checks and the
release workflow runs the same file as a CLI for its publication checks, so the
two cannot drift. Neither signing job checks out the repository — each gets an
explicit allowlist of scripts — so that module is listed in the macOS `Archive
signing input` step and in `scripts/release/archive-windows-signing-input.ps1`.

Three checks guard this, so a dropped asset fails the release instead of
shipping a broken updater:

- `release.mjs` fails each platform's packaging step if the channel file is
  absent from `dist/`.
- `Verify updater channel files` (`verify-staged`) fails the publication job if
  any of the four is missing from the downloaded artifacts, declares a version
  other than the tag's, or names an installer that is not staged beside it.
- The publication step re-reads the created release (`verify-published`) and
  fails if any of the four did not upload.

---

## Promoting a release to Latest

CI publishes every release as a GitHub `Pre-release`, so a freshly published
build reaches nobody on Stable · Latest and serves nothing from
`/releases/latest/download/`. Promotion is a deliberate operator action taken
after the release is validated.

Promote only once all of these hold:

- Every platform asset the tag should carry is attached to the release.
- The updater metadata (`latest-mac.yml`, `latest.yml`, `latest-linux*.yml`)
  is attached and names the published version.
- The release body carries the matching `CHANGELOG.md` entry.
- The build has been smoke-checked on at least one machine.

```bash
gh release edit v<version> --repo pwrdrvr/PwrAgent --latest --prerelease=false
```

No retag is needed. Clearing the flag on a suffix-free tag moves it from
Stable · Prerelease into Stable · Latest.

**Promote suffix-free tags only.** `--latest` also repoints
`/releases/latest/download/`, so promoting a suffixed tag such as
`v1.1.0-beta.3` would hand the website a beta build while leaving the app's
Stable · Latest slot on the previous stable — `selectChannelReleases` requires
a candidate to be both suffix-free and non-prerelease. Leave suffixed tags as
pre-releases.

To undo a premature promotion, restore the flag:

```bash
gh release edit v<version> --repo pwrdrvr/PwrAgent --prerelease
```

---

## Cutting a release (local path — fallback)

Useful when CI is down or for the very first signed/notarized verification
(plan Phase E5).

```bash
# 1. Source release-time env (do NOT commit this file):
cat > .envrc.release <<'EOF'
export CSC_NAME="Developer ID Application: PwrDrvr LLC (T44CNHC4UH)"
export APPLE_API_KEY=$HOME/Secrets/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
export APPLE_TEAM_ID=T44CNHC4UH
export GH_TOKEN=ghp_xxx_fine_grained_PAT_with_Contents_Read_Write_on_pwrdrvr_PwrAgent
EOF
source .envrc.release

# 2. Run the orchestrator. Common local modes:
pnpm --filter @pwragent/desktop package:dryrun  # unsigned, no publish
pnpm --filter @pwragent/desktop package         # signed + notarized, no publish
pnpm --filter @pwragent/desktop release         # signed + notarized + publish
pnpm --filter @pwragent/desktop package:linux   # current-arch .deb, no publish
```

The macOS modes need an Xcode 26 or newer selected (`xcode-select -p`, or
export `DEVELOPER_DIR`): electron-builder compiles `build/icon.icon` with
`actool` and refuses older versions. CI selects one with
`.github/actions/select-xcode-for-actool`; see AGENTS.md "macOS app icon".

The release orchestrator runs `pnpm licenses:check` before packaging. If
dependencies changed, run `pnpm licenses:generate`, review the
`THIRD_PARTY_LICENSES` diff, and commit it before cutting the release.

Verify the produced `.app`:

```bash
APP=apps/desktop/release-stage/dist/mac-universal/PwrAgent.app

# Identity must be PwrDrvr LLC
codesign -dv --verbose=4 "$APP"

# Main executable and native addon must contain both Apple Silicon and Intel slices
lipo -archs "$APP/Contents/MacOS/PwrAgent"
lipo -archs "$APP/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node"

# Gatekeeper-approved (Notarized Developer ID)
spctl -a -vv "$APP"

# Stapled — proves first-launch works offline
stapler validate "$APP"

# All four helpers must NOT contain the string "Electron"
ls "$APP/Contents/Frameworks/" | grep -i electron && echo "FAIL: leaked Electron Helper" || echo "OK"

# Fuses (ASAR integrity must be enabled)
npx --yes @electron/fuses read --app "$APP"

# First-party notices, third-party notices, and release notes must ship in Resources
test -f "$APP/Contents/Resources/LICENSE"
test -f "$APP/Contents/Resources/THIRD_PARTY_LICENSES"
test -f "$APP/Contents/Resources/CHANGELOG.md"
```

For releases that include automation scheduling changes, smoke-test one migrated
profile before publishing broadly:

```bash
PWRAGENT_PROFILE=release-smoke open "$APP"
```

Create an interval automation on an existing thread, use **Run now**, confirm it
appears in the thread context and global Automations view, then quit and relaunch
to verify closed-app ticks are not backfilled. Automation state lives in the
profile SQLite database under `~/.pwragent/profiles/<name>/state/state.db`.

---

## Auto-update on Phase 1

The macOS v1.x binary reads release metadata from GitHub Releases. If a local
run needs an explicit token, the app reads `process.env.GH_TOKEN` at runtime.
The cleanest one-liner is to launch via Terminal:

```bash
GH_TOKEN=ghp_fine_grained_PAT open /Applications/PwrAgent.app
```

Or persist it in `~/.zshrc` (or equivalent) so opening from Spotlight / dock
Just Works. A LaunchAgent plist is also possible but is overkill at Phase 1.

The "Check for updates" button in **Settings → About** invokes
`autoUpdater.checkForUpdates()` — useful for verifying the feed is reachable
without waiting for the auto-check on next launch.

### Switching back to a channel that is behind the running build

An operator can end up running a build that is newer than the channel they
have selected — the usual route is a prerelease auto-update landing a `main`
alpha on a machine whose selection later resolves to the Stable train. That
build serves no forward update on the selected channel, so the app treats the
older selected release as a **switch back** rather than "no update":

- The check sets `autoUpdater.allowDowngrade = true` for that check only,
  points the feed at the selected release, and downloads it. Every check that
  resolves to a newer release sets `allowDowngrade` back to `false`.
- The offer is made only for an operator-initiated check — the Settings
  "Check for Update" button, the app menu **Check for Updates**, or the app
  management tool. Startup and hourly background checks still report
  "You're up to date" so an operator who deliberately installed a newer build
  is not asked to move back down on every poll. Tell an operator who is
  stranded to press "Check for Update" after selecting their channel.
- A downloaded switch back never installs on quit. `autoInstallOnAppQuit`
  stays `false` for it, so it applies only when the operator presses
  **Restart to Switch**.
- Surfaces say "Switch to v1.0.2" and "Restart to Switch" instead of the
  update wording, because the operator is moving onto the channel they picked.
- A selected release equal to the running version is still "no update".

Phase 2 distribution channel migration removes the token requirement entirely.
See [desktop-distribution-phase-2-runbook.md](desktop-distribution-phase-2-runbook.md).

Linux builds intentionally skip `electron-updater`. Operators upgrade by
installing the newer `.deb` from GitHub Releases; the in-app update status
reports that Linux packages are updated manually.

---

## What to do if notarization fails

Apple's notarytool returns a submission ID even when notarization fails.
Fetch the JSON log:

```bash
xcrun notarytool log <submission-id> \
  --key "$APPLE_API_KEY" \
  --key-id "$APPLE_API_KEY_ID" \
  --issuer "$APPLE_API_ISSUER"
```

Most-common Electron failures:

| Symptom | Cause | Fix |
|---|---|---|
| "The binary is not signed with a valid Developer ID certificate." | Wrong cert in Keychain or `CSC_LINK` wrong | Re-import `.p12` from 1Password; verify `security find-identity -v -p codesigning` |
| "The signature does not include a secure timestamp." | `--timestamp` flag missing on inner sign | electron-builder ≥ 26 handles this automatically; upgrade builder |
| "The executable does not have the hardened runtime enabled." | Missing `mac.hardenedRuntime: true` | Confirm in `electron-builder.yml` |
| "The entitlement com.apple.security.cs.allow-jit ... is missing on a helper bundle." | `entitlementsInherit` not pointing at the same plist | Confirm `mac.entitlements` and `mac.entitlementsInherit` both reference `build/entitlements.mac.plist` |
| Hangs on "Waiting for notarization status..." for >30 min | Apple infrastructure congestion | Wait or re-submit; both submissions count against the same successful staple |

---

## Cert custody, rotation, and never-do list

- **Never** rotate the Developer ID Application certificate without coordinating
  a re-install ritual. Squirrel.Mac validates that the new binary's Team ID
  matches the running app's. If you ship a binary signed under a different
  Team ID, every existing user must re-install through a Gatekeeper warning.
  Apple permits multiple Developer ID certs simultaneously — use overlap to
  rotate without forcing re-install.
- **Never** revoke a Developer ID cert unless it is confirmed leaked.
  Revocation invalidates every shipped binary signed with it (existing
  installs stop launching after their staple expires).
- **Never** commit `.p12`, `.p8`, `.envrc.release`, or any `AuthKey_*.p8` to
  the repo. The `.gitignore` blocks these by default.
