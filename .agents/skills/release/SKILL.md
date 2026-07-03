---
name: release
description: Prepare, validate, tag, publish, and monitor guarded PwrAgent desktop releases. Use when the user asks to release PwrAgent, prepare a vX.Y.Z or vX.Y.Z-prerelease tag, update release notes or CHANGELOG.md for a desktop release, verify package.json/tag/changelog alignment, trigger the macOS signed/notarized release workflow, or inspect release workflow status.
---

# Release

Use this skill for PwrAgent desktop releases published by the
`.github/workflows/release.yml` Universal macOS workflow.

## Read First

Read these files before changing release metadata:

1. [../../../docs/desktop-release-runbook.md](../../../docs/desktop-release-runbook.md)
2. [../../../docs/desktop-distribution-phase-2-runbook.md](../../../docs/desktop-distribution-phase-2-runbook.md) when the release affects update feeds or distribution repos
3. [../../../.github/workflows/release.yml](../../../.github/workflows/release.yml)
4. [../../../scripts/check-desktop-release-metadata.mjs](../../../scripts/check-desktop-release-metadata.mjs)

## Guardrails

- Release from `main` for the active next-version train, or from a long-lived
  maintenance branch named `releases/<major>.<minor>` for patch releases on a
  prior train. Do not include the patch component in maintenance branch names:
  use `releases/1.0`, not `releases/1.0.x` or `releases/1.0.1`.
- Start from a clean working tree. If tracked files are dirty, stop and ask
  before changing release metadata.
- Fetch tags before planning:

  ```bash
  git fetch origin --tags
  ```

- Treat `apps/desktop/package.json` as the desktop release version source.
  The root `package.json` version is not the desktop app release version.
- Always use a leading-`v` tag such as `v1.0.0-alpha.5`.
- The tag version, `apps/desktop/package.json` version, and
  `CHANGELOG.md` release heading must match.
- Before moving `main` to a new major/minor train, verify that the prior train's
  maintenance branch exists. For example, before preparing `1.1.0-beta.1` from a
  current `1.0.*` `main`, check for `origin/releases/1.0`. If it is missing,
  stop and ask whether to create it from the current prior-train release commit
  before bumping version metadata.
- Patch releases for an existing train must land on that train's branch. For
  example, prepare `v1.0.1` on `releases/1.0`, not on `main`.
- Before pushing a release tag, verify the `apple-signing` GitHub Environment
  exists, requires reviewer approval, is scoped to release tags, and has the
  Apple signing/notarization secrets required by the workflow.
- Do not create or push the tag until the version and changelog are committed
  and present on the intended release branch.
- Do not create the GitHub Release by hand before the build succeeds. Let
  electron-builder create or update the release from the signed/notarized CI
  build; the workflow publishes the matching changelog entry to the GitHub
  Release body after release assets are uploaded.
- Do not use GitHub generated release notes as the final notes.
- A release is not complete when the workflow reaches the `apple-signing`
  approval gate. After approval, continue monitoring through the release-notes
  publishing job, and verify the release body is non-empty.
- Do not force-push the default branch or rewrite an existing release tag
  without explicit user approval.
- Keep MIT licensing intact: do not change first-party license metadata or
  remove license disclosures without an explicit policy change.

## Release Branch Preflight

For every release, identify `RELEASE_BRANCH` before editing files:

- Active-train beta or stable release: `main`.
- Prior-train patch release: `releases/<major>.<minor>`.

If the user asks to cut a new major/minor version from `main`, compare the
current desktop version's major/minor with the requested version's major/minor.
When they differ, check for the current train's maintenance branch:

```bash
git ls-remote --heads origin releases/<current-major>.<current-minor>
```

If it is missing, ask before proceeding:

```text
We are about to move main from the <old-train> train to the <new-train> train,
but there is no releases/<old-train> maintenance branch. Guidance is to create
it before bumping main so future <old-train>.x security patches can be cut
cleanly. Create releases/<old-train> from the current <old-train> release commit
now?
```

Create that branch before the version-bump commit that starts the new train:

```bash
git switch main
git fetch origin main --tags
git pull --ff-only
git switch -c releases/<old-train> v<old-train>.<patch>
git push origin releases/<old-train>
git switch main
```

