#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

export const SOURCE_REPO = "pwrdrvr/PwrAgent";
export const TAP_REPO = "pwrdrvr/homebrew-tap";
export const WINGET_REPO = "microsoft/winget-pkgs";
export const PACKAGE_ID = "PwrDrvr.PwrAgent";
export const WINGET_PATH = "manifests/p/PwrDrvr/PwrAgent";
export const SCHEMA_VERSION = "1.12.0";

export function ghJson(endpoint, optional = false) {
  const result = spawnSync("gh", ["api", endpoint], { encoding: "utf8" });
  if (result.status !== 0) {
    // An authentication, rate-limit or network failure is never absence.
    if (optional && /HTTP 404/.test(result.stderr)) return null;
    throw new Error(`GitHub API ${endpoint}: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

export function stableVersion(release) {
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
    throw new Error("Package channels require a published, promoted, suffix-free stable release");
  }
  return release.tag_name.slice(1);
}

export function compareVersions(left, right) {
  if (![left, right].every((v) => /^\d+\.\d+\.\d+$/.test(v))) {
    throw new Error(`Cannot compare stable versions: ${left}, ${right}`);
  }
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  }
  return 0;
}

export function releaseAssets(release) {
  const version = stableVersion(release);
  const names = [
    `PwrAgent-${version}-arm64.dmg`,
    `PwrAgent-${version}-universal.dmg`,
    `PwrAgent-${version}-windows-x64-setup.exe`,
    "PwrAgent-macos-SHA256SUMS",
    "PwrAgent-windows-SHA256SUMS",
  ];
  return names.map((name) => {
    const matches = release.assets.filter((asset) => asset.name === name);
    if (matches.length !== 1) throw new Error(`Expected exactly one released asset: ${name}`);
    const asset = matches[0];
    const expected = `https://github.com/${SOURCE_REPO}/releases/download/${release.tag_name}/${name}`;
    if (asset.browser_download_url !== expected || !(asset.size > 0)) {
      throw new Error(`Unexpected URL or size for ${name}`);
    }
    return asset;
  });
}

export function checksumFor(contents, name) {
  const matches = contents.split(/\r?\n/).filter((line) => line.endsWith(`  ${name}`));
  if (matches.length !== 1 || !/^[a-f0-9]{64}  /.test(matches[0])) {
    throw new Error(`Missing, duplicate or invalid published checksum for ${name}`);
  }
  return matches[0].slice(0, 64);
}

