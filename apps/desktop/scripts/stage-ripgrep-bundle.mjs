#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const desktopRoot = resolve(dirname(scriptPath), "..");
const manifestPath = join(desktopRoot, "ripgrep-bundle.json");
const outputRoot = join(desktopRoot, "build", "bundled-tools", "ripgrep");

function readManifest() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    typeof manifest.repository !== "string"
    || typeof manifest.tag !== "string"
    || !manifest.assets
    || typeof manifest.assets !== "object"
  ) {
    throw new Error(`Invalid ripgrep bundle manifest: ${manifestPath}`);
  }
  return manifest;
}

export function resolveCurrentRipgrepPlatform(platform, arch) {
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x86_64";
  if (platform === "linux" && arch === "arm64") return "linux-aarch64";
  if (platform === "linux" && arch === "x64") return "linux-x86_64";
  if (platform === "win32" && arch === "x64") return "windows-x86_64";
  throw new Error(`Unsupported ripgrep bundle platform: ${platform}-${arch}`);
}

export function resolveRipgrepAssetPlatforms(platform, hostPlatform, hostArch) {
  const resolvedPlatform = platform === "current"
    ? resolveCurrentRipgrepPlatform(hostPlatform, hostArch)
    : platform;
  return resolvedPlatform === "macos-universal"
    ? ["macos-arm64", "macos-x86_64"]
    : [resolvedPlatform];
}

async function download(url, targetPath) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const response = await fetch(url, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "PwrAgent-release-packager",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  await pipeline(response.body, createWriteStream(targetPath));
}