Use the exact prior-train release tag as the branch point. For the first stable
1.0 release, cut and tag `v1.0.0`, create `releases/1.0` at `v1.0.0`, then bump
`main` to `1.1.0-beta.1`.

## Prepare Release Metadata

1. Determine the next version from the previous tag and user intent:

   ```bash
   git tag --sort=-version:refname | head -n 10
   gh release list --limit 10
   ```

2. Update `apps/desktop/package.json` without creating a tag yet:

   ```bash
   pnpm --filter @pwragent/desktop version <version> --no-git-tag-version
   ```

   If that command is not available in the current pnpm version, edit only
   `apps/desktop/package.json` and preserve JSON formatting.

3. Add a top `CHANGELOG.md` entry:

   ```md
   ## v1.0.0-alpha.5 - YYYY-MM-DD
   ```

   Write user-facing bullets from merged PRs and direct commits since the last
   release. Preserve the same substance in GitHub release notes.

   Release notes must give context first, not just describe the code delta.
   Start each bullet with the user-visible area or feature, then state whether
   it was added, improved, or fixed. Keep bullets punchy and readable by
   operators:

   ```md
   - Composer - Improved complex Markdown pastes with lists, inline code, and nested code blocks.
   - Thread Search - Escape now dismisses search, pairing with Cmd/Ctrl+Shift+F to open it.
   - Thread List Pull Request Info - Merged PR commits no longer show as unpushed work.
   - Minor - Dependency updates and small UI polish.
   ```

   Avoid release-note bullets that only say "Improved handling", "Added
   plumbing", "Updated dependencies", or "Fixed packaging" without naming the
   feature surface and why users should care. Roll maintenance-only changes
   into a short `Minor - ...` bullet unless they materially affect installs,
   updates, or data safety.

4. Run the metadata gate locally before committing:

   ```bash
   RELEASE_TAG=v<version> pnpm release:check
   ```

5. Run normal repo gates unless the user explicitly narrows verification:

   ```bash
   pnpm typecheck
   pnpm test
   ```

## Commit, Land, And Tag

Commit the version and changelog together. Use a signed commit; this repo's git
config should already sign commits with SSH.

```bash
git add apps/desktop/package.json CHANGELOG.md
git commit -m "chore(release): prepare v<version>"
```

Preferred fast path: if maintainer direct-push bypass is enabled for
`RELEASE_BRANCH`, push the signed release metadata commit directly. This avoids
running PR CI and then running the same gates again from the release tag.

```bash
git push origin HEAD:<RELEASE_BRANCH>
git fetch origin <RELEASE_BRANCH> --tags
git pull --ff-only
```

Fallback path: if direct push to `RELEASE_BRANCH` is rejected, push the release
metadata commit to a short-lived release branch, open a PR, wait for required
checks, then **squash merge** the PR. Do not use rebase merge for release
metadata PRs: GitHub may rewrite the commit SHA, which makes it too easy to tag
the pre-merge commit instead of the actual release-branch commit.

Remember that a GitHub squash merge creates a GitHub-authored commit on
`RELEASE_BRANCH`, not the original locally signed commit. If the user requires
the release metadata commit on the release branch itself to be locally signed,
use the direct-push path or ask before using the PR fallback.

```bash
git switch -c release/v<version>
git push -u origin release/v<version>
gh pr create --base <RELEASE_BRANCH> --head release/v<version> \
  --title "chore(release): prepare v<version>" \
  --body-file .local/PR-v<version>.md
gh pr checks <pr-number> --watch --interval 10
gh pr merge <pr-number> --squash --delete-branch
git fetch origin <RELEASE_BRANCH> --tags
git switch <RELEASE_BRANCH>
git pull --ff-only
```

After the direct push or squash merge, rerun the metadata gate on
`RELEASE_BRANCH`, then create exactly one tag on the actual release-branch
commit.

```bash
RELEASE_TAG=v<version> pnpm release:check
```

If signing tags is configured and works locally, prefer a signed annotated tag:

```bash
git tag -s v<version> -m "v<version>"
```

