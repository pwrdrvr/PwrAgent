# Desktop and Outpost npm release contract

The desktop and the public npm **`pwragent`** Outpost CLI ship on one release
train. `apps/desktop/package.json` is the version authority.
`packages/pwragent/package.json` must have that **exact** version, including the
prerelease suffix. One protected `v<VERSION>` tag identifies the source commit
for both. `.github/workflows/release.yml` validates, packages and publishes both;
there is no CLI tag, separate version bump or CLI publish dispatch.
`publish-headless.yml` only validates PRs and ordinary branch pushes.

This replaces the former independent `0.1.0-alpha.1` / `pwragent-v*` policy.
The npm `0.0.0` placeholder is not a usable Outpost release. Synchronizing the
checked-in package with the desktop version does not publish it or backfill old
desktop tags. The first new desktop tag containing this implementation starts
the paired train. Shared/private workspace packages keep their own versions.

## Operator migration checklist — before the first paired tag

These are operator-only account/repository changes. Implementation and PR
validation do not authorize performing them. Pause release tagging until the
checklist is complete; missing prerequisites intentionally fail the release
before desktop builds/signing begin.

1. Confirm npm account **`huntharo`** owns the existing public `pwragent`
   package. Inspect public metadata with
   `npm view pwragent name dist-tags maintainers repository --json --registry=https://registry.npmjs.org`.
   Resolve any ownership conflict through npm; do not rename the package or
   bypass the ownership guard.
2. Keep the existing **`npm-pwragent`** GitHub Environment and required reviewer
   (currently `huntharo`), with **administrator bypass disabled**. Replace its
   former `main` branch-only deployment policy with exactly **one tag rule
   `v*`**, and no branch rules. The workflow checks those settings without
   editing them. Confirm the reviewer can approve a desktop-tag deployment.
   The former `main` rule cannot authorize a tag-triggered job.
3. Confirm protection/rulesets cover desktop **`v*` tags** against unauthorized
   creation, deletion and replacement. Preserve authorized maintainer exceptions
   and desktop signing protections; do not broaden bypass actors. The workflow
   requires `GITHUB_REF_PROTECTED=true` and rejects tags outside `main` or the
   matching `releases/<major>.<minor>` history. The old `pwragent-v*` rule alone
   does not protect the shared release tags.
4. As npm owner, configure a trusted publisher for organization **`pwrdrvr`**,
   repository **`PwrAgent`**, workflow filename **`release.yml`**, environment
   **`npm-pwragent`**, allowing direct **`npm publish`**. Stage-only permission
   is insufficient. The old `publish-headless.yml` trust does not authorize the
   new workflow. Follow npm's current UI for replacing/adding trust, verify near
   first use, and retire the obsolete publisher once the validation-only workflow
   is merged. Do not introduce a token fallback or grant dist-tag management.
   npm's [trusted publisher documentation](https://docs.npmjs.com/trusted-publishers/)
   defines identity fields and supported hosted runners. Public registry
   metadata cannot verify the owner's private trust configuration; configuration
   can be accepted by npm's UI and still fail at publish time.
5. **Only after owner verification**, set repository Actions variable
   **`OUTPOST_NPM_RELEASE_READY=release.yml/npm-pwragent`**. This records the
   operator's migration acknowledgement, not proof of a successful npm login.
   Missing/incorrect values fail with the checklist link. Do not set it merely
   to bypass preflight. A later npm authentication error is an incomplete release.
6. Land the implementation and version metadata, confirm normal PR checks pass,
   then create the next authorized desktop release tag. Do not move/reuse a
   historical desktop tag to adopt this workflow. No new CLI tag or manual CLI
   dispatch is needed. Keep Apple/Windows environment approvals unchanged.

If code lands before configuration, future releases stop in `release-preflight`
and produce no new desktop assets. Complete the checklist and rerun the same
release run. If configuration is staged first, the new npm identity remains
unused until code is merged and a new protected desktop tag is released.
Existing historical tags still contain their historical workflows; do not use
them to claim that the paired train was exercised.

## Version preparation and npm channels

Use the [desktop release runbook](desktop-release-runbook.md) and release skill:

```sh
pnpm release:prepare 1.4.0-alpha.1
# Add the matching CHANGELOG.md heading, then:
RELEASE_TAG=v1.4.0-alpha.1 pnpm release:check
```

`release:prepare` updates only desktop/Outpost versions and Outpost's
`publishConfig.tag`, preserving adjacent formatting. With no argument it copies
the current desktop version into Outpost. Review and commit both packages and
the changelog together. The lockfile records dependency specifiers/resolutions,
not these workspace package versions; no lockfile change is required unless
dependencies change. `release:check`, CLI validation and tarball validation
reject version/channel drift. No build silently rewrites release versions.

| Desktop version | npm channel |
| --- | --- |
| `X.Y.Z` | `latest` |
| `X.Y.Z-alpha.N`, `-beta.N`, `-prerelease.N`, `-rc.N` | `next` |
| Older maintenance train `releases/X.Y`, when a newer train owns a global channel | `release-X.Y` or `release-X.Y-next` |

Every new version must advance its selected npm channel. Maintenance routing
requires validated ancestry on its matching maintenance branch and never moves
global `latest`/`next` backwards. A rollback within the same train fails closed.
Install an exact version when matching a desktop release, especially on a
maintenance train. The npm stable channel advances for a suffix-free tag during
the shared workflow; GitHub still initially marks every desktop release as
Pre-release. Later GitHub promotion controls desktop/Homebrew/Winget feeds and
does not perform a second npm publish. Review that timing before authorizing a
suffix-free tag. Use `-prerelease.N` when stable npm consumers must not advance.