export function expectedChecksum(checksumText, assetName) {
  const trimmedChecksum = checksumText.trim();
  const checksumMatch = /^([0-9a-fA-F]{64})\s+\*?(.+)$/u.exec(trimmedChecksum);
  if (checksumMatch && basename(checksumMatch[2]) === assetName) {
    return checksumMatch[1].toLowerCase();
  }

  const certUtilLines = trimmedChecksum
    .split(/\r?\n/u)
    .map((line) => line.trim());
  if (
    certUtilLines.length === 3
    && certUtilLines[0] === `SHA256 hash of ${assetName}:`
    && /^[0-9a-fA-F]{64}$/u.test(certUtilLines[1])
    && certUtilLines[2] === "CertUtil: -hashfile command completed successfully."
  ) {
    return certUtilLines[1].toLowerCase();
  }

  throw new Error(`Invalid checksum for ${assetName}`);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function runChecked(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function extractArchive(archivePath, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const tar = process.platform === "win32" ? "tar.exe" : "tar";
  runChecked(tar, ["-xf", archivePath, "-C", targetDir]);
}

function extractedBundleDirectory(extractedRoot) {
  const directories = readdirSync(extractedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(extractedRoot, entry.name));
  if (directories.length !== 1) {
    throw new Error(
      `Expected one ripgrep archive directory under ${extractedRoot}; found ${directories.length}`,
    );
  }
  return directories[0];
}

function validateExtractedBundle(directory, platform) {
  const executable = platform.startsWith("windows-") ? "rg.exe" : "rg";
  const requiredFiles = [
    join(directory, executable),
    join(directory, "LICENSE-MIT"),
    join(directory, "UNLICENSE"),
  ];
  for (const requiredFile of requiredFiles) {
    if (!existsSync(requiredFile) || !statSync(requiredFile).isFile()) {
      throw new Error(`ripgrep bundle is missing ${requiredFile}`);
    }
  }
  return {
    directory,
    executable: join(directory, executable),
  };
}

function stagedExecutable() {
  return join(outputRoot, process.platform === "win32" ? "rg.exe" : "rg");
}

function cachedBundleMatches(manifest, requestedPlatform, assetPlatforms) {
  const metadataPath = join(outputRoot, "PWRAGENT-BUNDLE.json");
  if (!existsSync(metadataPath)) return false;
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    const platformMatches = metadata.platform === requestedPlatform
      || (
        requestedPlatform.startsWith("macos-")
        && requestedPlatform !== "macos-universal"
        && metadata.platform === "macos-universal"
      );
    const expectedAssets = assetPlatforms.map((platform) => manifest.assets[platform]);
    const cachedAssets = metadata.assets?.map(({ asset }) => asset);
    const assetsMatch = metadata.platform === "macos-universal"
      && requestedPlatform.startsWith("macos-")
      && requestedPlatform !== "macos-universal"
      ? expectedAssets.every((asset) => cachedAssets?.includes(asset))
      : JSON.stringify(cachedAssets) === JSON.stringify(expectedAssets);
    if (
      metadata.repository !== manifest.repository
      || metadata.tag !== manifest.tag
      || !platformMatches
      || !assetsMatch
      || !existsSync(join(outputRoot, "LICENSE-MIT"))
      || !existsSync(join(outputRoot, "UNLICENSE"))
      || !existsSync(stagedExecutable())
    ) {
      return false;
    }
    const probe = spawnSync(stagedExecutable(), ["--version"], {
      encoding: "utf8",
    });
    return probe.status === 0 && probe.stdout.startsWith(`ripgrep ${manifest.tag}`);
  } catch {
    return false;
  }
}

async function downloadAndExtractAsset({ assetName, platform, releaseBase, tempRoot }) {
  const archivePath = join(tempRoot, assetName);
  const checksumPath = `${archivePath}.sha256`;
  await Promise.all([
    download(`${releaseBase}/${assetName}`, archivePath),
    download(`${releaseBase}/${assetName}.sha256`, checksumPath),
  ]);
  const expected = expectedChecksum(readFileSync(checksumPath, "utf8"), assetName);
  const actual = await sha256(archivePath);
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${assetName}: expected ${expected}, got ${actual}`,
    );
  }

  const extractedRoot = join(tempRoot, `extracted-${platform}`);
  extractArchive(archivePath, extractedRoot);
  const bundle = validateExtractedBundle(
    extractedBundleDirectory(extractedRoot),
    platform,
  );
  return { ...bundle, asset: assetName, platform, sha256: actual };
}

function assembleBundle(bundles, requestedPlatform) {
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  copyFileSync(join(bundles[0].directory, "LICENSE-MIT"), join(outputRoot, "LICENSE-MIT"));
  copyFileSync(join(bundles[0].directory, "UNLICENSE"), join(outputRoot, "UNLICENSE"));
  const executable = stagedExecutable();
  if (requestedPlatform === "macos-universal") {
    const arm64 = bundles.find(({ platform }) => platform === "macos-arm64");
    const x86_64 = bundles.find(({ platform }) => platform === "macos-x86_64");
    if (!arm64 || !x86_64) {
      throw new Error("macos-universal ripgrep requires arm64 and x86_64 archives");
    }
    runChecked("lipo", ["-create", arm64.executable, x86_64.executable, "-output", executable]);
    runChecked("lipo", [executable, "-verify_arch", "arm64", "x86_64"]);
  } else {
    copyFileSync(bundles[0].executable, executable);
  }
  if (process.platform !== "win32") {
    chmodSync(executable, 0o755);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const platformIndex = argv.indexOf("--platform");
  const platform = platformIndex === -1 ? undefined : argv[platformIndex + 1];
  if (!platform) {
    throw new Error(
      "Usage: stage-ripgrep-bundle.mjs --platform <current|macos-universal|asset-platform>",
    );
  }

  const manifest = readManifest();
  const assetPlatforms = resolveRipgrepAssetPlatforms(
    platform,
    process.platform,
    process.arch,
  );
  const requestedPlatform = platform === "current"
    ? resolveCurrentRipgrepPlatform(process.platform, process.arch)
    : platform;
  for (const assetPlatform of assetPlatforms) {
    if (typeof manifest.assets[assetPlatform] !== "string") {
      throw new Error(`No ripgrep bundle asset is configured for ${assetPlatform}`);
    }
  }
  if (!argv.includes("--force") && cachedBundleMatches(
    manifest,
    requestedPlatform,
    assetPlatforms,
  )) {
    console.log(`Using staged ripgrep ${manifest.tag} at ${outputRoot}`);
    return;
  }

  const releaseBase =
    `https://github.com/${manifest.repository}/releases/download/${manifest.tag}`;
  const tempRoot = mkdtempSync(join(tmpdir(), "pwragent-ripgrep-bundle-"));
  try {
    const bundles = await Promise.all(assetPlatforms.map(async (assetPlatform) =>
      await downloadAndExtractAsset({
        assetName: manifest.assets[assetPlatform],
        platform: assetPlatform,
        releaseBase,
        tempRoot,
      })));
    assembleBundle(bundles, requestedPlatform);
    writeFileSync(
      join(outputRoot, "PWRAGENT-BUNDLE.json"),
      `${JSON.stringify(
        {
          repository: manifest.repository,
          tag: manifest.tag,
          platform: requestedPlatform,
          assets: bundles.map(({ asset, platform: assetPlatform, sha256: digest }) => ({
            platform: assetPlatform,
            asset,
            sha256: digest,
          })),
        },
        null,
        2,
      )}\n`,
    );
    runChecked(stagedExecutable(), ["--version"]);
    console.log(`Staged ripgrep ${manifest.tag} at ${outputRoot}`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  await main();
}
