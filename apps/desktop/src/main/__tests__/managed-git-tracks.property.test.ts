import { expect, it } from "vitest";
import { selectManagedGitReleases } from "../managed-git-verify";
import { FIXTURE_BUNDLED_VERSION } from "./helpers/managed-git-fixture";

it("normalizes all 256 raw release-flag combinations to the promotion oracle without payload fixtures", () => {
  // GitHub's boolean false alone promotes a build. The other raw values all
  // mean prerelease; their normalization needs no archive or persisted check.
  const flags = [true, false, undefined, "false"];
  const versions = [5, 6, 7, 8].map(build => `2.56.0-dev-pwrgit.${build}`);
  const releases = versions.map(version => ({
    tag_name: `v${version}`,
    draft: false,
    assets: ["runtime-manifest.json", "SHA256SUMS"].map(name => ({
      name,
      browser_download_url: `https://github.com/huntharo/git/releases/download/v${version}/${name}`,
      size: 1,
    })),
  }));
  for (let mask = 0; mask < flags.length ** versions.length; mask++) {
    const assignment = versions.map((_, index) => flags[Math.floor(mask / flags.length ** index) % flags.length]);
    const selected = selectManagedGitReleases(releases.map((release, index) => ({
      ...release,
      ...(assignment[index] === undefined ? {} : { prerelease: assignment[index] }),
    })), FIXTURE_BUNDLED_VERSION);
    expect(selected.map(release => ({ version: release.version, promoted: release.promoted })), JSON.stringify(assignment))
      .toEqual(versions.map((version, index) => ({ version, promoted: assignment[index] === false })).reverse());
  }
});
