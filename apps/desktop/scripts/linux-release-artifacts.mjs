#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, openSync, readSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const LINUX_PACKAGE_EXTENSIONS = ["deb", "rpm", "pacman", "tar.gz"];
export const LINUX_ARCHITECTURES = ["x64", "arm64"];
const ARTIFACT_ARCH_NAMES = {
  x64: { deb: "amd64", rpm: "x86_64" },
  arm64: { rpm: "aarch64", pacman: "aarch64" },
};

export function linuxPackageName(version, arch, extension) {
  if (!LINUX_ARCHITECTURES.includes(arch) || !LINUX_PACKAGE_EXTENSIONS.includes(extension)) {
    throw new Error(`Unsupported Linux package: ${arch}.${extension}`);
  }
  // electron-builder's getArtifactArchName uses format-specific names.
  const artifactArch = ARTIFACT_ARCH_NAMES[arch][extension] ?? arch;
  return `PwrAgent-${version}-linux-${artifactArch}.${extension}`;
}

export function linuxStableName(arch, extension) {
  return `PwrAgent-linux-${arch}.${extension}`;
}

export function linuxReleaseArtifactNames(version, architectures) {
  return architectures.flatMap((arch) => LINUX_PACKAGE_EXTENSIONS.flatMap((extension) => [
    linuxPackageName(version, arch, extension),
    linuxStableName(arch, extension),
  ]));
}

export function requireLinuxPackages(distDir, version, architectures, includeAliases = false) {
  const names = includeAliases
    ? linuxReleaseArtifactNames(version, architectures)
    : architectures.flatMap((arch) => LINUX_PACKAGE_EXTENSIONS.map(
      (extension) => linuxPackageName(version, arch, extension),
    ));
  const missing = names.filter((name) => !existsSync(join(distDir, name)));
  if (missing.length > 0) {
    throw new Error(`Missing Linux packages in ${distDir}: ${missing.join(", ")}`);
  }
  return names;
}

export function createLinuxStableAliases(distDir, version, arch) {
  // Validate the full format set before creating any aliases.
  requireLinuxPackages(distDir, version, [arch]);
  return LINUX_PACKAGE_EXTENSIONS.map((extension) => {
    const aliasPath = join(distDir, linuxStableName(arch, extension));
    copyFileSync(join(distDir, linuxPackageName(version, arch, extension)), aliasPath);
    return aliasPath;
  });
}

function digest(file) {
  const hash = createHash("sha256");
  const descriptor = openSync(file, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = readSync(descriptor, buffer)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

export function writeLinuxChecksums(distDir, version, architectures) {
  const names = requireLinuxPackages(distDir, version, architectures, true).sort();
  const lines = names.map((name) => `${digest(join(distDir, name))}  ${name}`);
  const checksumPath = join(distDir, "SHA256SUMS");
  writeFileSync(checksumPath, `${lines.join("\n")}\n`);
  return checksumPath;
}

// The publication job merges both architecture artifacts and uses the same
// completeness check and checksum writer as each native packaging job.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [distDir, version] = process.argv.slice(2);
  if (!distDir || !version) throw new Error("Usage: linux-release-artifacts.mjs <dist-dir> <version>");
  writeLinuxChecksums(distDir, version, LINUX_ARCHITECTURES);
}
