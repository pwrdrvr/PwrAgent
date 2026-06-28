import { describe, expect, it } from "vitest";

import { extractReleaseNotes } from "./extract-release-notes.mjs";

describe("extractReleaseNotes", () => {
  it("extracts a matching v-prefixed changelog section", () => {
    const changelog = [
      "# Changelog",
      "",
      "## v1.0.0-beta.21 - 2026-06-27",
      "",
      "- Desktop - Published release notes automatically.",
      "- Release - Verified non-empty body after upload.",
      "",
      "## v1.0.0-beta.20 - 2026-06-20",
      "",
      "- Prior release.",
      "",
    ].join("\n");

    expect(extractReleaseNotes(changelog, "v1.0.0-beta.21")).toBe(
      [
        "- Desktop - Published release notes automatically.",
        "- Release - Verified non-empty body after upload.",
        "",
      ].join("\n"),
    );
  });

  it("extracts a matching unprefixed changelog section", () => {
    const changelog = [
      "# Changelog",
      "",
      "## 1.2.3 - 2026-06-27",
      "",
      "- Release - Accepted headings without a leading v.",
      "",
      "## 1.2.2 - 2026-06-20",
      "- Prior release.",
    ].join("\n");

    expect(extractReleaseNotes(changelog, "v1.2.3")).toBe(
      "- Release - Accepted headings without a leading v.\n",
    );
  });

  it("does not match prerelease headings for a stable tag", () => {
    const changelog = [
      "# Changelog",
      "",
      "## v1.0.0-beta.1 - 2026-06-20",
      "",
      "- Beta notes.",
      "",
    ].join("\n");

    expect(extractReleaseNotes(changelog, "v1.0.0")).toBe("");
  });

  it("returns an empty string when the matching section has no notes", () => {
    const changelog = [
      "# Changelog",
      "",
      "## v1.0.0 - 2026-06-27",
      "",
      "",
      "## v0.9.0 - 2026-06-20",
      "- Prior release.",
    ].join("\n");

    expect(extractReleaseNotes(changelog, "v1.0.0")).toBe("");
  });
});