If signed tags are not available and the user approves an unsigned release tag,
create a lightweight tag instead:

```bash
git tag v<version>
```

Do not silently fall back from a failed signed tag to an unsigned tag. Ask the
user which tag form to use. Before pushing, verify the tag points at
`origin/<RELEASE_BRANCH>` or the intended release-branch commit:

```bash
git tag -v v<version>
git merge-base --is-ancestor v<version> origin/<RELEASE_BRANCH>
```

## Publish

Push the tag after the release metadata is already on `RELEASE_BRANCH`:

```bash
git push origin v<version>
```

The tag push triggers `Release Desktop (macOS universal)`. The workflow must
pass `Check release metadata` in the no-secret `Test and prepare signing input`
job before the environment-gated `Sign, notarize, publish` job can request
approval and access Apple signing secrets.

For a manual dispatch, verify the tag already exists on GitHub:

```bash
git ls-remote --tags origin v<version>
gh workflow run release.yml --ref <RELEASE_BRANCH> -f tag=v<version>
```

## Monitor And Verify

Find the run for the release tag and watch it. If it takes a while to appear,
sleep for 5-10 minutes before deciding it failed to start.

```bash
gh run list --workflow release.yml --limit 10
gh run watch <run-id>
```

The `Sign, notarize, publish` job pauses for `apple-signing` Environment
approval. Treat that pause as expected. Before approving, verify the workflow
run is for the intended tag, the tag points at the intended default-branch
commit, and the version/changelog metadata match the tag.

If monitoring is delegated and the monitor stops at the approval gate, resume
monitoring after approval. Do not end the release turn as "done" at the
approval gate; the workflow still has to publish and verify release notes after
assets are uploaded.

On failure, inspect logs yourself:

```bash
gh run view <run-id> --log-failed
```

After success, verify the release and generated assets:

```bash
gh release view v<version>
gh release download v<version> --dir .local/release/v<version>
ls .local/release/v<version>
```

Expect signed/notarized Universal macOS assets:

- A versioned Universal DMG, such as `PwrAgent-<version>-universal.dmg`.
- A stable `PwrAgent.dmg` alias uploaded by the workflow for
  `https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent.dmg`.
- A Universal updater ZIP and `.blockmap`.
- `latest-mac.yml`.

The stable `PwrAgent.dmg` alias is intentionally unversioned so the website can
link to the latest release without knowing the current version. Do not remove
or replace it with an arch-suffixed DMG.

The workflow replaces electron-builder's empty/default release notes after
release assets are published. Prerelease-tagged versions such as
`v1.0.0-beta.41` must be born as GitHub `Pre-release`; stable versions such as
`v1.0.0` must be born as normal releases so they can become Latest. GitHub
excludes pre-release entries from `/releases/latest`, which also excludes them
from `https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent.dmg`
and the default Electron updater feed.

This release-note publication is required, not cosmetic. Electron-builder may
leave the body empty or duplicate the tag name. If the workflow release-notes
job fails or GitHub temporarily rejects the edit, run the manual fallback after
confirming the extracted notes match the approved changelog entry:

```bash
node scripts/extract-release-notes.mjs \
  --tag v<version> \
  --out .local/release/v<version>/RELEASE_NOTES.md
gh release edit v<version> \
  --repo pwrdrvr/PwrAgent \
  --notes-file .local/release/v<version>/RELEASE_NOTES.md
```

Only use `gh release edit --prerelease` as a corrective fallback if a
prerelease-tagged version was not born as `Pre-release`.

Verify the final release body before calling the release complete:

```bash
gh release view v<version> --json name,body,isPrerelease \
  --jq '{name, isPrerelease, bodyLength: (.body | length)}'
```

The `bodyLength` must be greater than zero and the title/body must match the
approved changelog entry.

## Local Fallback

Use the local path only when CI is unavailable or the user explicitly asks for
local signing/notarization. Follow
[../../../docs/desktop-release-runbook.md](../../../docs/desktop-release-runbook.md)
for required Apple and GitHub secrets.

```bash
pnpm --filter @pwragent/desktop package:dryrun
pnpm --filter @pwragent/desktop package
pnpm --filter @pwragent/desktop release
```