## Execution and security boundaries

1. **Preflight**, without npm credentials or OIDC permission, requires the
   upstream repository, a protected desktop tag, event SHA = checkout SHA = tag
   commit, matching package versions, approved release-branch ancestry and the
   operator prerequisites. Manual desktop recovery dispatches must select the
   **same tag as the workflow ref**, e.g.
   `gh workflow run release.yml --ref v1.4.0-alpha.1 -f tag=v1.4.0-alpha.1`.
   Dispatching on `main` or another arbitrary ref is rejected. Historical release
   commits may be retried after a branch advances; current-main-tip equality is
   no longer required. Every desktop source checkout uses the event SHA.
2. **Outpost validation**, on GitHub-hosted Ubuntu with Node **22 and 24**, runs
   the mocked CLI/release tests and existing package checks before desktop setup.
   These bundle shared JavaScript services/notices, enforce pinned
   `node-pty@1.2.0-beta.15` plus bundled `node-addon-api`, reject additional runtime
   dependencies, verify licenses, and install offline with an empty npm cache
   and scripts disabled. The installed native PTY and mocked Codex/federation
   flows are exercised without credentials or model requests. Generated notices
   remain in the tested tarball; desktop notices retain their own dependency
   scope. Node 24's exact tarball/`pack.json` are retained for **90 days** and its
   SHA-512 integrity is exported independently as a job output. The staged npm
   manifest contains `pwragentRelease: { tag, commit }` for source verification.
3. Existing **desktop build/test/signing and publication** jobs run with their
   existing environment approvals and permissions. Outpost cannot publish before
   all-platform desktop assets and changelog notes have been published.
4. **Outpost publication** always follows successful desktop publication. It is
   gated by `npm-pwragent` review, uses GitHub-hosted Ubuntu/Node 24, and alone
   receives job-scoped `id-token: write` (`contents: read`). It installs no
   dependencies and rebuilds nothing. It rechecks the remote tag SHA, source,
   independently recorded tarball integrity, packed manifest, public ownership
   and channel state. npm **>=11.5.1**, OIDC and `--provenance --ignore-scripts
   --access public --registry https://registry.npmjs.org` are required. There is
   no publish path on a PR, ordinary branch push, fork or arbitrary dispatch ref.
5. Publication is verified against public npm metadata before a success receipt
   is written. `outpost-release-receipt` records version, tag, source commit,
   integrity, channel and `published` or `verified-existing`. The always-running
   **Verify desktop and Outpost release completion** job fails if prerequisites,
   validation, desktop publication or npm publication failed/skipped/cancelled.

## Partial failures and retries

GitHub Releases and npm are independent services. There is **no cross-service
transaction**. Desktop publication comes first so a failed desktop build cannot
publish a usable Outpost version for an absent desktop. The tradeoff is that
desktop assets/notes can be visible while npm is awaiting approval or has failed.
That state is **incomplete**, never evidence that Outpost shipped. Do not promote
the desktop release or report shared-release success until the completion job
and npm receipt are successful. A denied approval or authentication failure does
not automatically unpublish/delete either service's artifacts.

- If preflight fails, follow its named migration/source guard error before
  rerunning; do not weaken branch policies, permissions or ownership checks.
- If npm fails (including an ambiguous network response), the job fails even if
  the server might have accepted the write. Inspect registry metadata, then rerun
  the **failed jobs of the original release run**. This preserves successful
  desktop jobs and the original tested tarball/job integrity output, and requires
  any applicable environment approval again. No CLI dispatch/tag is needed.
- An occupied version is accepted only if registry **SHA-512 integrity**, packed
  source tag/commit metadata and npm's **SLSA provenance marker** match the tested
  release, with a valid channel at or ahead of it. This is an authenticated public
  registry comparison, not independent cryptographic verification of the Sigstore
  bundle. That retry reports `verified-existing` and makes **no npm mutation**.
  A later channel version is not rolled back.
- Different bytes/source, absent provenance, a channel behind the occupied
  version, missing/expired artifacts or an unavailable registry are blockers.
  Inspect the original run and restore its original tested artifact when possible;
  otherwise cut a new **desktop and Outpost** version together. Never overwrite
  an immutable npm version, move the release tag, delete a published version,
  rebuild-and-assume equivalence, change trust or use a token as automatic recovery.
  A full rerun/recovery dispatch may rebuild and passes only if those bytes still
  match an already occupied version. Artifact expiry is not permission to relax
  integrity checks. Same-tag runs and all npm publish jobs use
  [queued concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
  (`queue: max`, no cancellation), preventing workflow publishes from racing npm
  channel guards. Authorize versions in order: a newer version published first
  makes an older unpublished version fail the channel guard, never roll it back.

After completion compare registry metadata with the receipt and retained pack:

```sh
npm view pwragent@1.4.0-alpha.1 version pwragentRelease dist.integrity dist.attestations --json
npm view pwragent dist-tags --json
```

Verify provenance links and a clean exact-version installation on the target
host, following [the package README](../packages/pwragent/README.md) for Node,
separate Codex authentication, explicit service provisioning and restart/update
behavior. This implementation does not provision an Outpost or authenticate Codex.