export async function verifyFile(file, asset, checksum) {
  if ((await stat(file)).size !== asset.size) throw new Error(`Size mismatch for ${asset.name}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const actual = hash.digest("hex");
  if (actual !== checksum || (asset.digest && asset.digest !== `sha256:${actual}`)) {
    throw new Error(`SHA-256 mismatch for ${asset.name}`);
  }
  return actual;
}

export function renderPackages(release, hashes) {
  const version = stableVersion(release);
  const base = `https://github.com/${SOURCE_REPO}/releases/download/v${version}`;
  const arm = hashes[`PwrAgent-${version}-arm64.dmg`];
  const intel = hashes[`PwrAgent-${version}-universal.dmg`];
  const windows = hashes[`PwrAgent-${version}-windows-x64-setup.exe`];
  if (![arm, intel, windows].every((sha) => /^[a-f0-9]{64}$/.test(sha))) {
    throw new Error("All architecture checksums must be verified before rendering");
  }
  const cask = `# frozen_string_literal: true

cask "pwragent" do
  arch arm: "arm64", intel: "universal"

  version "${version}"
  sha256 arm:   "${arm}",
         intel: "${intel}"

  url "https://github.com/${SOURCE_REPO}/releases/download/v#{version}/PwrAgent-#{version}-#{arch}.dmg"
  name "PwrAgent"
  desc "Thread-centric coding agent desktop app"
  homepage "https://pwragent.ai/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :monterey

  app "PwrAgent.app"

  # Preserve ~/.pwragent: it contains profiles, secrets and thread state.
end
`;
  const header = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${SCHEMA_VERSION}.schema.json\nPackageIdentifier: ${PACKAGE_ID}\nPackageVersion: ${version}\n`;
  const footer = (type) => `ManifestType: ${type}\nManifestVersion: ${SCHEMA_VERSION}\n`;
  const files = {
    "Casks/pwragent.rb": cask,
    [`${WINGET_PATH}/${version}/${PACKAGE_ID}.yaml`]: header("version")
      + `DefaultLocale: en-US\n` + footer("version"),
    [`${WINGET_PATH}/${version}/${PACKAGE_ID}.installer.yaml`]: header("installer")
      + `InstallerType: nullsoft
UpgradeBehavior: install
Installers:
  - Architecture: x64
    Scope: user
    InstallerUrl: ${base}/PwrAgent-${version}-windows-x64-setup.exe
    InstallerSha256: ${windows.toUpperCase()}
    InstallerSwitches:
      Custom: /currentuser
  - Architecture: x64
    Scope: machine
    InstallerUrl: ${base}/PwrAgent-${version}-windows-x64-setup.exe
    InstallerSha256: ${windows.toUpperCase()}
    InstallerSwitches:
      Custom: /allusers
` + footer("installer"),
    [`${WINGET_PATH}/${version}/${PACKAGE_ID}.locale.en-US.yaml`]: header("defaultLocale")
      + `PackageLocale: en-US
Publisher: PwrDrvr LLC
PublisherUrl: https://pwrdrvr.com/
PublisherSupportUrl: https://github.com/${SOURCE_REPO}/issues
PackageName: PwrAgent
PackageUrl: https://pwragent.ai/
License: MIT
LicenseUrl: https://github.com/${SOURCE_REPO}/blob/v${version}/LICENSE
ShortDescription: Thread-centric coding agent desktop app
ReleaseNotesUrl: https://github.com/${SOURCE_REPO}/releases/tag/v${version}
` + footer("defaultLocale"),
  };
  return files;
}

export function auditChannels(api = ghJson) {
  const latest = api(`repos/${SOURCE_REPO}/releases/latest`);
  const version = stableVersion(latest);
  const cask = api(`repos/${TAP_REPO}/contents/Casks/pwragent.rb`, true);
  const core = api("repos/Homebrew/homebrew-cask/contents/Casks/p/pwragent.rb", true);
  const formula = api("repos/Homebrew/homebrew-core/contents/Formula/p/pwragent.rb", true);
  if (core || formula) throw new Error("PwrAgent exists in official Homebrew; reconcile ownership before updating the tap");
  const caskVersion = cask
    ? Buffer.from(cask.content, "base64").toString().match(/^  version "([^"]+)"$/m)?.[1]
    : null;
  if (cask && !caskVersion) throw new Error("Cannot parse authoritative PwrAgent cask version");
  const entries = api(`repos/${WINGET_REPO}/contents/${WINGET_PATH}`, true);
  const wingetVersions = entries?.filter((entry) => entry.type === "dir").map((entry) => entry.name) ?? [];
  const wingetVersion = wingetVersions.sort(compareVersions).at(-1) ?? null;
  const pending = (repo) => api(`search/issues?q=${encodeURIComponent(`repo:${repo} is:pr is:open PwrAgent`)}`).items
    .map(({ html_url, title }) => ({ url: html_url, title }));
  return {
    checkedAt: new Date().toISOString(),
    stable: { version, url: latest.html_url },
    homebrew: { token: "pwrdrvr/tap/pwragent", repository: TAP_REPO, version: caskVersion, pending: pending(TAP_REPO) },
    winget: { identifier: PACKAGE_ID, repository: WINGET_REPO, version: wingetVersion, pending: pending(WINGET_REPO) },
  };
}

async function download(asset, dir) {
  const file = resolve(dir, asset.name);
  try {
    await stat(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const response = await fetch(asset.browser_download_url);
    if (!response.ok) throw new Error(`Download ${asset.name}: HTTP ${response.status}`);
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(`${file}.part`));
      const { rename } = await import("node:fs/promises");
      await rename(`${file}.part`, file);
    } finally {
      await rm(`${file}.part`, { force: true });
    }
  }
  return file;
}

export async function materializeRelease(release, out, cache) {
  await mkdir(cache, { recursive: true });
  const assets = releaseAssets(release);
  for (const asset of assets) await download(asset, cache);
  const manifests = await Promise.all(assets.slice(3).map((asset) => readFile(resolve(cache, asset.name), "utf8")));
  const hashes = {};
  for (const [index, asset] of assets.slice(0, 3).entries()) {
    const expected = checksumFor(manifests[index === 2 ? 1 : 0], asset.name);
    hashes[asset.name] = await verifyFile(resolve(cache, asset.name), asset, expected);
  }
  for (const [path, contents] of Object.entries(renderPackages(release, hashes))) {
    const file = resolve(out, path);
    await mkdir(resolve(file, ".."), { recursive: true });
    // winget-pkgs requests CRLF for YAML; the cask retains LF.
    await writeFile(file, path.endsWith(".yaml") ? contents.replaceAll("\n", "\r\n") : contents);
  }
  return hashes;
}

async function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!["--audit", "--out", "--tag", "--assets", "--previous-out"].includes(key)) throw new Error(`Unknown argument ${key}`);
    options[key] = key === "--audit" ? true : argv[++i];
    if (!options[key]) throw new Error(`Missing value for ${key}`);
  }
  const audit = auditChannels();
  console.log(JSON.stringify(audit, null, 2));
  if (options["--audit"]) return;
  if (!options["--out"]) throw new Error("Use --audit, or --out <directory> [--tag vX.Y.Z] [--assets <cache>]");
  const tag = options["--tag"] ?? `v${audit.stable.version}`;
  const release = ghJson(`repos/${SOURCE_REPO}/releases/tags/${encodeURIComponent(tag)}`);
  const version = stableVersion(release);
  if (version !== audit.stable.version) throw new Error("Generate only the current promoted GitHub Latest release");
  for (const channel of [audit.homebrew, audit.winget]) {
    if (channel.version && compareVersions(version, channel.version) < 0) {
      throw new Error(`Refusing channel downgrade from ${channel.version} to ${version}`);
    }
  }
  const out = resolve(options["--out"]);
  const cache = resolve(options["--assets"] ?? `${out}/assets`);
  const hashes = await materializeRelease(release, out, cache);
  let previous = null;
  if (options["--previous-out"]) {
    const releases = ghJson(`repos/${SOURCE_REPO}/releases?per_page=100`);
    const candidates = releases.filter((item) => !item.draft && !item.prerelease && /^v\d+\.\d+\.\d+$/.test(item.tag_name))
      .filter((item) => compareVersions(item.tag_name.slice(1), version) < 0)
      .sort((a, b) => compareVersions(a.tag_name.slice(1), b.tag_name.slice(1)));
    previous = candidates.at(-1);
    if (!previous) throw new Error("No previous stable release in the latest 100 releases; select an upgrade baseline manually");
    await materializeRelease(previous, resolve(options["--previous-out"]), resolve(cache, "previous"));
  }
  await writeFile(resolve(out, "audit.json"), JSON.stringify({ ...audit, hashes, previousVersion: previous?.tag_name.slice(1) ?? null }, null, 2) + "\n");
  console.log(`Verified release bytes and generated Homebrew/Winget inputs in ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
