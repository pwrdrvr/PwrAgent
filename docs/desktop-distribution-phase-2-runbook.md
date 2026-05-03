# Desktop Distribution Phase 2 Runbook

> Closed-source preview. Copyright © 2026 PwrDrvr LLC.
>
> Origin: [docs/plans/2026-05-02-004-feat-desktop-release-packaging-plan.md](plans/2026-05-02-004-feat-desktop-release-packaging-plan.md)

This runbook covers migrating the desktop auto-update channel from Phase 1
(solo dogfooding through the existing private `pwrdrvr/PwrAgnt` GitHub repo,
with a runtime-injected `GH_TOKEN`) to Phase 2 (no token required, multiple
external testers can install).

> **Decision deadline:** Phase 2 must be chosen and migrated **before any
> external test user is onboarded.** During Phase 1 the only consumer of the
> auto-update feed is the developer running the binary on their own Mac. Phase
> 2 is the gate to growing past that.

---

## The three Phase 2 channels

Pick exactly one. All three end with `latest-mac.yml` + `.zip` reachable at a
public URL; the only differences are who hosts and how access is controlled.

### Option A — Open-source the source repo

Make `pwrdrvr/PwrAgnt` public. GitHub Releases attached to a public repo are
public-readable, so `electron-updater` no longer needs a token.

Required changes:
- `electron-builder.yml` `publish:` → set `private: false`
- Remove the runtime `GH_TOKEN` requirement from
  `apps/desktop/src/main/auto-updater.ts` (it becomes a no-op for public repos)
- Update `package.json` `license` to whatever OSS license is chosen, drop
  `UNLICENSED`, add an OSS LICENSE file, rewrite the README

Trade-offs:
- ✅ Zero infra change beyond toggling repo visibility.
- ✅ No second repo, no S3 bucket, no secret to rotate.
- ✅ Update channel works for everyone with no token plumbing.
- ❌ Source becomes public. This is a strategic product decision, not just a
  distribution decision. Coordinate separately with PwrDrvr LLC.

### Option B — Public release-only repo (recommended default)

Keep `pwrdrvr/PwrAgnt` private. Create a new public repo `pwrdrvr/PwrAgnt-Releases`
that holds *only* a README, the LICENSE/EULA, and GitHub Releases with the
signed artifacts. `electron-updater` points at the public repo. This is what
Hyper, early Linear, and several other closed-source Electron apps use.

Required changes:
- Create the public repo. Push a small README that says "Release artifacts for
  PwrAgnt. Source is proprietary."
- `electron-builder.yml` `publish:` →
  ```yaml
  publish:
    provider: github
    owner: pwrdrvr
    repo: PwrAgnt-Releases
    private: false
    releaseType: release
  ```
- `release.yml` workflow: change `RELEASES_PAT` to a fine-grained PAT with
  `Contents: Read and Write` scoped to `pwrdrvr/PwrAgnt-Releases` only.
- Mirror existing v0.x.0 / v1.0.x releases into the new repo so any installed
  Phase-1 binary that points at the new feed (after the bridge release lands)
  finds the expected versions.
- Remove the runtime `GH_TOKEN` requirement from `auto-updater.ts`.

Trade-offs:
- ✅ Source stays private; binaries are public.
- ✅ Cost: $0. GitHub-hosted, no infra to run.
- ✅ Conventional pattern; many closed-source apps use it.
- ❌ Two repos to keep coordinated (release tags must be cut on the public
  repo even though source lives in the private one).

### Option C — Generic provider on R2 / CloudFront / S3

Host artifacts on object storage with a static URL. `electron-updater` uses
the `generic` provider.

Required changes:
- Provision the bucket (Cloudflare R2 is the recommended default in 2026 —
  zero egress fees, ~$0.015/GB stored, dominates GitHub Pages and S3 on cost).
- Add a CloudFront / Cloudflare Worker in front of the bucket for caching +
  optional access control.
- `electron-builder.yml` `publish:` →
  ```yaml
  publish:
    provider: generic
    url: https://updates.pwragnt.com/${channel}
    channel: latest
    useMultipleRangeRequest: true
  ```
- `release.mjs` upload step: replace `--publish always` with a manual rclone
  copy of `dist/*.dmg`, `dist/*.zip`, `dist/*.blockmap`, `dist/latest-mac.yml`
  to the bucket. `compound-engineering:rclone` skill can do this.
- Cache headers: `latest-mac.yml` ≤ 60s; `.zip` and `.dmg` for a year, busted
  by version.

Trade-offs:
- ✅ Total control: signed URLs, geo restrictions, custom CDN behavior.
- ✅ No GitHub rate limits, no token in any binary.
- ✅ Cleanest if you ever go to public unauthenticated downloads.
- ❌ Requires standing up bucket + CDN + DNS.
- ❌ Cost: ~$1–5/month at any reasonable scale. Effectively free with R2.

---

## Bridge-release mechanics

The auto-update feed URL is baked into the app **at build time**. An installed
Phase-1 binary will keep checking the old (private repo) feed forever until it
installs a version pointing at the new feed.

Practically: cut **one bridge release** that ships from the OLD pipeline but
has the NEW `electron-builder.yml` `publish:` block. After that release lands
through the old feed, every subsequent release flows through the new feed.

For solo Phase 1 (only the developer running the binary), this is irrelevant
— a fresh install picks up the new feed automatically.

---

## Decision-time checklist

Before flipping to Phase 2:

- [ ] One channel (A, B, or C above) chosen and recorded in this doc.
- [ ] If A or B: any OSS license / proprietary repo decisions with PwrDrvr LLC
      are recorded.
- [ ] If C: bucket provisioned, DNS resolves, CDN cache headers set.
- [ ] `auto-updater.ts` updated (token requirement removed if A or B; provider
      changed if C).
- [ ] `electron-builder.yml` `publish:` block updated.
- [ ] `release.yml` GH Actions workflow secrets updated to whatever the new
      pipeline needs.
- [ ] Bridge release cut from the old pipeline pointing at the new feed.
- [ ] Smoke-tested: install the bridge release, then publish a follow-up
      version through the new feed, verify the install detects and applies it.
- [ ] First external test user invitations go out only AFTER the smoke-test
      passes.

---

## Optional: runtime feed-URL override

Phase 2 can be made cheaper by adding a runtime override env var
`PWRAGNT_UPDATE_URL` to the production binary. With it, future feed-URL
migrations are zero-touch: ship a stale binary, point users at the new URL via
a launcher script or LaunchAgent. Low implementation cost (~10 lines in
`auto-updater.ts`); valuable insurance if multiple distribution channel pivots
turn out to be needed. Not implemented in v1.0; flag as defer-if-busy.

---

## Plan / brainstorm references

- Plan: [docs/plans/2026-05-02-004-feat-desktop-release-packaging-plan.md](plans/2026-05-02-004-feat-desktop-release-packaging-plan.md)
- Brainstorm: [docs/brainstorms/2026-05-02-desktop-release-packaging-requirements.md](brainstorms/2026-05-02-desktop-release-packaging-requirements.md)
- Phase 1 release runbook: [docs/desktop-release-runbook.md](desktop-release-runbook.md)
