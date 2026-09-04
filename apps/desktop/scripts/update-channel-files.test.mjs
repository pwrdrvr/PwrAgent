import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  linuxUpdateChannelFile,
  MAC_UPDATE_CHANNEL_FILE,
  RELEASE_UPDATE_CHANNEL_FILES,
  requireUpdateChannelFile,
  verifyPublishedChannelFiles,
  verifyStagedChannelFiles,
  WINDOWS_UPDATE_CHANNEL_FILE,
} from "./update-channel-files.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const releaseWorkflow = readFileSync(
  join(repoRoot, ".github", "workflows", "release.yml"),
  "utf8",
);
const windowsSigningInput = readFileSync(
  join(repoRoot, "scripts", "release", "archive-windows-signing-input.ps1"),
  "utf8",
);

function channelFile(version, artifact) {
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${artifact}`,
    "    sha512: Zm9v",
    "    size: 3",
    `path: ${artifact}`,
    "sha512: Zm9v",
    "releaseDate: '2026-09-03T14:34:59.419Z'",
    "",
  ].join("\n");
}

describe("updater channel file names", () => {
  // electron-updater fetches exactly one of these from the release feed
  // (Provider#getChannelFilePrefix, electron-updater 6.8.9). The exact strings
  // are asserted rather than re-derived: a release missing one answers 404 to
  // every update check on that platform, and that is precisely what happened
  // through v1.1.0-alpha.2.
  it("matches what electron-updater requests per platform", () => {
    expect(MAC_UPDATE_CHANNEL_FILE).toBe("latest-mac.yml");
    expect(WINDOWS_UPDATE_CHANNEL_FILE).toBe("latest.yml");
    expect(linuxUpdateChannelFile("x64")).toBe("latest-linux.yml");
    expect(linuxUpdateChannelFile("arm64")).toBe("latest-linux-arm64.yml");
    expect(RELEASE_UPDATE_CHANNEL_FILES).toEqual([
      "latest-mac.yml",
      "latest.yml",
      "latest-linux.yml",
      "latest-linux-arm64.yml",
    ]);
  });

  // electron-builder's getArchPrefixForUpdateFile spells this one arch "-arm".
  // Rendering it as "-armv7l" would make the packaging check look for a file
  // electron-builder never writes.
  it("spells armv7l the way electron-builder does", () => {
    expect(linuxUpdateChannelFile("armv7l")).toBe("latest-linux-arm.yml");
  });
});

describe("requireUpdateChannelFile", () => {
  let distDir;

  beforeEach(() => {
    distDir = mkdtempSync(join(tmpdir(), "pwragent-channel-files-"));
  });

  afterEach(() => {
    rmSync(distDir, { recursive: true, force: true });
  });

  it("returns the path when the packaging step produced one", () => {
    writeFileSync(join(distDir, "latest.yml"), channelFile("1.2.3", "setup.exe"));
    expect(requireUpdateChannelFile(distDir, "latest.yml")).toBe(
      join(distDir, "latest.yml"),
    );
  });

  it("throws when the packaging step did not", () => {
    expect(() => requireUpdateChannelFile(distDir, "latest.yml")).toThrow(
      /latest\.yml is missing/,
    );
  });
});

describe("verifyStagedChannelFiles", () => {
  let stageDir;
  let macDir;
  let windowsDir;
  let linuxDir;

  function stage(version = "1.1.0-alpha.2") {
    writeFileSync(
      join(macDir, "latest-mac.yml"),
      channelFile(version, "PwrAgent-mac.zip"),
    );
    writeFileSync(join(macDir, "PwrAgent-mac.zip"), "foo");
    writeFileSync(
      join(windowsDir, "latest.yml"),
      channelFile(version, "PwrAgent-setup.exe"),
    );
    writeFileSync(join(windowsDir, "PwrAgent-setup.exe"), "foo");
    writeFileSync(
      join(linuxDir, "latest-linux.yml"),
      channelFile(version, "PwrAgent-amd64.deb"),
    );
    writeFileSync(join(linuxDir, "PwrAgent-amd64.deb"), "foo");
    writeFileSync(
      join(linuxDir, "latest-linux-arm64.yml"),
      channelFile(version, "PwrAgent-arm64.deb"),
    );
    writeFileSync(join(linuxDir, "PwrAgent-arm64.deb"), "foo");
  }

  function verify() {
    return verifyStagedChannelFiles("1.1.0-alpha.2", [macDir, windowsDir, linuxDir]);
  }

  beforeEach(() => {
    stageDir = mkdtempSync(join(tmpdir(), "pwragent-release-stage-"));
    macDir = join(stageDir, "mac-dist");
    windowsDir = join(stageDir, "windows-dist");
    linuxDir = join(stageDir, "linux-dist");
    for (const dir of [macDir, windowsDir, linuxDir]) {
      mkdirSync(dir);
    }
  });

  afterEach(() => {
    rmSync(stageDir, { recursive: true, force: true });
  });

  it("passes on a complete stage", () => {
    stage();
    expect(verify()).toEqual([]);
  });

  // The state every release up to v1.1.0-alpha.2 shipped in.
  it("reports the Windows and Linux channel files as missing", () => {
    stage();
    rmSync(join(windowsDir, "latest.yml"));
    rmSync(join(linuxDir, "latest-linux.yml"));
    rmSync(join(linuxDir, "latest-linux-arm64.yml"));
    expect(verify()).toHaveLength(3);
    expect(verify()[0]).toMatch(/Missing updater channel file latest\.yml/);
  });

  it("reports a channel file left over from another version", () => {
    stage();
    writeFileSync(join(windowsDir, "latest.yml"), channelFile("1.0.9", "PwrAgent-setup.exe"));
    expect(verify()).toEqual([
      expect.stringMatching(/declares version '1\.0\.9', expected '1\.1\.0-alpha\.2'/),
    ]);
  });

  // A channel file that resolves but names an installer nobody uploaded moves
  // the broken update one request later instead of removing it.
  it("reports a channel file naming an artifact that is not staged", () => {
    stage();
    rmSync(join(windowsDir, "PwrAgent-setup.exe"));
    expect(verify()).toEqual([
      expect.stringMatching(/names PwrAgent-setup\.exe, which is not staged beside it/),
    ]);
  });
});

describe("verifyPublishedChannelFiles", () => {
  it("accepts a release carrying every channel file", () => {
    expect(
      verifyPublishedChannelFiles([
        "PwrAgent.dmg",
        ...RELEASE_UPDATE_CHANNEL_FILES,
      ]),
    ).toEqual([]);
  });

  // The real v1.1.0-alpha.2 asset list.
  it("rejects the release shape this pipeline used to publish", () => {
    expect(
      verifyPublishedChannelFiles([
        "builder-debug.yml",
        "latest-mac.yml",
        "PwrAgent-1.1.0-alpha.2-windows-x64-setup.exe",
        "PwrAgent.dmg",
      ]),
    ).toEqual([
      "Release is missing updater channel file latest.yml",
      "Release is missing updater channel file latest-linux.yml",
      "Release is missing updater channel file latest-linux-arm64.yml",
    ]);
  });

  it("does not accept an asset that merely ends with a channel file name", () => {
    expect(
      verifyPublishedChannelFiles([
        "latest-mac.yml",
        "PwrAgent-latest.yml",
        "latest-linux.yml",
        "latest-linux-arm64.yml",
      ]),
    ).toEqual(["Release is missing updater channel file latest.yml"]);
  });
});

describe("release pipeline wiring", () => {
  // electron-builder writes the channel file during packaging, so the only way
  // it goes missing is an artifact glob that does not name it. That is the
  // defect this whole module exists to prevent from recurring.
  it("collects the Windows and Linux channel files into the publication artifacts", () => {
    expect(releaseWorkflow).toContain("apps/desktop/release-stage/dist/latest.yml");
    expect(releaseWorkflow).toContain("apps/desktop/release-stage/dist/latest-linux*.yml");
    expect(releaseWorkflow).toContain("linux-dist/latest-linux*.yml");
  });

  it("runs both release checks through this module", () => {
    expect(releaseWorkflow).toContain(
      "node apps/desktop/scripts/update-channel-files.mjs \\\n            verify-staged",
    );
    expect(releaseWorkflow).toContain(
      "node apps/desktop/scripts/update-channel-files.mjs \\\n            verify-published",
    );
  });

  // Neither signing job checks out the repository; each receives an explicit
  // allowlist of scripts. A module release.mjs imports that is missing from
  // either list crashes that job on import.
  it("ships this module to both signing jobs", () => {
    expect(releaseWorkflow).toContain("apps/desktop/scripts/update-channel-files.mjs \\");
    expect(windowsSigningInput).toContain(
      '"apps/desktop/scripts/update-channel-files.mjs"',
    );
  });
});
