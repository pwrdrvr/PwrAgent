#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const desktopRoot = resolve(dirname(scriptPath), "..");
const manifestPath = join(desktopRoot, "grok-bundle.json");
const outputRoot = join(desktopRoot, "build", "bundled-agents", "grok");

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function readManifest() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    typeof manifest.repository !== "string"
    || typeof manifest.tag !== "string"
    || !manifest.assets
    || typeof manifest.assets !== "object"
  ) {
    throw new Error(`Invalid Grok bundle manifest: ${manifestPath}`);
  }
  return manifest;
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

function expectedChecksum(checksumText, assetName) {
  for (const line of checksumText.split(/\r?\n/u)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/u.exec(line.trim());
    if (match?.[2] === assetName) {
      return match[1].toLowerCase();
    }
  }
  throw new Error(`SHA256SUMS does not contain ${assetName}`);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function extractArchive(archivePath, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const tar = process.platform === "win32" ? "tar.exe" : "tar";
  const result = spawnSync(tar, ["-xf", archivePath, "-C", targetDir], {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${tar} exited with status ${result.status}`);
  }
}

function validateExtractedBundle(directory) {
  const executable = process.platform === "win32" ? "grok.exe" : "grok";
  const executablePath = join(directory, executable);
  const requiredFiles = [
    executablePath,
    join(directory, "LICENSE"),
    join(directory, "THIRD-PARTY-NOTICES"),
    join(directory, "SOURCE_REV"),
    join(directory, "PWRAGENT-BUILD.txt"),
  ];
  for (const requiredFile of requiredFiles) {
    if (!existsSync(requiredFile)) {
      throw new Error(`Grok bundle is missing ${requiredFile}`);
    }
  }
  if (process.platform !== "win32") {
    chmodSync(executablePath, 0o755);
  }
}

async function main() {
  const platform = readArgument("--platform");
  if (!platform) {
    throw new Error("Usage: stage-grok-bundle.mjs --platform <asset-platform>");
  }

  const manifest = readManifest();
  const assetName = manifest.assets[platform];
  if (typeof assetName !== "string" || !assetName) {
    throw new Error(`No Grok bundle asset is configured for ${platform}`);
  }

  const releaseBase =
    `https://github.com/${manifest.repository}/releases/download/${manifest.tag}`;
  const tempRoot = mkdtempSync(join(tmpdir(), "pwragent-grok-bundle-"));
  try {
    const checksumPath = join(tempRoot, "SHA256SUMS");
    const archivePath = join(tempRoot, assetName);
    await Promise.all([
      download(`${releaseBase}/SHA256SUMS`, checksumPath),
      download(`${releaseBase}/${assetName}`, archivePath),
    ]);

    const expected = expectedChecksum(
      readFileSync(checksumPath, "utf8"),
      assetName,
    );
    const actual = await sha256(archivePath);
    if (actual !== expected) {
      throw new Error(
        `Checksum mismatch for ${assetName}: expected ${expected}, got ${actual}`,
      );
    }

    const extractedRoot = join(tempRoot, "extracted");
    extractArchive(archivePath, extractedRoot);
    validateExtractedBundle(extractedRoot);

    rmSync(outputRoot, { recursive: true, force: true });
    cpSync(extractedRoot, outputRoot, { recursive: true });
    writeFileSync(
      join(outputRoot, "PWRAGENT-BUNDLE.json"),
      `${JSON.stringify(
        {
          repository: manifest.repository,
          tag: manifest.tag,
          asset: assetName,
          sha256: actual,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Staged ${assetName} at ${outputRoot}`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();
