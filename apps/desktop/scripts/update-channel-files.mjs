#!/usr/bin/env node
/**
 * The electron-updater channel files a PwrAgent release must carry.
 *
 * `configureAutoUpdaterFeedForRelease` points electron-updater at a `generic`
 * feed rooted at one release's download directory, and electron-updater then
 * fetches exactly one file name from it, chosen by platform (Provider
 * #getChannelFilePrefix in electron-updater 6.8.9). A release that does not
 * carry the file for a platform answers 404 to every update check there.
 *
 * The name stays `latest` even for a prerelease version: electron-builder
 * derives a channel from the version's prerelease tag only for the `generic`
 * publish provider, and electron-builder.yml publishes through `github`.
 * Verified against electron-builder 26.15.7 at version 1.1.0-alpha.2 — the deb,
 * nsis, and mac targets each wrote a `latest*.yml`, never an `alpha*.yml`.
 *
 * release.mjs imports these names for its per-platform packaging checks and the
 * release workflow runs this file as a CLI for its pre- and post-publish checks,
 * so the two cannot drift. Both signing jobs receive an explicit allowlist of
 * scripts rather than a checkout, so this file is listed in the macOS `Archive
 * signing input` step and in scripts/release/archive-windows-signing-input.ps1;
 * a new import from release.mjs has to be added to both.
 *
 * Usage:
 *   node update-channel-files.mjs verify-staged --version <version> <dir>...
 *   node update-channel-files.mjs verify-published <asset-name-file>
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAC_UPDATE_CHANNEL_FILE = "latest-mac.yml";
export const WINDOWS_UPDATE_CHANNEL_FILE = "latest.yml";

// electron-builder's getArchPrefixForUpdateFile omits the suffix for x64 and
// spells armv7l `-arm`, not `-armv7l`. electron-updater derives the same name
// from `process.arch` at runtime.
export function linuxUpdateChannelFile(arch) {
  if (arch === "x64") {
    return "latest-linux.yml";
  }
  if (arch === "armv7l") {
    return "latest-linux-arm.yml";
  }
  return `latest-linux-${arch}.yml`;
}

// Every channel file one published release must carry, across the platforms and
// architectures electron-builder.yml targets.
export const RELEASE_UPDATE_CHANNEL_FILES = [
  MAC_UPDATE_CHANNEL_FILE,
  WINDOWS_UPDATE_CHANNEL_FILE,
  linuxUpdateChannelFile("x64"),
  linuxUpdateChannelFile("arm64"),
];

// electron-builder writes the channel file as a side effect of packaging, not
// of publishing, so a `--publish=never` build still produces one. A missing file
// means the running app would fetch a 404 from the release feed and every update
// check on that platform would fail, so fail the build instead.
export function requireUpdateChannelFile(distDir, name) {
  const channelFilePath = join(distDir, name);
  if (!existsSync(channelFilePath)) {
    throw new Error(
      `electron-updater channel file ${name} is missing from ${distDir}. `
        + "Auto-update cannot resolve an update without it.",
    );
  }
  return channelFilePath;
}

function unquote(value) {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// electron-builder serializes the channel file with a top-level `version:` and
// one `- url:` entry per artifact the update can install. Reading those two
// fields line-by-line keeps this script dependency-free; the signing jobs get an
// allowlist of scripts and no node_modules of their own.
export function readChannelFileVersion(channelFilePath) {
  for (const line of readFileSync(channelFilePath, "utf8").split("\n")) {
    if (line.startsWith("version:")) {
      return unquote(line.slice("version:".length));
    }
  }
  return undefined;
}

export function readChannelFileArtifacts(channelFilePath) {
  const artifacts = [];
  for (const line of readFileSync(channelFilePath, "utf8").split("\n")) {
    const match = /^\s*-\s+url:\s*(.+)$/.exec(line);
    if (match) {
      artifacts.push(unquote(match[1]));
    }
  }
  return artifacts;
}

function findChannelFile(name, directories) {
  for (const directory of directories) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Check the staged release payload before a GitHub Release exists: every channel
 * file is present in one of `directories`, declares `version`, and names only
 * artifacts staged beside it. The last part matters because a channel file that
 * resolves but names a missing installer moves the broken update one request
 * later instead of removing it.
 */
export function verifyStagedChannelFiles(version, directories) {
  const problems = [];
  for (const name of RELEASE_UPDATE_CHANNEL_FILES) {
    const channelFilePath = findChannelFile(name, directories);
    if (!channelFilePath) {
      problems.push(`Missing updater channel file ${name} in ${directories.join(", ")}`);
      continue;
    }
    const declared = readChannelFileVersion(channelFilePath);
    if (declared !== version) {
      problems.push(
        `${channelFilePath} declares version '${declared ?? ""}', expected '${version}'`,
      );
      continue;
    }
    for (const artifact of readChannelFileArtifacts(channelFilePath)) {
      if (!existsSync(join(dirname(channelFilePath), artifact))) {
        problems.push(`${channelFilePath} names ${artifact}, which is not staged beside it`);
      }
    }
  }
  return problems;
}

/**
 * Check the created GitHub Release. An asset that failed to upload leaves the
 * release looking complete while auto-update stays broken on that platform,
 * which is how latest.yml went missing from every release up to v1.1.0-alpha.2.
 */
export function verifyPublishedChannelFiles(assetNames) {
  const uploaded = new Set(assetNames);
  return RELEASE_UPDATE_CHANNEL_FILES.filter((name) => !uploaded.has(name)).map(
    (name) => `Release is missing updater channel file ${name}`,
  );
}

function fail(problems) {
  for (const problem of problems) {
    console.error(`::error::${problem}`);
  }
  process.exit(1);
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "verify-staged") {
    const versionIndex = rest.indexOf("--version");
    const version = versionIndex === -1 ? undefined : rest[versionIndex + 1];
    if (!version) {
      fail(["verify-staged requires --version <version>"]);
    }
    const directories = rest.filter(
      (arg, index) => index !== versionIndex && index !== versionIndex + 1,
    );
    if (directories.length === 0) {
      fail(["verify-staged requires at least one directory"]);
    }
    const problems = verifyStagedChannelFiles(version, directories);
    if (problems.length > 0) {
      fail(problems);
    }
    for (const name of RELEASE_UPDATE_CHANNEL_FILES) {
      console.log(`ok: ${name} (${version})`);
    }
    return;
  }
  if (command === "verify-published") {
    const [assetNameFile] = rest;
    if (!assetNameFile) {
      fail(["verify-published requires a file of asset names, one per line"]);
    }
    const assetNames = readFileSync(assetNameFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const problems = verifyPublishedChannelFiles(assetNames);
    if (problems.length > 0) {
      fail(problems);
    }
    console.log(`ok: release carries all ${RELEASE_UPDATE_CHANNEL_FILES.length} channel files`);
    return;
  }
  fail([`Unknown command ${JSON.stringify(command ?? "")}`]);
}

const invokedDirectly =
  process.argv[1] != null
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2));
}
