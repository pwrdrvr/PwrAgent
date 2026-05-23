# Desktop Release Runbook

> MIT-licensed desktop release pipeline.
>
> Origin: [docs/plans/2026-05-02-004-feat-desktop-release-packaging-plan.md](plans/2026-05-02-004-feat-desktop-release-packaging-plan.md)

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

## Cutting a release (CI path — preferred)

```bash
# 1. Bump the desktop version and add a matching top CHANGELOG.md entry.
# Treat apps/desktop/package.json as the release version source.
RELEASE_TAG=v1.0.0-alpha.7 pnpm release:check
pnpm licenses:generate
pnpm licenses:check

# 2. Commit the release metadata and land it on main.
# Preferred: direct signed push by a maintainer with branch-protection bypass.
git add apps/desktop/package.json CHANGELOG.md THIRD_PARTY_LICENSES
git commit -S -m "chore(release): prepare v1.0.0-alpha.7"
git push origin HEAD:main

# 3. Tag the exact main commit after the metadata is on main.
git fetch origin main --tags
git pull --ff-only
RELEASE_TAG=v1.0.0-alpha.7 pnpm release:check
git tag -s v1.0.0-alpha.7 -m "v1.0.0-alpha.7"
git push origin v1.0.0-alpha.7
```

The `Release Desktop (macOS universal + Linux DEB)` workflow triggers as four
release jobs:

1. `Test and prepare signing input`, with `contents: read`, explicit
   `id-token: none`, no Apple secrets, and checkout credentials disabled. It
   installs dependencies, runs release metadata checks, typecheck, tests, and
   `apps/desktop/scripts/release.mjs --prepare-only`.
2. `Sign, notarize, publish`, gated by the protected `apple-signing`
   environment, with `contents: write` and explicit `id-token: none`. It does
   not check out the repository or run dependency installation/postinstall
   scripts. It downloads the prepared artifact, verifies its SHA-256 digest,
   expands it, and runs `apps/desktop/scripts/release.mjs --sign-stage-only`
   with the environment-scoped Apple secrets.
3. `Package Linux DEB`, running on native Ubuntu x64 and arm64 GitHub-hosted
   runners. Each job runs `apps/desktop/scripts/release.mjs --linux
   --no-publish`, verifies the packaged ASAR, writes a stable download alias,
   and uploads the `.deb` files as short-retention workflow artifacts.
4. `Publish Linux DEB artifacts`, which waits for the macOS publish job so the
   GitHub Release exists, combines both Linux architecture artifacts, generates
   `SHA256SUMS`, and uploads the `.deb` files plus checksums to the same
   release.

The no-secret prepare job:

1. Verifies `THIRD_PARTY_LICENSES` matches a fresh deterministic generation.
2. Builds main/preload/renderer with electron-vite.
3. Runs `pnpm deploy --prod` to materialize a flat `node_modules` tree under
   `apps/desktop/release-stage/`.
4. Seeds the stage with `out/`, `build/`, `electron-builder.yml`, `LICENSE`,
   and `THIRD_PARTY_LICENSES`.
5. Archives the prepared stage plus the already-resolved `electron-builder`
   toolchain into the `desktop-release-signing-input` workflow artifact.

The environment-gated signing job:

1. Verifies the prepared artifact SHA-256 from the build job output.
2. Decodes `APPLE_API_KEY_BASE64` from the env to a temp `.p8` file.
3. Runs `electron-builder --mac --universal --publish always` from the
   downloaded artifact, without invoking `pnpm install`, `npx`, or dependency
   lifecycle scripts. `electron-builder` signs every
   helper bundle individually, signs the main `.app`, submits to Apple's
   notarization service via `notarytool`, staples the ticket, builds the DMG
   and universal updater ZIP, generates `latest-mac.yml`, and uploads
   everything to a GitHub Release on `pwrdrvr/PwrAgent`.
4. Uploads the stable-name `PwrAgent.dmg` alias for landing-page download
   links.

Cycle time target: ≤ 12 minutes.

Do not approve the `apple-signing` environment unless the tag, commit, and
metadata are the intended release. Do not create the GitHub Release manually
before the build succeeds. A manually created release appears before
signing/notarization finishes. The current flow lets electron-builder create or
update the release from the successful CI build; afterward, edit the release to
mark prerelease tags as prereleases and replace the generated/empty notes with
the matching `CHANGELOG.md` content.

If direct push to `main` is rejected, use the repo-local release skill fallback:
open a short-lived release PR, wait for checks, squash merge it, then tag the
merged `main` commit.

Stable landing-page URL:

```text
https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent.dmg
```

Stable Linux download URLs:

```text
https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent-linux-x64.deb
https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent-linux-arm64.deb
https://github.com/pwrdrvr/PwrAgent/releases/latest/download/SHA256SUMS
```

For the current arm64-only beta, backfill the stable alias:

```bash
tmpdir=$(mktemp -d)
cd "$tmpdir"
gh release download v1.0.0-beta.4 --repo pwrdrvr/PwrAgent --pattern "*arm64.dmg"
mv PwrAgent-*-arm64.dmg PwrAgent.dmg
gh release upload v1.0.0-beta.4 PwrAgent.dmg --repo pwrdrvr/PwrAgent --clobber
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

---

## Plan / brainstorm references

- Plan: [docs/plans/2026-05-02-004-feat-desktop-release-packaging-plan.md](plans/2026-05-02-004-feat-desktop-release-packaging-plan.md)
- Brainstorm: [docs/brainstorms/2026-05-02-desktop-release-packaging-requirements.md](brainstorms/2026-05-02-desktop-release-packaging-requirements.md)
- Phase 2 distribution migration: [docs/desktop-distribution-phase-2-runbook.md](desktop-distribution-phase-2-runbook.md)
