import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
);
const releaseScript = readFileSync(
  join(repoRoot, "apps", "desktop", "scripts", "release.mjs"),
  "utf8",
);
const releaseWorkflow = readFileSync(
  join(repoRoot, ".github", "workflows", "release.yml"),
  "utf8",
);

// `configureAutoUpdaterFeedForRelease` points electron-updater at one release's
// download directory, and electron-updater then fetches exactly one file name
// from it, chosen by platform (Provider#getChannelFilePrefix, electron-updater
// 6.8.9). A release that does not carry the file for a platform answers 404 to
// every update check there, which is how Windows auto-update stayed broken
// through v1.1.0-alpha.2: electron-builder wrote `latest.yml` during packaging,
// and the workflow artifact globs dropped it before publication.
//
// The names carry no prerelease suffix. electron-builder derives a channel from
// the version's prerelease tag only for the `generic` publish provider, and
// electron-builder.yml publishes through `github`.
const CHANNEL_FILES = [
  "latest-mac.yml",
  "latest.yml",
  "latest-linux.yml",
  "latest-linux-arm64.yml",
];

function workflowStepBody(name: string): string {
  const start = releaseWorkflow.indexOf(`- name: ${name}`);
  expect(start, `release.yml is missing the "${name}" step`).toBeGreaterThan(-1);
  const next = releaseWorkflow.indexOf("\n      - name: ", start + 1);
  return releaseWorkflow.slice(start, next === -1 ? undefined : next);
}

describe("updater channel files", () => {
  // The packaging jobs run electron-builder with `--publish=never`, so nothing
  // downstream would notice a missing channel file. Fail at the source instead.
  it("fails each packaging job when its channel file is missing", () => {
    expect(releaseScript).toContain(
      "requireUpdateManifest(dist, WINDOWS_UPDATE_MANIFEST)",
    );
    expect(releaseScript).toContain(
      "requireUpdateManifest(dist, linuxUpdateManifestName(currentLinuxBuilderArch()))",
    );
    expect(releaseScript).toContain('requireUpdateManifest(dist, "latest-mac.yml")');
  });

  it("derives the same per-platform names electron-updater requests", () => {
    expect(releaseScript).toContain('const WINDOWS_UPDATE_MANIFEST = "latest.yml"');
    expect(releaseScript).toContain(
      'return arch === "x64" ? "latest-linux.yml" : `latest-linux-${arch}.yml`;',
    );
  });

  // Each packaging job hands its dist files to the publication job through a
  // workflow artifact. An upload glob that does not name the channel file drops
  // it silently.
  it("collects the Windows and Linux channel files into the publication artifacts", () => {
    expect(workflowStepBody("Upload Windows installer artifact")).toContain(
      "apps/desktop/release-stage/dist/latest.yml",
    );
    expect(workflowStepBody("Upload Linux package artifact")).toContain(
      "apps/desktop/release-stage/dist/latest-linux*.yml",
    );
  });

  it("attaches the Linux channel files to the created release", () => {
    expect(workflowStepBody("Create release and publish all platform assets")).toContain(
      "linux-dist/latest-linux*.yml",
    );
  });

  it("checks every platform channel file before publishing", () => {
    const step = workflowStepBody("Verify updater channel files");
    for (const channelFile of CHANNEL_FILES) {
      expect(step, `pre-publish check does not cover ${channelFile}`).toContain(
        channelFile,
      );
    }
  });

  it("re-checks every platform channel file on the created release", () => {
    const step = workflowStepBody("Create release and publish all platform assets");
    const loop = step.slice(step.indexOf("for channel_file in latest-mac.yml"));
    expect(loop).not.toHaveLength(0);
    for (const channelFile of CHANNEL_FILES) {
      expect(loop, `post-publish check does not cover ${channelFile}`).toContain(
        channelFile,
      );
    }
  });
});
