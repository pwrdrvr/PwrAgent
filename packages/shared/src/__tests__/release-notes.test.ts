import { describe, expect, it } from "vitest";
import {
  PWRAGENT_RELEASES_URL,
  PWRAGENT_REPO_URL,
  releaseNotesUrl,
} from "../release-notes";

describe("releaseNotesUrl", () => {
  it("composes the tag page for a bare version", () => {
    // What `AppUpdateStatus` carries: electron-updater's `updateInfo.version`
    // and `app.getVersion()` are both unprefixed.
    expect(releaseNotesUrl("1.0.6")).toBe(
      "https://github.com/pwrdrvr/PwrAgent/releases/tag/v1.0.6",
    );
  });

  it("accepts a tag, because the release feed carries one", () => {
    // `AppUpdateReleaseInfo.version` holds GitHub's `tag_name` verbatim, so
    // the slot matrix hands this side of the seam in.
    expect(releaseNotesUrl("v1.0.6")).toBe(
      "https://github.com/pwrdrvr/PwrAgent/releases/tag/v1.0.6",
    );
    expect(releaseNotesUrl("V1.0.6")).toBe(
      "https://github.com/pwrdrvr/PwrAgent/releases/tag/v1.0.6",
    );
  });

  it("composes the prerelease tags the beta train actually publishes", () => {
    // Real tags from this repository, not invented shapes.
    expect(releaseNotesUrl("1.1.0-beta.1")).toBe(
      "https://github.com/pwrdrvr/PwrAgent/releases/tag/v1.1.0-beta.1",
    );
    expect(releaseNotesUrl("v1.1.0-alpha.5")).toBe(
      "https://github.com/pwrdrvr/PwrAgent/releases/tag/v1.1.0-alpha.5",
    );
    expect(releaseNotesUrl("v1.0.2-prerelease.2")).toBe(
      "https://github.com/pwrdrvr/PwrAgent/releases/tag/v1.0.2-prerelease.2",
    );
  });

  it("escapes build metadata, which GitHub would otherwise read as a space", () => {
    expect(releaseNotesUrl("1.0.6+build.3")).toBe(
      "https://github.com/pwrdrvr/PwrAgent/releases/tag/v1.0.6%2Bbuild.3",
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(releaseNotesUrl("  v1.0.6 ")).toBe(
      "https://github.com/pwrdrvr/PwrAgent/releases/tag/v1.0.6",
    );
  });

  it("answers nothing for a version this repository could not have tagged", () => {
    // Every one of these reaches a real surface. `undefined` is what makes
    // `ReleaseNotesLink` render nothing instead of a link onto a 404.
    for (const version of [
      undefined,
      null,
      "",
      "   ",
      // `runAppUpdateCheck` logs this when electron-updater answers with no
      // `updateInfo`.
      "unknown",
      // The slot matrix's own empty-slot copy, never a version.
      "Unavailable",
      "Loading…",
      "1.0",
      "1.0.6.1",
      "v",
      "latest",
    ]) {
      expect(releaseNotesUrl(version)).toBeUndefined();
    }
  });

  it("refuses versions crafted to escape the tag path", () => {
    // The anchored pattern is the whole defense. Without it each of these
    // would compose a URL that is still https://github.com and would still
    // pass `isSafeExternalOpenUrl`, because that gate checks the scheme and
    // not the path.
    for (const version of [
      "1.0.6/../../pwrdrvr/PwrAgent/settings",
      "1.0.6?x=1",
      "1.0.6#frag",
      "1.0.6 1.0.7",
      "../../../evil",
      "https://evil.example.com",
      "javascript:alert(1)",
      "1.0.6%2F..",
      // A leading `v` is stripped once, not repeatedly — `vv1.0.6` is not a
      // tag this repository has ever published.
      "vv1.0.6",
    ]) {
      expect(releaseNotesUrl(version)).toBeUndefined();
    }
  });

  it("keeps the two constants on the repository the update feed reads", () => {
    // `auto-updater.ts` reads api.github.com/repos/pwrdrvr/PwrAgent and
    // electron-builder publishes to the same repo. A link that pointed
    // somewhere else would describe a build the app cannot install.
    expect(PWRAGENT_REPO_URL).toBe("https://github.com/pwrdrvr/PwrAgent");
    expect(PWRAGENT_RELEASES_URL).toBe(
      "https://github.com/pwrdrvr/PwrAgent/releases",
    );
  });
});
