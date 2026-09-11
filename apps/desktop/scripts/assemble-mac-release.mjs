#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Use the prepared builder's YAML dependency, including in the signing job
// where dependency installation is forbidden.
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const libraryRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const yaml = libraryRequire("js-yaml");

function digest(path, algorithm, encoding) {
  const hash = createHash(algorithm);
  const buffer = Buffer.alloc(1024 * 1024);
  const descriptor = openSync(path, "r");
  try {
    let count;
    while ((count = readSync(descriptor, buffer)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest(encoding);
  } finally {
    closeSync(descriptor);
  }
}

function readTarget(directory, arch) {
  const info = yaml.load(readFileSync(join(directory, "latest-mac.yml"), "utf8"));
  if (typeof info?.version !== "string" || !Array.isArray(info.files) || info.files.length !== 1) {
    throw new Error(`Expected one updater ZIP in ${directory}`);
  }
  const file = info.files[0];
  const expected = `PwrAgent-${info.version}-${arch}-mac.zip`;
  if (file.url !== expected || basename(file.url) !== file.url) {
    throw new Error(`Expected ${expected} in ${directory}`);
  }
  const zip = join(directory, file.url);
  if (file.sha512 !== digest(zip, "sha512", "base64") || file.size !== statSync(zip).size) {
    throw new Error(`Updater hash or size does not match ${zip}`);
  }
  for (const name of [`${expected}.blockmap`, `PwrAgent-${info.version}-${arch}.dmg`]) {
    if (!existsSync(join(directory, name))) throw new Error(`Missing ${name}`);
  }
  return info;
}

export function assembleMacRelease(universalDir, arm64Dir) {
  const universal = readTarget(universalDir, "universal");
  const arm64 = readTarget(arm64Dir, "arm64");
  if (universal.version !== arm64.version) throw new Error("macOS target versions differ");
  const version = universal.version;
  const armZip = arm64.files[0].url;
  for (const name of [armZip, `${armZip}.blockmap`, `PwrAgent-${version}-arm64.dmg`]) {
    copyFileSync(join(arm64Dir, name), join(universalDir, name));
  }
  const aliases = [
    [`PwrAgent-${version}-universal.dmg`, "PwrAgent.dmg"],
    [`PwrAgent-${version}-arm64.dmg`, "PwrAgent-arm64.dmg"],
  ];
  for (const [source, alias] of aliases) {
    copyFileSync(join(universalDir, source), join(universalDir, alias));
  }
  // Preserve the universal legacy path/hash for older clients. Modern
  // MacUpdater selects arm64 by URL on Apple Silicon, including Rosetta.
  const merged = {
    ...universal,
    files: [universal.files[0], arm64.files[0]],
    path: universal.files[0].url,
    sha512: universal.files[0].sha512,
  };
  writeFileSync(join(universalDir, "latest-mac.yml"), yaml.dump(merged));
  const names = [
    "latest-mac.yml",
    ...merged.files.flatMap(({ url }) => [url, `${url}.blockmap`]),
    ...aliases.flat(),
  ];
  writeFileSync(join(universalDir, "PwrAgent-macos-SHA256SUMS"), names.map(
    (name) => `${digest(join(universalDir, name), "sha256", "hex")}  ${name}\n`,
  ).join(""));
  return merged;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [universalDir, arm64Dir] = process.argv.slice(2);
  if (!universalDir || !arm64Dir) throw new Error("Usage: assemble-mac-release.mjs <universal-dist> <arm64-dist>");
  assembleMacRelease(universalDir, arm64Dir);
  console.log("Verified and assembled universal + arm64 macOS release payload");
}
