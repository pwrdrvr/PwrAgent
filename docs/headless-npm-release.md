# Headless CLI npm release runbook

`packages/pwragent/package.json` owns the independent headless CLI version.
Desktop `v*` tags, desktop changelog metadata, signing environments, Homebrew,
Winget and desktop update feeds are unchanged. CLI release tags are
`pwragent-v<VERSION>` and never trigger the desktop release workflow.

## Registry audit and initial version

On 2026-10-27, the public npm registry reported `pwragent@0.0.0` as its only
version and `latest`, with maintainer `huntharo` and this repository's
`packages/pwragent` directory. Recheck before releasing:

```sh
npm view pwragent name version dist-tags maintainers repository --json --registry=https://registry.npmjs.org
```

The first implemented headless release is prepared as `0.1.0-alpha.1`, published
to `next`. This leaves the existing `latest` placeholder intact until a stable
CLI is deliberately released. Alpha, beta and rc versions use `next`; suffix-free
versions use `latest`. Update both `version` and `publishConfig.tag` together.
Versions are immutable; an occupied version or a channel rollback fails closed.

## Operator prerequisites (required before the first publish)

These are account/repository configuration changes for the operator. This PR
does not perform them, change credentials, create release tags or publish npm.

1. Confirm that npm account `huntharo` still owns `pwragent`. Resolve ownership
   through npm if that changes; do not substitute a different package name or
   bypass the ownership guard to get a green workflow.
2. Create GitHub Environment **`npm-pwragent`** in `pwrdrvr/PwrAgent`. Require a
   reviewer approval and allow deployments from the **`main` branch only**
   (selected branches/tags: one branch rule named `main`, no tag rules).
   Disable administrator bypass where available. The workflow checks that the
   reviewed environment already exists before scheduling the publish job.
3. In npm's `pwragent` settings, add a GitHub Actions trusted publisher:
   organization **`pwrdrvr`**, repository **`PwrAgent`**, workflow filename
   **`publish-headless.yml`**, environment **`npm-pwragent`**. Permit direct
   **`npm publish`**; stage-only permission does not authorize this workflow.
   Configure it near the intended first release: an unused new trust
   configuration expires after two days under the current npm policy.
4. Protect `pwragent-v*` tags against unauthorized creation, deletion and
   replacement. Confirm the intended reviewer can approve the environment.

The repository is public and this unscoped npm package is public. Use
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) on
GitHub-hosted Ubuntu with job-scoped `id-token: write` and provenance. npm >=11.5.1
is required; the publish job uses Node 24 and checks the npm version. There is
no `NPM_TOKEN` secret or token fallback configured. Do not reuse desktop signing
or distribution credentials. Public metadata does not expose an npm package's
trusted publisher configuration; the npm owner must verify those settings.

## Validate and prepare

1. Start from clean current `main`; verify the desired change is merged.
2. Set the independent CLI version and channel in `packages/pwragent/package.json`
   and merge that metadata through a PR. Use increasing alpha/beta/rc numbers
   for prereleases; use a new suffix-free version for a stable release.
3. Confirm the **Headless CLI package** workflow passes both Node 22 and 24 on
   that commit. It runs mocked Codex integration and release-guard tests,
   builds at npm `prepack`, checks the tarball contents and MIT/`ws` notices,
   then installs it offline into a fresh npm prefix with an empty cache and
   install scripts disabled. The installed executable exercises help, a mocked
   turn, transcript reads, federation initialization, restart and idempotent
   submission. No model requests or credentials are used.

The usual repository CI supplies lint, typecheck and the broader mocked suite.
Package checks can be reproduced from an installed checkout with
`pnpm --filter pwragent test` and `pnpm --filter pwragent pack:check`, subject to
the repository's verification environment guidance. The latter retains the
validated tarball and `pack.json` under `.local/headless-package/`.

## Publish (requires explicit operator authorization)

Do not run these steps merely to validate a PR. Creating a tag does not publish;
publication requires manual dispatch, matching confirmation and environment
approval. The release tag must point to the exact `main` commit selected by the
dispatch so npm provenance identifies the source that produced the tarball.
If `main` advances before dispatch, prepare a new release commit/version at its
tip rather than moving an existing tag.

For an approved version, on clean current main:

```sh
git fetch origin main
git merge --ff-only origin/main
# Use a signed annotated tag when signing is configured:
git tag -s pwragent-v0.1.0-alpha.1 -m "pwragent 0.1.0-alpha.1"
git push origin pwragent-v0.1.0-alpha.1
gh workflow run publish-headless.yml --ref main \
  -f tag=pwragent-v0.1.0-alpha.1 \
  -f 'confirmation=publish pwragent@0.1.0-alpha.1'
```

Before approving `npm-pwragent`, review the tag/SHA, version/channel, test logs,
package inventory and `headless-npm-package` artifact from **this run**.
Validation has no publish credentials. Only the approved publish job receives
OIDC permission; it verifies the retained tarball's SHA-512 integrity and repeats
the public ownership/version checks, then publishes those bytes with provenance
and scripts disabled. It does not rebuild, create a GitHub Release, change npm
owners, authenticate Codex, install a service or provision compute.

After success, verify npm metadata, the provenance link and a clean installation:

```sh
npm view pwragent@0.1.0-alpha.1 version dist.integrity dist.attestations --json
npm view pwragent dist-tags --json
npm install --global pwragent@0.1.0-alpha.1
pwragent --help
```

Compare npm's integrity with the retained `pack.json`. See the
[package README](../packages/pwragent/README.md) for Node/Codex prerequisites,
installation, updates and the explicit systemd setup example. If publishing
fails, inspect the registry before retrying: an already published version must
never be overwritten. Do not remove a version, move its tag or change credentials
as an automatic recovery step.
