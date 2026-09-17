// Where a version's release notes live, and the one place that composes the
// URL.
//
// PwrAgent publishes every build as a GitHub Release, and the notes for a
// version are on that release's page. Nothing in the app could reach them
// before this module: Settings -> About's "Open changelog" reads the
// CHANGELOG that shipped INSIDE the running build, which by construction
// says nothing about the version being offered to you — a v1.0.6 install
// cannot carry v1.1.0's notes. So every surface that names a version also
// needs a way out to the published page, and they all compose it here so
// they cannot disagree.
//
// The URL is DERIVED from the version rather than read from the feed, even
// though `AppUpdateReleaseInfo.url` carries GitHub's own `html_url` for the
// four published slots. Two reasons:
//
//   - The status surfaces have no feed record to read. `AppUpdateStatus`
//     carries a bare version through checking/available/downloading/
//     downloaded/canceled, and plumbing a URL onto every one of those
//     transitions — including the ones electron-updater raises, which never
//     saw `readAppUpdateReleaseVersions`' GitHub read — is a lot of wire for
//     a string that is a pure function of the version.
//   - `html_url` is remote data. `isSafeExternalOpenUrl` would still gate it
//     on scheme, but that gate admits every https origin; a URL we compose
//     from a version we already trust needs no such argument.
//
// Deriving is exact because the release tag IS `v` + the version. Every tag
// this repository has published matches — v1.0.6, v1.1.0-beta.1,
// v1.1.0-alpha.5, v1.0.2-prerelease.2 — `readAppUpdateReleaseVersions` in
// main/auto-updater.ts recovers the version by stripping exactly that `v`,
// and `electron-builder.yml` publishes to `pwrdrvr/PwrAgent`.

/** PwrAgent's public source repository. The local checkout is `PwrAgnt`;
 *  the GitHub repository, the update feed, and the release tags are all
 *  `PwrAgent`. */
export const PWRAGENT_REPO_URL = "https://github.com/pwrdrvr/PwrAgent";

/** Every published build, newest first — where a caller points when it has
 *  no single version to name. */
export const PWRAGENT_RELEASES_URL = `${PWRAGENT_REPO_URL}/releases`;

/** Tag shape the release lane publishes: `1.2.3`, `1.2.3-beta.4`, with an
 *  optional `+build` suffix. Anchored, so a version carrying a path
 *  separator, a scheme, or a query cannot reach the template below. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The GitHub release page for one version, or `undefined` when the version
 * is not one this repository could have tagged.
 *
 * Accepts a bare version (`1.1.0`, as `AppUpdateStatus` carries it) or a tag
 * (`v1.1.0`, as `AppUpdateReleaseInfo.version` carries it — that field holds
 * GitHub's `tag_name` verbatim), so a caller never has to know which side of
 * that seam its string came from.
 *
 * Returning `undefined` rather than a best-effort URL is the point: a link
 * that isn't there is a smaller failure than one that lands on a 404. The
 * strings that actually reach these surfaces without being a version are the
 * `"unknown"` `runAppUpdateCheck` falls back to when electron-updater
 * answers with no `updateInfo`, the slot matrix's own `Loading…` /
 * `Unavailable` headlines, and a hand-edited config.
 *
 * What this cannot tell apart, and deliberately does not try to: a
 * semver-shaped version that was never tagged. A local build carries
 * `apps/desktop/package.json`'s version, which is semver, so it gets a link
 * whether or not that tag is published yet. Answering otherwise would mean
 * asking GitHub, which is exactly the per-surface feed read the header
 * rejects — and a developer running an untagged build is the one reader who
 * can tell a 404 for what it is.
 */
export function releaseNotesUrl(
  version: string | undefined | null,
): string | undefined {
  if (typeof version !== "string") {
    return undefined;
  }
  const tag = version.trim().replace(/^v/i, "");
  if (!SEMVER.test(tag)) {
    return undefined;
  }
  // Everything SEMVER admits is already URL-safe except `+`, which has to be
  // escaped or GitHub reads it as a space.
  return `${PWRAGENT_REPO_URL}/releases/tag/v${encodeURIComponent(tag)}`;
}
