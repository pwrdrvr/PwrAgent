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

- Release from the repository default branch unless the user explicitly approves
  another ref.
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
- Do not create or push the tag until the version and changelog are committed
  and present on the repository default branch.
- Do not create the GitHub Release by hand before the build succeeds. Let
  electron-builder create or update the release from the signed/notarized CI
  build, then replace the generated/empty release notes with the changelog
  entry.
- Do not use GitHub generated release notes as the final notes.
- Do not force-push the default branch or rewrite an existing release tag
  without explicit user approval.
- Keep MIT licensing intact: do not change first-party license metadata or
  remove license disclosures without an explicit policy change.

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

Preferred fast path: if maintainer direct-push bypass is enabled for `main`,
push the signed release metadata commit directly. This avoids running PR CI and
then running the same gates again from the release tag.

```bash
git push origin HEAD:main
git fetch origin main --tags
git pull --ff-only
```

Fallback path: if direct push to `main` is rejected, push the release metadata
commit to a short-lived release branch, open a PR, wait for required checks,
then **squash merge** the PR. Do not use rebase merge for release metadata PRs:
GitHub may rewrite the commit SHA, which makes it too easy to tag the pre-merge
commit instead of the actual default-branch release commit.

```bash
git switch -c release/v<version>
git push -u origin release/v<version>
gh pr create --base main --head release/v<version> \
  --title "chore(release): prepare v<version>" \
  --body-file .local/PR-v<version>.md
gh pr checks <pr-number> --watch --interval 10
gh pr merge <pr-number> --squash --delete-branch
git fetch origin main --tags
git switch main
git pull --ff-only
```

After the direct push or squash merge, rerun the metadata gate on `main`, then
create exactly one tag on the actual default-branch commit.

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
`origin/main` or the intended default-branch release commit:

```bash
git tag -v v<version>
git merge-base --is-ancestor v<version> origin/main
```

## Publish

Push the tag after the release metadata is already on `main`:

```bash
git push origin v<version>
```

The tag push triggers `Release Desktop (macOS universal)`. The workflow must
pass `Check release metadata` before build/sign/notarize/publish starts.

For a manual dispatch, verify the tag already exists on GitHub:

```bash
git ls-remote --tags origin v<version>
gh workflow run release.yml -f tag=v<version>
```

## Monitor And Verify

Find the run for the release tag and watch it. If it takes a while to appear,
sleep for 5-10 minutes before deciding it failed to start.

```bash
gh run list --workflow release.yml --limit 10
gh run watch <run-id>
```

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

Then replace electron-builder's empty/default release notes and mark prerelease
tags as prereleases:

```bash
gh release edit v<version> \
  --title "v<version> - <short release theme>" \
  --notes-file .local/release/v<version>/RELEASE_NOTES.md \
  --prerelease
```

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
